// SPDX-License-Identifier: Apache-2.0
// The list fetcher (ADR-0022): HTTPS and public hosts only, conditional requests, caps.
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createListFetcher, type ListFetcher } from '../../src/fetch/list.ts'
import { startServer, type TestServer, testPolicy } from './helpers.ts'

const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

async function server(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const s = await startServer(handler)
  open.push(s)
  return s
}

function fetcher(o: Parameters<typeof createListFetcher>[0] = { guard: testPolicy() }): ListFetcher {
  const f = createListFetcher(o)
  open.push(f)
  return f
}

const LIST = '*://*.spam.example/*\n*://*.junk.example/*\n'

describe('createListFetcher', () => {
  it('downloads a list and answers 304 to its own validators', async () => {
    const s = await server((req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' })
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        etag: '"v1"',
        'last-modified': 'Fri, 30 Oct 2026 10:00:00 GMT',
      })
      res.end(LIST)
    })
    const f = fetcher()
    const first = await f.fetch({ url: `${s.origin}/list.txt` })
    expect(first).toMatchObject({
      kind: 'ok',
      text: LIST,
      etag: '"v1"',
      lastModified: 'Fri, 30 Oct 2026 10:00:00 GMT',
    })
    expect(first.kind === 'ok' && first.bytesSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(s.seen[0]?.headers['if-none-match']).toBeUndefined()
    const second = await f.fetch({
      url: `${s.origin}/list.txt`,
      etag: '"v1"',
      lastModified: 'Fri, 30 Oct 2026 10:00:00 GMT',
    })
    expect(second).toMatchObject({ kind: 'not_modified', etag: '"v1"' })
    expect(s.seen[1]?.headers['if-modified-since']).toBe('Fri, 30 Oct 2026 10:00:00 GMT')
    expect(s.seen[1]?.headers['user-agent']).toMatch(/^search-hole\//)
  })

  it('refuses plain HTTP and private addresses without the test override', async () => {
    const f = fetcher({})
    expect(await f.fetch({ url: 'http://lists.example/list.txt' })).toMatchObject({
      kind: 'error',
      code: 'not_https',
    })
    expect(await f.fetch({ url: 'https://127.0.0.1/list.txt' })).toMatchObject({
      kind: 'error',
      code: 'blocked_address',
    })
    expect(await f.fetch({ url: 'https://10.0.0.5/list.txt' })).toMatchObject({
      kind: 'error',
      code: 'blocked_address',
    })
    expect(await f.fetch({ url: 'https://localhost/list.txt' })).toMatchObject({
      kind: 'error',
      code: 'blocked_address',
    })
    expect(await f.fetch({ url: 'ftp://lists.example/list.txt' })).toMatchObject({
      kind: 'error',
      code: 'not_https',
    })
  })

  it('refuses a name that resolves to a private address (DNS is checked at connect time)', async () => {
    const f = fetcher({
      guard: {
        resolve: async () => [{ address: '192.168.1.10', family: 4 }],
      },
    })
    expect(await f.fetch({ url: 'https://lists.example/list.txt' })).toMatchObject({
      kind: 'error',
      code: 'blocked_address',
    })
  })

  it('follows redirects only to HTTPS (each hop is checked)', async () => {
    const s = await server((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/list.txt' })
        res.end()
        return
      }
      if (req.url === '/downgrade') {
        res.writeHead(301, { location: 'http://lists.example/list.txt' })
        res.end()
        return
      }
      if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end(LIST)
    })
    const f = fetcher()
    expect(await f.fetch({ url: `${s.origin}/moved` })).toMatchObject({
      kind: 'ok',
      finalUrl: `${s.origin}/list.txt`,
    })
    expect(await f.fetch({ url: `${s.origin}/downgrade` })).toMatchObject({
      kind: 'error',
      code: 'not_https',
    })
    expect(await f.fetch({ url: `${s.origin}/loop` })).toMatchObject({
      kind: 'error',
      code: 'too_many_redirects',
    })
  })

  it('caps the decoded size (a gzip bomb stops at the cap) and refuses binary bodies', async () => {
    const big = 'x'.repeat(4096)
    const s = await server((req, res) => {
      if (req.url === '/gz') {
        res.writeHead(200, { 'content-encoding': 'gzip' })
        res.end(gzipSync(Buffer.from(big)))
        return
      }
      if (req.url === '/bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
        return
      }
      res.writeHead(200)
      res.end(big)
    })
    const f = fetcher({ guard: testPolicy(), maxBytes: 1024 })
    expect(await f.fetch({ url: `${s.origin}/plain` })).toMatchObject({ kind: 'error', code: 'too_large' })
    expect(await f.fetch({ url: `${s.origin}/gz` })).toMatchObject({ kind: 'error', code: 'too_large' })
    expect(await f.fetch({ url: `${s.origin}/bin` })).toMatchObject({ kind: 'error', code: 'not_text' })
  })

  it('reports HTTP errors and timeouts as coded outcomes', async () => {
    const s = await server((req, res) => {
      if (req.url === '/slow') return // never answers
      res.writeHead(404)
      res.end('not found')
    })
    const f = fetcher({ guard: testPolicy(), timeoutMs: 200 })
    expect(await f.fetch({ url: `${s.origin}/gone` })).toMatchObject({
      kind: 'error',
      code: 'http_status',
      status: 404,
    })
    expect(await f.fetch({ url: `${s.origin}/slow` })).toMatchObject({ kind: 'error', code: 'timeout' })
  })
})
