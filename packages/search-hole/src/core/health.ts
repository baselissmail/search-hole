// SPDX-License-Identifier: Apache-2.0
/**
 * Engine health and suspension (ADR-0009 points 3 and 4). Pure: every function takes
 * the previous state and a timestamp and returns the next state. Persistence (the
 * `engine_health` table) and the clock belong to the caller.
 *
 * Three states:
 * - healthy:   the last attempt succeeded within the 10-minute window and no suspension applies
 * - unhealthy: suspended, capped, inactive, or the last attempt (inside the window) failed
 * - unknown:   no attempt yet, or none recent
 */

import type { ErrorClass, HealthState, InactiveReason } from '../shared/types.ts'

/** A success or failure older than this says nothing about the engine now. */
export const HEALTH_WINDOW_MS = 10 * 60_000
/** Exponential backoff never exceeds this (ADR-0009: capped at 1 h). */
export const MAX_BACKOFF_MS = 60 * 60_000

const SECOND = 1000
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/** What can lift an open-ended suspension. */
export type SuspendEvent = 'key_change' | 'config_change'

export type SuspendRule =
  | { kind: 'none' }
  /** A constant duration; consecutive failures do not lengthen it. */
  | { kind: 'fixed'; ms: number }
  /** `baseMs × 2^(consecutive − 1)`, capped at one hour. */
  | { kind: 'backoff'; baseMs: number }
  /** The server's reset hint (Retry-After and friends) when given, else `defaultMs`; never above `maxMs`. */
  | { kind: 'reset'; defaultMs: number; maxMs: number }
  /** Until something changes, for example the user stores a new key. */
  | { kind: 'until_event'; event: SuspendEvent }

export interface ErrorPolicy {
  suspend: SuspendRule
  /** The same engine may be retried (bounded by the adapter's `retry.sameEngineRetries`). */
  retrySame: boolean
  /** A different engine may take over right away. */
  fallback: boolean
  /**
   * Whether this class may suspend the last engine standing (ADR-0009 point 3):
   * `always` for explicit signals, `with_reset` when the server also named a reset time, `never` otherwise.
   */
  explicit: 'always' | 'with_reset' | 'never'
  /** False for classes that say nothing about the engine itself (offline, cancelled). */
  recordsAttempt: boolean
  /** Sets the `adapter_broken` flag (a parse failure means the adapter needs an update). */
  adapterBroken: boolean
  /** One user-facing line, engine-agnostic; callers prefix the engine name. */
  fix: string
}

/** The ADR-0009 point 3 table, as data. */
export const ERROR_POLICY: Readonly<Record<ErrorClass, ErrorPolicy>> = {
  offline: {
    suspend: { kind: 'none' },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: false,
    adapterBroken: false,
    fix: 'You appear to be offline.',
  },
  unreachable: {
    suspend: { kind: 'fixed', ms: 30 * SECOND },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The engine is not reachable. Check that it is running, or run `searchhole doctor`.',
  },
  timeout: {
    suspend: { kind: 'backoff', baseMs: 5 * SECOND },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The engine timed out.',
  },
  rate_limited: {
    suspend: { kind: 'reset', defaultMs: 180 * SECOND, maxMs: DAY },
    retrySame: false,
    fallback: true,
    explicit: 'with_reset',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The engine is rate-limited; it resumes automatically.',
  },
  quota: {
    suspend: { kind: 'reset', defaultMs: DAY, maxMs: 31 * DAY },
    retrySame: false,
    fallback: true,
    explicit: 'always',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The monthly quota is used up.',
  },
  auth: {
    suspend: { kind: 'until_event', event: 'key_change' },
    retrySame: false,
    fallback: true,
    explicit: 'always',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The API key was rejected. Set a valid key with `searchhole keys set <engine>`.',
  },
  forbidden: {
    suspend: { kind: 'fixed', ms: HOUR },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The engine refused the request (HTTP 403).',
  },
  json_disabled: {
    suspend: { kind: 'until_event', event: 'config_change' },
    retrySame: false,
    fallback: true,
    explicit: 'always',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'Enable `json` in SearXNG `search.formats`, or run `searchhole searxng up`.',
  },
  captcha: {
    suspend: { kind: 'fixed', ms: HOUR },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'An upstream engine served a CAPTCHA. Consider a keyed engine.',
  },
  server: {
    suspend: { kind: 'backoff', baseMs: 30 * SECOND },
    retrySame: true,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The engine returned a server error.',
  },
  malformed: {
    suspend: { kind: 'none' },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: true,
    fix: 'The adapter could not read the response. It may need an update; please report this.',
  },
  bad_request: {
    suspend: { kind: 'none' },
    retrySame: false,
    fallback: true,
    explicit: 'never',
    recordsAttempt: true,
    adapterBroken: false,
    fix: 'The engine rejected this request (for example an unsupported query). Try rephrasing; report it if it repeats.',
  },
  cancelled: {
    suspend: { kind: 'none' },
    retrySame: false,
    fallback: false,
    explicit: 'never',
    recordsAttempt: false,
    adapterBroken: false,
    fix: 'The search was cancelled.',
  },
}

/** Persisted per engine (and per key fingerprint, by the store). Plain data: JSON-safe. */
export interface EngineHealth {
  consecutiveFailures: number
  /** Epoch ms of the last recorded attempt, or null. */
  lastAttemptAt: number | null
  lastOk: boolean | null
  lastSuccessAt: number | null
  lastErrorClass: ErrorClass | null
  /** Epoch ms; null when not under a timed suspension. */
  suspendedUntil: number | null
  /** Open-ended suspension, lifted by `clearOnEvent`. */
  suspendedUntilEvent: SuspendEvent | null
  /** The class that caused the current suspension. */
  suspendedClass: ErrorClass | null
  adapterBroken: boolean
}

export type HealthOutcome =
  | { ok: true }
  | {
      ok: false
      errorClass: ErrorClass
      /** The server's reset hint in ms (see `parseRetryAfter`). */
      retryAfterMs?: number
      /** True when no other engine is available (ADR-0009: only explicit signals suspend the last engine). */
      lone?: boolean
    }

/** A fresh record: nothing known. */
export function emptyHealth(): EngineHealth {
  return {
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastOk: null,
    lastSuccessAt: null,
    lastErrorClass: null,
    suspendedUntil: null,
    suspendedUntilEvent: null,
    suspendedClass: null,
    adapterBroken: false,
  }
}

/** True while a timed or open-ended suspension applies. */
export function isSuspended(h: EngineHealth, now: number): boolean {
  return h.suspendedUntilEvent !== null || (h.suspendedUntil !== null && now < h.suspendedUntil)
}

/** Why an engine is not being called right now, in the receipt vocabulary; null when it can be called. */
export function inactiveReasonOf(h: EngineHealth, now: number): InactiveReason | null {
  if (!isSuspended(h, now)) return null
  return h.suspendedClass === 'json_disabled' ? 'json_disabled' : 'suspended'
}

/** The user-visible three-state health. `capped` and `inactive` come from the caller (usage table, setup()). */
export function healthStateOf(
  h: EngineHealth | null | undefined,
  now: number,
  ext: { capped?: boolean; inactive?: boolean } = {},
): HealthState {
  if (ext.capped === true || ext.inactive === true) return 'unhealthy'
  if (!h) return 'unknown'
  if (isSuspended(h, now)) return 'unhealthy'
  if (h.lastAttemptAt === null || now - h.lastAttemptAt > HEALTH_WINDOW_MS) return 'unknown'
  return h.lastOk === true ? 'healthy' : 'unhealthy'
}

/** Whether an error outcome may suspend the engine, given the lone-engine rule. */
function mayGoSuspended(policy: ErrorPolicy, outcome: { retryAfterMs?: number; lone?: boolean }): boolean {
  if (outcome.lone !== true) return true
  if (policy.explicit === 'always') return true
  return policy.explicit === 'with_reset' && outcome.retryAfterMs !== undefined
}

/** The suspension length for a timed rule, or null for an open-ended rule. */
function suspendMs(rule: SuspendRule, failures: number, retryAfterMs: number | undefined): number | null {
  switch (rule.kind) {
    case 'none':
    case 'until_event':
      return null
    case 'fixed':
      return rule.ms
    case 'backoff': {
      const exp = Math.min(Math.max(failures - 1, 0), 30)
      return Math.min(rule.baseMs * 2 ** exp, MAX_BACKOFF_MS)
    }
    case 'reset': {
      const hinted =
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : rule.defaultMs
      return Math.min(Math.max(hinted, 0), rule.maxMs)
    }
  }
}

/**
 * Applies one finished attempt to the stored health. Success resets everything.
 * Failures count, suspend according to `ERROR_POLICY`, and never suspend the last
 * engine standing unless the signal is explicit. `offline` and `cancelled` leave the
 * record untouched (they say nothing about the engine).
 */
export function nextHealth(prev: EngineHealth, outcome: HealthOutcome, now: number): EngineHealth {
  if (outcome.ok) {
    return {
      consecutiveFailures: 0,
      lastAttemptAt: now,
      lastOk: true,
      lastSuccessAt: now,
      lastErrorClass: null,
      suspendedUntil: null,
      suspendedUntilEvent: null,
      suspendedClass: null,
      adapterBroken: false,
    }
  }
  const policy = ERROR_POLICY[outcome.errorClass]
  if (!policy.recordsAttempt) return prev

  const failures = prev.consecutiveFailures + 1
  const stillSuspended = isSuspended(prev, now)
  let suspendedUntil = stillSuspended ? prev.suspendedUntil : null
  let suspendedUntilEvent = stillSuspended ? prev.suspendedUntilEvent : null
  let suspendedClass = stillSuspended ? prev.suspendedClass : null

  if (policy.suspend.kind !== 'none' && mayGoSuspended(policy, outcome)) {
    if (policy.suspend.kind === 'until_event') {
      suspendedUntilEvent = policy.suspend.event
      suspendedUntil = null
      suspendedClass = outcome.errorClass
    } else {
      const ms = suspendMs(policy.suspend, failures, outcome.retryAfterMs)
      if (ms !== null && ms > 0) {
        const until = now + ms
        if (suspendedUntil === null || until > suspendedUntil) {
          suspendedUntil = until
          // An open-ended suspension already in force keeps its own class.
          if (suspendedUntilEvent === null) suspendedClass = outcome.errorClass
        }
      }
    }
  }

  return {
    consecutiveFailures: failures,
    lastAttemptAt: now,
    lastOk: false,
    lastSuccessAt: prev.lastSuccessAt,
    lastErrorClass: outcome.errorClass,
    suspendedUntil,
    suspendedUntilEvent,
    suspendedClass,
    adapterBroken: prev.adapterBroken || policy.adapterBroken,
  }
}

/** Lifts an open-ended suspension when the event it waits for has happened (new key, config change). */
export function clearOnEvent(h: EngineHealth, event: SuspendEvent): EngineHealth {
  if (h.suspendedUntilEvent !== event) return h
  return {
    ...h,
    suspendedUntilEvent: null,
    suspendedClass: h.suspendedUntil === null ? null : h.suspendedClass,
  }
}

// ── Network error classification ────────────────────────────────────────

/**
 * Maps a transport-level failure (a Node error code, an error name or a message) to an
 * error class. Timeouts are checked before aborts because `AbortSignal.timeout()` errors
 * mention both. Unknown failures count as `unreachable`.
 */
export function classifyNetworkError(code: string): ErrorClass {
  const c = code.toUpperCase()
  if (/TIMEOUT|TIMED[ _]OUT|ETIMEDOUT/.test(c)) return 'timeout'
  if (/ABORT/.test(c)) return 'cancelled'
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN/.test(c)) return 'offline'
  return 'unreachable'
}

/**
 * True when the failure proves the request never left the machine, so a spend
 * reservation can be refunded (ADR-0009 point 6). Timeouts and resets are not refunded.
 */
export function requestNeverLeft(code: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|CERT|SSL|TLS/.test(
    code.toUpperCase(),
  )
}
