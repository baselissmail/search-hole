// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILTIN_BLOCKED_DOMAINS_CAP } from '../../src/app/index.ts'
import type { BuiltinResult } from '../../src/app/types.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { type MockEngines, startMockEngines } from '../mock-engine/server.ts'
import { fallbackSession, hookSession, mockSettings, RECEIPT_RE, setup, TAVILY_KEY } from './helpers.ts'

let mock: MockEngines
beforeAll(async () => {
  mock = await startMockEngines()
})
afterAll(async () => {
  await mock.close()
})

const RULES = `version: 1
rules:
  - { match: pinterest.com, action: block }
  - { match: "=www.w3schools.com", action: block }
  - { match: example.com, action: block }
  - { match: "=docs.example.com", action: allow }
  - { match: "|https://*.dev/amp/^", action: block }
  - { match: developer.mozilla.org, action: pin }
  - { match: react.dev, action: raise, weight: 3 }
  - { match: geeksforgeeks.org, action: lower, weight: 3 }
`

const RESULTS: BuiltinResult[] = [
  { title: 'Pinterest board', url: 'https://www.pinterest.com/pin/1' },
  { title: 'GFG', url: 'https://www.geeksforgeeks.org/react' },
  { title: 'Example', url: 'https://example.com/x' },
  { title: 'Docs', url: 'https://docs.example.com/guide' },
  { title: 'AMP copy', url: 'https://mirror.dev/amp/?id=1' },
  { title: 'Blog', url: 'https://blog.logrocket.com/react' },
  { title: 'React', url: 'https://react.dev/learn' },
  { title: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web' },
]

describe('built-in WebSearch mode (ADR-0018)', () => {
  it('blocked_domains: domain blocks only (the API covers subdomains), user allows excluded, no patterns', async () => {
    const h = await setup({ rules: RULES })
    const domains = await h.app.builtinBlockedDomains(hookSession(), 'react hooks')
    // `=www.w3schools.com` is exact-host: pushing it would also drop its subdomains, so it is
    // applied after the search instead.
    expect(domains).toEqual(['pinterest.com'])
    expect(BUILTIN_BLOCKED_DOMAINS_CAP).toBe(200)
  })

  it('a regex or pattern allow disables blocked_domains (it could keep any host)', async () => {
    const h = await setup({
      rules: `version: 1
rules:
  - { match: pinterest.com, action: block }
  - { match: "/docs\\\\./", action: allow }
`,
    })
    expect(await h.app.builtinBlockedDomains({}, 'x')).toEqual([])
  })

  it('caps blocked_domains at 200, user tiers first', async () => {
    const many = Array.from(
      { length: 250 },
      (_, i) => `  - { match: spam${i}.example.net, action: block }`,
    ).join('\n')
    const h = await setup({ rules: `version: 1\nrules:\n${many}\n` })
    const domains = await h.app.builtinBlockedDomains({}, 'x')
    expect(domains).toHaveLength(200)
    expect(domains[0]).toBe('spam0.example.net')
  })

  it('filters results: hidden dropped, pins first, then raise/lower; logs URLs and titles for the local log', async () => {
    const h = await setup({ rules: RULES })
    const out = await h.app.filterBuiltinResults('react hooks', RESULTS, {
      ...hookSession(),
      toolUseId: 'toolu_9',
    })
    expect(out.receiptId).toMatch(RECEIPT_RE)
    expect(out.kept.map((r) => r.url)).toEqual([
      'https://developer.mozilla.org/en-US/docs/Web',
      'https://react.dev/learn',
      'https://docs.example.com/guide',
      'https://blog.logrocket.com/react',
      'https://www.geeksforgeeks.org/react',
    ])
    expect(out.hidden.map((r) => [r.url, r.reason, r.rule?.text])).toEqual([
      ['https://www.pinterest.com/pin/1', 'rule', 'block pinterest.com'],
      ['https://example.com/x', 'rule', 'block example.com'],
      ['https://mirror.dev/amp/?id=1', 'rule', 'block |https://*.dev/amp/^'],
    ])
    expect(out.removedPostSearch).toBe(true)
    expect(out.pinned).toBe(1)

    const [entry] = await h.app.log.recent()
    expect(entry).toMatchObject({ mode: 'builtin', kept: 5, hidden: 3, query: 'react hooks', engines: [] })
    const detail = await h.app.log.detail(entry?.searchId ?? 0)
    expect(detail?.results).toHaveLength(8)
    // Built-in results are the user's own session data: the local log keeps URL and title (ADR-0018).
    for (const r of detail?.results ?? []) {
      expect(r.engine).toBe('builtin')
      expect(r.url).toMatch(/^https:\/\//)
    }
    expect(detail?.results[0]?.url).toBe('https://developer.mozilla.org/en-US/docs/Web')
    expect(detail?.results[0]).toMatchObject({ decision: 'pinned', domain: 'mozilla.org', rank: 1 })
    expect(detail?.results.filter((r) => r.decision === 'hidden').map((r) => r.domain)).toEqual([
      'pinterest.com',
      'example.com',
      'mirror.dev',
    ])
    // Titles are kept too, hidden results included, so the user can see what a rule removed.
    const pinterest = detail?.results.find((r) => r.domain === 'pinterest.com')
    expect(pinterest?.title).toContain('Pinterest board')
  })

  it('nothing hidden: removedPostSearch is false', async () => {
    const h = await setup({ rules: RULES })
    const out = await h.app.filterBuiltinResults('x', [{ title: 'a', url: 'https://react.dev/a' }], {})
    expect(out.removedPostSearch).toBe(false)
    expect(out.hidden).toEqual([])
  })

  it('checkUrl refuses blocked URLs with the rule; recordBuiltinFetch adds an opened source', async () => {
    const h = await setup({ rules: RULES })
    expect(await h.app.checkUrl('https://docs.example.com/a', {})).toEqual({ allowed: true })
    const refused = await h.app.checkUrl('https://www.pinterest.com/x', {})
    expect(refused).toMatchObject({ allowed: false, rule: { text: 'block pinterest.com' } })
    expect(refused.allowed === false && refused.message).toMatch(/pinterest\.com is blocked by your rule/)

    const ctx = hookSession('s-fetch')
    await h.app.openTurn(ctx)
    await h.app.recordBuiltinFetch('https://react.dev/learn', ctx)
    const [r] = await h.app.receipt(undefined, ctx)
    expect(r?.sources).toEqual([
      { url: 'https://react.dev/learn', dates: [], sourceType: 'unknown', freshness: 'unknown' },
    ])
  })
})

describe('search mode (ADR-0018)', () => {
  it('auto is builtin until an engine is healthy, then engines', async () => {
    const h = await setup({ settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')) })
    expect(await h.app.searchMode()).toEqual({ configured: 'auto', effective: 'builtin' })
    await h.app.search({ query: 'react compiler', depth: 'quick' }, {})
    expect(await h.app.searchMode()).toEqual({ configured: 'auto', effective: 'engines' })
    // Ten minutes later the health is unknown again.
    h.clock.advance(11 * 60_000)
    expect((await h.app.searchMode()).effective).toBe('builtin')
  })

  it('a bounded probe makes an unknown SearXNG healthy', async () => {
    const h = await setup({ settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')) })
    const status = await h.app.probeEngines(500)
    expect(status.find((s) => s.engine === 'searxng')?.health).toBe('healthy')
    expect(status.find((s) => s.engine === 'tavily')).toMatchObject({
      configured: false,
      inactiveReason: 'missing_key',
    })
    expect((await h.app.searchMode()).effective).toBe('engines')
  })

  it('engines works as engines until every configured engine has failed, then as filtered built-in', async () => {
    const h = await setup({
      settings: mockSettings(mock.endpoint('searxng', 'server_error'), mock.endpoint('tavily')),
    })
    await h.app.settings.setMode('engines')
    expect(await h.app.searchMode()).toEqual({ configured: 'engines', effective: 'engines' })
    await h.app.search({ query: 'react compiler', depth: 'quick' }, {}).catch(() => undefined)
    expect(await h.app.searchMode()).toEqual({ configured: 'engines', effective: 'builtin' })
  })

  it('a running app picks up settings.yaml edits made by another process', async () => {
    const h = await setup({ settings: 'version: 1\n' })
    expect((await h.app.searchMode()).configured).toBe('auto')
    const cli = await h.reopen({ host: 'cli' })
    await cli.settings.setMode('builtin')
    expect((await h.app.searchMode()).configured).toBe('builtin')
    expect(h.app.checkQuery('192.168.1.1 router admin page')).toMatchObject({
      action: 'redact',
      query: 'router admin page',
      classes: ['private_ip'],
    })
    writeFileSync(join(h.home, 'settings.yaml'), 'version: 1\nqueryHygiene: { hosts: block }\n')
    expect(h.app.checkQuery('192.168.1.1 router admin page').action).toBe('block')
  })

  it('SEARCHHOLE_MODE overrides settings; setMode writes hosts.claude-code.mode keeping comments', async () => {
    const h = await setup({ settings: '# my settings\nversion: 1\n' })
    await h.app.settings.setMode('engines')
    expect(await h.app.searchMode()).toEqual({ configured: 'engines', effective: 'engines' })
    const text = readFileSync(join(h.home, 'settings.yaml'), 'utf8')
    expect(text).toContain('# my settings')
    expect(text).toMatch(/claude-code:\s*\n\s*mode: engines/)
    expect((await h.app.settings.get()).hosts).toEqual({ 'claude-code': { mode: 'engines' } })
    const other = await h.reopen({ env: { SEARCHHOLE_MODE: 'builtin' } })
    expect(await other.searchMode()).toEqual({ configured: 'builtin', effective: 'builtin' })
    // The settings file still validates (doctor sees no warning for hosts.*).
    const report = await h.app.doctor()
    expect(report.checks.find((c) => c.id === 'settings')?.status).toBe('ok')
  })
})

describe('turns and receipts (ADR-0005, ADR-0014)', () => {
  const env = { TAVILY_API_KEY: TAVILY_KEY }

  it('closeTurn returns the one-line receipt for a turn that searched', async () => {
    const h = await setup({
      settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')),
      env,
      rules: RULES,
    })
    const ctx = hookSession('turns')
    const { receiptId } = await h.app.openTurn(ctx)
    expect(receiptId).toMatch(RECEIPT_RE)
    const s = await h.app.search({ query: 'react compiler', depth: 'quick' }, ctx)
    expect(s.receiptId).toBe(receiptId)
    const b1 = await h.app.filterBuiltinResults('a', RESULTS, ctx)
    const b2 = await h.app.filterBuiltinResults('b', RESULTS.slice(0, 2), ctx)
    expect([b1.receiptId, b2.receiptId]).toEqual([receiptId, receiptId])
    await h.app.recordBuiltinFetch('https://react.dev/learn', ctx)
    const closed = await h.app.closeTurn(ctx)
    const kept = s.results.length + b1.kept.length + b2.kept.length
    const hidden = s.hidden.length + b1.hidden.length + b2.hidden.length
    expect(closed.receiptId).toBe(receiptId)
    expect(closed.receiptLine).toBe(
      `search-hole · 3 searches (2 built-in) · ${kept} results · ${hidden} hidden · opened 1 · receipt ${receiptId}`,
    )
    // The receipt survives a restart (rebuilt from the log).
    const other = await h.reopen()
    const [r] = await other.receipt([receiptId], {})
    expect(r?.searches.map((x) => x.mode)).toEqual(['engines', 'builtin', 'builtin'])
    expect(r?.closedAt).toBeDefined()
    expect(r?.summaryLine).toMatch(/^3 searches · \d+ results · \d+ hidden · sources: 1 /)
  })

  it('a turn without searches prints nothing; a search after Stop reopens that turn', async () => {
    const h = await setup({ rules: RULES })
    const ctx = hookSession('quiet')
    await h.app.openTurn(ctx)
    expect((await h.app.closeTurn(ctx)).receiptLine).toBeUndefined()
    const t2 = await h.app.openTurn(ctx)
    await h.app.closeTurn(ctx)
    const late = await h.app.filterBuiltinResults('late', RESULTS.slice(0, 1), ctx)
    expect(late.receiptId).toBe(t2.receiptId)
    expect((await h.app.closeTurn(ctx)).receiptLine).toMatch(
      /^search-hole · 1 search \(1 built-in\) · 0 results · 1 hidden · receipt /,
    )
    // A new prompt starts a new receipt.
    const t3 = await h.app.openTurn(ctx)
    expect(t3.receiptId).not.toBe(t2.receiptId)
  })

  it('hooks.receiptLine: false keeps the line off', async () => {
    const h = await setup({ rules: RULES, settings: 'version: 1\nhooks: { receiptLine: false }\n' })
    const ctx = hookSession('off')
    await h.app.openTurn(ctx)
    await h.app.filterBuiltinResults('a', RESULTS, ctx)
    const out = await h.app.closeTurn(ctx)
    expect(out.receiptLine).toBeUndefined()
    expect(out.receiptId).toMatch(RECEIPT_RE)
  })

  it('fallback sessions never auto-join and cannot ask for "the latest" receipt', async () => {
    const h = await setup({ rules: RULES })
    const ctx = fallbackSession()
    const a = await h.app.filterBuiltinResults('a', RESULTS, ctx)
    const b = await h.app.filterBuiltinResults('b', RESULTS, ctx)
    expect(a.receiptId).not.toBe(b.receiptId)
    await expect(h.app.receipt(undefined, ctx)).rejects.toSatisfy(
      (e: unknown) => isSearchHoleError(e) && e.code === 'invalid_argument',
    )
    await expect(h.app.receipt(['rcpt_AAAAAAAAAAAAAAAAAAAAAA'], ctx)).rejects.toSatisfy(
      (e: unknown) => isSearchHoleError(e) && e.code === 'invalid_argument',
    )
  })

  it('meta-keyed sessions share a receipt until 10 idle minutes', async () => {
    const h = await setup({ rules: RULES })
    const ctx = { session: { key: 'vscode-conv', source: 'meta' as const } }
    const a = await h.app.filterBuiltinResults('a', RESULTS, ctx)
    h.clock.advance(5 * 60_000)
    const b = await h.app.filterBuiltinResults('b', RESULTS, ctx)
    h.clock.advance(11 * 60_000)
    const c = await h.app.filterBuiltinResults('c', RESULTS, ctx)
    expect(b.receiptId).toBe(a.receiptId)
    expect(c.receiptId).not.toBe(a.receiptId)
  })
})

describe('built-in reordering uses the engines-mode scoring (ADR-0010)', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    title: `R${i + 1}`,
    url: `https://site${i + 1}.example.org/`,
  }))
  const order = async (rules: string): Promise<string[]> => {
    const h = await setup({ rules: `version: 1\nrules:\n${rules}` })
    const out = await h.app.filterBuiltinResults('q', ten, hookSession())
    return out.kept.map((r) => r.title)
  }

  it('raise 1 nudges (#10 → #7), raise 3 lifts (#10 → #1), lower 3 drops (#1 → #10)', async () => {
    expect(
      (await order('  - { match: site10.example.org, action: raise, weight: 1 }\n')).indexOf('R10'),
    ).toBe(6)
    expect(
      (await order('  - { match: site10.example.org, action: raise, weight: 3 }\n')).indexOf('R10'),
    ).toBe(0)
    expect((await order('  - { match: site1.example.org, action: lower, weight: 3 }\n')).indexOf('R1')).toBe(
      9,
    )
  })
})
