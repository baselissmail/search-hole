// SPDX-License-Identifier: Apache-2.0
/**
 * The review list (ADR-0025): sites that had kept results in at least three searches of the
 * last `days` days and that the assistant never opened. It points the user at sites worth a
 * rule; it never changes one. Everything comes from the local log, there is no network call.
 *
 * A site leaves the list when a page of it is opened, when a global rule of the user decides
 * it (matched by the rules engine, not re-implemented here), or when the user dismisses it
 * ("this site is fine"). Dismissals are stored in `meta_kv`.
 */
import { compileRuleSet } from '../core/rules/index.ts'
import { hostOf, registrableDomain } from '../core/url.ts'
import { SearchHoleError } from '../shared/errors.ts'
import type { Rule } from '../shared/types.ts'
import type { AppContext } from './context.ts'
import { sourceTypeOf } from './logview.ts'
import type { RulesService } from './rules.ts'
import type { ReviewList, ReviewSite } from './types.ts'

const DAY_MS = 24 * 60 * 60_000
export const REVIEW_DAYS_DEFAULT = 30
const REVIEW_DAYS_MAX = 365
/** A site is worth a look once it showed up in this many distinct searches. */
export const REVIEW_MIN_SEARCHES = 3
const LIMIT_DEFAULT = 100
const LIMIT_MAX = 500
/** Candidates read from the log before rules are applied (most-seen first). */
const CANDIDATE_CAP = 1000
const EXAMPLES_PER_SITE = 3

export interface ReviewDeps {
  ctx: AppContext
  rules: RulesService
}

const clampInt = (v: number | undefined, lo: number, hi: number, fallback: number): number =>
  v === undefined || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, Math.trunc(v)))

/**
 * True for a URL that one of the user's global rules matches: block, allow, pin, raise, lower
 * or normal, in any profile, unless it is past its `until`. The rules are compiled alone (no
 * lists), so this stays cheap in a CLI call.
 */
function decidedByGlobalRule(rules: readonly Rule[], now: number): (url: string) => boolean {
  if (rules.length === 0) return () => false
  const set = compileRuleSet({ rules })
  return (url) => set.explainAll(url, { now }).some((m) => m.skipped === undefined)
}

/** The site list for the last `days` days, most-seen first. */
export async function reviewList(
  d: ReviewDeps,
  opts: { days?: number; limit?: number } = {},
): Promise<ReviewList> {
  const days = clampInt(opts.days, 1, REVIEW_DAYS_MAX, REVIEW_DAYS_DEFAULT)
  const limit = clampInt(opts.limit, 1, LIMIT_MAX, LIMIT_DEFAULT)
  const out: ReviewList = { days, minSearches: REVIEW_MIN_SEARCHES, sites: [], total: 0, dismissed: [] }
  const store = await d.ctx.store.read()
  if (!store) return out
  const now = d.ctx.now()
  const since = now - days * DAY_MS
  const dismissed = store.review.dismissed()
  out.dismissed = [...dismissed]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([domain, at]) => ({ domain, at: new Date(at).toISOString() }))
  const decided = decidedByGlobalRule(d.rules.global(store).loaded?.rules ?? [], now)
  const candidates = store.review
    .candidates({
      since,
      minSearches: REVIEW_MIN_SEARCHES,
      limit: CANDIDATE_CAP,
      exclude: [...dismissed.keys()],
    })
    .filter((c) => !decided(`https://${c.domain}/`))
  const examples = store.review.examples({
    domains: candidates.map((c) => c.domain),
    since,
    perDomain: EXAMPLES_PER_SITE,
  })
  const sites: ReviewSite[] = []
  for (const c of candidates) {
    const pages = examples.get(c.domain) ?? []
    // A rule on a host or path of the site (`=www.example.com`) that covers every page we
    // know of decides the site too, even though it does not match the bare domain.
    if (pages.length > 0 && pages.every((p) => decided(p.url))) continue
    sites.push({
      domain: c.domain,
      searches: c.searches,
      results: c.results,
      lastSeen: new Date(c.lastSeen).toISOString(),
      sourceType: sourceTypeOf(c.sourceType),
      examples: pages.map((p) => (p.title === null ? { url: p.url } : { url: p.url, title: p.title })),
    })
  }
  out.total = sites.length
  out.sites = sites.slice(0, limit)
  return out
}

/** The registrable domain of the domain, host or URL the user named. */
function siteDomain(site: string): string {
  const text = site.trim()
  const host =
    text === '' || text.length > 2048
      ? null
      : hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  if (host === null || !host.includes('.')) {
    throw new SearchHoleError('invalid_argument', 'That is not a site.', {
      fix: 'Name a domain such as example.com, as `searchhole review` lists it.',
    })
  }
  return registrableDomain(host)
}

/** Dismisses (`dismiss: true`) or restores a site. User action only. */
export async function setReviewDismissed(
  d: ReviewDeps,
  site: string,
  dismiss: boolean,
): Promise<{ domain: string; changed: boolean }> {
  const domain = siteDomain(site)
  const store = await d.ctx.store.write()
  const changed = dismiss ? store?.review.dismiss(domain) : store?.review.restore(domain)
  if (changed === undefined) {
    const status = store?.status()
    const why =
      status === undefined
        ? 'The search-hole database is unavailable.'
        : status.mode === 'read-write'
          ? 'The search-hole database is busy.'
          : status.message
    throw new SearchHoleError('store_unavailable', `Could not update the review list. ${why}`, {
      fix: 'Try again, or run `searchhole doctor`.',
    })
  }
  return { domain, changed }
}
