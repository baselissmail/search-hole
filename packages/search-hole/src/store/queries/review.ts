// SPDX-License-Identifier: Apache-2.0
/**
 * The review list (ADR-0025): sites that kept showing up in results and that the assistant
 * never opened, plus the sites the user dismissed from it ("this site is fine").
 *
 * Cost on a large log: two range scans of `results` by `created_at` (one grouped query for the
 * candidates, one for the examples of the sites that are shown) and one range scan of `fetches`.
 * Never a query per site. Dismissals are one `meta_kv` row, so no migration was needed.
 */
import { z } from 'zod'
import { hostOf, registrableDomain } from '../../core/url.ts'
import type { Db } from '../driver.ts'
import type { ReviewCandidate, ReviewExample } from '../types.ts'
import { kvGet, kvSet } from './meta.ts'

/** The `meta_kv` key: a JSON object of registrable domain → dismissed-at (epoch ms). */
export const REVIEW_DISMISSED_KEY = 'review.dismissed'
/** Oldest dismissals are dropped beyond this many, so the row stays small. */
export const MAX_DISMISSED = 2000

const domainRow = z.object({ domain: z.string() })
const urlRow = z.object({ url: z.string() })

/**
 * Registrable domains with an opened page since `since`. A fetch row carries the domain it
 * ended on; a redirected one also counts for the domain it was requested from.
 */
export function openedDomains(db: Db, since: number): Set<string> {
  const out = new Set<string>()
  const ended = db
    .prepare(
      `SELECT DISTINCT registrable_domain AS domain FROM fetches
        WHERE created_at >= ? AND decision = 'opened' AND registrable_domain IS NOT NULL`,
    )
    .all([since])
  for (const raw of ended) out.add(domainRow.parse(raw).domain)
  const redirected = db
    .prepare(
      `SELECT DISTINCT url FROM fetches
        WHERE created_at >= ? AND decision = 'opened' AND final_url IS NOT NULL AND url IS NOT NULL`,
    )
    .all([since])
  for (const raw of redirected) {
    const host = hostOf(urlRow.parse(raw).url)
    if (host !== null) out.add(registrableDomain(host))
  }
  return out
}

const candidateRow = z.object({
  domain: z.string(),
  searches: z.number().int(),
  results: z.number().int(),
  last_seen: z.number(),
  source_type: z.string(),
})

/**
 * One grouped pass over the window. `source_type` is a bare column next to the single
 * `MAX(created_at)`, which SQLite defines as "from the row with that maximum": the type of the
 * site's most recent result. Exported for the query-plan test.
 */
export const REVIEW_CANDIDATES_SQL = `
SELECT r.registrable_domain AS domain,
       COUNT(DISTINCT r.search_id) AS searches,
       COUNT(*) AS results,
       MAX(r.created_at) AS last_seen,
       r.source_type AS source_type
  FROM results r
 WHERE r.created_at >= $since AND r.decision <> 'hidden' AND r.registrable_domain <> ''
   AND r.registrable_domain NOT IN (SELECT value FROM json_each($exclude))
 GROUP BY r.registrable_domain
HAVING COUNT(DISTINCT r.search_id) >= $minSearches
 ORDER BY searches DESC, results DESC, domain ASC
 LIMIT $limit`

/**
 * Sites with kept results in at least `minSearches` distinct searches since `since` and no
 * opened page in that time, most-seen first. `exclude` removes more domains (the dismissed ones).
 */
export function reviewCandidates(
  db: Db,
  o: { since: number; minSearches: number; limit: number; exclude: readonly string[] },
): ReviewCandidate[] {
  const exclude = new Set(o.exclude)
  for (const d of openedDomains(db, o.since)) exclude.add(d)
  return db
    .prepare(REVIEW_CANDIDATES_SQL)
    .all({
      since: o.since,
      minSearches: o.minSearches,
      limit: o.limit,
      exclude: JSON.stringify([...exclude]),
    })
    .map((raw) => {
      const r = candidateRow.parse(raw)
      return {
        domain: r.domain,
        searches: r.searches,
        results: r.results,
        lastSeen: r.last_seen,
        sourceType: r.source_type,
      }
    })
}

const exampleRow = z.object({
  domain: z.string(),
  canonical_key: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
})

/**
 * Up to `$perDomain` distinct pages per site, the most often returned first. A page qualifies
 * only when its URL is stored: results of decisions-only engines (ADR-0009 point 9) have
 * neither a canonical key nor a payload, so such a site has no examples. Exported for the
 * query-plan test.
 */
export const REVIEW_EXAMPLES_SQL = `
WITH pages AS (
  SELECT r.registrable_domain AS domain, MAX(r.id) AS result_id, COUNT(*) AS n
    FROM results r
   WHERE r.created_at >= $since AND r.decision <> 'hidden'
     AND r.registrable_domain IN (SELECT value FROM json_each($domains))
     AND (r.canonical_key IS NOT NULL
          OR EXISTS (SELECT 1 FROM result_payloads p WHERE p.result_id = r.id AND p.expires_at > $now))
   GROUP BY r.registrable_domain, r.url_hash
), ranked AS (
  SELECT domain, result_id,
         ROW_NUMBER() OVER (PARTITION BY domain ORDER BY n DESC, result_id DESC) AS rn
    FROM pages
)
SELECT k.domain AS domain, r.canonical_key AS canonical_key,
       (SELECT p.title FROM result_payloads p
         WHERE p.result_id = k.result_id AND p.expires_at > $now ORDER BY p.id LIMIT 1) AS title,
       (SELECT p.url FROM result_payloads p
         WHERE p.result_id = k.result_id AND p.expires_at > $now ORDER BY p.id LIMIT 1) AS url
  FROM ranked k JOIN results r ON r.id = k.result_id
 WHERE k.rn <= $perDomain
 ORDER BY k.domain ASC, k.rn ASC`

/** Example pages for the given sites (one query for all of them). Sites without any are absent. */
export function reviewExamples(
  db: Db,
  o: { domains: readonly string[]; since: number; now: number; perDomain: number },
): Map<string, ReviewExample[]> {
  const out = new Map<string, ReviewExample[]>()
  if (o.domains.length === 0) return out
  const rows = db.prepare(REVIEW_EXAMPLES_SQL).all({
    since: o.since,
    now: o.now,
    perDomain: o.perDomain,
    domains: JSON.stringify(o.domains),
  })
  for (const raw of rows) {
    const r = exampleRow.parse(raw)
    // The canonical key is scheme-less (`//host/path`); the log shows it the same way.
    const url = r.url ?? (r.canonical_key === null ? null : `https:${r.canonical_key}`)
    if (url === null) continue
    const list = out.get(r.domain) ?? []
    list.push({ url, title: r.title === null || r.title === '' ? null : r.title })
    out.set(r.domain, list)
  }
  return out
}

const dismissedJson = z.record(z.string(), z.number())

/** Dismissed domains with when (epoch ms). A missing or unreadable value reads as none. */
export function readDismissed(db: Db): Map<string, number> {
  const text = kvGet(db, REVIEW_DISMISSED_KEY)
  if (text === undefined) return new Map()
  try {
    const parsed = dismissedJson.safeParse(JSON.parse(text))
    return parsed.success ? new Map(Object.entries(parsed.data)) : new Map()
  } catch {
    return new Map()
  }
}

/**
 * Dismisses (`at` = epoch ms) or restores (`at` = null) one domain. Returns true when the
 * stored set changed. Call inside a write transaction: the row is read, changed and written.
 */
export function setDismissed(db: Db, domain: string, at: number | null, now: number): boolean {
  const current = readDismissed(db)
  if (at === null) {
    if (!current.delete(domain)) return false
  } else {
    if (current.has(domain)) return false
    current.set(domain, at)
  }
  const kept = [...current.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  kvSet(db, REVIEW_DISMISSED_KEY, JSON.stringify(Object.fromEntries(kept.slice(0, MAX_DISMISSED))), now)
  return true
}
