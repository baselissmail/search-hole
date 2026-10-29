// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { makeCtx, makePlan, NOW, readFixture, response } from '../../test/mock-engine/helpers.ts'
import { createTavilyAdapter } from './tavily.ts'

const adapter = createTavilyAdapter({ now: () => NOW })
const KEY = 'tvly-test-key-0123456789abcdef'
const ctx = makeCtx({ apiKey: KEY })

function bodyOf(plan: Parameters<typeof makePlan>[0]): Record<string, unknown> {
  return JSON.parse(adapter.buildRequest(makePlan(plan), ctx).body ?? '{}') as Record<string, unknown>
}

describe('tavily adapter: tables', () => {
  it('declares the ADR-0009 capability and retention tables', () => {
    expect(adapter.id).toBe('tavily')
    expect(adapter.retention).toEqual({ log: 'full', payloadTtlHours: null })
    expect(adapter.capabilities).toMatchObject({
      requiresKey: true,
      endpoint: 'fixed',
      billed: true,
      goggles: false,
      dateFilter: 'range',
      maxPerCall: 20,
    })
    expect(adapter.capabilities.domainInclude).toEqual({ max: 300 })
    expect(adapter.capabilities.domainExclude).toEqual({ max: 150 })
  })
})

describe('tavily adapter: setup', () => {
  it('needs a usable key', () => {
    expect(adapter.setup(makeCtx({ apiKey: null }))).toMatchObject({ active: false, reason: 'missing_key' })
    expect(adapter.setup(makeCtx({ apiKey: 'tvly-abc def' }))).toMatchObject({
      active: false,
      reason: 'missing_key',
    })
    expect(adapter.setup(ctx)).toEqual({ active: true })
  })
})

describe('tavily adapter: buildRequest', () => {
  it('posts JSON with a Bearer key and always asks for published dates', () => {
    const req = adapter.buildRequest(makePlan({ query: 'react compiler', count: 12 }), ctx)
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://api.tavily.com/search')
    expect(req.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.url).not.toContain(KEY)
    expect(req.body).not.toContain(KEY)
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      query: 'react compiler',
      max_results: 12,
      search_depth: 'basic',
      include_published_date: true,
    })
  })

  it('uses advanced search only at deep depth and caps max_results at 20', () => {
    expect(bodyOf({ depth: 'quick' }).search_depth).toBe('basic')
    expect(bodyOf({ depth: 'standard' }).search_depth).toBe('basic')
    expect(bodyOf({ depth: 'deep', count: 99 })).toMatchObject({ search_depth: 'advanced', max_results: 20 })
    expect(bodyOf({ count: 0 }).max_results).toBe(1)
  })

  it('sends exclude_domains from query excludes and pushdown hosts (cap 150) and include_domains (cap 300)', () => {
    const body = bodyOf({
      excludeDomains: ['Pinterest.com'],
      pushdownBlockHosts: ['spam.example', 'pinterest.com', 'bad host.example', 'x.example\n'],
      includeDomains: ['react.dev', 'github.com'],
    })
    expect(body.exclude_domains).toEqual(['pinterest.com', 'spam.example', 'x.example'])
    expect(body.include_domains).toEqual(['react.dev', 'github.com'])

    const many = Array.from({ length: 400 }, (_, i) => `h${i}.example.com`)
    const capped = bodyOf({ pushdownBlockHosts: many, includeDomains: many })
    expect(capped.exclude_domains).toHaveLength(150)
    expect(capped.include_domains).toHaveLength(300)
    expect('exclude_domains' in bodyOf({})).toBe(false)
    expect('include_domains' in bodyOf({})).toBe(false)
  })

  it('counts only pushdown hosts as pushed rules', () => {
    const plan = makePlan({ excludeDomains: ['a.example'], pushdownBlockHosts: ['b.example', 'c.example'] })
    expect(adapter.pushedRuleCount(plan)).toBe(2)
    expect(adapter.pushedRuleCount(makePlan())).toBe(0)
  })

  it('carries sinceDate as start_date', () => {
    expect(bodyOf({ sinceDate: '2026-04-30' }).start_date).toBe('2026-04-30')
    expect('start_date' in bodyOf({})).toBe(false)
    expect('start_date' in bodyOf({ sinceDate: 'last week' })).toBe(false)
  })

  it('honours an endpoint override', () => {
    const req = adapter.buildRequest(
      makePlan(),
      makeCtx({ apiKey: KEY, endpoint: 'http://127.0.0.1:9/tavily/' }),
    )
    expect(req.url).toBe('http://127.0.0.1:9/tavily/search')
  })
})

describe('tavily adapter: parseResponse', () => {
  const plan = makePlan()

  it('parses results, keeps Tavily order, and reads published_date in several forms', () => {
    const out = adapter.parseResponse(response(200, readFixture('tavily/search-ok.json')), plan, ctx)
    if (out.kind !== 'ok') throw new Error('expected ok')
    // The javascript: result is dropped.
    expect(out.results.map((r) => r.url)).toEqual([
      'https://react.dev/learn/react-compiler',
      'https://react.dev/blog/2025/10/07/react-compiler-1',
      'https://github.com/facebook/react/tree/main/compiler',
      'https://www.npmjs.com/package/babel-plugin-react-compiler',
      'https://stackoverflow.com/questions/78901234/react-compiler-is-it-worth-it',
    ])
    expect(out.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5])
    expect(out.results.every((r) => r.engine === 'tavily')).toBe(true)
    expect(out.results[0]?.title).toBe('React Compiler – React')

    // RFC 2822 with GMT: not assumed; ISO with Z: not assumed; ISO without tz: assumed.
    expect(out.results[0]?.dates).toEqual([
      {
        value: '2025-10-07T16:21:03.000Z',
        kind: 'published',
        method: 'engine:tavily.published_date',
        confidence: 'medium',
        tzAssumed: false,
      },
    ])
    expect(out.results[1]?.dates[0]).toMatchObject({ value: '2025-10-07T00:00:00.000Z', tzAssumed: false })
    expect(out.results[3]?.dates[0]).toMatchObject({ value: '2026-08-19T20:41:12.000Z', tzAssumed: true })
    // Without published_date, and with an unparseable one: no dates, still a result.
    expect(out.results[2]?.dates).toEqual([])
    expect(out.results[4]?.dates).toEqual([])
  })

  it('honours plan.count and returns empty for no results', () => {
    const few = adapter.parseResponse(
      response(200, readFixture('tavily/search-ok.json')),
      makePlan({ count: 2 }),
      ctx,
    )
    expect(few.kind === 'ok' && few.results).toHaveLength(2)
    expect(adapter.parseResponse(response(200, readFixture('tavily/search-empty.json')), plan, ctx)).toEqual({
      kind: 'empty',
    })
  })

  it('reports non-JSON and shapeless 200s as malformed', () => {
    expect(adapter.parseResponse(response(200, 'oops'), plan, ctx)).toMatchObject({
      kind: 'error',
      errorClass: 'malformed',
    })
    expect(adapter.parseResponse(response(200, '{"results":"nope"}'), plan, ctx)).toMatchObject({
      errorClass: 'malformed',
    })
  })

  it('maps error statuses', () => {
    const err = (status: number, body: string, headers: Record<string, string> = {}) =>
      adapter.parseResponse(response(status, body, headers), plan, ctx)
    expect(err(401, readFixture('tavily/error-unauthorized.json'))).toMatchObject({ errorClass: 'auth' })
    expect(err(429, readFixture('tavily/error-rate-limit.json'))).toMatchObject({
      errorClass: 'rate_limited',
    })
    expect(err(429, readFixture('tavily/error-rate-limit.json'), { 'retry-after': '20' })).toMatchObject({
      errorClass: 'rate_limited',
      retryAfterMs: 20_000,
    })
    expect(err(432, readFixture('tavily/error-plan-limit.json'))).toMatchObject({ errorClass: 'quota' })
    expect(err(433, '{}')).toMatchObject({ errorClass: 'quota' })
    expect(err(402, '{}')).toMatchObject({ errorClass: 'quota' })
    expect(err(400, readFixture('tavily/error-bad-request.json'))).toMatchObject({ errorClass: 'malformed' })
    expect(err(500, '')).toMatchObject({ errorClass: 'server' })
    const detail = err(400, readFixture('tavily/error-bad-request.json'))
    expect(detail.kind === 'error' && detail.detail).toContain('Query is too long')
  })

  it('does not echo the user query when an error repeats it', () => {
    const q = makePlan({ query: 'my private search words' })
    const body = JSON.stringify({ detail: { error: 'Bad query: my private search words' } })
    const out = adapter.parseResponse(response(400, body), q, ctx)
    expect(out.kind === 'error' && out.detail).not.toContain('private search')
  })

  it('never echoes the key in an error detail', () => {
    const body = JSON.stringify({ detail: { error: `Invalid key ${KEY}` } })
    const out = adapter.parseResponse(response(401, body), plan, ctx)
    expect(out.kind === 'error' && out.detail).not.toContain(KEY)
  })
})
