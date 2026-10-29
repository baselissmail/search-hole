// SPDX-License-Identifier: Apache-2.0
/**
 * Strict date parsing (ADR-0011 point 5). ISO 8601 and RFC 2822 first, then a
 * short list of explicit, unambiguous formats. No natural language ("2 days
 * ago"), no D/M vs M/D guessing. A value without a timezone is taken as UTC
 * and marked `tzAssumed`. Values before 1995-01-01 or more than one day after
 * `now` are rejected. Pure: the caller passes `now`.
 */

export const MIN_DATE_MS = Date.UTC(1995, 0, 1)
export const FUTURE_TOLERANCE_MS = 86_400_000
const MAX_INPUT_CHARS = 80

export interface ParsedDate {
  /** ISO 8601 in UTC, as produced by `Date#toISOString`. */
  value: string
  /** Epoch milliseconds. */
  ms: number
  /** True when the input carried no timezone and UTC was assumed. */
  tzAssumed: boolean
  /** `day` for date-only input, `time` when a time of day was given. */
  precision: 'day' | 'time'
}

export interface ParseDateOptions {
  /** Reference time (epoch ms) for the future-date check. */
  now: number
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

const WEEKDAYS = new Set([
  'mon',
  'monday',
  'tue',
  'tues',
  'tuesday',
  'wed',
  'wednesday',
  'thu',
  'thur',
  'thurs',
  'thursday',
  'fri',
  'friday',
  'sat',
  'saturday',
  'sun',
  'sunday',
])

/** RFC 2822 named zones, in minutes east of UTC. */
const NAMED_ZONES: Readonly<Record<string, number>> = {
  z: 0,
  ut: 0,
  utc: 0,
  gmt: 0,
  est: -300,
  edt: -240,
  cst: -360,
  cdt: -300,
  mst: -420,
  mdt: -360,
  pst: -480,
  pdt: -420,
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*([Zz]|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?)?$/
const RFC2822_RE =
  /^(?:([a-z]{3,9})\.?,?\s+)?(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([+-]\d{4}|[a-z]{1,3}))?)?$/i
const MDY_RE = /^(?:([a-z]{3,9})\.?,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i
const YMD_SEP_RE = /^(\d{4})([/.])(\d{1,2})\2(\d{1,2})\.?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const CJK_RE =
  /^(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일](?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/

interface Parts {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
  ms: number
  /** Minutes east of UTC, or null when the input had no zone. */
  offset: number | null
  precision: 'day' | 'time'
}

const int = (s: string | undefined): number => (s === undefined ? 0 : Number.parseInt(s, 10))

function parseOffset(zone: string | undefined): number | null | 'invalid' {
  if (zone === undefined || zone === '') return null
  const named = NAMED_ZONES[zone.toLowerCase()]
  if (named !== undefined) return named
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)
  if (!m) return 'invalid'
  const hours = int(m[2])
  const minutes = int(m[3])
  if (hours > 14 || minutes > 59) return 'invalid'
  return (m[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

function fromIso(input: string): Parts | null {
  const m = ISO_RE.exec(input)
  if (!m) return null
  const offset = parseOffset(m[8])
  if (offset === 'invalid') return null
  const fraction = m[7] === undefined ? 0 : Number.parseInt(m[7].slice(0, 3).padEnd(3, '0'), 10)
  return {
    y: int(m[1]),
    mo: int(m[2]),
    d: int(m[3]),
    h: int(m[4]),
    mi: int(m[5]),
    s: int(m[6]),
    ms: fraction,
    offset: m[4] === undefined ? null : offset,
    precision: m[4] === undefined ? 'day' : 'time',
  }
}

function fromRfc2822(input: string): Parts | null {
  const m = RFC2822_RE.exec(input)
  if (!m) return null
  if (m[1] !== undefined && !WEEKDAYS.has(m[1].toLowerCase())) return null
  const mo = MONTHS[(m[3] ?? '').toLowerCase()]
  if (mo === undefined) return null
  const offset = parseOffset(m[8])
  if (offset === 'invalid') return null
  return {
    y: int(m[4]),
    mo,
    d: int(m[2]),
    h: int(m[5]),
    mi: int(m[6]),
    s: int(m[7]),
    ms: 0,
    offset: m[5] === undefined ? null : offset,
    precision: m[5] === undefined ? 'day' : 'time',
  }
}

function fromMdy(input: string): Parts | null {
  const m = MDY_RE.exec(input)
  if (!m) return null
  if (m[1] !== undefined && !WEEKDAYS.has(m[1].toLowerCase())) return null
  const mo = MONTHS[(m[2] ?? '').toLowerCase()]
  if (mo === undefined) return null
  return { y: int(m[4]), mo, d: int(m[3]), h: 0, mi: 0, s: 0, ms: 0, offset: null, precision: 'day' }
}

function fromNumericYmd(re: RegExp, input: string, idx: [number, number, number, number]): Parts | null {
  const m = re.exec(input)
  if (!m) return null
  const [mo, d, h] = [m[idx[0]], m[idx[1]], m[idx[2]]]
  const hasTime = h !== undefined
  return {
    y: int(m[1]),
    mo: int(mo),
    d: int(d),
    h: int(h),
    mi: int(m[idx[3]]),
    s: int(m[idx[3] + 1]),
    ms: 0,
    offset: null,
    precision: hasTime ? 'time' : 'day',
  }
}

/** Builds epoch ms from validated parts, or null when any field is out of range. */
function toEpoch(p: Parts): number | null {
  if (p.mo < 1 || p.mo > 12 || p.d < 1 || p.d > 31) return null
  if (p.h > 23 || p.mi > 59 || p.s > 59) return null
  const local = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms)
  const check = new Date(Date.UTC(p.y, p.mo - 1, p.d))
  if (check.getUTCFullYear() !== p.y || check.getUTCMonth() !== p.mo - 1 || check.getUTCDate() !== p.d) {
    return null
  }
  return local - (p.offset ?? 0) * 60_000
}

/** True when `ms` lies inside the ADR-0011 plausibility window for `now`. */
export function isPlausibleDate(ms: number, now: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_DATE_MS && ms <= now + FUTURE_TOLERANCE_MS
}

/**
 * Parses one machine-readable date string. Returns null for anything that is
 * not an exact, supported format, or that falls outside the plausible window.
 */
export function parseStrictDate(raw: string, opts: ParseDateOptions): ParsedDate | null {
  if (typeof raw !== 'string') return null
  const input = raw.replace(/[   ]/g, ' ').trim().replace(/\s+/g, ' ')
  if (input.length < 6 || input.length > MAX_INPUT_CHARS) return null
  const parts =
    fromIso(input) ??
    fromRfc2822(input) ??
    fromMdy(input) ??
    fromNumericYmd(YMD_SEP_RE, input, [3, 4, 5, 6]) ??
    fromNumericYmd(CJK_RE, input, [2, 3, 4, 5])
  if (!parts) return null
  const ms = toEpoch(parts)
  if (ms === null || !isPlausibleDate(ms, opts.now)) return null
  return {
    value: new Date(ms).toISOString(),
    ms,
    tzAssumed: parts.offset === null,
    precision: parts.precision,
  }
}
