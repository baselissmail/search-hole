// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isSearchHoleError, type SearchHoleError } from '../../src/shared/errors.ts'
import { MIGRATIONS, type Migration, openStore } from '../../src/store/index.ts'
import { startServer } from '../fetch/helpers.ts'
import { readFixture } from '../mock-engine/helpers.ts'
import { type MockEngines, startMockEngines } from '../mock-engine/server.ts'
import { hookSession, mockSettings, NOW, RECEIPT_RE, setup, TAVILY_KEY } from './helpers.ts'

let mock: MockEngines
beforeAll(async () => {
  mock = await startMockEngines({ slowMs: 50 })
})
afterAll(async () => {
  await mock.close()
})

const env = { TAVILY_API_KEY: TAVILY_KEY }
const settings = () => mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily'))

async function rejects(p: Promise<unknown>): Promise<SearchHoleError> {
  try {
    await p
  } catch (e) {
    if (isSearchHoleError(e)) return e
    throw e
  }
  throw new Error('expected a SearchHoleError')
}

describe('construction is side-effect free (ADR-0006, ADR-0013)', () => {
  it('creates no database, folder or file until a method needs history', async () => {
    const h = await setup({ settings: settings(), env })
    expect(readdirSync(h.home).sort()).toEqual(['project', 'settings.yaml'])
    await h.app.searchMode()
    await h.app.engineStatus()
    expect(existsSync(join(h.home, 'searchhole.db'))).toBe(false)
  })
})

describe('search end to end against the mock engines', () => {
  it('fuses SearXNG and Tavily, logs the search and returns a receipt', async () => {
    const h = await setup({ settings: settings(), env })
    const out = await h.app.search({ query: 'react compiler' }, { ...hookSession(), toolUseId: 'toolu_1' })
    expect(out.receiptId).toMatch(RECEIPT_RE)
    expect(out.depth).toBe('standard')
    expect(out.engines.map((e) => [e.engine, e.status])).toEqual([
      ['searxng', 'ok'],
      ['tavily', 'ok'],
    ])
    expect(out.results.length).toBe(10)
    expect(out.results[0]?.url).toBe('https://react.dev/learn/react-compiler')
    expect(out.results[0]?.engines).toEqual(['searxng', 'tavily'])
    // Per-engine payloads for retention.
    expect(out.results[0]?.hits?.map((x) => x.engine).sort()).toEqual(['searxng', 'tavily'])
    expect(out.sessionId).toBe('session-1')
    expect(out.toolUseId).toBe('toolu_1')
    expect(out.warnings.filter((w) => w.code === 'logging_unavailable')).toEqual([])

    const log = await h.app.log.recent()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      receiptId: out.receiptId,
      query: 'react compiler',
      mode: 'engines',
      engines: ['searxng', 'tavily'],
      kept: 10,
      depth: 'standard',
    })
    const detail = await h.app.log.detail(log[0]?.searchId ?? 0)
    expect(detail?.results[0]).toMatchObject({
      rank: 1,
      decision: 'kept',
      domain: 'react.dev',
      url: 'https://react.dev/learn/react-compiler',
    })
    // The query hit the engines with the SearXNG request shape (explicit language, engines unset).
    const sx = mock.requests.filter((r) => r.engine === 'searxng' && r.path === '/search').at(-1)
    expect(sx?.query).toMatchObject({ q: 'react compiler', format: 'json', language: 'all' })
  })

  it('hides blocked results, pins first, pushes safe blocks to Tavily and records them', async () => {
    const rules = `version: 1
rules:
  - { match: reddit.com, action: block }
  - { match: nextjs.org, action: pin }
  - { match: onecompiler.com, action: lower, weight: 5 }
`
    const h = await setup({ settings: settings(), env, rules })
    const before = mock.requests.length
    const out = await h.app.search({ query: 'react compiler', depth: 'deep' }, {})
    expect(out.results[0]?.registrableDomain).toBe('nextjs.org')
    expect(out.results[0]?.flags).toContain('pinned')
    expect(out.results.some((r) => r.registrableDomain === 'reddit.com')).toBe(false)
    const hiddenReddit = out.hidden.filter((r) => r.registrableDomain === 'reddit.com')
    expect(hiddenReddit.length).toBeGreaterThan(0)
    expect(hiddenReddit[0]?.hiddenReason).toBe('rule')
    expect(hiddenReddit[0]?.decision.visibilityRule?.text).toBe('block reddit.com')
    expect(out.hiddenSummary.byReason.rule).toBe(hiddenReddit.length)
    // Pushdown (ADR-0009 point 8): Tavily got the block; SearXNG (pushdown off) did not.
    const tavily = mock.requests.slice(before).find((r) => r.engine === 'tavily')
    expect(JSON.parse(tavily?.body ?? '{}').exclude_domains).toEqual(['reddit.com'])
    expect(out.pushedRuleIds).toHaveLength(1)
    // The log keeps the hidden rows with their rule.
    const [entry] = await h.app.log.recent({ hiddenOnly: true })
    const detail = await h.app.log.detail(entry?.searchId ?? 0)
    const hiddenRow = detail?.results.find((r) => r.decision === 'hidden')
    expect(hiddenRow).toMatchObject({
      reason: 'rule',
      domain: 'reddit.com',
      rule: { text: 'block reddit.com', tier: 'T3' },
    })
    expect(detail?.results.find((r) => r.decision === 'pinned')?.domain).toBe('nextjs.org')
  })

  it('does not push a block that an allow could overlap', async () => {
    const rules = `version: 1
rules:
  - { match: github.com, action: block }
  - { match: "=docs.github.com", action: allow }
`
    const h = await setup({ settings: settings(), env, rules })
    const before = mock.requests.length
    await h.app.search({ query: 'react compiler' }, {})
    const tavily = mock.requests.slice(before).find((r) => r.engine === 'tavily')
    expect(JSON.parse(tavily?.body ?? '{}').exclude_domains).toBeUndefined()
  })

  it('a model maxAgeDays only tightens the profile freshness', async () => {
    const rules = `version: 1
profiles:
  coding:
    match: { keywords: [react] }
    freshness: { maxAgeDays: 400 }
`
    const h = await setup({ settings: settings(), env, rules })
    const loose = await h.app.search({ query: 'react compiler', maxAgeDays: 5000 }, {})
    const tight = await h.app.search({ query: 'react compiler', maxAgeDays: 30 }, {})
    expect(loose.profile).toBe('coding')
    expect(tight.hiddenSummary.byReason.stale ?? 0).toBeGreaterThan(loose.hiddenSummary.byReason.stale ?? 0)
    // 400 days from 2026-10-30: the 2024 reddit post is stale in both.
    expect(loose.hidden.some((r) => r.hiddenReason === 'stale')).toBe(true)
  })

  it('falls back to Tavily when SearXNG is rate-limited (quick depth)', async () => {
    const h = await setup({
      settings: mockSettings(mock.endpoint('searxng', 'rate_limited'), mock.endpoint('tavily')),
      env,
    })
    const out = await h.app.search({ query: 'react compiler', depth: 'quick' }, {})
    expect(out.fallbackTrail).toEqual([{ from: 'searxng', to: 'tavily', errorClass: 'rate_limited' }])
    expect(out.warnings).toContainEqual({ code: 'engine_fallback', from: 'searxng', to: 'tavily' })
    expect(out.results.every((r) => r.engines.includes('tavily'))).toBe(true)
    // SearXNG is now suspended in the shared health table: the next search skips it.
    const status = await h.app.engineStatus()
    expect(status.find((s) => s.engine === 'searxng')).toMatchObject({
      health: 'unhealthy',
      inactiveReason: 'suspended',
    })
    const next = await h.app.search({ query: 'react compiler', depth: 'quick' }, {})
    expect(next.engines[0]?.engine).toBe('tavily')
  })

  it('blocks a query that contains a secret, naming the class and never echoing it', async () => {
    const h = await setup({ settings: settings(), env })
    const before = mock.requests.length
    const secret = 'ghp_8fK2mQ9xLr4TzW7vN1bYc6Hd3Sj5Pa0EuGiR'
    const e = await rejects(h.app.search({ query: `why does ${secret} fail` }, {}))
    expect(e.code).toBe('query_blocked')
    expect(e.why).toMatch(/API key/)
    expect(e.toUserText()).not.toContain(secret)
    expect(mock.requests.length).toBe(before)
    expect(h.app.checkQuery(`token ${secret}`)).toMatchObject({ action: 'block', classes: ['api_key'] })
  })

  it('redacts instead of blocking when queryHygiene.mode is redact', async () => {
    const h = await setup({
      settings: mockSettings(
        mock.endpoint('searxng'),
        mock.endpoint('tavily'),
        'queryHygiene: { mode: redact }\n',
      ),
      env,
    })
    const out = await h.app.search({ query: 'AKIAZ7Q3K5M2N8P4R6T1 rejected', depth: 'quick' }, {})
    expect(out.query).toBe('[redacted] rejected')
    const sx = mock.requests.filter((r) => r.engine === 'searxng').at(-1)
    expect(sx?.query.q).toBe('[redacted] rejected')
    expect(out.warnings).toContainEqual({ code: 'query_redacted', classes: ['api_key'] })
  })

  it('by default a private address is cut out of the query, and the model is told', async () => {
    const h = await setup({ settings: settings(), env })
    const out = await h.app.search({ query: '192.168.1.1 router admin page', depth: 'quick' }, {})
    expect(out.query).toBe('router admin page')
    const sx = mock.requests.filter((r) => r.engine === 'searxng').at(-1)
    expect(sx?.query.q).toBe('router admin page')
    expect(out.warnings[0]).toEqual({ code: 'query_redacted', classes: ['private_ip'] })
  })

  it('throws no_healthy_engine naming every engine when nothing can answer', async () => {
    const h = await setup({
      settings: `version: 1
engines:
  searxng: { url: "http://127.0.0.1:9" }
  brave: { enabled: false }
`,
    })
    const e = await rejects(h.app.search({ query: 'react compiler' }, {}))
    expect(e.code).toBe('no_healthy_engine')
    expect(e.why).toMatch(/searxng: not reachable/)
    expect(e.why).toMatch(/tavily: no API key/)
    expect(e.fix).toBe('run `searchhole doctor`')
  })

  it('throws no_healthy_engine before calling anything when no engine is configured', async () => {
    const h = await setup({ settings: 'version: 1\nengines:\n  searxng: { enabled: false }\n' })
    const e = await rejects(h.app.search({ query: 'react compiler' }, {}))
    expect(e.code).toBe('no_healthy_engine')
    expect(e.why).toBe('No healthy engine (searxng: disabled; brave: no API key; tavily: no API key).')
  })

  it('rejects bad arguments and unconfigured engines', async () => {
    const h = await setup({ settings: settings(), env })
    expect((await rejects(h.app.search({ query: '' }, {}))).code).toBe('invalid_argument')
    expect((await rejects(h.app.search({ query: 'x', engines: ['brave'] }, {}))).code).toBe(
      'invalid_argument',
    )
    expect((await rejects(h.app.search({ query: 'x', profile: 'nope' }, {}))).code).toBe('invalid_argument')
  })

  it('an unknown receiptId is not an error: new receipt plus receipt_expired', async () => {
    const h = await setup({ settings: settings(), env })
    const out = await h.app.search({ query: 'react compiler', depth: 'quick', receiptId: 'rcpt_gone' }, {})
    expect(out.warnings).toContainEqual({ code: 'receipt_expired', previous: 'rcpt_gone' })
    const joined = await h.app.search(
      { query: 'react compiler', depth: 'quick', receiptId: out.receiptId },
      {},
    )
    expect(joined.receiptId).toBe(out.receiptId)
    const [r] = await h.app.receipt([out.receiptId], {})
    expect(r?.searches).toHaveLength(2)
  })

  it('stores a key fingerprint, never the key, with the health row', async () => {
    const h = await setup({ settings: settings(), env })
    await h.app.search({ query: 'react compiler' }, {})
    const store = await openStore({ dataDir: h.home, appVersion: '0.1.0', now: () => NOW })
    try {
      const rows = store.engineHealth.list('tavily')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.keyFp).toMatch(/^[0-9a-f]{16}$/)
      expect(rows[0]?.state).toBe('healthy')
      expect(JSON.stringify(rows)).not.toContain(TAVILY_KEY)
      expect(store.engineHealth.list('searxng')[0]?.keyFp).toBe('')
    } finally {
      store.close()
    }
  })
})

describe('store modes', () => {
  /** A writer-breaking migration from a newer binary. */
  const NEWER: Migration = {
    id: MIGRATIONS.length + 1,
    name: '9999_from_the_future',
    introducedIn: '0.4.0',
    minWriterVersion: '0.3.0',
    minReaderVersion: '0.0.0',
    sql: 'CREATE TABLE future_probe (id INTEGER PRIMARY KEY);',
  }

  it('a read-only store (newer data) still searches, with logging_unavailable', async () => {
    const h = await setup({ settings: settings(), env })
    const newer = await openStore({
      dataDir: h.home,
      appVersion: '0.4.0',
      now: () => NOW,
      migrations: [...MIGRATIONS, NEWER],
    })
    newer.close()
    const out = await h.app.search({ query: 'react compiler', depth: 'quick' }, hookSession())
    expect(out.results.length).toBeGreaterThan(0)
    const w = out.warnings.find((x) => x.code === 'logging_unavailable')
    expect(w).toBeDefined()
    expect(w?.code === 'logging_unavailable' && w.detail).toMatch(/older than your data/)
    expect(await h.app.log.recent()).toEqual([])
    // The receipt still works from process memory.
    const [r] = await h.app.receipt(undefined, hookSession())
    expect(r?.searches).toHaveLength(1)
    expect(r?.warnings.join(' ')).toMatch(/older than your data/)
  })

  it('an unavailable store still searches, with logging_unavailable', async () => {
    const h = await setup({ settings: settings(), env })
    mkdirSync(join(h.home, 'searchhole.db'))
    const out = await h.app.search({ query: 'react compiler', depth: 'quick' }, {})
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.warnings.some((x) => x.code === 'logging_unavailable')).toBe(true)
  })
})

describe('per-engine concurrency (ADR-0009)', () => {
  it('keeps at most 4 SearXNG requests in flight per process', async () => {
    const body = readFixture('searxng/react-compiler.json')
    const slow = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
      }, 40)
    })
    try {
      const h = await setup({
        settings: `version: 1\nengines:\n  searxng: { url: "${slow.origin}" }\n  brave: { enabled: false }\n`,
      })
      const outs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          h.app.search({ query: `react compiler ${i}`, depth: 'quick' }, {}),
        ),
      )
      expect(outs.every((o) => o.results.length > 0)).toBe(true)
      expect(slow.stats.maxInFlight).toBeLessThanOrEqual(4)
      expect(slow.seen).toHaveLength(10)
    } finally {
      await slow.close()
    }
  })
})
