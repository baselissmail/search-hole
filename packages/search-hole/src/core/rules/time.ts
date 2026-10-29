// SPDX-License-Identifier: Apache-2.0
/**
 * `until` and TTL handling (ADR-0008 fields). All functions are pure: the clock
 * is always passed in.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * The instant (epoch ms) from which a rule with this `until` no longer applies,
 * or null if the text is not a valid date. A date-only value means "through the
 * end of that day, UTC" (`2026-12-31` stops at `2027-01-01T00:00:00Z`). A
 * date-time must carry `Z` or an offset, so the result never depends on the
 * machine's time zone.
 */
export function untilToMs(until: string): number | null {
  const d = DATE_ONLY.exec(until)
  if (d) {
    const y = Number(d[1])
    const m = Number(d[2])
    const day = Number(d[3])
    const start = Date.UTC(y, m - 1, day)
    const check = new Date(start)
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day)
      return null
    return start + 86_400_000
  }
  if (!DATE_TIME.test(until)) return null
  const ms = Date.parse(until)
  return Number.isNaN(ms) ? null : ms
}

/** True when the rule's `until` has passed at `now` (epoch ms). Rules without `until` never expire. */
export function isExpired(until: string | undefined, now: number): boolean {
  if (until === undefined) return false
  const ms = untilToMs(until)
  return ms === null || now >= ms
}

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** Parses a duration such as `30m`, `12h`, `7d` or `2w` into milliseconds; null if invalid. */
export function parseDuration(text: string): number | null {
  const m = /^(\d{1,6})([mhdw])$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = UNIT_MS[m[2] ?? '']
  return n > 0 && unit !== undefined ? n * unit : null
}

/**
 * Converts a TTL into an absolute `until` (ISO 8601, UTC) relative to `now`.
 * Used by writers of session rules and `rules add --ttl`, so stored rules only
 * ever carry `until`.
 */
export function ttlToUntil(ttl: string, now: number): string | null {
  const ms = parseDuration(ttl)
  return ms === null ? null : new Date(now + ms).toISOString()
}
