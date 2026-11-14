// SPDX-License-Identifier: Apache-2.0
// The review list (ADR-0025): sites seen in several searches and never opened, their example
// pages, and the dismissals kept in meta_kv. Includes the query plans and a 100k-row run.
import { describe, expect, it } from 'vitest'
import { canonicalKey } from '../../src/core/url.ts'
import { openDb } from '../../src/store/driver.ts'
import { type Store, urlHash } from '../../src/store/index.ts'
import {
  MAX_DISMISSED,
  REVIEW_CANDIDATES_SQL,
  REVIEW_DISMISSED_KEY,
  REVIEW_EXAMPLES_SQL,
} from '../../src/store/queries/review.ts'
import { type Clock, clock, open, recorded, searchInput, tempDir } from './helpers.ts'

const DAY = 86_400_000
const hashOf = (url: string): string => urlHash(canonicalKey(url) ?? url)

interface Hit {
  url: string
  title?: string
  hidden?: boolean
  engine?: 'searxng' | 'brave'
  sourceType?: 'blog' | 'docs' | 'forum' | 'content_farm' | 'unknown'
}

/** One search keeping (or hiding) the given pages; the domain is the URL's host. */
function search(store: Store, hits: readonly (string | Hit)[]): number {
  const results = hits.map((h) => {
    const hit = typeof h === 'string' ? { url: h } : h
    const engine = hit.engine ?? 'searxng'
    return recorded(hit.url, hit.hidden === true ? { visibility: 'hidden', reason: 'rule' } : {}, {
      canonicalKey: canonicalKey(hit.url) ?? hit.url,
      engines: [engine],
      positions: { [engine]: 1 },
      sourceType: hit.sourceType ?? 'unknown',
      ...(hit.title === undefined ? {} : { title: hit.title }),
    })
  })
  const r = store.recordSearch(searchInput({ sessionId: 's1', keptCount: results.length, results }))
  if (r.status !== 'recorded') throw new Error(`not recorded: ${r.status}`)
  return r.searchId
}

function opened(store: Store, url: string, finalUrl?: string): void {
  const host = new URL(finalUrl ?? url).hostname
  store.fetches.record({
    receiptId: 'rcpt_test',
    sessionId: 's1',
    urlHash: hashOf(url),
    url,
    ...(finalUrl === undefined ? {} : { finalUrl, finalUrlHash: hashOf(finalUrl) }),
    host,
    registrableDomain: host,
    decision: 'opened',
  })
}

const candidates = (store: Store, t: Clock, over: { days?: number; exclude?: string[] } = {}) =>
  store.review.candidates({
    since: t() - (over.days ?? 30) * DAY,
    minSearches: 3,
    limit: 100,
    ...(over.exclude === undefined ? {} : { exclude: over.exclude }),
  })

describe('review.candidates', () => {
  it('lists sites kept in at least 3 distinct searches, most-seen first, with counts and last seen', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    // farm.example: 4 searches, 5 results. blog.example: 3 searches. twice.example: 2 searches.
    search(store, ['https://farm.example/a', 'https://farm.example/b', 'https://twice.example/1'])
    t.advance(1000)
    search(store, ['https://farm.example/a', 'https://blog.example/1', 'https://twice.example/2'])
    t.advance(1000)
    search(store, ['https://farm.example/c', 'https://blog.example/2'])
    t.advance(1000)
    const lastFarm = t()
    search(store, [{ url: 'https://farm.example/d', sourceType: 'content_farm' }, 'https://blog.example/3'])
    expect(candidates(store, t)).toEqual([
      { domain: 'farm.example', searches: 4, results: 5, lastSeen: lastFarm, sourceType: 'content_farm' },
      { domain: 'blog.example', searches: 3, results: 3, lastSeen: lastFarm, sourceType: 'unknown' },
    ])
  })

  it('breaks a tie in searches by results, then by name', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 3; i++) {
      search(store, [
        `https://b.example/${i}`,
        `https://a.example/${i}`,
        `https://c.example/${i}`,
        `https://c.example/x${i}`,
      ])
    }
    expect(candidates(store, t).map((c) => [c.domain, c.searches, c.results])).toEqual([
      ['c.example', 3, 6],
      ['a.example', 3, 3],
      ['b.example', 3, 3],
    ])
  })

  it('counts kept results only: a site that was hidden is not a candidate', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 3; i++) {
      search(store, [{ url: `https://blocked.example/${i}`, hidden: true }, `https://seen.example/${i}`])
    }
    expect(candidates(store, t).map((c) => c.domain)).toEqual(['seen.example'])
  })

  it('drops a site once any of its pages was opened, also through a redirect', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 3; i++) {
      search(store, [
        `https://read.example/${i}`,
        `https://short.example/${i}`,
        `https://skipped.example/${i}`,
      ])
    }
    expect(candidates(store, t).map((c) => c.domain)).toEqual([
      'read.example',
      'short.example',
      'skipped.example',
    ])
    opened(store, 'https://read.example/elsewhere')
    // Requested on short.example, ended on landing.example: both count as opened.
    opened(store, 'https://short.example/1', 'https://landing.example/page')
    expect(candidates(store, t).map((c) => c.domain)).toEqual(['skipped.example'])
  })

  it('looks only at the window: old results and old fetches fall out', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 2; i++) search(store, [`https://old.example/${i}`, `https://again.example/${i}`])
    opened(store, 'https://again.example/0')
    t.advance(40 * DAY)
    search(store, ['https://old.example/9', 'https://again.example/9'])
    search(store, ['https://again.example/10'])
    search(store, ['https://again.example/11'])
    // 30 days: old.example has one search in the window; again.example has three, and its only
    // opened page is older than the window.
    expect(candidates(store, t).map((c) => [c.domain, c.searches])).toEqual([['again.example', 3]])
    // 60 days: the fetch is inside the window again, and old.example reaches three searches.
    expect(candidates(store, t, { days: 60 }).map((c) => [c.domain, c.searches])).toEqual([
      ['old.example', 3],
    ])
  })

  it('leaves out the domains it is told to exclude', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 3; i++) search(store, [`https://a.example/${i}`, `https://b.example/${i}`])
    expect(candidates(store, t, { exclude: ['a.example'] }).map((c) => c.domain)).toEqual(['b.example'])
  })
})

describe('review.examples', () => {
  it('returns up to three distinct pages per site, the most returned first, in one call', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    search(store, [
      { url: 'https://farm.example/a', title: 'Page A' },
      { url: 'https://farm.example/b', title: 'Page B' },
    ])
    search(store, [
      { url: 'https://farm.example/a', title: 'Page A' },
      { url: 'https://farm.example/c', title: 'Page C' },
    ])
    search(store, [
      { url: 'https://farm.example/a', title: 'Page A' },
      { url: 'https://farm.example/d', title: 'Page D' },
    ])
    search(store, [
      { url: 'https://farm.example/hidden', title: 'Hidden', hidden: true },
      { url: 'https://other.example/1', title: 'Other' },
    ])
    const examples = store.review.examples({
      domains: ['farm.example', 'other.example', 'none.example'],
      since: 0,
      perDomain: 3,
    })
    expect(examples.get('farm.example')).toEqual([
      { url: 'https://farm.example/a', title: 'Page A' },
      { url: 'https://farm.example/d', title: 'Page D' },
      { url: 'https://farm.example/c', title: 'Page C' },
    ])
    expect(examples.get('other.example')).toEqual([{ url: 'https://other.example/1', title: 'Other' }])
    expect(examples.has('none.example')).toBe(false)
    expect(store.review.examples({ domains: [], since: 0, perDomain: 3 }).size).toBe(0)
  })

  it('has nothing for a decisions-only engine (Brave), and only the URL once the payload expired', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 3; i++) {
      search(store, [
        { url: `https://brave-only.example/${i}`, title: 'Never stored', engine: 'brave' },
        { url: 'https://kept.example/page', title: 'Stored title' },
      ])
    }
    const domains = ['brave-only.example', 'kept.example']
    // The site still is a candidate: only its examples are missing.
    expect(candidates(store, t).map((c) => c.domain)).toEqual(['brave-only.example', 'kept.example'])
    expect(store.review.examples({ domains, since: 0, perDomain: 3 })).toEqual(
      new Map([['kept.example', [{ url: 'https://kept.example/page', title: 'Stored title' }]]]),
    )
    t.advance(91 * DAY) // past the payload's expiry (90 days by default)
    expect(store.review.examples({ domains, since: 0, perDomain: 3 })).toEqual(
      new Map([['kept.example', [{ url: 'https://kept.example/page', title: null }]]]),
    )
  })
})

describe('review dismissals (meta_kv, no migration)', () => {
  it('dismisses and restores a site, idempotently, in one meta_kv row', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    expect(store.review.dismissed().size).toBe(0)
    expect(store.review.dismiss('fine.example')).toBe(true)
    t.advance(5000)
    expect(store.review.dismiss('fine.example')).toBe(false)
    expect(store.review.dismiss('also-fine.example')).toBe(true)
    expect([...store.review.dismissed()]).toEqual([
      ['also-fine.example', t()],
      ['fine.example', t() - 5000],
    ])
    expect(JSON.parse(store.meta.get(REVIEW_DISMISSED_KEY) ?? '')).toEqual({
      'also-fine.example': t(),
      'fine.example': t() - 5000,
    })
    expect(store.review.restore('fine.example')).toBe(true)
    expect(store.review.restore('fine.example')).toBe(false)
    expect([...store.review.dismissed().keys()]).toEqual(['also-fine.example'])
    // Another process sees it: the row is in the database, not in memory.
    const again = await open(dir, t)
    expect([...again.review.dismissed().keys()]).toEqual(['also-fine.example'])
  })

  it('reads a damaged value as "nothing dismissed" and keeps only the newest entries', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    store.meta.set(REVIEW_DISMISSED_KEY, '{not json')
    expect(store.review.dismissed().size).toBe(0)
    store.meta.set(REVIEW_DISMISSED_KEY, JSON.stringify(['a.example']))
    expect(store.review.dismissed().size).toBe(0)
    const many = Object.fromEntries(
      Array.from({ length: MAX_DISMISSED }, (_, i) => [`d${i}.example`, 1000 + i]),
    )
    store.meta.set(REVIEW_DISMISSED_KEY, JSON.stringify(many))
    expect(store.review.dismiss('newest.example')).toBe(true)
    const kept = store.review.dismissed()
    expect(kept.size).toBe(MAX_DISMISSED)
    expect(kept.has('newest.example')).toBe(true)
    expect(kept.has('d0.example')).toBe(false) // the oldest one made room
  })

  it('writes nothing once the store is closed', async () => {
    const store = await open(tempDir(), clock())
    store.close()
    expect(store.review.dismiss('late.example')).toBeUndefined()
    expect(store.review.candidates({ since: 0, minSearches: 3, limit: 10 })).toEqual([])
  })
})

describe('review queries on a large log', () => {
  it('read results and fetches through their created_at indexes', async () => {
    const dir = tempDir()
    await open(dir, clock())
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    const plan = (sql: string, params: Record<string, string | number>): string =>
      raw
        .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(params)
        .map((r) => r.detail)
        .join('\n')
    const grouped = plan(REVIEW_CANDIDATES_SQL, { since: 1, minSearches: 3, limit: 100, exclude: '[]' })
    expect(grouped).toContain('USING INDEX results_by_created (created_at>?)')
    expect(grouped).not.toMatch(/SCAN r\b/)
    const examples = plan(REVIEW_EXAMPLES_SQL, { since: 1, now: 2, perDomain: 3, domains: '[]' })
    expect(examples).toContain('USING INDEX results_by_created (created_at>?)')
    expect(examples).toContain('result_payloads_by_result')
    expect(examples).not.toMatch(/SCAN (r|p|results|result_payloads)\b/)
    const fetches = plan(
      "SELECT DISTINCT registrable_domain FROM fetches WHERE created_at >= $since AND decision = 'opened'",
      { since: 1 },
    )
    expect(fetches).toContain('fetches_by_created')
    raw.close()
  })

  it('answers over 100,000 result rows with two passes, well inside a page load', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 5000 })
    // 8,000 searches × 12.5 kept results over 600 sites, plus 2,000 opened pages on 100 of them.
    const SEARCHES = 8000
    const PER_SEARCH = [12, 13]
    const start = t() - 29 * DAY
    raw.tx('immediate', () => {
      const insSearch = raw.prepare(
        `INSERT INTO searches (receipt_id, session_id, query_redacted, profile, depth, engines_json, latency_ms,
                               kept_count, hidden_count, created_at)
         VALUES ('rcpt_bulk', 's_bulk', 'q', 'default', 'standard', '[]', 1, 12, 0, ?)`,
      )
      const insResult = raw.prepare(
        `INSERT INTO results (search_id, engine, raw_rank, positions_json, canonical_key, url_hash,
                              registrable_domain, decision, flags_json, source_type, dates_json, created_at)
         VALUES (?, 'searxng', ?, '{}', ?, ?, ?, 'kept', '[]', 'unknown', '[]', ?)`,
      )
      const insFetch = raw.prepare(
        `INSERT INTO fetches (receipt_id, session_id, url_hash, registrable_domain, decision, created_at)
         VALUES ('rcpt_bulk', 's_bulk', ?, ?, 'opened', ?)`,
      )
      let n = 0
      for (let s = 0; s < SEARCHES; s++) {
        const at = start + s * 60_000
        const id = insSearch.run([at]).lastInsertRowid
        const per = PER_SEARCH[s % 2] ?? 12
        for (let r = 0; r < per; r++) {
          const site = (s * 7 + r * 13) % 600
          const key = `//site${site}.example/p${(s + r) % 5}`
          insResult.run([id, r + 1, key, `h${site}_${(s + r) % 5}`, `site${site}.example`, at])
          n++
        }
        if (s % 4 === 0) insFetch.run([`f${s}`, `site${(s / 4) % 100}.example`, at])
      }
      expect(n).toBe(100_000)
    })
    raw.close()

    const started = performance.now()
    const found = candidates(store, t)
    const examples = store.review.examples({
      domains: found.map((c) => c.domain),
      since: t() - 30 * DAY,
      perDomain: 3,
    })
    const ms = performance.now() - started
    // Sites 0..99 were opened; the other 500 were seen often and never opened.
    expect(found).toHaveLength(100) // the limit asked for
    expect(found.every((c) => Number(c.domain.slice(4, -8)) >= 100 && c.searches >= 3)).toBe(true)
    expect(examples.size).toBe(100)
    expect([...examples.values()].every((e) => e.length === 3)).toBe(true)
    // Measured at about 70 ms for both queries (2026-11, Apple silicon). The bound is loose on
    // purpose: it only catches a plan that stopped using the index or went quadratic.
    expect(ms).toBeLessThan(3000)
  })
})
