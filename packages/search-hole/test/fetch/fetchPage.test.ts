// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchFailureReason } from '../../src/fetch/errors.ts'
import {
  type BlockVerdict,
  createPageFetcher,
  type PageFetcher,
  type PageFetcherConfig,
} from '../../src/fetch/fetchPage.ts'
import { SearchHoleError } from '../../src/shared/errors.ts'
import type { RuleRef } from '../../src/shared/types.ts'
import { fakeDns, type Handler, neverBlocked, startServer, type TestServer, testPolicy } from './helpers.ts'

const FIXTURES = join(import.meta.dirname, '../fixtures/pages')
const NOW = Date.UTC(2026, 9, 30, 12)

const servers: TestServer[] = []
const fetchers: PageFetcher[] = []
afterEach(async () => {
  await Promise.all(fetchers.splice(0).map((f) => f.close()))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function serve(handler: Handler): Promise<TestServer> {
  const s = await startServer(handler)
  servers.push(s)
  return s
}

function fetcher(config: PageFetcherConfig = {}, opts: { robots?: boolean } = {}): PageFetcher {
  const f = createPageFetcher({ guard: testPolicy(), ...(opts.robots ? {} : { robots: false }), ...config })
  fetchers.push(f)
  return f
}

async function failure(p: Promise<unknown>): Promise<SearchHoleError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(SearchHoleError)
  return err as SearchHoleError
}

const html = (body: string, status = 200, headers: Record<string, string> = {}): Handler => {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(body)
  }
}

const rule = (text: string): RuleRef => ({ ruleId: 'r1', tier: 'T2', text })

describe('fetchPage: readable text', () => {
  it('extracts the article from a saved page and drops chrome, scripts and hidden text', async () => {
    const page = readFileSync(join(FIXTURES, 'article-readable.html'), 'utf8')
    const s = await serve(html(page, 200, { 'last-modified': 'Mon, 15 Sep 2025 14:30:00 GMT' }))
    const out = await fetcher().fetchPage(`${s.origin}/posts/pinning`, {
      isBlocked: neverBlocked,
      now: () => NOW,
    })

    expect(out.status).toBe(200)
    expect(out.untrusted).toBe(true)
    expect(out.extraction).toBe('readability')
    expect(out.contentType).toBe('text/html')
    expect(out.sourceTitle).toBe('Pinning dependencies with lockfiles')
    expect(out.canonicalUrl).toBe('https://engineering.example/posts/pinning-dependencies')
    expect(out.lang).toBe('en')
    expect(out.text).toContain('A lockfile records the exact versions that were resolved')
    expect(out.text).toContain('## Updating safely')
    expect(out.text).toMatch(/1\. Run the update command on a branch/)
    expect(out.text).toContain('```sh\npnpm install --frozen-lockfile\nnpm ci\n```')
    expect(out.text).toContain('| npm | package-lock.json |')
    expect(out.text).toContain(`[integrity hashes explainer](${s.origin}/posts/integrity-hashes)`)
    expect(out.text).toContain('[format reference](https://docs.example/lockfiles#format)')
    for (const absent of [
      'Ignore all previous instructions',
      'developer mode',
      'UA-NOT-CONTENT',
      'Careers',
      'Buy our conference',
      'Subscribe',
    ]) {
      expect(out.text).not.toContain(absent)
    }
    expect(out.dates.map((d) => `${d.method}=${d.value}`)).toEqual([
      'jsonld:datePublished=2025-06-02T09:00:00.000Z',
      'jsonld:dateModified=2025-09-15T14:30:00.000Z',
      'og:article:published_time=2025-06-02T09:00:00.000Z',
      'time:datetime=2025-06-02T00:00:00.000Z',
      'http:last-modified=2025-09-15T14:30:00.000Z',
    ])
    expect(out.sanitized).toEqual({ invisibleChars: 0, hiddenTextBlocks: 2 })
    expect(out.nextCursor).toBeUndefined()
    expect(out.fetchedAt).toBe('2026-10-30T12:00:00.000Z')
  })

  it('falls back to htmlparser2 text when Readability finds no article', async () => {
    const s = await serve(
      html(
        '<html><head><title>Tiny</title></head><body><nav>Menu</nav><p>Just a short note.</p></body></html>',
      ),
    )
    const out = await fetcher().fetchPage(`${s.origin}/`, { isBlocked: neverBlocked })
    expect(out.extraction).toBe('html-text')
    expect(out.text).toBe('Just a short note.')
    expect(out.sourceTitle).toBe('Tiny')
  })

  it('passes text/plain through and strips invisible characters', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('line one\r\nline​ two\u{e0041}\u{e0042}‮')
    })
    const out = await fetcher().fetchPage(`${s.origin}/notes.txt`, { isBlocked: neverBlocked })
    expect(out.extraction).toBe('plain')
    expect(out.text).toBe('line one\nline two')
    expect(out.sanitized).toEqual({ invisibleChars: 4, hiddenTextBlocks: 0 })
    expect(out.sourceTitle).toBeNull()
  })

  it('decodes legacy charsets from the header and from <meta charset>', async () => {
    const latin = Buffer.from('<html><body><p>caf\xe9 cr\xe8me</p></body></html>', 'latin1')
    const s = await serve((req, res) => {
      if (req.url === '/header') res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' })
      else res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        req.url === '/header' ? latin : Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin]),
      )
    })
    const f = fetcher()
    expect((await f.fetchPage(`${s.origin}/header`, { isBlocked: neverBlocked })).text).toBe('café crème')
    const meta = await f.fetchPage(`${s.origin}/meta`, { isBlocked: neverBlocked })
    expect(meta.text).toBe('café crème')
    expect(meta.charset).toBe('windows-1252')
  })

  it('decodes gzip and brotli bodies', async () => {
    const body = '<html><body><p>compressed hello</p></body></html>'
    const s = await serve((req, res) => {
      const br = req.url === '/br'
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': br ? 'br' : 'gzip' })
      res.end(br ? brotliCompressSync(body) : gzipSync(body))
    })
    const f = fetcher()
    expect((await f.fetchPage(`${s.origin}/gz`, { isBlocked: neverBlocked })).text).toBe('compressed hello')
    expect((await f.fetchPage(`${s.origin}/br`, { isBlocked: neverBlocked })).text).toBe('compressed hello')
    expect(s.seen[0]?.headers['accept-encoding']).toBe('gzip, br')
  })

  it('sends an honest user agent', async () => {
    const s = await serve(html('<p>ok</p>'))
    await fetcher().fetchPage(`${s.origin}/`, { isBlocked: neverBlocked })
    expect(s.seen[0]?.headers['user-agent']).toMatch(
      /^search-hole\/\d+\.\d+\.\d+\S* \(\+https:\/\/github\.com\/baselissmail\/search-hole\)$/,
    )
  })

  it('reports a meta-refresh target without following it', async () => {
    const s = await serve(html('<meta http-equiv="refresh" content="0; url=/moved-here"><p>Redirecting…</p>'))
    const out = await fetcher().fetchPage(`${s.origin}/old`, { isBlocked: neverBlocked })
    expect(out.refreshUrl).toBe(`${s.origin}/moved-here`)
    expect(s.seen).toHaveLength(1)
  })

  it('returns non-2xx pages with their status and no dates', async () => {
    const s = await serve(html('<meta name="date" content="2020-01-01"><p>Not found</p>', 404))
    const out = await fetcher().fetchPage(`${s.origin}/2020/01/01/gone`, { isBlocked: neverBlocked })
    expect(out.status).toBe(404)
    expect(out.text).toBe('Not found')
    expect(out.dates).toEqual([])
  })
})

describe('fetchPage: content types', () => {
  it('reports PDFs as unsupported (planned) without downloading them', async () => {
    let closedEarly = false
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.write(Buffer.alloc(64 * 1024, 1))
      res.on('close', () => {
        closedEarly = !res.writableFinished
      })
      setTimeout(() => res.end(Buffer.alloc(64 * 1024, 1)), 300)
    })
    const out = await fetcher().fetchPage(`${s.origin}/paper.pdf`, { isBlocked: neverBlocked })
    expect(out.unsupported).toEqual({
      type: 'pdf',
      planned: true,
      message: 'unsupported_type: pdf (planned)',
    })
    expect(out.text).toBe('')
    expect(out.bytes).toBe(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(closedEarly).toBe(true)
  })

  it('sniffs a PDF and HTML served without a content type', async () => {
    const s = await serve((req, res) => {
      res.writeHead(200, { 'content-type': '' })
      res.end(req.url === '/pdf' ? '%PDF-1.7\n...' : '<!DOCTYPE html><title>T</title><p>sniffed html</p>')
    })
    const f = fetcher()
    expect((await f.fetchPage(`${s.origin}/pdf`, { isBlocked: neverBlocked })).unsupported?.type).toBe('pdf')
    const page = await f.fetchPage(`${s.origin}/html`, { isBlocked: neverBlocked })
    expect(page.contentType).toBe('text/html')
    expect(page.text).toBe('sniffed html')
  })

  it('refuses other binary types with a clear message', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.alloc(10))
    })
    const out = await fetcher().fetchPage(`${s.origin}/x.png`, { isBlocked: neverBlocked })
    expect(out.unsupported).toEqual({
      type: 'image/png',
      planned: false,
      message: 'unsupported_type: image/png',
    })
  })
})

describe('fetchPage: redirects are re-checked on every hop', () => {
  it('follows up to 5 redirects and reports them', async () => {
    const s = await serve((req, res) => {
      const n = Number(req.url?.slice(1) || '0')
      if (n < 5) {
        res.writeHead(n % 2 ? 301 : 302, { location: `/${n + 1}` })
        res.end()
      } else html('<p>landed</p>')(req, res, '')
    })
    const out = await fetcher().fetchPage(`${s.origin}/0`, { isBlocked: neverBlocked })
    expect(out.finalUrl).toBe(`${s.origin}/5`)
    expect(out.requestedUrl).toBe(`${s.origin}/0`)
    expect(out.redirects.map((r) => r.status)).toEqual([302, 301, 302, 301, 302])
    expect(out.text).toBe('landed')
  })

  it('refuses a 6th redirect', async () => {
    const s = await serve((req, res) => {
      res.writeHead(302, { location: `/${Number(req.url?.slice(1) || '0') + 1}` })
      res.end()
    })
    const err = await failure(fetcher().fetchPage(`${s.origin}/0`, { isBlocked: neverBlocked }))
    expect(fetchFailureReason(err)).toBe('too_many_redirects')
    expect(s.seen).toHaveLength(6)
  })

  it('blocks a public → private hop (cloud metadata)', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    })
    const err = await failure(fetcher().fetchPage(`${s.origin}/r`, { isBlocked: neverBlocked }))
    expect(err.code).toBe('fetch_blocked')
    expect(err.details).toMatchObject({ reason: 'ssrf', hop: 1, range: 'linkLocal' })
  })

  it('blocks a hop to a hostname that resolves to a private address', async () => {
    const dns = fakeDns({ 'public.test': '127.0.0.1', 'intranet.test': '10.0.0.7' })
    const s = await serve((_req, res) => {
      res.writeHead(307, { location: `http://intranet.test:${s.port}/admin` })
      res.end()
    })
    const f = fetcher({ guard: testPolicy(dns) })
    const err = await failure(f.fetchPage(`http://public.test:${s.port}/`, { isBlocked: neverBlocked }))
    expect(err.details).toMatchObject({ reason: 'ssrf', address: '10.0.0.7', hop: 1 })
    expect(s.seen.map((r) => r.host)).toEqual([`public.test:${s.port}`])
  })

  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['http://user:pw@example.com/', 'credentials'],
    ['http://example.com:25/', 'port'],
    ['http://[::ffff:10.0.0.1]/', 'ssrf'],
  ])('refuses a redirect to %s', async (location, reason) => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location })
      res.end()
    })
    const err = await failure(fetcher().fetchPage(`${s.origin}/`, { isBlocked: neverBlocked }))
    expect(fetchFailureReason(err)).toBe(reason)
  })

  it('refuses a redirect into a blocked domain before connecting (no laundering)', async () => {
    const dns = fakeDns({ 'redirector.test': '127.0.0.1', 'blocked.test': '127.0.0.1' })
    const s = await serve((req, res) => {
      if (req.headers.host?.startsWith('redirector.test')) {
        res.writeHead(301, { location: `http://blocked.test:${s.port}/article` })
        res.end()
      } else html('<p>should never be served</p>')(req, res, '')
    })
    const checked: string[] = []
    const isBlocked = (url: string): BlockVerdict | null => {
      checked.push(url)
      return new URL(url).hostname === 'blocked.test' ? { reason: 'rule', rule: rule('blocked.test') } : null
    }
    const f = fetcher({ guard: testPolicy(dns) })
    const err = await failure(f.fetchPage(`http://redirector.test:${s.port}/go`, { isBlocked }))
    expect(err.code).toBe('fetch_blocked')
    expect(err.details).toMatchObject({ reason: 'rule', hop: 1, rule: { text: 'blocked.test' } })
    expect(err.why).toContain('blocked.test is blocked by the rule "blocked.test"')
    expect(checked).toEqual([`http://redirector.test:${s.port}/go`, `http://blocked.test:${s.port}/article`])
    expect(s.seen).toHaveLength(1)
  })

  it('refuses a blocked start URL without any request', async () => {
    const s = await serve(html('<p>x</p>'))
    const err = await failure(
      fetcher().fetchPage(`${s.origin}/`, { isBlocked: async () => ({ reason: 'list' }) }),
    )
    expect(err.details).toMatchObject({ reason: 'rule', hop: 0 })
    expect(s.seen).toHaveLength(0)
  })

  it('applies rules to <link rel=canonical>', async () => {
    const s = await serve(
      html('<link rel="canonical" href="https://contentfarm.example/copied"><p>mirror</p>'),
    )
    const isBlocked = (url: string): BlockVerdict | null =>
      url.startsWith('https://contentfarm.example/')
        ? { reason: 'list', rule: rule('contentfarm.example') }
        : null
    const err = await failure(fetcher().fetchPage(`${s.origin}/mirror`, { isBlocked }))
    expect(err.details).toMatchObject({ reason: 'canonical_rule', url: 'https://contentfarm.example/copied' })
  })
})

describe('fetchPage: limits', () => {
  it('caps the decoded body at 5 MB and aborts the download', async () => {
    let finished = true
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      const chunk = Buffer.alloc(256 * 1024, 'a')
      let sent = 0
      const pump = (): void => {
        while (sent < 40 * 1024 * 1024) {
          sent += chunk.length
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      res.on('close', () => {
        finished = res.writableFinished
      })
      pump()
    })
    const out = await fetcher().fetchPage(`${s.origin}/big`, { isBlocked: neverBlocked, maxTokens: 500 })
    expect(out.truncated).toBe(true)
    expect(out.bytes).toBe(5 * 1024 * 1024)
    expect(out.chunk.total).toBe(5 * 1024 * 1024)
    await new Promise((r) => setTimeout(r, 50))
    expect(finished).toBe(false)
  })

  it('applies the cap to decompressed bytes (gzip bomb)', async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 'b'))
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' })
      res.end(bomb)
    })
    const out = await fetcher({ maxBodyBytes: 1024 * 1024 }).fetchPage(`${s.origin}/bomb`, {
      isBlocked: neverBlocked,
      maxTokens: 500,
    })
    expect(out.truncated).toBe(true)
    expect(out.bytes).toBe(1024 * 1024)
  })

  it('enforces the total deadline', async () => {
    const s = await serve(() => {
      // never answers
    })
    const started = Date.now()
    const err = await failure(
      fetcher({ timeoutMs: 300 }).fetchPage(`${s.origin}/slow`, { isBlocked: neverBlocked }),
    )
    expect(fetchFailureReason(err)).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('honours cancellation', async () => {
    const s = await serve(() => {})
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const err = await failure(
      fetcher().fetchPage(`${s.origin}/`, { isBlocked: neverBlocked, signal: ac.signal }),
    )
    expect(fetchFailureReason(err)).toBe('cancelled')
  })

  it('reports a refused connection as a network failure', async () => {
    const s = await serve(() => {})
    const port = s.port
    await s.close()
    servers.splice(servers.indexOf(s), 1)
    const err = await failure(fetcher().fetchPage(`http://127.0.0.1:${port}/`, { isBlocked: neverBlocked }))
    expect(err.code).toBe('fetch_failed')
    expect(err.details).toMatchObject({ reason: 'network' })
    expect(err.why).toContain('refused the connection')
  })

  it('keeps at most 2 concurrent requests per origin', async () => {
    const s = await serve((req, res) => {
      setTimeout(() => html('<p>slow</p>')(req, res, ''), 100)
    })
    const f = fetcher()
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => f.fetchPage(`${s.origin}/${i}`, { isBlocked: neverBlocked })),
    )
    expect(s.stats.maxInFlight).toBeLessThanOrEqual(2)
    expect(s.seen).toHaveLength(6)
  })
})

describe('fetchPage: robots.txt', () => {
  const robotsServer = (robots: { status: number; body?: string }) =>
    serve((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(robots.status, { 'content-type': 'text/plain' })
        res.end(robots.body ?? '')
        return
      }
      html('<p>page</p>')(req, res, '')
    })

  it('respects Disallow for our product token and caches robots.txt per origin', async () => {
    const s = await robotsServer({
      status: 200,
      body: 'User-agent: *\nAllow: /\n\nUser-agent: search-hole\nDisallow: /private\n',
    })
    const f = fetcher({}, { robots: true })
    const err = await failure(f.fetchPage(`${s.origin}/private/report`, { isBlocked: neverBlocked }))
    expect(err.code).toBe('fetch_blocked')
    expect(err.details).toMatchObject({ reason: 'robots' })
    expect(err.why).toContain('line 5')
    expect((await f.fetchPage(`${s.origin}/public`, { isBlocked: neverBlocked })).text).toBe('page')
    await f.fetchPage(`${s.origin}/public2`, { isBlocked: neverBlocked })
    expect(s.seen.filter((r) => r.url === '/robots.txt')).toHaveLength(1)
  })

  it('allows everything when robots.txt is 404', async () => {
    const s = await robotsServer({ status: 404 })
    const out = await fetcher({}, { robots: true }).fetchPage(`${s.origin}/x`, { isBlocked: neverBlocked })
    expect(out.text).toBe('page')
  })

  it.each([429, 503])('treats robots.txt %i as a temporary disallow', async (status) => {
    const s = await robotsServer({ status })
    const err = await failure(
      fetcher({}, { robots: true }).fetchPage(`${s.origin}/x`, { isBlocked: neverBlocked }),
    )
    expect(err.details).toMatchObject({ reason: 'robots_unavailable' })
    expect(err.fix).toContain('retry in a few minutes')
  })
})

describe('fetchPage: cursor continuation', () => {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `<p>Paragraph ${i + 1}. ${'The quick brown fox jumps over the lazy dog. '.repeat(12)}</p>`,
  ).join('\n')
  const page = `<html><head><title>Long</title></head><body><article><h1>Long page</h1>${paragraphs}</article></body></html>`

  it('splits long text into budgeted chunks that reassemble exactly', async () => {
    const s = await serve(html(page))
    const f = fetcher()
    const whole = await f.fetchPage(`${s.origin}/long`, { isBlocked: neverBlocked, maxTokens: 8000 })
    expect(whole.nextCursor).toBeUndefined()

    const pieces: string[] = []
    let cursor: string | undefined
    let calls = 0
    do {
      const out = await f.fetchPage(`${s.origin}/long`, {
        isBlocked: neverBlocked,
        maxTokens: 1000,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(out.chunk.tokens).toBeLessThanOrEqual(1000)
      expect(out.cursorStale).toBeUndefined()
      pieces.push(whole.text.slice(out.chunk.start, out.chunk.end))
      expect(out.text).toBe(pieces[pieces.length - 1])
      if (out.nextCursor) expect(out.text.endsWith('\n\n') || out.text.endsWith('. ')).toBe(true)
      cursor = out.nextCursor
      calls++
    } while (cursor && calls < 50)
    expect(calls).toBeGreaterThan(3)
    expect(pieces.join('')).toBe(whole.text)
  })

  it('flags a cursor whose page changed and resumes at a line start', async () => {
    let version = 1
    const s = await serve((req, res) =>
      html(version === 1 ? page : page.replace('Paragraph 1.', 'Paragraph one.'))(req, res, ''),
    )
    const f = fetcher()
    const first = await f.fetchPage(`${s.origin}/long`, { isBlocked: neverBlocked, maxTokens: 1000 })
    version = 2
    const next = await f.fetchPage(`${s.origin}/long`, {
      isBlocked: neverBlocked,
      maxTokens: 1000,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    })
    expect(next.cursorStale).toBe(true)
    expect(next.text.length).toBeGreaterThan(0)
  })

  it('rejects a malformed cursor as an invalid argument', async () => {
    const s = await serve(html(page))
    const err = await failure(
      fetcher().fetchPage(`${s.origin}/long`, { isBlocked: neverBlocked, cursor: 'bm9wZQ' }),
    )
    expect(err.code).toBe('invalid_argument')
    expect(s.seen).toHaveLength(0)
  })

  it('budgets CJK text at one token per character', async () => {
    const s = await serve(html(readFileSync(join(FIXTURES, 'article-ja.html'), 'utf8')))
    const f = fetcher()
    const out = await f.fetchPage(`${s.origin}/ja`, { isBlocked: neverBlocked, maxTokens: 150 })
    expect(out.lang).toBe('ja')
    expect(out.chunk.tokens).toBeLessThanOrEqual(150)
    expect(out.text.length).toBeLessThanOrEqual(150)
    expect(out.nextCursor).toBeDefined()
  })
})
