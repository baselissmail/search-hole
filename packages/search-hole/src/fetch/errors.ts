// SPDX-License-Identifier: Apache-2.0
/**
 * Typed `fetch` failures. Every refusal is a SearchHoleError whose
 * `details.reason` is a stable code (persistable in `fetches`), so the gateway
 * can render "blocked by your rule …" or "robots.txt disallows …" and the
 * receipt can count refusals by reason.
 */
import { type ErrorCode, SearchHoleError } from '../shared/errors.ts'
import type { RuleRef } from '../shared/types.ts'

export type FetchFailureReason =
  | 'invalid_url'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'ssrf'
  | 'rule'
  | 'canonical_rule'
  | 'robots'
  | 'robots_unavailable'
  | 'too_many_redirects'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'decode'
  | 'invalid_cursor'

const CODE_FOR: Readonly<Record<FetchFailureReason, ErrorCode>> = {
  invalid_url: 'invalid_argument',
  scheme: 'invalid_argument',
  credentials: 'invalid_argument',
  invalid_cursor: 'invalid_argument',
  port: 'fetch_blocked',
  ssrf: 'fetch_blocked',
  rule: 'fetch_blocked',
  canonical_rule: 'fetch_blocked',
  robots: 'fetch_blocked',
  robots_unavailable: 'fetch_blocked',
  too_many_redirects: 'fetch_failed',
  timeout: 'fetch_failed',
  cancelled: 'fetch_failed',
  network: 'fetch_failed',
  decode: 'fetch_failed',
}

const FIX_FOR: Partial<Record<FetchFailureReason, string>> = {
  ssrf: 'search-hole only fetches public web addresses',
  port: 'use the site’s normal http(s) port',
  rule: 'the user blocked this source; pick another result, or ask the user to change the rule',
  canonical_rule: 'the user blocked this source; pick another result, or ask the user to change the rule',
  robots: 'the site asks automated agents not to fetch this page; use another source',
  robots_unavailable: 'retry in a few minutes or use another source',
  too_many_redirects: 'open the final URL directly',
  timeout: 'retry later or use another source',
  invalid_cursor: 'pass the nextCursor from the previous fetch of the same URL, or omit cursor',
}

export interface FetchFailureDetails {
  reason: FetchFailureReason
  url: string
  /** 0 for the requested URL, n for the n-th redirect target. */
  hop?: number
  rule?: RuleRef
  address?: string
  range?: string
  status?: number
}

/** Builds the SearchHoleError for a fetch refusal or failure. */
export function fetchFailure(why: string, details: FetchFailureDetails, cause?: unknown): SearchHoleError {
  const fix = FIX_FOR[details.reason]
  return new SearchHoleError(CODE_FOR[details.reason], why, {
    ...(fix === undefined ? {} : { fix }),
    details: { ...details },
    ...(cause === undefined ? {} : { cause }),
  })
}

/** Reads the stable reason code from an error thrown by fetchPage, if it is one. */
export function fetchFailureReason(err: unknown): FetchFailureReason | null {
  if (!(err instanceof SearchHoleError)) return null
  const reason = err.details?.reason
  return typeof reason === 'string' && reason in CODE_FOR ? (reason as FetchFailureReason) : null
}
