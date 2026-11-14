// SPDX-License-Identifier: Apache-2.0
// ADR-0025 through the App facade: "opened" on logged results, and the review list with its
// rule and dismissal exclusions. Searches and fetches go through the real pipelines.
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { App, BuiltinResult, RequestCtx, ReviewApi } from '../../src/app/types.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { openStore } from '../../src/store/index.ts'
import { startServer, type TestServer, testPolicy } from '../fetch/helpers.ts'
import { type MockEngines, startMockEngines } from '../mock-engine/server.ts'
import { recorded, searchInput } from '../store/helpers.ts'
import { hookSession, mockSettings, setup, TAVILY_KEY } from './helpers.ts'

let page: TestServer
let mock: MockEngines
beforeAll(async () => {
  mock = await startMockEngines()
  page = await startServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/article' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>Notes</title></head><body><p>Some notes.</p></body></html>')
  })
})
afterAll(async () => {
  await page.close()
  await mock.close()
})

const DAY = 86_400_000
const seams = { pageFetcher: { guard: testPolicy(), robots: false as const } }
const hit = (url: string, title = `Title of ${url}`): BuiltinResult => ({ title, url })

function reviewOf(app: App): ReviewApi {
  if (app.review === undefined) throw new Error('createApp always provides review')
  return app.review
}

/** `n` built-in searches that each return every given page. */
async function searches(app: App, n: number, urls: readonly string[], ctx: RequestCtx = hookSession()) {
  for (let i = 0; i < n; i++) {
    await app.filterBuiltinResults(
      `query ${i}`,
      urls.map((u) => hit(u)),
      ctx,
    )
  }
}

describe('opened results in the log (ADR-0025 part A)', () => {
  it('marks what our fetch opened, by requested or final URL, and counts it in the listing', async () => {
    const h = await setup({ seams, host: 'cli' })
    const ctx = hookSession('s-open')
    await h.app.filterBuiltinResults(
      'notes',
      [
        hit(`${page.origin}/article`, 'Reached through a redirect'),
        hit(`${page.origin}/direct?utm_source=feed`, 'Opened directly'),
        hit(`${page.origin}/skipped`, 'Never opened'),
        hit('https://another.example/page', 'Another site'),
      ],
      ctx,
    )
    expect((await h.app.log.detail(1))?.results.map((r) => r.opened)).toEqual([false, false, false, false])
    expect((await h.app.fetch({ url: `${page.origin}/moved` }, ctx)).kind).toBe('page')
    // A later turn of the same session, and a URL that differs only by a tracking parameter.
    await h.app.closeTurn(ctx)
    await h.app.openTurn(ctx)
    expect((await h.app.fetch({ url: `${page.origin}/direct` }, ctx)).kind).toBe('page')
    // Another session opening the third page does not count for this search.
    expect((await h.app.fetch({ url: `${page.origin}/skipped` }, hookSession('s-other'))).kind).toBe('page')

    const detail = await h.app.log.detail(1)
    expect(detail?.results.map((r) => [r.title, r.decision, r.opened])).toEqual([
      ['Reached through a redirect', 'kept', true],
      ['Opened directly', 'kept', true],
      ['Never opened', 'kept', false],
      ['Another site', 'kept', false],
    ])
    expect(detail?.opened).toBe(2)
    expect((await h.app.log.recent()).map((e) => [e.searchId, e.opened])).toEqual([[1, 2]])
    // Dashboard pages and the live tail are sent before anything can be opened: no count there.
    expect((await h.app.dashboard?.page({}))?.items[0]).not.toHaveProperty('opened')
  })

  it('a hidden result is never "opened", and a refused fetch opens nothing', async () => {
    const h = await setup({
      seams,
      host: 'cli',
      rules: 'version: 1\nrules:\n  - { match: blocked.example, action: block }\n',
    })
    const ctx = hookSession('s-hidden')
    await h.app.filterBuiltinResults(
      'pins',
      [hit('https://www.blocked.example/pin/1'), hit(`${page.origin}/a`)],
      ctx,
    )
    expect((await h.app.fetch({ url: 'https://www.blocked.example/pin/1' }, ctx)).kind).toBe('refused')
    // Even a page recorded as opened (WebFetch before the rule existed) leaves the result "hidden".
    await h.app.recordBuiltinFetch('https://www.blocked.example/pin/1', ctx)
    const detail = await h.app.log.detail(1)
    expect(detail?.results.map((r) => [r.decision, r.opened])).toEqual([
      ['kept', false],
      ['hidden', false],
    ])
    expect(detail?.opened).toBe(0)
    expect((await h.app.log.recent())[0]?.opened).toBe(0)
  })

  it('matches an engine search against a page Claude Code opened with WebFetch', async () => {
    const h = await setup({
      settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')),
      env: { TAVILY_API_KEY: TAVILY_KEY },
    })
    const ctx = hookSession('s-engines')
    const out = await h.app.search({ query: 'react compiler' }, ctx)
    const first = out.results[0]?.url ?? ''
    expect(first).toBe('https://react.dev/learn/react-compiler')
    // The same page as WebFetch would be handed it: another scheme, `www.` and a fragment.
    await h.app.recordBuiltinFetch('http://www.react.dev/learn/react-compiler#usage', ctx)
    const detail = await h.app.log.detail(1)
    expect(detail?.results.filter((r) => r.opened).map((r) => r.url)).toEqual([first])
    expect(detail?.opened).toBe(1)
  })

  it('without a session, falls back to the receipt', async () => {
    const h = await setup({ seams, host: 'cli' })
    const first = await h.app.filterBuiltinResults(
      'no session',
      [hit(`${page.origin}/one`), hit(`${page.origin}/two`)],
      {},
    )
    // Same receipt: counts. A fetch that got its own receipt: does not.
    await h.app.fetch({ url: `${page.origin}/one`, receiptId: first.receiptId }, {})
    await h.app.fetch({ url: `${page.origin}/two` }, {})
    expect((await h.app.log.detail(1))?.results.map((r) => r.opened)).toEqual([true, false])
  })
})

describe('the review list (ADR-0025 part B)', () => {
  it('is empty, and creates nothing, before there is a log', async () => {
    const h = await setup({ host: 'cli' })
    expect(await reviewOf(h.app).list()).toEqual({
      days: 30,
      minSearches: 3,
      sites: [],
      total: 0,
      dismissed: [],
    })
    expect(existsSync(join(h.home, 'searchhole.db'))).toBe(false)
  })

  it('lists sites seen in three searches and never opened, with examples, most-seen first', async () => {
    const h = await setup({ host: 'cli' })
    await searches(h.app, 4, [
      'https://www.farm.example/how-to',
      'https://farm.example/list',
      'https://blog.example/post',
    ])
    await searches(h.app, 2, ['https://twice.example/a'])
    h.clock.advance(60_000)
    await searches(h.app, 1, [
      'https://twice.example/a',
      'https://opened.example/x',
      'https://blog.example/post',
    ])
    await searches(h.app, 2, ['https://opened.example/x'])
    await h.app.recordBuiltinFetch('https://opened.example/another-page', hookSession())

    const list = await reviewOf(h.app).list()
    expect(list).toMatchObject({ days: 30, minSearches: 3, total: 3, dismissed: [] })
    expect(list.sites.map((s) => [s.domain, s.searches, s.results])).toEqual([
      ['blog.example', 5, 5],
      ['farm.example', 4, 8],
      ['twice.example', 3, 3],
    ])
    expect(list.sites[0]).toEqual({
      domain: 'blog.example',
      searches: 5,
      results: 5,
      lastSeen: new Date(h.clock.now()).toISOString(),
      sourceType: 'unknown',
      examples: [{ url: 'https://blog.example/post', title: 'Title of https://blog.example/post' }],
    })
    expect(list.sites[1]?.examples.map((e) => e.url)).toEqual([
      'https://farm.example/list',
      'https://www.farm.example/how-to',
    ])
    expect(await reviewOf(h.app).list({ limit: 1 })).toMatchObject({
      total: 3,
      sites: [{ domain: 'blog.example' }],
    })
  })

  it('takes days from 1 to 365 and looks no further back', async () => {
    const h = await setup({ host: 'cli' })
    await searches(h.app, 3, ['https://old.example/a'])
    h.clock.advance(31 * DAY)
    const review = reviewOf(h.app)
    expect((await review.list()).sites).toEqual([])
    expect((await review.list({ days: 45 })).sites.map((s) => s.domain)).toEqual(['old.example'])
    expect((await review.list({ days: 0 })).days).toBe(1)
    expect((await review.list({ days: 100_000 })).days).toBe(365)
    expect((await review.list({ days: Number.NaN })).days).toBe(30)
  })

  it('leaves out a site that a global rule of the user decides (through the rules engine)', async () => {
    const h = await setup({ host: 'cli' })
    const sites = [
      'blocked',
      'allowed',
      'pinned',
      'raised',
      'lowered',
      'normal',
      'expired',
      'pathonly',
      'free',
    ]
    await searches(
      h.app,
      3,
      sites.map((s) => `https://www.${s}.example/page`),
    )
    await searches(h.app, 3, ['https://docs.hostrule.example/guide'])
    const review = reviewOf(h.app)
    expect((await review.list()).total).toBe(sites.length + 1)

    await h.app.rules.add({ match: 'blocked.example', action: 'block' })
    await h.app.rules.add({ match: 'allowed.example', action: 'allow' })
    await h.app.rules.add({ match: 'pinned.example', action: 'pin' })
    await h.app.rules.add({ match: 'raised.example', action: 'raise', weight: 2 })
    await h.app.rules.add({ match: 'lowered.example', action: 'lower', profile: 'coding' })
    await h.app.rules.add({ match: 'normal.example', action: 'normal' })
    // Not decisions about the whole site: a rule that ran out, and one for another path.
    await h.app.rules.add({ match: 'expired.example', action: 'block', until: '2026-01-01' })
    await h.app.rules.add({ match: 'pathonly.example/elsewhere', action: 'block' })
    // An exact-host rule does not match the bare domain, but covers every page we stored.
    await h.app.rules.add({ match: '=docs.hostrule.example', action: 'lower' })
    expect((await review.list()).sites.map((s) => s.domain).sort()).toEqual([
      'expired.example',
      'free.example',
      'pathonly.example',
    ])

    await h.app.rules.remove('blocked.example')
    expect((await review.list()).sites.map((s) => s.domain)).toContain('blocked.example')
  })

  it('ignores project and session rules: only the global rules file decides', async () => {
    const h = await setup({
      host: 'cli',
      projectRules: 'version: 1\nrules:\n  - { match: project.example, action: block }\n',
    })
    await h.app.rules.trust(h.project)
    // Hidden in this project, so it never reaches three kept searches here...
    await searches(h.app, 3, ['https://project.example/a', 'https://seen.example/a'])
    expect((await reviewOf(h.app).list()).sites.map((s) => s.domain)).toEqual(['seen.example'])
    // ...but kept elsewhere, and a project rule is not the user's standing decision.
    await searches(h.app, 3, ['https://project.example/a'], {
      ...hookSession('elsewhere'),
      projectDir: h.home,
    })
    expect((await reviewOf(h.app).list()).sites.map((s) => s.domain)).toEqual([
      'project.example',
      'seen.example',
    ])
  })

  it('dismiss ("this site is fine") hides a site until it is restored; both are idempotent', async () => {
    const h = await setup({ host: 'cli' })
    await searches(h.app, 3, ['https://docs.fine.example/a', 'https://other.example/a'])
    const review = reviewOf(h.app)
    expect(await review.dismiss('https://docs.fine.example/a?x=1')).toEqual({
      domain: 'fine.example',
      changed: true,
    })
    h.clock.advance(1000)
    expect(await review.dismiss(' FINE.example ')).toEqual({ domain: 'fine.example', changed: false })
    expect(await review.dismiss('not-seen-yet.example')).toEqual({
      domain: 'not-seen-yet.example',
      changed: true,
    })
    const list = await review.list()
    expect(list.sites.map((s) => s.domain)).toEqual(['other.example'])
    expect(list.dismissed).toEqual([
      { domain: 'not-seen-yet.example', at: new Date(h.clock.now()).toISOString() },
      { domain: 'fine.example', at: new Date(h.clock.now() - 1000).toISOString() },
    ])
    // Another process (the dashboard, a second CLI call) sees the same dismissals.
    const other = await h.reopen()
    expect((await reviewOf(other).list()).sites.map((s) => s.domain)).toEqual(['other.example'])
    expect(await reviewOf(other).restore('fine.example')).toEqual({ domain: 'fine.example', changed: true })
    expect(await review.restore('fine.example')).toEqual({ domain: 'fine.example', changed: false })
    expect((await review.list()).sites.map((s) => s.domain)).toEqual(['fine.example', 'other.example'])
  })

  it('refuses what is not a site, without echoing it', async () => {
    const h = await setup({ host: 'cli' })
    const review = reviewOf(h.app)
    for (const bad of [
      '',
      '   ',
      'two words',
      'localhost',
      'ftp://example.com/x',
      'sk-secret-typed-by-mistake',
    ]) {
      const err = await review.dismiss(bad).then(
        () => null,
        (e: unknown) => e,
      )
      expect(isSearchHoleError(err) && err.code, bad).toBe('invalid_argument')
      if (isSearchHoleError(err) && bad.trim() !== '') expect(err.toUserText(), bad).not.toContain(bad.trim())
    }
    expect(existsSync(join(h.home, 'searchhole.db'))).toBe(false)
  })

  it('says so when the database cannot be written', async () => {
    const h = await setup({ host: 'cli' })
    // A file where the database should be: the store cannot open.
    writeFileSync(join(h.home, 'searchhole.db'), 'not a database')
    const err = await reviewOf(h.app)
      .dismiss('fine.example')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(isSearchHoleError(err) && err.code).toBe('store_unavailable')
    expect((await reviewOf(h.app).list()).sites).toEqual([])
  })

  it('has no titles or URLs for a site only a decisions-only engine returned', async () => {
    const h = await setup({ host: 'cli' })
    // Written straight to the store, as a search answered by Brave alone would be logged.
    const db = await openStore({ dataDir: h.home, appVersion: '0.1.0', now: h.clock.now })
    for (let i = 0; i < 3; i++) {
      db.recordSearch(
        searchInput({
          results: [
            recorded(
              `https://brave-only.example/${i}`,
              {},
              { engines: ['brave'], positions: { brave: 1 }, sourceType: 'blog' },
            ),
          ],
        }),
      )
    }
    db.close()
    expect((await reviewOf(h.app).list()).sites).toEqual([
      {
        domain: 'brave-only.example',
        searches: 3,
        results: 3,
        lastSeen: new Date(h.clock.now()).toISOString(),
        sourceType: 'blog',
        examples: [],
      },
    ])
  })
})
