// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ErrorClass } from '../shared/types.ts'
import {
  classifyNetworkError,
  clearOnEvent,
  type EngineHealth,
  ERROR_POLICY,
  emptyHealth,
  HEALTH_WINDOW_MS,
  healthStateOf,
  inactiveReasonOf,
  isSuspended,
  MAX_BACKOFF_MS,
  nextHealth,
  requestNeverLeft,
} from './health.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const SEC = 1000
const MIN = 60_000
const HOUR = 60 * MIN

const ALL_CLASSES = Object.keys(ERROR_POLICY) as ErrorClass[]

const fail = (
  h: EngineHealth,
  errorClass: ErrorClass,
  at: number,
  extra: { retryAfterMs?: number; lone?: boolean } = {},
) => nextHealth(h, { ok: false, errorClass, ...extra }, at)

describe('ERROR_POLICY (ADR-0009 point 3 table)', () => {
  it('covers every error class', () => {
    expect(ALL_CLASSES.sort()).toEqual(
      [
        'auth',
        'bad_request',
        'cancelled',
        'captcha',
        'forbidden',
        'json_disabled',
        'malformed',
        'offline',
        'quota',
        'rate_limited',
        'server',
        'timeout',
        'unreachable',
      ].sort(),
    )
  })

  it('matches the documented suspension rules', () => {
    expect(ERROR_POLICY.offline.suspend).toEqual({ kind: 'none' })
    expect(ERROR_POLICY.unreachable.suspend).toEqual({ kind: 'fixed', ms: 30 * SEC })
    expect(ERROR_POLICY.timeout.suspend).toEqual({ kind: 'backoff', baseMs: 5 * SEC })
    expect(ERROR_POLICY.rate_limited.suspend).toMatchObject({ kind: 'reset', defaultMs: 180 * SEC })
    expect(ERROR_POLICY.quota.suspend).toMatchObject({ kind: 'reset', defaultMs: 24 * HOUR })
    expect(ERROR_POLICY.auth.suspend).toEqual({ kind: 'until_event', event: 'key_change' })
    expect(ERROR_POLICY.forbidden.suspend).toEqual({ kind: 'fixed', ms: HOUR })
    expect(ERROR_POLICY.json_disabled.suspend).toEqual({ kind: 'until_event', event: 'config_change' })
    expect(ERROR_POLICY.captcha.suspend).toEqual({ kind: 'fixed', ms: HOUR })
    expect(ERROR_POLICY.server.suspend).toEqual({ kind: 'backoff', baseMs: 30 * SEC })
    expect(ERROR_POLICY.malformed.suspend).toEqual({ kind: 'none' })
  })

  it('retries the same engine only for server errors', () => {
    expect(ALL_CLASSES.filter((c) => ERROR_POLICY[c].retrySame)).toEqual(['server'])
  })

  it('has a user-facing fix line for every class and flags only malformed as adapter_broken', () => {
    for (const c of ALL_CLASSES) expect(ERROR_POLICY[c].fix.length).toBeGreaterThan(10)
    expect(ALL_CLASSES.filter((c) => ERROR_POLICY[c].adapterBroken)).toEqual(['malformed'])
  })
})

describe('nextHealth: suspension durations', () => {
  it('suspends an unreachable engine for a constant 30 s, without backoff growth', () => {
    let h = emptyHealth()
    for (let i = 0; i < 6; i++) {
      h = fail(h, 'unreachable', NOW)
      expect(h.suspendedUntil).toBe(NOW + 30 * SEC)
    }
    expect(h.consecutiveFailures).toBe(6)
  })

  it('doubles timeout suspensions from 5 s and caps them at one hour', () => {
    let h = emptyHealth()
    const seen: number[] = []
    for (let i = 0; i < 16; i++) {
      h = fail(h, 'timeout', NOW)
      seen.push((h.suspendedUntil ?? 0) - NOW)
    }
    expect(seen.slice(0, 5)).toEqual([5 * SEC, 10 * SEC, 20 * SEC, 40 * SEC, 80 * SEC])
    expect(Math.max(...seen)).toBe(MAX_BACKOFF_MS)
    expect(seen.at(-1)).toBe(HOUR)
  })

  it('starts server-error backoff at 30 s', () => {
    const h1 = fail(emptyHealth(), 'server', NOW)
    expect((h1.suspendedUntil ?? 0) - NOW).toBe(30 * SEC)
    const h2 = fail(h1, 'server', NOW)
    expect((h2.suspendedUntil ?? 0) - NOW).toBe(60 * SEC)
  })

  it('honours the server reset hint for rate limits and falls back to 180 s', () => {
    expect(fail(emptyHealth(), 'rate_limited', NOW, { retryAfterMs: 14 * MIN }).suspendedUntil).toBe(
      NOW + 14 * MIN,
    )
    expect(fail(emptyHealth(), 'rate_limited', NOW).suspendedUntil).toBe(NOW + 180 * SEC)
    // A hint beyond a day is clamped.
    expect(fail(emptyHealth(), 'rate_limited', NOW, { retryAfterMs: 90 * 24 * HOUR }).suspendedUntil).toBe(
      NOW + 24 * HOUR,
    )
  })

  it('suspends on quota until the reset, else 24 h', () => {
    expect(fail(emptyHealth(), 'quota', NOW).suspendedUntil).toBe(NOW + 24 * HOUR)
    expect(fail(emptyHealth(), 'quota', NOW, { retryAfterMs: 5 * 24 * HOUR }).suspendedUntil).toBe(
      NOW + 5 * 24 * HOUR,
    )
  })

  it('suspends forbidden and captcha for one hour', () => {
    expect(fail(emptyHealth(), 'forbidden', NOW).suspendedUntil).toBe(NOW + HOUR)
    expect(fail(emptyHealth(), 'captcha', NOW).suspendedUntil).toBe(NOW + HOUR)
  })

  it('suspends auth and json_disabled until their event, not by time', () => {
    const auth = fail(emptyHealth(), 'auth', NOW)
    expect(auth).toMatchObject({
      suspendedUntil: null,
      suspendedUntilEvent: 'key_change',
      suspendedClass: 'auth',
    })
    expect(isSuspended(auth, NOW + 365 * 24 * HOUR)).toBe(true)
    const json = fail(emptyHealth(), 'json_disabled', NOW)
    expect(json).toMatchObject({ suspendedUntilEvent: 'config_change', suspendedClass: 'json_disabled' })
    expect(inactiveReasonOf(json, NOW)).toBe('json_disabled')
    expect(inactiveReasonOf(auth, NOW)).toBe('suspended')
  })

  it('lifts an open-ended suspension only on its own event', () => {
    const auth = fail(emptyHealth(), 'auth', NOW)
    expect(isSuspended(clearOnEvent(auth, 'config_change'), NOW)).toBe(true)
    const cleared = clearOnEvent(auth, 'key_change')
    expect(isSuspended(cleared, NOW)).toBe(false)
    expect(cleared.suspendedClass).toBeNull()
  })

  it('does not suspend on offline or malformed, and flags malformed as adapter_broken', () => {
    const offline = fail(emptyHealth(), 'offline', NOW)
    expect(offline).toEqual(emptyHealth())
    const malformed = fail(emptyHealth(), 'malformed', NOW)
    expect(isSuspended(malformed, NOW)).toBe(false)
    expect(malformed.adapterBroken).toBe(true)
    expect(malformed.consecutiveFailures).toBe(1)
  })

  it('ignores cancellations entirely', () => {
    const h = fail(emptyHealth(), 'timeout', NOW)
    expect(fail(h, 'cancelled', NOW + SEC)).toBe(h)
  })

  it('never shortens an active suspension, and keeps an open-ended one', () => {
    const long = fail(emptyHealth(), 'captcha', NOW)
    const after = fail(long, 'unreachable', NOW + SEC)
    expect(after.suspendedUntil).toBe(NOW + HOUR)
    expect(after.suspendedClass).toBe('captcha')
    const auth = fail(emptyHealth(), 'auth', NOW)
    const stillAuth = fail(auth, 'timeout', NOW + SEC)
    expect(stillAuth.suspendedUntilEvent).toBe('key_change')
    expect(stillAuth.suspendedClass).toBe('auth')
  })
})

describe('nextHealth: success resets', () => {
  it('clears failures, suspension and the adapter_broken flag', () => {
    let h = emptyHealth()
    h = fail(h, 'malformed', NOW)
    h = fail(h, 'timeout', NOW)
    h = fail(h, 'auth', NOW)
    expect(h.consecutiveFailures).toBe(3)
    const ok = nextHealth(h, { ok: true }, NOW + MIN)
    expect(ok).toEqual({
      consecutiveFailures: 0,
      lastAttemptAt: NOW + MIN,
      lastOk: true,
      lastSuccessAt: NOW + MIN,
      lastErrorClass: null,
      suspendedUntil: null,
      suspendedUntilEvent: null,
      suspendedClass: null,
      adapterBroken: false,
    })
  })

  it('restarts the backoff ladder after a success', () => {
    let h = emptyHealth()
    for (let i = 0; i < 5; i++) h = fail(h, 'timeout', NOW)
    h = nextHealth(h, { ok: true }, NOW)
    expect((fail(h, 'timeout', NOW).suspendedUntil ?? 0) - NOW).toBe(5 * SEC)
  })
})

describe('nextHealth: the lone-engine rule', () => {
  it('does not suspend the last engine on non-explicit signals', () => {
    for (const c of ['unreachable', 'timeout', 'forbidden', 'captcha', 'server', 'malformed'] as const) {
      const h = fail(emptyHealth(), c, NOW, { lone: true })
      expect(isSuspended(h, NOW), c).toBe(false)
      expect(h.lastOk).toBe(false)
      expect(h.consecutiveFailures).toBe(1)
    }
  })

  it('suspends the last engine on explicit signals', () => {
    expect(isSuspended(fail(emptyHealth(), 'auth', NOW, { lone: true }), NOW)).toBe(true)
    expect(isSuspended(fail(emptyHealth(), 'quota', NOW, { lone: true }), NOW)).toBe(true)
    expect(isSuspended(fail(emptyHealth(), 'json_disabled', NOW, { lone: true }), NOW)).toBe(true)
  })

  it('suspends the last engine on a 429 only when the server named a reset', () => {
    expect(isSuspended(fail(emptyHealth(), 'rate_limited', NOW, { lone: true }), NOW)).toBe(false)
    const withReset = fail(emptyHealth(), 'rate_limited', NOW, { lone: true, retryAfterMs: 60 * SEC })
    expect(withReset.suspendedUntil).toBe(NOW + 60 * SEC)
  })

  it('still suspends when it is not the last engine', () => {
    expect(isSuspended(fail(emptyHealth(), 'timeout', NOW, { lone: false }), NOW)).toBe(true)
  })
})

describe('healthStateOf: three states', () => {
  it('is unknown with no record or no attempt', () => {
    expect(healthStateOf(undefined, NOW)).toBe('unknown')
    expect(healthStateOf(null, NOW)).toBe('unknown')
    expect(healthStateOf(emptyHealth(), NOW)).toBe('unknown')
  })

  it('is healthy after a success inside the 10-minute window and unknown after it', () => {
    const h = nextHealth(emptyHealth(), { ok: true }, NOW)
    expect(healthStateOf(h, NOW)).toBe('healthy')
    expect(healthStateOf(h, NOW + HEALTH_WINDOW_MS)).toBe('healthy')
    expect(healthStateOf(h, NOW + HEALTH_WINDOW_MS + 1)).toBe('unknown')
  })

  it('is unhealthy while suspended, even with a recent success', () => {
    const ok = nextHealth(emptyHealth(), { ok: true }, NOW)
    const h = fail(ok, 'rate_limited', NOW + SEC, { retryAfterMs: 5 * MIN })
    expect(healthStateOf(h, NOW + 2 * SEC)).toBe('unhealthy')
    // After the suspension ends the last attempt still failed, until the window runs out.
    expect(healthStateOf(h, NOW + 6 * MIN)).toBe('unhealthy')
    expect(healthStateOf(h, NOW + SEC + HEALTH_WINDOW_MS + 1)).toBe('unknown')
  })

  it('is unhealthy when the last attempt failed without a suspension (lone engine)', () => {
    const h = fail(emptyHealth(), 'timeout', NOW, { lone: true })
    expect(healthStateOf(h, NOW + SEC)).toBe('unhealthy')
  })

  it('is unhealthy when capped or inactive, whatever the record says', () => {
    const ok = nextHealth(emptyHealth(), { ok: true }, NOW)
    expect(healthStateOf(ok, NOW, { capped: true })).toBe('unhealthy')
    expect(healthStateOf(ok, NOW, { inactive: true })).toBe('unhealthy')
    expect(healthStateOf(undefined, NOW, { inactive: true })).toBe('unhealthy')
  })

  it('does not let offline blips turn a healthy engine unhealthy', () => {
    const ok = nextHealth(emptyHealth(), { ok: true }, NOW)
    expect(healthStateOf(fail(ok, 'offline', NOW + SEC), NOW + 2 * SEC)).toBe('healthy')
  })
})

describe('nextHealth: properties', () => {
  type Step =
    | { ok: true }
    | { ok: false; errorClass: ErrorClass; lone: boolean; retryAfterMs: number | undefined }
  const classArb = fc.constantFrom(...ALL_CLASSES)
  const failureArb: fc.Arbitrary<Step> = fc.record({
    ok: fc.constant(false as const),
    errorClass: classArb,
    lone: fc.boolean(),
    retryAfterMs: fc.option(fc.integer({ min: 0, max: 10 * 24 * HOUR }), { nil: undefined }),
  })
  const stepArb: fc.Arbitrary<Step> = fc.oneof(fc.constant<Step>({ ok: true }), failureArb)

  const apply = (h: EngineHealth, s: Step, t: number, forceLone?: boolean): EngineHealth =>
    s.ok
      ? nextHealth(h, s, t)
      : nextHealth(
          h,
          {
            ok: false,
            errorClass: s.errorClass,
            lone: forceLone ?? s.lone,
            ...(s.retryAfterMs === undefined ? {} : { retryAfterMs: s.retryAfterMs }),
          },
          t,
        )

  const run = (steps: Step[]) => {
    let h = emptyHealth()
    let t = NOW
    const trace: Array<{ h: EngineHealth; t: number }> = []
    for (const s of steps) {
      t += 7 * SEC
      h = apply(h, s, t)
      trace.push({ h, t })
    }
    return { h, t, trace }
  }

  it('keeps every number finite and every timed suspension within 31 days', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 80 }), (steps) => {
        const { trace } = run(steps)
        for (const { h, t } of trace) {
          expect(Number.isInteger(h.consecutiveFailures) && h.consecutiveFailures >= 0).toBe(true)
          if (h.suspendedUntil !== null) {
            expect(Number.isFinite(h.suspendedUntil)).toBe(true)
            expect(h.suspendedUntil - t).toBeLessThanOrEqual(31 * 24 * HOUR)
          }
        }
      }),
    )
  })

  it('never suspends longer than the one-hour cap for backoff and fixed classes', () => {
    const boundedArb = fc.record({
      ok: fc.constant(false as const),
      errorClass: fc.constantFrom('timeout', 'unreachable', 'server', 'forbidden', 'captcha' as const),
      lone: fc.constant(false),
      retryAfterMs: fc.constant(undefined),
    })
    fc.assert(
      fc.property(fc.array(boundedArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const { trace } = run(steps)
        for (const { h, t } of trace) expect((h.suspendedUntil ?? t) - t).toBeLessThanOrEqual(MAX_BACKOFF_MS)
      }),
    )
  })

  it('a success always returns to a clean slate, whatever came before', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        const { h, t } = run(steps)
        const ok = nextHealth(h, { ok: true }, t + SEC)
        expect(ok.consecutiveFailures).toBe(0)
        expect(isSuspended(ok, t + SEC)).toBe(false)
        expect(ok.adapterBroken).toBe(false)
        expect(healthStateOf(ok, t + SEC)).toBe('healthy')
      }),
    )
  })

  it('a lone engine is only ever suspended by explicit signals', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 60 }), (steps) => {
        let h = emptyHealth()
        let t = NOW
        for (const s of steps) {
          t += 7 * SEC
          const before = h
          h = apply(h, s, t, true)
          if (s.ok || isSuspended(before, t)) continue
          if (isSuspended(h, t)) {
            const p = ERROR_POLICY[s.errorClass]
            expect(
              p.explicit === 'always' || (p.explicit === 'with_reset' && s.retryAfterMs !== undefined),
            ).toBe(true)
          }
        }
      }),
    )
  })

  it('consecutive timeout backoff is non-decreasing until a success', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (n) => {
        let h = emptyHealth()
        let prev = 0
        for (let i = 0; i < n; i++) {
          h = fail(h, 'timeout', NOW)
          const len = (h.suspendedUntil ?? 0) - NOW
          expect(len).toBeGreaterThanOrEqual(prev)
          expect(len).toBeLessThanOrEqual(MAX_BACKOFF_MS)
          prev = len
        }
      }),
    )
  })
})

describe('network classification is reachable from core', () => {
  it('classifies and tells whether the request left', () => {
    expect(classifyNetworkError('ECONNREFUSED')).toBe('unreachable')
    expect(classifyNetworkError('ENOTFOUND')).toBe('offline')
    expect(requestNeverLeft('ECONNREFUSED')).toBe(true)
    expect(requestNeverLeft('ETIMEDOUT')).toBe(false)
  })
})
