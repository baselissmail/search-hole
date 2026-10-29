// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP and network error classification shared by every adapter (ADR-0009 point 3).
 * `classifyNetworkError` and `requestNeverLeft` live in core/health.ts, because the
 * pure fan-out in core cannot import from engines; they are re-exported here.
 */

import type { ErrorClass } from '../shared/types.ts'

export { classifyNetworkError, requestNeverLeft } from '../core/health.ts'

const CAPTCHA_BODY =
  /captcha|cf-chl|challenge-platform|attention required|unusual traffic|are you a robot|verify you are human/i
const QUOTA_BODY =
  /quota|usage[_ ]limit|monthly (?:limit|usage)|credits? (?:exhausted|limit)|out of credits|insufficient credits/i

const YEAR_MS = 366 * 24 * 60 * 60_000
const THIRTY_DAYS_S = 30 * 24 * 60 * 60

/**
 * Maps an HTTP status (plus a short body snippet and the lower-cased response headers)
 * to an error class. Returns null for 2xx. Other 4xx statuses mean our request was wrong
 * and count as `malformed` (adapter needs an update). A redirect from an API endpoint is
 * unexpected and also `malformed`.
 */
export function classifyHttp(
  status: number,
  headers: Readonly<Record<string, string>>,
  bodySnippet: string,
): ErrorClass | null {
  if (status >= 200 && status < 300) return null
  const body = bodySnippet.slice(0, 2000)
  const challenged = CAPTCHA_BODY.test(body) || (headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge'
  if (status >= 300 && status < 400) return 'malformed'
  switch (status) {
    case 401:
      return 'auth'
    case 402:
    case 432:
    case 433:
      return 'quota'
    case 403:
      return challenged ? 'captcha' : 'forbidden'
    case 408:
      return 'timeout'
    case 429:
      if (QUOTA_BODY.test(body)) return 'quota'
      return challenged ? 'captcha' : 'rate_limited'
    default:
      break
  }
  if (status >= 500) return status === 503 && challenged ? 'captcha' : 'server'
  return 'malformed'
}

// ── Retry-After and rate-limit reset headers ────────────────────────────

/** Parses `1m30s`, `250ms`, `1.5s`, `2h` or bare seconds into ms; undefined when it is not a duration. */
function parseDuration(raw: string): number | undefined {
  const s = raw.trim().toLowerCase()
  if (s === '') return undefined
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  if (!/^(?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+$/.test(s)) return undefined
  const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  let total = 0
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)) {
    total += Number(m[1]) * (unitMs[m[2] ?? ''] ?? 0)
  }
  return Math.round(total)
}

function clampMs(ms: number): number | undefined {
  if (!Number.isFinite(ms)) return undefined
  return Math.min(Math.max(Math.round(ms), 0), YEAR_MS)
}

/** `x-ratelimit-reset`: below 30 days it is a number of seconds, otherwise a Unix epoch (seconds or ms). */
function parseResetValue(raw: string, now: number): number | undefined {
  const t = raw.trim()
  if (!/^\d+(?:\.\d+)?$/.test(t)) return parseDuration(t)
  const n = Number(t)
  if (n < THIRTY_DAYS_S) return clampMs(n * 1000)
  const epochMs = n >= 1e12 ? n : n * 1000
  return clampMs(epochMs - now)
}

function splitList(raw: string | undefined): string[] {
  return raw === undefined
    ? []
    : raw
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
}

/**
 * How long the server says to wait, in ms, or undefined when it says nothing.
 * Order follows agentgateway's parser (ADR-0009 point 3): `retry-after-ms`, then
 * `Retry-After` (seconds or an HTTP date), then `x-ratelimit-reset`, then the smallest
 * of `x-ratelimit-reset-requests|tokens|requests-day|tokens-minute`.
 * Brave sends comma-separated windows ("1, 1419704"); with `x-ratelimit-remaining` we
 * pick the exhausted window, otherwise the shortest.
 */
export function parseRetryAfter(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v

  const afterMs = h['retry-after-ms']
  if (afterMs !== undefined && /^\s*\d+(?:\.\d+)?\s*$/.test(afterMs)) return clampMs(Number(afterMs))

  const after = h['retry-after']
  if (after !== undefined) {
    if (/^\s*\d+(?:\.\d+)?\s*$/.test(after)) return clampMs(Number(after) * 1000)
    const when = Date.parse(after)
    if (!Number.isNaN(when)) return clampMs(when - now)
  }

  const resets = splitList(h['x-ratelimit-reset']).map((p) => parseResetValue(p, now))
  if (resets.length > 0) {
    const remaining = splitList(h['x-ratelimit-remaining']).map(Number)
    const exhausted: number[] = []
    const all: number[] = []
    resets.forEach((r, i) => {
      if (r === undefined) return
      all.push(r)
      if (remaining[i] === 0) exhausted.push(r)
    })
    if (exhausted.length > 0) return Math.max(...exhausted)
    if (all.length > 0) return Math.min(...all)
  }

  const variants: number[] = []
  for (const name of [
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset-requests-day',
    'x-ratelimit-reset-tokens-minute',
  ]) {
    const raw = h[name]
    if (raw === undefined) continue
    const ms = parseDuration(raw)
    if (ms !== undefined) variants.push(ms)
  }
  if (variants.length > 0) return clampMs(Math.min(...variants))
  return undefined
}
