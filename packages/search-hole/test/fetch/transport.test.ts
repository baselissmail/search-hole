// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEngineTransport,
  type EngineOriginPolicy,
  type EngineTransport,
  type EngineTransportOptions,
  isTransportFailure,
  type TransportFailure,
  type TransportTrace,
} from '../../src/fetch/transport.ts'
import type { HttpResponse } from '../../src/shared/types.ts'
import { type Handler, startServer, type TestServer } from './helpers.ts'

const servers: TestServer[] = []
const transports: EngineTransport[] = []
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function serve(handler: Handler): Promise<TestServer> {
  const s = await startServer(handler)
  servers.push(s)
  return s
}

function transport(
  origins: Array<[string, EngineOriginPolicy]>,
  extra: Partial<EngineTransportOptions> = {},
): EngineTransport {
  const t = createEngineTransport({ allowedOrigins: new Map(origins), ...extra })
  transports.push(t)
  return t
}

const brave: EngineOriginPolicy = { engineId: 'brave', authHeaderNames: ['X-Subscription-Token'] }
const searxng: EngineOriginPolicy = { engineId: 'searxng', authHeaderNames: [] }
const SECRET = 'BSA-super-secret-key-123'

function ok(r: Awaited<ReturnType<EngineTransport>>): HttpResponse {
  if (isTransportFailure(r)) throw new Error(`unexpected failure: ${r.networkError}`)
  return r
}
function failed(r: Awaited<ReturnType<EngineTransport>>): TransportFailure {
  if (!isTransportFailure(r)) throw new Error(`unexpected response ${r.status}`)
  return r
}

describe('engine transport', () => {
  it('reaches a configured localhost origin and returns a normalised response', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '41' })
      res.end('{"results":[]}')
    })
    let clock = 1000
    const t = transport([[`${s.origin}/`, searxng]], { now: () => (clock += 7) })
    const res = ok(
      await t({ method: 'GET', url: `${s.origin}/search?q=x&format=json`, headers: {} }, undefined, 5000),
    )
    expect(res.status).toBe(200)
    expect(res.text).toBe('{"results":[]}')
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.headers['x-ratelimit-remaining']).toBe('41')
    expect(Object.keys(res.headers).every((k) => k === k.toLowerCase())).toBe(true)
    expect(res.durationMs).toBe(7)
    expect(s.seen[0]?.headers['user-agent']).toMatch(/^search-hole\//)
  })

  it('refuses an origin that is not configured, without opening a socket', async () => {
    const s = await serve((_req, res) => {
      res.end('x')
    })
    const t = transport([['http://127.0.0.1:1', searxng]])
    const r = failed(await t({ method: 'GET', url: `${s.origin}/search`, headers: {} }, undefined, 2000))
    expect(r).toMatchObject({ code: 'origin_not_allowed', errorClass: 'forbidden' })
    expect(s.seen).toHaveLength(0)
  })

  it('keeps the key on a same-origin redirect', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/old') {
        res.writeHead(301, { location: '/new' })
        res.end()
      } else res.end('done')
    })
    const t = transport([[s.origin, brave]])
    const res = ok(
      await t(
        { method: 'GET', url: `${s.origin}/old`, headers: { 'X-Subscription-Token': SECRET } },
        undefined,
        2000,
      ),
    )
    expect(res.text).toBe('done')
    expect(s.seen[1]?.headers['x-subscription-token']).toBe(SECRET)
  })

  it('strips engine auth headers (not only Authorization) on a cross-origin redirect', async () => {
    const b = await serve((_req, res) => {
      res.end('landed')
    })
    const a = await serve((_req, res) => {
      res.writeHead(307, { location: `${b.origin}/elsewhere` })
      res.end()
    })
    const t = transport([
      [a.origin, brave],
      [b.origin, searxng],
    ])
    const res = ok(
      await t(
        {
          method: 'GET',
          url: `${a.origin}/res/v1/web/search?q=1`,
          headers: {
            'X-Subscription-Token': SECRET,
            Authorization: `Bearer ${SECRET}`,
            Cookie: 'session=1',
            Accept: 'application/json',
          },
        },
        undefined,
        2000,
      ),
    )
    expect(res.text).toBe('landed')
    const seen = b.seen[0]?.headers ?? {}
    expect(seen['x-subscription-token']).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
    expect(seen.cookie).toBeUndefined()
    expect(seen.accept).toBe('application/json')
  })

  it("never sends another engine's auth header to an origin (keys bound to origin)", async () => {
    const s = await serve((_req, res) => {
      res.end('{}')
    })
    const tavily: EngineOriginPolicy = { engineId: 'tavily', authHeaderNames: ['Authorization'] }
    const t = transport([
      [s.origin, tavily],
      ['https://api.search.brave.com', brave],
    ])
    ok(
      await t(
        {
          method: 'GET',
          url: `${s.origin}/search`,
          headers: { Authorization: 'Bearer tvly-1', 'X-Subscription-Token': SECRET },
        },
        undefined,
        2000,
      ),
    )
    expect(s.seen[0]?.headers.authorization).toBe('Bearer tvly-1')
    expect(s.seen[0]?.headers['x-subscription-token']).toBeUndefined()
  })

  it('rejects an invalid allowlist entry at construction', () => {
    expect(() => createEngineTransport({ allowedOrigins: new Map([['localhost:8888', searxng]]) })).toThrow(
      /not an http\(s\) URL/,
    )
  })

  it('refuses a redirect to an origin that is not configured', async () => {
    const evil = await serve((_req, res) => {
      res.end('stolen')
    })
    const a = await serve((_req, res) => {
      res.writeHead(302, { location: `${evil.origin}/collect` })
      res.end()
    })
    const t = transport([[a.origin, brave]])
    const r = failed(
      await t(
        { method: 'GET', url: `${a.origin}/`, headers: { 'X-Subscription-Token': SECRET } },
        undefined,
        2000,
      ),
    )
    expect(r).toMatchObject({ code: 'redirect_not_allowed', errorClass: 'forbidden' })
    expect(evil.seen).toHaveLength(0)
    expect(r.networkError).not.toContain(SECRET)
  })

  it('turns POST into GET on 303 and keeps the body on 307', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/see-other') {
        res.writeHead(303, { location: '/result' })
        res.end()
      } else if (req.url === '/temp') {
        res.writeHead(307, { location: '/echo' })
        res.end()
      } else res.end(`${req.method}`)
    })
    const t = transport([[s.origin, searxng]])
    const headers = { 'content-type': 'application/json' }
    expect(
      ok(await t({ method: 'POST', url: `${s.origin}/see-other`, headers, body: '{"q":1}' }, undefined, 2000))
        .text,
    ).toBe('GET')
    expect(s.seen[1]).toMatchObject({ method: 'GET', body: '' })
    expect(
      ok(await t({ method: 'POST', url: `${s.origin}/temp`, headers, body: '{"q":2}' }, undefined, 2000))
        .text,
    ).toBe('POST')
    expect(s.seen[3]).toMatchObject({ method: 'POST', body: '{"q":2}' })
  })

  it('stops after 5 redirects', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: '/again' })
      res.end()
    })
    const r = failed(
      await transport([[s.origin, searxng]])(
        { method: 'GET', url: `${s.origin}/`, headers: {} },
        undefined,
        2000,
      ),
    )
    expect(r.code).toBe('too_many_redirects')
    expect(s.seen).toHaveLength(6)
  })

  it('returns non-2xx responses as data', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(429, { 'retry-after': '30' })
      res.end('slow down')
    })
    const res = ok(
      await transport([[s.origin, brave]])(
        { method: 'GET', url: `${s.origin}/`, headers: {} },
        undefined,
        2000,
      ),
    )
    expect(res).toMatchObject({ status: 429, text: 'slow down' })
    expect(res.headers['retry-after']).toBe('30')
  })

  it('decodes gzip responses', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(gzipSync('{"ok":"✓"}'))
    })
    const res = ok(
      await transport([[s.origin, searxng]])(
        { method: 'GET', url: `${s.origin}/`, headers: {} },
        undefined,
        2000,
      ),
    )
    expect(res.text).toBe('{"ok":"✓"}')
  })

  it('classifies refused connections, timeouts and cancellation without throwing', async () => {
    const dead = await serve(() => {})
    const deadOrigin = dead.origin
    await dead.close()
    servers.splice(servers.indexOf(dead), 1)
    const hang = await serve(() => {})
    const t = transport([
      [deadOrigin, searxng],
      [hang.origin, searxng],
    ])
    expect(
      failed(await t({ method: 'GET', url: `${deadOrigin}/`, headers: {} }, undefined, 2000)),
    ).toMatchObject({
      code: 'refused',
      errorClass: 'unreachable',
    })
    expect(
      failed(await t({ method: 'GET', url: `${hang.origin}/`, headers: {} }, undefined, 150)),
    ).toMatchObject({
      code: 'timeout',
      errorClass: 'timeout',
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    expect(
      failed(await t({ method: 'GET', url: `${hang.origin}/`, headers: {} }, ac.signal, 5000)),
    ).toMatchObject({
      code: 'cancelled',
      errorClass: 'cancelled',
    })
  })

  it('never throws on a malformed request', async () => {
    const t = transport([['http://127.0.0.1:9', searxng]])
    expect(failed(await t({ method: 'GET', url: 'not a url', headers: {} }, undefined, 100)).code).toBe(
      'invalid_request',
    )
    expect(
      failed(await t({ method: 'DELETE' as 'GET', url: 'http://127.0.0.1:9/', headers: {} }, undefined, 100))
        .code,
    ).toBe('invalid_request')
  })

  it('caps the response body', async () => {
    const s = await serve((_req, res) => {
      res.end(Buffer.alloc(2048, 'x'))
    })
    const r = failed(
      await transport([[s.origin, searxng]], { maxBodyBytes: 1024 })(
        { method: 'GET', url: `${s.origin}/`, headers: {} },
        undefined,
        2000,
      ),
    )
    expect(r.code).toBe('body_too_large')
  })

  it('traces without keys, headers or query strings', async () => {
    const s = await serve((_req, res) => {
      res.end('{}')
    })
    const events: TransportTrace[] = []
    const t = transport([[s.origin, brave]], { onTrace: (e) => events.push(e) })
    ok(
      await t(
        {
          method: 'GET',
          url: `${s.origin}/res/v1/web/search?q=secret+query&key=${SECRET}`,
          headers: { 'X-Subscription-Token': SECRET },
        },
        undefined,
        2000,
      ),
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      engineId: 'brave',
      method: 'GET',
      origin: s.origin,
      path: '/res/v1/web/search',
      status: 200,
    })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    expect(JSON.stringify(events)).not.toContain('secret+query')
  })
})
