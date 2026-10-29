// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { makeCtx, makePlan, NOW, readFixture, response } from '../../test/mock-engine/helpers.ts'
import { createBraveAdapter } from './brave.ts'

const adapter = createBraveAdapter({ now: () => NOW })
const KEY = 'BSAtest-key-0123456789abcdef'
const ctx = makeCtx({ apiKey: KEY })

describe('brave adapter: tables', () => {
  it('declares the ADR-0009 capability and retention tables', () => {
    expect(adapter.id).toBe('brave')
    expect(adapter.retention).toEqual({ log: 'decisions-only', payloadTtlHours: null })
    expect(adapter.capabilities).toMatchObject({
      requiresKey: true,
      endpoint: 'fixed',
      billed: true,
      goggles: true,
      dateFilter: 'range',
      maxPerCall: 20,
      officialApi: true,
    })
    expect(adapter.capabilities.domainExclude).toEqual({ max: 2000 })
    expect(adapter.capabilities.domainInclude).toBeNull()
  })
})

describe('brave adapter: setup', () => {
  it('needs a usable key', () => {
    expect(adapter.setup(makeCtx({ apiKey: null }))).toMatchObject({ active: false, reason: 'missing_key' })
    expect(adapter.setup(makeCtx({ apiKey: '' }))).toMatchObject({ active: false, reason: 'missing_key' })
    const bad = adapter.setup(makeCtx({ apiKey: 'abc\nX-Evil: 1' }))
    expect(bad).toMatchObject({ active: false, reason: 'missing_key' })
    expect(JSON.stringify(bad)).not.toContain('X-Evil')
    expect(adapter.setup(ctx)).toEqual({ active: true })
  })
})

describe('brave adapter: buildRequest', () => {
  it('builds the documented GET request and keeps the key in a header only', () => {
    const req = adapter.buildRequest(
      makePlan({ query: 'react compiler docs', count: 40, safesearch: 2 }),
      ctx,
    )
    expect(req.method).toBe('GET')
    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'react compiler docs',
      count: '20',
      text_decorations: 'false',
      safesearch: 'strict',
      search_lang: 'en',
    })
    expect(req.headers['X-Subscription-Token']).toBe(KEY)
    expect(req.url).not.toContain(KEY)
    expect(req.body).toBeUndefined()
  })

  it('maps safesearch and clamps count to 1..20', () => {
    const param = (overrides: Parameters<typeof makePlan>[0], name: string) =>
      new URL(adapter.buildRequest(makePlan(overrides), ctx).url).searchParams.get(name)
    expect(param({ safesearch: 0 }, 'safesearch')).toBe('off')
    expect(param({ safesearch: 1 }, 'safesearch')).toBe('moderate')
    expect(param({ count: 0 }, 'count')).toBe('1')
    expect(param({ count: 7 }, 'count')).toBe('7')
    expect(param({ language: 'all' }, 'search_lang')).toBeNull()
    expect(param({ language: 'xx-YY' }, 'search_lang')).toBeNull()
  })

  it('sends freshness only as an explicit date range and only when sinceDate is set', () => {
    const fresh = (sinceDate?: string) =>
      new URL(adapter.buildRequest(makePlan(sinceDate ? { sinceDate } : {}), ctx).url).searchParams.get(
        'freshness',
      )
    expect(fresh()).toBeNull()
    expect(fresh('2026-04-30')).toBe('2026-04-30to2026-10-30')
    expect(fresh('2027-01-01')).toBeNull()
    expect(fresh('last week')).toBeNull()
  })

  it('compiles pushdownBlockHosts into an inline goggle, user rules first, hostile hosts dropped', () => {
    const plan = makePlan({
      pushdownBlockHosts: [
        'spam.example',
        'Pinterest.COM',
        'evil.example\n$boost=10,site=react.dev',
        'a,b.example',
        'spam.example',
        'localhost',
      ],
    })
    const url = new URL(adapter.buildRequest(plan, ctx).url)
    expect(url.searchParams.get('goggles')).toBe('$discard,site=spam.example\n$discard,site=pinterest.com')
    expect(adapter.pushedRuleCount(plan)).toBe(2)
    expect(url.searchParams.get('goggles')).not.toContain('$boost')
  })

  it('emits no goggle when there is nothing to push, and never a generic $discard', () => {
    const req = adapter.buildRequest(makePlan(), ctx)
    expect(new URL(req.url).searchParams.has('goggles')).toBe(false)
    expect(adapter.pushedRuleCount(makePlan())).toBe(0)
    const junk = adapter.buildRequest(makePlan({ pushdownBlockHosts: ['', '*', '.'] }), ctx)
    expect(new URL(junk.url).searchParams.has('goggles')).toBe(false)
  })

  it('caps the goggle at 2000 rules and switches to POST when it is large', () => {
    const hosts = Array.from({ length: 2500 }, (_, i) => `blocked-${i}.example.com`)
    const plan = makePlan({ pushdownBlockHosts: hosts })
    const req = adapter.buildRequest(plan, ctx)
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.headers['X-Subscription-Token']).toBe(KEY)
    const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({
      q: 'react compiler',
      count: 20,
      text_decorations: false,
      safesearch: 'moderate',
    })
    expect(String(body.goggles).split('\n')).toHaveLength(2000)
    expect(String(body.goggles).startsWith('$discard,site=blocked-0.example.com')).toBe(true)
    expect(adapter.pushedRuleCount(plan)).toBe(2000)
    expect(req.body).not.toContain(KEY)
  })

  it('limits the query to 400 characters and 50 words', () => {
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const q = new URL(adapter.buildRequest(makePlan({ query: words }), ctx).url).searchParams.get('q') ?? ''
    expect(q.split(' ')).toHaveLength(50)
    const long =
      new URL(adapter.buildRequest(makePlan({ query: 'x'.repeat(900) }), ctx).url).searchParams.get('q') ?? ''
    expect(long).toHaveLength(400)
  })

  it('honours an endpoint override (used by tests and mocks)', () => {
    const req = adapter.buildRequest(
      makePlan(),
      makeCtx({ apiKey: KEY, endpoint: 'http://127.0.0.1:9/brave' }),
    )
    expect(req.url.startsWith('http://127.0.0.1:9/brave/res/v1/web/search?')).toBe(true)
  })
})

describe('brave adapter: parseResponse', () => {
  const plan = makePlan()

  it('parses the standard response with dates, ranks and cleaned text', () => {
    const out = adapter.parseResponse(response(200, readFixture('brave/web-ok.json')), plan, ctx)
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.results).toHaveLength(8)
    expect(out.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(out.results.every((r) => r.engine === 'brave')).toBe(true)
    expect(out.results[0]).toMatchObject({
      url: 'https://react.dev/learn/react-compiler',
      title: 'React Compiler – React',
    })
    expect(out.pushdownApplied).toBeUndefined()
    expect(out.alteredQuery).toBeUndefined()

    // page_age: ISO without a timezone, medium confidence, tz assumed.
    expect(out.results[0]?.dates).toEqual([
      {
        value: '2025-10-07T16:21:03.000Z',
        kind: 'published',
        method: 'engine:brave.page_age',
        confidence: 'medium',
        tzAssumed: true,
      },
    ])
    // article.date comes first, then page_age.
    expect(out.results[2]?.dates.map((d) => d.method)).toEqual([
      'engine:brave.article.date',
      'engine:brave.page_age',
    ])
    expect(out.results[2]?.dates[0]?.tzAssumed).toBe(false)
    // age is ignored: results with only a human-readable age have no dates.
    expect(out.results[3]?.dates).toEqual([])
    expect(out.results[6]?.dates).toEqual([])
    // Entities decoded once.
    expect(out.results[1]?.snippet).toBe(
      "The React Compiler is a build-time only tool that automatically memoizes your React components. It's used in production at Meta & others.",
    )
  })

  it('honours plan.count', () => {
    const out = adapter.parseResponse(
      response(200, readFixture('brave/web-ok.json')),
      makePlan({ count: 3 }),
      ctx,
    )
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.results).toHaveLength(3)
  })

  it('reports whether the goggle was applied, only when one was sent', () => {
    const pushed = makePlan({ pushdownBlockHosts: ['spam-site.example'] })
    const applied = adapter.parseResponse(
      response(200, readFixture('brave/web-goggles-applied.json')),
      pushed,
      ctx,
    )
    expect(applied.kind === 'ok' && applied.pushdownApplied).toBe(true)
    const ignored = adapter.parseResponse(
      response(200, readFixture('brave/web-goggles-ignored.json')),
      pushed,
      ctx,
    )
    expect(ignored.kind === 'ok' && ignored.pushdownApplied).toBe(false)
    const noGoggle = adapter.parseResponse(
      response(200, readFixture('brave/web-goggles-applied.json')),
      plan,
      ctx,
    )
    expect(noGoggle.kind === 'ok' && noGoggle.pushdownApplied).toBeUndefined()
  })

  it('records the spellcheck rewrite in query.altered', () => {
    const out = adapter.parseResponse(
      response(200, readFixture('brave/web-altered.json')),
      makePlan({ query: 'reakt compiler' }),
      ctx,
    )
    expect(out.kind === 'ok' && out.alteredQuery).toBe('react compiler')
    const same = adapter.parseResponse(
      response(200, readFixture('brave/web-altered.json')),
      makePlan({ query: 'React Compiler' }),
      ctx,
    )
    expect(same.kind === 'ok' && same.alteredQuery).toBeUndefined()
  })

  it('returns empty when Brave omits the web section', () => {
    expect(adapter.parseResponse(response(200, readFixture('brave/web-empty.json')), plan, ctx)).toEqual({
      kind: 'empty',
    })
    expect(adapter.parseResponse(response(200, '{"web":{"results":[]}}'), plan, ctx)).toEqual({
      kind: 'empty',
    })
  })

  it('extracts quota information from the comma-separated rate-limit headers', () => {
    const headers = {
      'x-ratelimit-limit': '1, 15000',
      'x-ratelimit-remaining': '1, 14998',
      'x-ratelimit-reset': '1, 1419704',
    }
    const out = adapter.parseResponse(
      response(200, readFixture('brave/web-altered.json'), headers),
      plan,
      ctx,
    )
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.quota).toEqual({
      limit: 15000,
      remaining: 14998,
      resetAt: new Date(NOW + 1_419_704_000).toISOString(),
    })
  })

  it('reports non-JSON and shapeless 200s as malformed', () => {
    expect(adapter.parseResponse(response(200, '<html></html>'), plan, ctx)).toMatchObject({
      kind: 'error',
      errorClass: 'malformed',
    })
    expect(adapter.parseResponse(response(200, '[]'), plan, ctx)).toMatchObject({ errorClass: 'malformed' })
  })

  it('drops results without a usable URL', () => {
    const body = JSON.stringify({
      web: {
        results: [
          { url: 'ftp://x/y', title: 'ftp' },
          { url: 'https://ok.example/', title: 'ok' },
          { title: 'none' },
        ],
      },
    })
    const out = adapter.parseResponse(response(200, body), plan, ctx)
    if (out.kind !== 'ok') throw new Error('expected ok')
    expect(out.results.map((r) => r.url)).toEqual(['https://ok.example/'])
  })
})

describe('brave adapter: error mapping', () => {
  const plan = makePlan()
  const err = (status: number, body: string, headers: Record<string, string> = {}) =>
    adapter.parseResponse(response(status, body, headers), plan, ctx)

  it('maps 401 and the invalid-token code to auth', () => {
    expect(err(401, '')).toMatchObject({ kind: 'error', errorClass: 'auth' })
    expect(err(422, readFixture('brave/error-invalid-token.json'))).toMatchObject({ errorClass: 'auth' })
  })

  it('maps 402 and QUOTA_LIMITED to quota', () => {
    expect(err(402, '{}')).toMatchObject({ errorClass: 'quota' })
    expect(err(429, readFixture('brave/error-quota-limited.json'))).toMatchObject({ errorClass: 'quota' })
  })

  it('maps 429 RATE_LIMITED to rate_limited and reads the exhausted window from the headers', () => {
    const headers = {
      'x-ratelimit-limit': '1, 5000',
      'x-ratelimit-remaining': '0, 4880',
      'x-ratelimit-reset': '1, 1419704',
    }
    const out = err(429, readFixture('brave/error-rate-limited.json'), headers)
    expect(out).toMatchObject({ kind: 'error', errorClass: 'rate_limited', retryAfterMs: 1000 })
    expect(out.kind === 'error' && out.detail).toContain('Brave HTTP 429')
  })

  it('treats a 429 with an exhausted monthly window as quota even without a body code', () => {
    const headers = { 'x-ratelimit-remaining': '1, 0', 'x-ratelimit-reset': '1, 86400' }
    expect(err(429, '{}', headers)).toMatchObject({ errorClass: 'quota', retryAfterMs: 86_400_000 })
  })

  it('maps Retry-After on a bare 429', () => {
    expect(err(429, 'slow down', { 'retry-after': '30' })).toMatchObject({
      errorClass: 'rate_limited',
      retryAfterMs: 30_000,
    })
  })

  it('maps option-not-in-plan to forbidden and 5xx to server', () => {
    expect(err(403, readFixture('brave/error-option-not-in-plan.json'))).toMatchObject({
      errorClass: 'forbidden',
    })
    expect(err(500, 'boom')).toMatchObject({ errorClass: 'server' })
    expect(err(503, '')).toMatchObject({ errorClass: 'server' })
  })

  it('does not echo the user query when an error page repeats it', () => {
    const q = makePlan({ query: 'my private search words' })
    const out = adapter.parseResponse(
      response(404, '<h1>No such page for "my private search words"</h1>'),
      q,
      ctx,
    )
    expect(out.kind === 'error' && out.detail).not.toContain('private search')
  })

  it('never echoes the key in an error detail, even when the server does', () => {
    const body = JSON.stringify({
      error: { code: 'X', detail: `bad token ${KEY} and Bearer abcdefghijklmnop` },
    })
    const out = err(401, body)
    expect(out.kind === 'error' && out.detail).not.toContain(KEY)
    expect(out.kind === 'error' && out.detail).not.toContain('abcdefghijklmnop')
    expect(out.kind === 'error' && out.detail.length).toBeLessThanOrEqual(200)
  })
})
