// SPDX-License-Identifier: Apache-2.0
// Lists end to end (ADR-0008 "Lists", ADR-0017 point 7, ADR-0022): the starter set offline,
// artifacts, subscriptions with their guards, modes in rules.yaml, imports, background refresh.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { App, AppSeams, ListStatus } from '../../src/app/types.ts'
import { createListFetcher, type ListFetcher } from '../../src/fetch/list.ts'
import { renderSearchText, searchStructured } from '../../src/gateway/render.ts'
import { decodeArtifact } from '../../src/lists/artifact.ts'
import { stripVendorHeader, VENDORED_LISTS } from '../../src/lists/catalog.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { openStore } from '../../src/store/index.ts'
import { startServer, type TestServer, testPolicy } from '../fetch/helpers.ts'
import { type MockEngines, startMockEngines } from '../mock-engine/server.ts'
import { hookSession, mockSettings, NOW, onCleanup, setup, TAVILY_KEY } from './helpers.ts'

const REPO = join(import.meta.dirname, '..', '..', '..', '..')
const PINTEREST = { title: 'Pin', url: 'https://www.pinterest.com/pin/1/' }
const AI_SITE = { title: 'AI', url: 'https://www.perplexity.ai/search' }
const PLAIN = { title: 'Docs', url: 'https://developer.mozilla.org/en-US/' }

const domains = (n: number): string => Array.from({ length: n }, (_, i) => `d${i}.spam.example`).join('\n')

/** A list server: `lists.test` paths, and the catalog's raw.githubusercontent.com URLs. */
interface ListServer {
  server: TestServer
  /** Path → body; ETag is a hash of the body. */
  files: Map<string, string>
  seams: AppSeams
}

async function listServer(): Promise<ListServer> {
  const files = new Map<string, string>()
  const server = await startServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const body = files.get(path)
    if (body === undefined) {
      res.writeHead(404)
      res.end('nope')
      return
    }
    const etag = `"${Buffer.from(body).toString('base64url').slice(-12)}-${body.length}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', etag })
    res.end(body)
  })
  onCleanup(() => server.close())
  const real = createListFetcher({ guard: testPolicy() })
  onCleanup(() => real.close())
  const fetcher: ListFetcher = {
    fetch: (r) =>
      real.fetch({
        ...r,
        url: r.url
          .replace('https://lists.test', server.origin)
          .replace('https://raw.githubusercontent.com', server.origin),
      }),
    close: async () => undefined,
  }
  return { server, files, seams: { listFetcher: fetcher, listRefreshDelayMs: 0 } }
}

const byId = (lists: readonly ListStatus[], id: string): ListStatus => {
  const s = lists.find((l) => l.id === id)
  if (s === undefined) throw new Error(`no list ${id}`)
  return s
}

async function rejection(p: Promise<unknown>): Promise<{ code: string; why: string; fix?: string }> {
  try {
    await p
  } catch (e) {
    if (isSearchHoleError(e))
      return { code: e.code, why: e.why, ...(e.fix === undefined ? {} : { fix: e.fix }) }
    throw e
  }
  throw new Error('expected an error')
}

const blocked = async (app: App, url: string): Promise<boolean> => !(await app.checkUrl(url, {})).allowed

describe('the starter set (ADR-0017 point 7)', () => {
  it('is on by default with its recommended modes and works offline from the shipped copies', async () => {
    const h = await setup()
    const lists = await h.app.lists?.list()
    if (lists === undefined) throw new Error('no list API')
    expect(lists.map((l) => `${l.id}:${l.source}:${l.mode}:${l.copy}`)).toEqual([
      'official-docs:bundled:enforce:built-in',
      'official-health:bundled:enforce:built-in',
      'github-clones:bundled:enforce:built-in',
      'ai-content-farms:bundled:audit:built-in',
      'quenhus-dev-filter:vendored:enforce:shipped',
      'arosh-stackoverflow-translation:vendored:enforce:shipped',
      'arosh-github-translation:vendored:enforce:shipped',
      'rjaus-pinterest:vendored:enforce:shipped',
      'laylavish-huge-ai:vendored:audit:shipped',
    ])
    const rjaus = byId(lists, 'rjaus-pinterest')
    expect(rjaus).toMatchObject({
      ruleCount: 50,
      license: 'CC0-1.0',
      lastUpdate: '2026-10-31',
      lastError: null,
    })
    expect(rjaus.nextUpdate).toBe('2026-11-07T00:00:00.000Z')
    expect(byId(lists, 'laylavish-huge-ai').ruleCount).toBeGreaterThan(1500)

    const out = await h.app.filterBuiltinResults('q', [PINTEREST, AI_SITE, PLAIN], hookSession())
    expect(out.hidden.map((x) => [x.url, x.reason, x.rule?.listId])).toEqual([
      [PINTEREST.url, 'list', 'rjaus-pinterest'],
    ])
    // Audit: the AI site stays, and the log counts what the list would have hidden.
    expect(out.kept.map((x) => x.url).sort()).toEqual([PLAIN.url, AI_SITE.url].sort())
    const after = (await h.app.lists?.list()) ?? []
    expect(byId(after, 'rjaus-pinterest').contribution).toEqual({ hidden7d: 1, wouldHide7d: 0 })
    expect(byId(after, 'laylavish-huge-ai').contribution).toEqual({ hidden7d: 0, wouldHide7d: 1 })
  })

  it('caches compiled artifacts and rebuilds a corrupt one instead of failing', async () => {
    const h = await setup()
    await h.app.filterBuiltinResults('q', [PINTEREST], hookSession())
    // The data folder exists now, so the next load writes the artifacts.
    const again = await h.reopen()
    await again.filterBuiltinResults('q', [PINTEREST], hookSession())
    const file = join(h.home, 'lists', 'rjaus-pinterest', 'compiled-1.json')
    expect(existsSync(file)).toBe(true)
    expect(decodeArtifact(readFileSync(file, 'utf8'), { listId: 'rjaus-pinterest' }).ok).toBe(true)
    writeFileSync(file, '{"magic":"searchhole-list-artifact"}\nnot json')
    const third = await h.reopen()
    const out = await third.filterBuiltinResults('q', [PINTEREST], hookSession())
    expect(out.hidden).toHaveLength(1)
    expect(decodeArtifact(readFileSync(file, 'utf8'), { listId: 'rjaus-pinterest' }).ok).toBe(true)
  })
})

describe('doctor (ADR-0022)', () => {
  it('summarises the lists and says when a shipped copy has gone stale offline', async () => {
    const h = await setup({ host: 'cli' })
    const fresh = await h.app.doctor()
    expect(fresh.checks.find((c) => c.id === 'lists')).toMatchObject({ status: 'ok' })
    expect(fresh.checks.find((c) => c.id === 'lists')?.title).toMatch(
      /^Lists: 7 enforced, 2 audit, 0 off · [\d,]+ rules$/,
    )
    h.clock.set(Date.parse('2027-01-15T00:00:00Z'))
    const later = await h.app.doctor()
    const stale = later.checks.find((c) => c.id === 'lists:rjaus-pinterest:stale')
    expect(stale).toMatchObject({ status: 'info' })
    expect(stale?.fix).toContain('searchhole lists update rjaus-pinterest')
  })
})

describe('audit lists never change the visible output (ADR-0008 property, end to end)', () => {
  let mock: MockEngines
  beforeAll(async () => {
    mock = await startMockEngines({ slowMs: 50 })
  })
  afterAll(async () => {
    await mock.close()
  })

  it('built-in results: the same kept and hidden results with the audit list on or off', async () => {
    const h = await setup()
    const results = [AI_SITE, PINTEREST, PLAIN, { title: 'AI 2', url: 'https://otter.ai/' }]
    const on = await h.app.filterBuiltinResults('q', results, hookSession())
    await h.app.lists?.setMode('laylavish-huge-ai', 'disabled')
    const off = await h.app.filterBuiltinResults('q', results, hookSession())
    expect(on.kept).toEqual(off.kept)
    expect(on.hidden).toEqual(off.hidden)
  })

  it('engine search: same results, order and hidden set; the model never sees the audit verdict', async () => {
    const h = await setup({
      settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')),
      env: { TAVILY_API_KEY: TAVILY_KEY },
      host: 'cli',
    })
    const file = join(h.home, 'audit-me.txt')
    writeFileSync(file, 'onecompiler.com\nnpmjs.com\n')
    await h.app.lists?.import(file, { name: 'audit-me', kind: 'content-farm', mode: 'audit' })
    const on = await h.app.search({ query: 'react compiler' }, {})
    expect(on.results.some((r) => r.flags.includes('would_hide'))).toBe(true)
    await h.app.lists?.setMode('audit-me', 'disabled')
    const off = await h.app.search({ query: 'react compiler' }, {})
    const view = (o: typeof on) => ({
      results: o.results.map((r) => [r.url, r.sourceType, r.adjusted]),
      hidden: o.hidden.map((r) => r.url),
    })
    expect(view(on)).toEqual(view(off))
    expect(renderSearchText(on).text).not.toMatch(/audit|would hide/i)
    expect(searchStructured(on).results.flatMap((r) => r.flags)).not.toContain('would_hide')
    const lists = (await h.app.lists?.list()) ?? []
    expect(byId(lists, 'audit-me').contribution.wouldHide7d).toBeGreaterThan(0)
  })
})

describe('subscriptions', () => {
  it('add writes rules.yaml (comments kept) and downloads; ETag gives 304; the shrink guard and --force', async () => {
    const ls = await listServer()
    ls.files.set('/spam.txt', domains(10))
    const h = await setup({
      host: 'cli',
      seams: ls.seams,
      rules: '# my rules, by hand\nversion: 1\nrules:\n  - { match: example.org, action: block } # keep\n',
    })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    const added = await lists.add({ source: 'https://lists.test/spam.txt' })
    expect(added).toMatchObject({
      id: 'spam',
      source: 'subscribed',
      mode: 'enforce',
      ruleCount: 10,
      copy: 'downloaded',
      lastError: null,
    })
    expect(added.detectedFormat).toBe('domains')
    const yaml = readFileSync(join(h.home, 'rules.yaml'), 'utf8')
    expect(yaml).toContain('# my rules, by hand')
    expect(yaml).toContain('# keep')
    expect(yaml).toMatch(/subscriptions:\n {2}- name: spam\n {4}url: https:\/\/lists\.test\/spam\.txt/)
    expect(await blocked(h.app, 'https://d9.spam.example/x')).toBe(true)
    expect(await blocked(h.app, 'https://example.org/')).toBe(true)

    // Unchanged upstream: a conditional request and a 304.
    const [same] = await lists.update(['spam'])
    expect(same).toMatchObject({ id: 'spam', result: 'unchanged' })
    expect(ls.server.seen.at(-1)?.headers['if-none-match']).toBeDefined()

    // A copy with under half the rules is refused; the copy in force stays.
    ls.files.set('/spam.txt', domains(3))
    const [refused] = await lists.update(['spam'])
    expect(refused).toMatchObject({ result: 'failed', error: { code: 'shrink_guard' }, ruleCount: 10 })
    expect(await blocked(h.app, 'https://d9.spam.example/x')).toBe(true)
    const doctor = await h.app.doctor()
    expect(doctor.checks.find((c) => c.id === 'lists:spam')).toMatchObject({ status: 'warn' })
    expect(doctor.checks.find((c) => c.id === 'lists:spam')?.fix).toContain('--force')
    expect(byId(await lists.list(), 'spam').lastError?.code).toBe('shrink_guard')

    const [forced] = await lists.update(['spam'], { force: true })
    expect(forced).toMatchObject({ result: 'updated', ruleCount: 3, previousRuleCount: 10 })
    expect(await blocked(h.app, 'https://d9.spam.example/x')).toBe(false)
    expect(byId(await lists.list(), 'spam')).toMatchObject({ ruleCount: 3, lastError: null })

    // A failed download keeps the copy in force.
    ls.files.delete('/spam.txt')
    const [gone] = await lists.update(['spam'])
    expect(gone).toMatchObject({ result: 'failed', error: { code: 'http_status' }, ruleCount: 3 })
    expect(await blocked(h.app, 'https://d1.spam.example/')).toBe(true)
  })

  it('a pinned sha256 that does not match is refused; HTTP URLs and unknown names are refused', async () => {
    const ls = await listServer()
    ls.files.set('/pinned.txt', domains(4))
    const h = await setup({ host: 'cli', seams: ls.seams })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    const s = await lists.add({ source: 'https://lists.test/pinned.txt', sha256: 'f'.repeat(64) })
    expect(s).toMatchObject({
      id: 'pinned',
      copy: 'none',
      ruleCount: 0,
      lastError: { code: 'sha256_mismatch' },
    })
    expect(s.sha256).toBe('f'.repeat(64))
    const doctor = await h.app.doctor()
    expect(doctor.checks.find((c) => c.id === 'lists:pinned')?.title).toContain('pinned sha256')
    expect((await rejection(lists.add({ source: 'http://lists.test/x.txt' }))).why).toContain('HTTPS')
    expect((await rejection(lists.add({ source: 'not-a-list' }))).code).toBe('invalid_argument')
    expect((await rejection(lists.add({ source: 'https://lists.test/pinned.txt' }))).why).toContain(
      'already exists',
    )
  })

  it('a starter list refreshes from its catalog URL; the shrink guard counts the shipped copy', async () => {
    const ls = await listServer()
    const path = '/rjaus/ublacklist-pinterest/main/ublacklist-pinterest.txt'
    ls.files.set(path, '*://*.pinterest.com/*\n*://*.pinterest.de/*\n')
    const h = await setup({ host: 'cli', seams: ls.seams })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    const [refused] = await lists.update(['rjaus-pinterest'])
    expect(refused).toMatchObject({
      result: 'failed',
      error: { code: 'shrink_guard' },
      previousRuleCount: 50,
    })
    expect(byId(await lists.list(), 'rjaus-pinterest').copy).toBe('shipped')
    const more = Array.from({ length: 60 }, (_, i) => `*://*.pinterest-${i}.example/*`).join('\n')
    ls.files.set(path, `*://*.pinterest.com/*\n${more}\n`)
    const [ok] = await lists.update(['rjaus-pinterest'])
    expect(ok).toMatchObject({ result: 'updated', ruleCount: 61, previousRuleCount: 50 })
    const s = byId(await lists.list(), 'rjaus-pinterest')
    expect(s).toMatchObject({ copy: 'downloaded', source: 'vendored', ruleCount: 61 })
    expect(await blocked(h.app, 'https://www.pinterest-7.example/')).toBe(true)
    // Built-in and imported lists are not downloaded.
    expect((await lists.update(['github-clones']))[0]).toMatchObject({ result: 'skipped' })
  })
})

describe('adopting the shipped copy', () => {
  it('stores an identical upstream copy, then refreshes with conditional requests (304)', async () => {
    const ls = await listServer()
    const v = VENDORED_LISTS.find((x) => x.id === 'arosh-github-translation')
    if (v === undefined) throw new Error('no vendored list')
    const body = stripVendorHeader(readFileSync(join(REPO, v.path), 'utf8'))?.body ?? ''
    ls.files.set('/arosh/ublacklist-github-translation/master/uBlacklist.txt', body)
    const h = await setup({ host: 'cli', seams: ls.seams })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    expect((await lists.update(['arosh-github-translation']))[0]).toMatchObject({
      result: 'unchanged',
      message: 'same content',
    })
    expect(byId(await lists.list(), 'arosh-github-translation').copy).toBe('downloaded')
    expect((await lists.update(['arosh-github-translation']))[0]).toMatchObject({
      result: 'unchanged',
      message: 'not modified',
    })
    expect(ls.server.seen.at(-1)?.headers['if-none-match']).toBeDefined()
  })
})

describe('modes, removal and imports', () => {
  it('writes modes to rules.yaml and applies them at once', async () => {
    const h = await setup({ host: 'cli', rules: '# hand-written\nversion: 1\n' })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    expect(await blocked(h.app, AI_SITE.url)).toBe(false)
    expect((await lists.setMode('laylavish-huge-ai', 'enforce')).mode).toBe('enforce')
    expect(await blocked(h.app, AI_SITE.url)).toBe(true)
    await lists.setMode('rjaus-pinterest', 'disabled')
    expect(await blocked(h.app, PINTEREST.url)).toBe(false)
    await lists.setMode('github-clones', 'audit')
    const yaml = readFileSync(join(h.home, 'rules.yaml'), 'utf8')
    expect(yaml).toContain('# hand-written')
    expect(yaml).toContain('laylavish-huge-ai: { mode: enforce }')
    expect(yaml).toContain('rjaus-pinterest: { mode: disabled }')
    // Another process sees the change from the file.
    const other = await h.reopen()
    expect(await blocked(other, PINTEREST.url)).toBe(false)
    // "add" of a starter list turns it back on with its recommended mode.
    expect((await lists.add({ source: 'rjaus-pinterest', fetch: false })).mode).toBe('enforce')
    expect(await blocked(h.app, PINTEREST.url)).toBe(true)
    const err = await rejection(lists.remove('rjaus-pinterest'))
    expect(err.fix).toContain('lists disable rjaus-pinterest')
    expect((await rejection(lists.setMode('nope', 'audit'))).code).toBe('invalid_argument')
  })

  it('imports a local file, never refreshes it, and removes it with its files', async () => {
    const h = await setup({ host: 'cli' })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    const file = join(h.project, 'mine.txt')
    writeFileSync(file, '# my list\nbad.example\n0.0.0.0 worse.example\n')
    const s = await lists.import(file, { name: 'mine', kind: 'block', format: 'domains' })
    expect(s).toMatchObject({
      id: 'mine',
      source: 'local',
      copy: 'imported',
      ruleCount: 1,
      skipped: 1,
      mode: 'enforce',
    })
    // Importing the same name again replaces the list.
    const hosts = await lists.import(file, { name: 'mine', kind: 'block', format: 'hosts' })
    expect(hosts.ruleCount).toBe(2)
    expect(existsSync(join(h.home, 'lists', 'local', 'mine', 'source.txt'))).toBe(true)
    expect(await blocked(h.app, 'https://bad.example/')).toBe(true)
    expect((await lists.update(['mine']))[0]).toMatchObject({ result: 'skipped' })
    expect((await lists.remove('mine')).id).toBe('mine')
    expect(existsSync(join(h.home, 'lists', 'local', 'mine'))).toBe(false)
    expect(await blocked(h.app, 'https://bad.example/')).toBe(false)

    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]))
    expect((await rejection(lists.import(file, { name: 'bin', kind: 'block' }))).why).toContain('binary')
    writeFileSync(file, '! nothing here\n[Adblock Plus 2.0]\n##.ad-banner\n')
    expect((await rejection(lists.import(file, { name: 'empty', kind: 'block' }))).why).toContain(
      'could be imported',
    )
    expect((await rejection(lists.import(file, { name: 'github-clones', kind: 'block' }))).why).toContain(
      'already exists',
    )
  })
})

describe('background refresh (ADR-0006 point 7)', () => {
  it('a gateway refreshes due lists after a real request, and only under the lease', async () => {
    const ls = await listServer()
    ls.files.set('/spam.txt', domains(5))
    const rules =
      'version: 1\nsubscriptions:\n  - { name: spam, url: "https://lists.test/spam.txt", format: domains }\n'
    const h = await setup({ host: 'claude-code', seams: ls.seams, rules })
    const lists = h.app.lists
    if (lists === undefined) throw new Error('no list API')
    expect(byId(await lists.list(), 'spam')).toMatchObject({ copy: 'none', ruleCount: 0 })
    // Searching never waits for it.
    await h.app.filterBuiltinResults('q', [PLAIN], hookSession())
    const deadline = Date.now() + 5000
    while (byId(await lists.list(), 'spam').copy === 'none' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(byId(await lists.list(), 'spam')).toMatchObject({ copy: 'downloaded', ruleCount: 5 })
    expect(ls.server.seen.filter((r) => r.url === '/spam.txt')).toHaveLength(1)

    // Another process holds the lease: this one does not fetch.
    const other = await openStore({ dataDir: h.home, appVersion: '0.1.0', now: () => NOW })
    onCleanup(() => other.close())
    const held = other.jobs.acquire('lists:refresh', { gatewayId: 'gw_other', version: '0.1.0' }, 30_000)
    expect(held.acquired).toBe(true)
    const [r] = await lists.update(['spam'])
    expect(r).toMatchObject({ result: 'skipped' })
    expect(r?.message).toContain('another search-hole process')
  })
})
