// SPDX-License-Identifier: Apache-2.0
/**
 * Effective dates and staleness (ADR-0011 point 4, ADR-0010 §6). Pure: `now` is always
 * passed in (epoch milliseconds).
 *
 * - Only `published` and `modified` dates count. `crawled` and `existed_by` never feed
 *   freshness.
 * - Only high- and medium-confidence dates count. Low-only means "unknown".
 * - Implausible dates (more than 1 day in the future, or before 1995-01-01) are rejected.
 */
import type { FoundDate, Freshness } from '../shared/types.ts'

/** Which date freshness is judged on. Default: `published`. */
export type FreshnessBasis = NonNullable<Freshness['basis']>

export const DAY_MS = 86_400_000
/** Dates before 1995-01-01 are rejected (ADR-0011 point 5). */
export const MIN_PLAUSIBLE_MS = Date.UTC(1995, 0, 1)
/** Dates more than this far after `now` are rejected (ADR-0011 point 5). */
export const FUTURE_TOLERANCE_MS = DAY_MS
/** A modified date at least this many days after the published date raises `updated`. */
export const UPDATED_MIN_GAP_DAYS = 30

const ISO =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i

/**
 * Parses an ISO 8601 value (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a date-time with optional
 * fraction and offset) to epoch milliseconds. A value without an offset is UTC. Returns
 * null for anything else, including impossible calendar dates.
 */
export function parseDateMs(value: string): number | null {
  const m = ISO.exec(value.trim())
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', frac = '', tz = 'Z'] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
  const offset = offsetMs(tz)
  if (offset === null) return null
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0–99 to 1900–1999.
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, Math.floor(Number(`0.${frac || '0'}`) * 1000))
  if (date.getUTCDate() !== day) return null
  return date.getTime() - offset
}

function offsetMs(tz: string): number | null {
  if (tz.toUpperCase() === 'Z') return 0
  const sign = tz.startsWith('-') ? -1 : 1
  const digits = tz.slice(1).replace(':', '')
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2) || '0')
  if (hours > 23 || minutes > 59) return null
  return sign * (hours * 60 + minutes) * 60_000
}

/** True when the value parses and lies in [1995-01-01, now + 1 day]. */
export function isPlausibleDate(value: string, now: number): boolean {
  const ms = parseDateMs(value)
  return ms !== null && ms >= MIN_PLAUSIBLE_MS && ms <= now + FUTURE_TOLERANCE_MS
}

/** True for a plausible published/modified date with high or medium confidence. */
export function isUsableDate(date: FoundDate, now: number): boolean {
  return (
    (date.kind === 'published' || date.kind === 'modified') &&
    (date.confidence === 'high' || date.confidence === 'medium') &&
    isPlausibleDate(date.value, now)
  )
}

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Earlier first; at the same instant, higher confidence, then an explicit timezone,
 * then kind, method and raw value win. Total order, so selection never depends on input order.
 */
function compareChronological(a: FoundDate, b: FoundDate): number {
  const d = (parseDateMs(a.value) ?? 0) - (parseDateMs(b.value) ?? 0)
  if (d !== 0) return d
  const c = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]
  if (c !== 0) return c
  if (a.tzAssumed !== b.tzAssumed) return a.tzAssumed ? 1 : -1
  return cmpStr(a.kind, b.kind) || cmpStr(a.method, b.method) || cmpStr(a.value, b.value)
}

function earliest(dates: readonly FoundDate[]): FoundDate | undefined {
  return [...dates].sort(compareChronological)[0]
}

function latest(dates: readonly FoundDate[]): FoundDate | undefined {
  // At the same instant the higher-confidence date still wins.
  return [...dates].sort((a, b) => {
    const d = (parseDateMs(b.value) ?? 0) - (parseDateMs(a.value) ?? 0)
    return d !== 0 ? d : compareChronological(a, b)
  })[0]
}

/** Earliest usable published date and latest usable modified date (ADR-0010 §2). */
export function datePair(
  dates: readonly FoundDate[],
  now: number,
): { published?: FoundDate; modified?: FoundDate } {
  const usable = dates.filter((d) => isUsableDate(d, now))
  const published = earliest(usable.filter((d) => d.kind === 'published'))
  const modified = latest(usable.filter((d) => d.kind === 'modified'))
  return { ...(published ? { published } : {}), ...(modified ? { modified } : {}) }
}

/**
 * The date freshness is judged on (ADR-0011 point 4):
 * - `published` (default): the earliest usable published date, else the latest usable modified;
 * - `modified`: the latest usable modified date, else the earliest usable published;
 * - `newest`: the most recent usable date of either kind.
 * Undefined when only low-confidence, crawl or implausible dates exist (`date_unknown`).
 */
export function effectiveDate(
  dates: readonly FoundDate[],
  basis: FreshnessBasis | undefined,
  now: number,
): FoundDate | undefined {
  const { published, modified } = datePair(dates, now)
  switch (basis ?? 'published') {
    case 'published':
      return published ?? modified
    case 'modified':
      return modified ?? published
    case 'newest':
      return latest([published, modified].filter((d): d is FoundDate => d !== undefined))
  }
}

/** Age in (fractional) days at `now`; null when the value doesn't parse. */
export function ageDays(date: FoundDate, now: number): number | null {
  const ms = parseDateMs(date.value)
  return ms === null ? null : (now - ms) / DAY_MS
}

/** True when the date is more than `maxAgeDays` old at `now`. An unparseable date is never stale. */
export function isStale(date: FoundDate, maxAgeDays: number, now: number): boolean {
  const age = ageDays(date, now)
  return age !== null && age > maxAgeDays
}

/** True when the usable modified date is at least `UPDATED_MIN_GAP_DAYS` after the usable published date. */
export function isUpdated(dates: readonly FoundDate[], now: number): boolean {
  const { published, modified } = datePair(dates, now)
  if (!published || !modified) return false
  const gap = (parseDateMs(modified.value) ?? 0) - (parseDateMs(published.value) ?? 0)
  return gap >= UPDATED_MIN_GAP_DAYS * DAY_MS
}

/** Freshness of one result against a profile. */
export interface FreshnessVerdict {
  /** `unknown`: no usable date. `stale`: older than `maxAgeDays`. `fresh`: otherwise. */
  status: 'fresh' | 'stale' | 'unknown'
  effective?: FoundDate
  updated: boolean
}

/** Applies `effectiveDate`, `isStale` and `isUpdated` for one profile. */
export function judgeFreshness(
  dates: readonly FoundDate[],
  freshness: Freshness,
  now: number,
): FreshnessVerdict {
  const effective = effectiveDate(dates, freshness.basis, now)
  const updated = isUpdated(dates, now)
  if (!effective) return { status: 'unknown', updated }
  const stale = freshness.maxAgeDays !== undefined && isStale(effective, freshness.maxAgeDays, now)
  return { status: stale ? 'stale' : 'fresh', effective, updated }
}
