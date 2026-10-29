// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { makeCtx, makePlan, NOW, readFixture, response } from '../../test/mock-engine/helpers.ts'
import { classifyUpstreamMessage, createSearxngAdapter } from './searxng.ts'

const adapter = createSearxngAdapter({ now: () => NOW })
const ctx = makeCtx({ endpoint: 'http://127.0.0.1:8080', apiKey: null, timeoutMs: 5500 })

interface FixtureItem {
  url: string
  score: number
  engines: string[]
  publishedDate: string | null
}
function fixtureItems(name: string): FixtureItem[] {
  return (JSON.parse(readFixture(`searxng/${name}.json`)) as { results: FixtureItem[] }).results
}

describe('searxng adapter: tables', () => {
  it('declares the ADR-0009 capability and retention tables', () => {
    expect(adapter.id).toBe('searxng')
    expect(adapter.retention).toEqual({ log: 'full', payloadTtlHours: null })
    expect(adapter.capabilities).toMatchObject({
      requiresKey: false,
      endpoint: 'user',
      billed: false,
      goggles: false,
      domainInclude: null,
      domainExclude: null,
      dates: 'published',
    })
    expect(adapter.capabilities.dateFilter).toEqual({ buckets: ['day', 'week', 'month', 'year'] })
    expect(adapter.defaults.timeoutMs).toBeGreaterThan(4000)
  })
})

describe('searxng adapter: setup', () => {
  it('needs an http(s) endpoint and no key', () => {
    expect(adapter.setup(makeCtx({ endpoint: null }))).toMatchObject({ active: false, reason: 'no_endpoint' })
    expect(adapter.setup(makeCtx({ endpoint: 'not a url' }))).toMatchObject({
      active: false,
      reason: 'no_endpoint',
    })
    expect(adapter.setup(makeCtx({ endpoint: 'ftp://host' }))).toMatchObject({
      active: false,
      reason: 'no_endpoint',
    })
    expect(adapter.setup(ctx)).toEqual({ active: true })
  })
})

describe('searxng adapter: buildRequest', () => {
  it('builds the documented GET request', () => {
    const req = adapter.buildRequest(makePlan({ query: 'python asyncio taskgroup', language: 'en-US' }), ctx)
    expect(req.method).toBe('GET')
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('http://127.0.0.1:8080/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'python asyncio taskgroup',
      format: 'json',
      language: 'en-US',
      safesearch: '1',
      pageno: '1',
      timeout_limit: '4',
    })
    expect(req.headers['Accept-Language']).toBe('en')
    expect(req.headers.Accept).toBe('application/json')
    expect(req.body).toBeUndefined()
  })

  it('never sends categories, and sends engines only when validated names are given', () => {
    const none = new URL(adapter.buildRequest(makePlan(), ctx).url)
    expect(none.searchParams.has('categories')).toBe(false)
    expect(none.searchParams.has('engines')).toBe(false)
    const some = new URL(
      adapter.buildRequest(
        makePlan({ upstreamEngines: ['brave', 'google cse', 'bad,name', 'x\ny', 'brave'] }),
        ctx,
      ).url,
    )
    expect(some.searchParams.get('engines')).toBe('brave,google cse')
    expect(some.searchParams.has('categories')).toBe(false)
  })

  it('always sends an explicit language', () => {
    expect(
      new URL(adapter.buildRequest(makePlan({ language: '' }), ctx).url).searchParams.get('language'),
    ).toBe('all')
  })

  it('maps sinceDate to the smallest covering time_range bucket', () => {
    const range = (sinceDate: string) =>
      new URL(adapter.buildRequest(makePlan({ sinceDate }), ctx).url).searchParams.get('time_range')
    expect(range('2026-10-30')).toBe('day')
    expect(range('2026-10-29')).toBe('week')
    expect(range('2026-10-24')).toBe('week')
    expect(range('2026-10-22')).toBe('month')
    expect(range('2026-10-01')).toBe('month')
    expect(range('2026-09-01')).toBe('year')
    expect(range('2026-01-15')).toBe('year')
    expect(range('2020-01-01')).toBeNull()
    expect(new URL(adapter.buildRequest(makePlan(), ctx).url).searchParams.has('time_range')).toBe(false)
  })

  it('derives timeout_limit from the client timeout and omits it when too short', () => {
    const limit = (timeoutMs: number) =>
      new URL(adapter.buildRequest(makePlan(), makeCtx({ ...ctx, timeoutMs })).url).searchParams.get(
        'timeout_limit',
      )
    expect(limit(5500)).toBe('4')
    expect(limit(9500)).toBe('8')
    expect(limit(2000)).toBeNull()
  })

  it('encodes hostile queries and tolerates a trailing slash on the endpoint', () => {
    const req = adapter.buildRequest(
      makePlan({ query: 'a&format=csv #x\n!!g' }),
      makeCtx({ ...ctx, endpoint: 'http://h:1/' }),
    )
    const url = new URL(req.url)
    expect(url.pathname).toBe('/search')
    expect(url.searchParams.get('q')).toBe('a&format=csv #x\n!!g')
    expect(url.searchParams.get('format')).toBe('json')
  })
})

describe('searxng adapter: parseResponse with the real fixtures', () => {
  it('parses all 43 results of "react compiler", ranked by score, with via and dates', () => {
    const out = adapter.parseResponse(
      response(200, readFixture('searxng/react-compiler.json')),
      makePlan({ count: 50 }),
      ctx,
    )
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.results).toHaveLength(43)
    expect(out.results.map((r) => r.rank)).toEqual(Array.from({ length: 43 }, (_, i) => i + 1))
    expect(out.upstream).toBeUndefined()

    // Ranked by score descending, stable on ties, independent of the array order.
    const items = fixtureItems('react-compiler')
    const expected = items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => b.it.score - a.it.score || a.i - b.i)
      .map((x) => x.it.url)
    expect(out.results.map((r) => r.url)).toEqual(expected)
    const first = out.results[0]
    expect(first?.url).toBe('https://react.dev/learn/react-compiler')
    expect(first?.via).toEqual(['brave', 'google cse', 'duckduckgo'])
    expect(first?.engine).toBe('searxng')
    expect(first?.title).toBe('React Compiler – React')
    expect(first?.snippet.startsWith('React Compiler Introduction')).toBe(true)

    // The array order is NOT the rank order in this capture.
    expect(items.map((i) => i.url)).not.toEqual(out.results.map((r) => r.url))
  })

  it('parses publishedDate where present, as medium-confidence published dates with tzAssumed', () => {
    const out = adapter.parseResponse(
      response(200, readFixture('searxng/react-compiler.json')),
      makePlan({ count: 50 }),
      ctx,
    )
    if (out.kind !== 'ok') throw new Error('expected ok')
    const withDates = out.results.filter((r) => r.dates.length > 0)
    expect(withDates).toHaveLength(
      fixtureItems('react-compiler').filter((i) => i.publishedDate !== null).length,
    )
    expect(withDates).toHaveLength(16)
    for (const r of withDates) {
      expect(r.dates).toHaveLength(1)
      expect(r.dates[0]).toMatchObject({
        kind: 'published',
        method: 'engine:searxng.publishedDate',
        confidence: 'medium',
        tzAssumed: true,
      })
    }
    const sample = out.results.find((r) => r.dates[0]?.value === '2024-05-15T18:38:33.000Z')
    expect(sample?.via).toEqual(['brave', 'google cse'])
  })

  it('parses the second capture (43 results, 14 dated) and honours plan.count', () => {
    const body = readFixture('searxng/asyncio-taskgroup-year.json')
    const all = adapter.parseResponse(response(200, body), makePlan({ count: 100 }), ctx)
    if (all.kind !== 'ok') throw new Error('expected ok')
    expect(all.results).toHaveLength(43)
    expect(all.results.filter((r) => r.dates.length > 0)).toHaveLength(14)
    expect(all.results[0]?.url).toBe('https://docs.python.org/3/library/asyncio-task.html')

    const few = adapter.parseResponse(response(200, body), makePlan({ count: 10 }), ctx)
    if (few.kind !== 'ok') throw new Error('expected ok')
    expect(few.results).toHaveLength(10)
    expect(few.results.map((r) => r.url)).toEqual(all.results.slice(0, 10).map((r) => r.url))
  })

  it('has no upstream diagnostics in the captures and keeps duplicate URLs for the core to merge', () => {
    const out = adapter.parseResponse(
      response(200, readFixture('searxng/react-compiler.json')),
      makePlan({ count: 50 }),
      ctx,
    )
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(new Set(out.results.map((r) => r.url)).size).toBe(42)
  })
})

describe('searxng adapter: parseResponse errors and edge cases', () => {
  const plan = makePlan({ count: 50 })

  it('maps 403 to json_disabled and 429 to rate_limited with the server hint', () => {
    expect(adapter.parseResponse(response(403, '<html>Forbidden</html>'), plan, ctx)).toMatchObject({
      kind: 'error',
      errorClass: 'json_disabled',
    })
    const limited = adapter.parseResponse(
      response(429, 'Too Many Requests', { 'retry-after': '90' }),
      plan,
      ctx,
    )
    expect(limited).toMatchObject({ kind: 'error', errorClass: 'rate_limited', retryAfterMs: 90_000 })
    const noHint = adapter.parseResponse(response(429, 'Too Many Requests'), plan, ctx)
    expect(noHint).toMatchObject({ kind: 'error', errorClass: 'rate_limited' })
    expect(noHint.kind === 'error' && noHint.retryAfterMs).toBeFalsy()
  })

  it('does not echo the user query when an error page repeats it', () => {
    const q = makePlan({ query: 'my private search words' })
    const out = adapter.parseResponse(response(404, '<h1>Nothing for my private search words</h1>'), q, ctx)
    expect(out.kind === 'error' && out.detail).not.toContain('private search')
    expect(out.kind === 'error' && out.detail).toContain('[query]')
  })

  it('maps other statuses through the shared table', () => {
    expect(adapter.parseResponse(response(500, 'oops'), plan, ctx)).toMatchObject({ errorClass: 'server' })
    expect(adapter.parseResponse(response(302, ''), plan, ctx)).toMatchObject({ errorClass: 'malformed' })
    expect(adapter.parseResponse(response(404, 'nope'), plan, ctx)).toMatchObject({ errorClass: 'bad_request' })
  })

  it('reports non-JSON and shapeless 200s as malformed, never throwing', () => {
    expect(adapter.parseResponse(response(200, '<html><body>login</body></html>'), plan, ctx)).toMatchObject({
      kind: 'error',
      errorClass: 'malformed',
    })
    expect(adapter.parseResponse(response(200, '{"nothing":true}'), plan, ctx)).toMatchObject({
      errorClass: 'malformed',
    })
    expect(adapter.parseResponse(response(200, '[1,2,3]'), plan, ctx)).toMatchObject({
      errorClass: 'malformed',
    })
    expect(adapter.parseResponse(response(200, ''), plan, ctx)).toMatchObject({ errorClass: 'malformed' })
  })

  it('returns empty (not an error) for a genuine zero-result answer', () => {
    expect(
      adapter.parseResponse(
        response(200, JSON.stringify({ results: [], unresponsive_engines: [] })),
        plan,
        ctx,
      ),
    ).toEqual({
      kind: 'empty',
    })
  })

  it('skips broken items and non-http URLs', () => {
    const body = JSON.stringify({
      results: [
        { url: 'javascript:alert(1)', title: 'bad scheme', score: 5 },
        { title: 'no url' },
        'not an object',
        { url: 'https://ok.example/a', title: 'Fine', content: 'text', score: 2, engines: ['brave'] },
        { url: 'https://ok.example/b', title: 12, content: null, score: 'high' },
      ],
    })
    const out = adapter.parseResponse(response(200, body), plan, ctx)
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.results.map((r) => r.url)).toEqual(['https://ok.example/a', 'https://ok.example/b'])
    expect(out.results[1]).toMatchObject({ title: 'https://ok.example/b', snippet: '' })
  })

  it('cleans hostile titles and snippets to plain text', () => {
    const body = JSON.stringify({
      results: [
        {
          url: 'https://x.example/',
          title: 'A‮<b>B</b>\u0000  C &amp; D &#x27;E&#39;',
          content: 'line1\n\n\tline2​',
          score: 1,
        },
      ],
    })
    const out = adapter.parseResponse(response(200, body), plan, ctx)
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.results[0]?.title).toBe("A<b>B</b> C & D 'E'")
    expect(out.results[0]?.snippet).toBe('line1 line2')
  })
})

describe('searxng adapter: unresponsive_engines', () => {
  it('maps SearXNG messages to error classes and detects the Suspended prefix', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://ok.example/a', title: 'T', content: 'c', score: 1, engines: ['brave'] }],
      unresponsive_engines: [
        ['duckduckgo', 'CAPTCHA'],
        ['google', 'Suspended: CAPTCHA'],
        ['brave', 'timeout'],
        ['bing', 'Suspended: too many requests'],
        ['qwant', 'access denied'],
        ['startpage', 'parsing error'],
        ['mojeek', 'HTTP connection error'],
        ['odd', 'something new'],
        [42],
        'junk',
      ],
    })
    const out = adapter.parseResponse(response(200, body), makePlan(), ctx)
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.upstream).toEqual([
      { name: 'duckduckgo', errorClass: 'captcha', message: 'CAPTCHA', suspended: false },
      { name: 'google', errorClass: 'captcha', message: 'CAPTCHA', suspended: true },
      { name: 'brave', errorClass: 'timeout', message: 'timeout', suspended: false },
      { name: 'bing', errorClass: 'rate_limited', message: 'too many requests', suspended: true },
      { name: 'qwant', errorClass: 'forbidden', message: 'access denied', suspended: false },
      { name: 'startpage', errorClass: 'malformed', message: 'parsing error', suspended: false },
      { name: 'mojeek', errorClass: 'unreachable', message: 'HTTP connection error', suspended: false },
      { name: 'odd', errorClass: 'unknown', message: 'something new', suspended: false },
    ])
  })

  it('keeps diagnostics on an empty answer so the core can tell empty from broken', () => {
    const body = JSON.stringify({ results: [], unresponsive_engines: [['duckduckgo', 'CAPTCHA']] })
    const out = adapter.parseResponse(response(200, body), makePlan(), ctx)
    expect(out).toEqual({
      kind: 'empty',
      upstream: [{ name: 'duckduckgo', errorClass: 'captcha', message: 'CAPTCHA', suspended: false }],
    })
  })

  it('classifies the English phrases', () => {
    expect(classifyUpstreamMessage('SSL error: certificate validation has failed')).toBe('unreachable')
    expect(classifyUpstreamMessage('server API error')).toBe('server')
    expect(classifyUpstreamMessage('unexpected crash')).toBe('malformed')
    expect(classifyUpstreamMessage('')).toBe('unknown')
  })
})
