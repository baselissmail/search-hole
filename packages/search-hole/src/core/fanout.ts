// SPDX-License-Identifier: Apache-2.0
/**
 * Fan-out orchestrator (ADR-0009 points 3, 5 and 6). Pure: transport, health storage,
 * usage reservation, clock and sleeping are all injected.
 *
 * Each planned engine runs in its own concurrent *lane*. A lane calls its engine
 * (retrying the same engine only where the error table allows, with backoff). If the
 * engine fails, is suspended, capped or inactive, the lane walks the fallback chain to a
 * *different* engine, at most `maxFallbacks` (2) real hops, checking suspension and spend
 * caps before each hop. An attempted-set shared by all lanes keeps two lanes from using
 * the same engine, so no engine is called twice for one search.
 *
 * Engine errors are data: nothing here throws for an engine failure. Attribution, the
 * hop trail and per-engine outcomes are recorded for the receipt.
 */

import type {
  AdapterCtx,
  EngineAdapter,
  EngineId,
  EnginePlan,
  EngineRun,
  ErrorClass,
  HttpRequest,
  HttpResponse,
  InactiveReason,
  ParseOutcome,
  QuotaInfo,
  RawResult,
  UpstreamDiag,
  Warning,
} from '../shared/types.ts'
import {
  classifyNetworkError,
  type EngineHealth,
  ERROR_POLICY,
  emptyHealth,
  inactiveReasonOf,
  isSuspended,
  nextHealth,
  requestNeverLeft,
} from './health.ts'

type MaybePromise<T> = T | Promise<T>

/** In-memory calls allowed per billed engine, per process, per UTC day, when usage cannot be reserved. */
export const LOCAL_ALLOWANCE_PER_DAY = 20
const DAY_MS = 86_400_000

/** An adapter, optionally able to say how many block rules its request pushes upstream. */
export type FanoutAdapter = EngineAdapter & { readonly pushedRuleCount?: (plan: EnginePlan) => number }

export interface PlannedEngine {
  adapter: FanoutAdapter
  plan: EnginePlan
  ctx: AdapterCtx
}

/** What a transport returns: a response (any status) or a network-level failure code or message. */
export type TransportResult = HttpResponse | { networkError: string }

export type Transport = (req: HttpRequest, signal: AbortSignal, timeoutMs: number) => Promise<TransportResult>

export interface HealthPort {
  get(engine: EngineId): MaybePromise<EngineHealth | null | undefined>
  put(engine: EngineId, state: EngineHealth): MaybePromise<void>
}

export type ReserveResult = 'ok' | 'capped' | 'unavailable'

export interface UsagePort {
  /** Reserves one call before it is made. 'unavailable' means the shared store could not be written. */
  reserve(engine: EngineId): Promise<ReserveResult>
  /** Gives a reservation back; called only when the request provably never left. */
  refund(engine: EngineId): MaybePromise<void>
}

/** Per-process fallback allowance for billed engines while the shared usage store is unavailable. */
export interface LocalAllowance {
  take(engine: EngineId, nowMs: number): boolean
  give(engine: EngineId, nowMs: number): void
}

/** Creates an allowance of `limitPerDay` calls per engine per UTC day. */
export function createLocalAllowance(limitPerDay: number = LOCAL_ALLOWANCE_PER_DAY): LocalAllowance {
  const used = new Map<string, number>()
  const key = (engine: EngineId, nowMs: number) => `${engine}:${Math.floor(nowMs / DAY_MS)}`
  return {
    take(engine, nowMs) {
      const today = Math.floor(nowMs / DAY_MS)
      for (const k of used.keys()) if (!k.endsWith(`:${today}`)) used.delete(k)
      const k = key(engine, nowMs)
      const n = used.get(k) ?? 0
      if (n >= limitPerDay) return false
      used.set(k, n + 1)
      return true
    },
    give(engine, nowMs) {
      const k = key(engine, nowMs)
      const n = used.get(k) ?? 0
      if (n > 0) used.set(k, n - 1)
    },
  }
}

/** The process-wide allowance used when `runEngines` is not given one. */
export const processLocalAllowance: LocalAllowance = createLocalAllowance()

export interface RunEnginesOptions {
  /** Engines to call now, concurrently. */
  plans: readonly PlannedEngine[]
  /** Engines that may be called only as fallbacks; they are used in the order `fallback` lists them. */
  standby?: readonly PlannedEngine[]
  transport: Transport
  health: HealthPort
  usage: UsagePort
  /** The configured fallback chain (ADR-0017: searxng, tavily, brave, exa), filtered to what exists. */
  fallback: readonly EngineId[]
  now: () => number
  signal: AbortSignal
  /** Maximum real fallback hops per lane. Default 2. */
  maxFallbacks?: number
  /** Waits `ms` or until the signal aborts. Injected so tests need no real delay. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  allowance?: LocalAllowance
}

export interface FanoutHop {
  from: EngineId
  to: EngineId
  /** Why the previous engine was left. */
  reason: ErrorClass | InactiveReason | 'upstream_failed'
}

export interface FanoutResult {
  raw: RawResult[]
  runs: EngineRun[]
  warnings: Warning[]
  /** The engines the caller planned, in order. */
  original: EngineId[]
  /** Every engine considered, in the order first taken (planned, then fallbacks). */
  attempted: EngineId[]
  hops: FanoutHop[]
  /** Spellcheck rewrites reported by an engine (Brave `query.altered`). */
  altered: Partial<Record<EngineId, string>>
  quota: Partial<Record<EngineId, QuotaInfo>>
}

// ── Internals ───────────────────────────────────────────────────────────

type Outcome =
  | {
      kind: 'ok'
      results: RawResult[]
      upstream?: UpstreamDiag[]
      quota?: QuotaInfo
      alteredQuery?: string
      pushdownApplied?: boolean
      latencyMs: number
    }
  | { kind: 'empty'; upstream?: UpstreamDiag[]; quota?: QuotaInfo; latencyMs: number }
  | {
      kind: 'error'
      errorClass: ErrorClass
      retryAfterMs?: number
      detail: string
      latencyMs: number
      /** True when the failure proves the request never left the machine. */
      neverLeft: boolean
    }

type Attempt =
  | { kind: 'ok' | 'empty'; run: EngineRun; results: RawResult[]; softFail: boolean }
  | { kind: 'failed'; run: EngineRun; errorClass: ErrorClass }
  | { kind: 'skipped'; run: EngineRun; reason: InactiveReason }
  | { kind: 'cancelled'; run: EngineRun }

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** Keeps run details free of API keys and URLs (a URL can carry the query), and short. */
function redact(text: string, ctx: AdapterCtx): string {
  const cleaned = ctx.apiKey && ctx.apiKey.length >= 4 ? text.split(ctx.apiKey).join('[redacted]') : text
  return cleaned
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}

function runBase(p: PlannedEngine): Pick<EngineRun, 'engine'> & { attribution?: string } {
  const attribution = p.adapter.capabilities.attribution
  return attribution ? { engine: p.adapter.id, attribution } : { engine: p.adapter.id }
}

/** Runs the fan-out. See the module comment for the lane and fallback rules. */
export async function runEngines(opts: RunEnginesOptions): Promise<FanoutResult> {
  const { transport, health, usage, now, signal } = opts
  const maxFallbacks = opts.maxFallbacks ?? 2
  const sleep = opts.sleep ?? defaultSleep
  const allowance = opts.allowance ?? processLocalAllowance

  const candidates = new Map<EngineId, PlannedEngine>()
  for (const p of [...opts.plans, ...(opts.standby ?? [])]) {
    if (!candidates.has(p.adapter.id)) candidates.set(p.adapter.id, p)
  }
  const original = opts.plans.map((p) => p.adapter.id)
  const attempted = new Set<EngineId>(original)
  const attemptedOrder: EngineId[] = [...original]

  const warnings: Warning[] = []
  const warnedLocal = new Set<EngineId>()
  const hops: FanoutHop[] = []
  const altered: Partial<Record<EngineId, string>> = {}
  const quota: Partial<Record<EngineId, QuotaInfo>> = {}
  let gotResponse = false
  /** Offline failures whose health write waits until we know whether anything else got through. */
  const offlineRuns: Array<{ run: EngineRun; p: PlannedEngine; hop?: FanoutHop }> = []

  const isLone = async (id: EngineId): Promise<boolean> => {
    for (const [otherId, c] of candidates) {
      if (otherId === id) continue
      if (!safeSetup(c).active) continue
      const h = await health.get(otherId)
      if (!h || !isSuspended(h, now())) return false
    }
    return true
  }

  const safeSetup = (p: PlannedEngine): ReturnType<EngineAdapter['setup']> => {
    try {
      return p.adapter.setup(p.ctx)
    } catch {
      return { active: false, reason: 'disabled', detail: 'adapter setup failed' }
    }
  }

  /** Takes the next unattempted engine from the fallback chain, or undefined. */
  const takeFallback = (): PlannedEngine | undefined => {
    for (const id of opts.fallback) {
      if (attempted.has(id)) continue
      const c = candidates.get(id)
      if (!c) continue
      attempted.add(id)
      attemptedOrder.push(id)
      return c
    }
    return undefined
  }

  /** One transport call with a per-engine timeout; never throws. */
  const callOnce = async (p: PlannedEngine): Promise<Outcome> => {
    const started = now()
    const timeoutMs = p.ctx.timeoutMs > 0 ? p.ctx.timeoutMs : p.adapter.defaults.timeoutMs
    const fail = (errorClass: ErrorClass, detail: string, neverLeft = false): Outcome => ({
      kind: 'error',
      errorClass,
      detail,
      latencyMs: Math.max(0, now() - started),
      neverLeft,
    })

    let req: HttpRequest
    try {
      req = p.adapter.buildRequest(p.plan, p.ctx)
    } catch {
      return fail('malformed', 'the adapter could not build a request')
    }

    const timer = new AbortController()
    let timedOut = false
    const handle = setTimeout(() => {
      timedOut = true
      timer.abort()
    }, timeoutMs)
    const sig = AbortSignal.any([signal, timer.signal])

    try {
      const pending = Promise.resolve().then(() => transport(req, sig, timeoutMs))
      pending.catch(() => undefined)
      const aborted = new Promise<TransportResult>((resolve) => {
        if (sig.aborted) return resolve({ networkError: 'AbortError' })
        sig.addEventListener('abort', () => resolve({ networkError: 'AbortError' }), { once: true })
      })
      let result: TransportResult
      try {
        result = await Promise.race([pending, aborted])
      } catch (e) {
        result = { networkError: e instanceof Error ? e.name || e.message : 'unreachable' }
      }

      if ('networkError' in result) {
        const code = result.networkError
        let cls = classifyNetworkError(code)
        if (signal.aborted) cls = 'cancelled'
        else if (timedOut || cls === 'cancelled') cls = 'timeout'
        return fail(cls, redact(`network error: ${code}`, p.ctx), requestNeverLeft(code))
      }

      gotResponse = true
      let parsed: ParseOutcome
      try {
        parsed = p.adapter.parseResponse(result, p.plan, p.ctx)
      } catch {
        parsed = { kind: 'error', errorClass: 'malformed', detail: 'the adapter threw while parsing' }
      }
      const latencyMs = Number.isFinite(result.durationMs) ? result.durationMs : Math.max(0, now() - started)
      if (parsed.kind === 'error') {
        return {
          kind: 'error',
          errorClass: parsed.errorClass,
          ...(parsed.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.retryAfterMs }),
          detail: redact(parsed.detail, p.ctx),
          latencyMs,
          neverLeft: false,
        }
      }
      if (parsed.kind === 'ok' && parsed.results.length > 0) {
        return { ...parsed, latencyMs }
      }
      return {
        kind: 'empty',
        ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
        ...(parsed.quota ? { quota: parsed.quota } : {}),
        latencyMs,
      }
    } finally {
      clearTimeout(handle)
    }
  }

  /** Reserves usage for one call. Returns a skip reason when the call must not be made. */
  const reserve = async (
    p: PlannedEngine,
  ): Promise<{ ok: true; local: boolean } | { ok: false; reason: InactiveReason; detail: string }> => {
    const id = p.adapter.id
    let result: ReserveResult
    try {
      result = await usage.reserve(id)
    } catch {
      result = 'unavailable'
    }
    if (result === 'ok') return { ok: true, local: false }
    if (result === 'capped') return { ok: false, reason: 'spend_cap', detail: 'spend cap reached' }
    // The shared usage store could not be written: free engines proceed, billed engines get a small local allowance.
    if (!p.adapter.capabilities.billed) return { ok: true, local: false }
    if (!warnedLocal.has(id)) {
      warnedLocal.add(id)
      warnings.push({ code: 'spend_cap_local', engine: id })
    }
    if (allowance.take(id, now())) return { ok: true, local: true }
    return {
      ok: false,
      reason: 'spend_cap',
      detail: 'spend cap not shared (usage store unavailable); local allowance used up',
    }
  }

  const skipped = (p: PlannedEngine, reason: InactiveReason, detail: string): Attempt => ({
    kind: 'skipped',
    reason,
    run: {
      ...runBase(p),
      status: 'skipped',
      inactiveReason: reason,
      detail: redact(detail, p.ctx),
      returned: 0,
    },
  })

  /** Calls one engine, with same-engine retries where allowed, and records its health. */
  const attempt = async (p: PlannedEngine): Promise<Attempt> => {
    const id = p.adapter.id
    if (signal.aborted) {
      return {
        kind: 'cancelled',
        run: { ...runBase(p), status: 'error', errorClass: 'cancelled', returned: 0 },
      }
    }
    const setup = safeSetup(p)
    if (!setup.active) return skipped(p, setup.reason, setup.detail)

    const before = (await health.get(id)) ?? emptyHealth()
    if (isSuspended(before, now())) {
      const reason = inactiveReasonOf(before, now()) ?? 'suspended'
      const until =
        before.suspendedUntil === null
          ? 'until the cause changes'
          : `until ${new Date(before.suspendedUntil).toISOString()}`
      return skipped(p, reason, `suspended ${until} (${before.suspendedClass ?? 'error'})`)
    }

    let tries = 0
    let outcome: Outcome | undefined
    for (;;) {
      const gate = await reserve(p)
      if (!gate.ok) {
        if (tries === 0) return skipped(p, gate.reason, gate.detail)
        break
      }
      outcome = await callOnce(p)
      if (outcome.kind === 'error' && outcome.neverLeft) {
        if (gate.local) allowance.give(id, now())
        else await usage.refund(id)
      }
      if (outcome.kind !== 'error') break
      const policy = ERROR_POLICY[outcome.errorClass]
      if (!policy.retrySame || tries >= p.adapter.defaults.retry.sameEngineRetries || signal.aborted) break
      await sleep(p.adapter.defaults.retry.backoffMs * 2 ** tries, signal)
      tries += 1
      if (signal.aborted) break
    }
    if (outcome === undefined) return skipped(p, 'spend_cap', 'spend cap reached')

    if (outcome.kind === 'error') {
      const run: EngineRun = {
        ...runBase(p),
        status: 'error',
        latencyMs: outcome.latencyMs,
        errorClass: outcome.errorClass,
        detail: outcome.detail,
        returned: 0,
      }
      if (outcome.errorClass === 'cancelled') return { kind: 'cancelled', run }
      if (outcome.errorClass === 'offline') {
        offlineRuns.push({ run, p })
      } else {
        const lone = await isLone(id)
        const prev = (await health.get(id)) ?? emptyHealth()
        await health.put(
          id,
          nextHealth(
            prev,
            {
              ok: false,
              errorClass: outcome.errorClass,
              lone,
              ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
            },
            now(),
          ),
        )
      }
      return { kind: 'failed', run, errorClass: outcome.errorClass }
    }

    const prev = (await health.get(id)) ?? emptyHealth()
    await health.put(id, nextHealth(prev, { ok: true }, now()))
    if (outcome.quota) quota[id] = outcome.quota
    const upstream = outcome.upstream && outcome.upstream.length > 0 ? outcome.upstream : undefined
    const base: EngineRun = {
      ...runBase(p),
      status: outcome.kind,
      latencyMs: outcome.latencyMs,
      returned: outcome.kind === 'ok' ? outcome.results.length : 0,
      ...(upstream ? { upstream } : {}),
    }
    if (outcome.kind === 'ok') {
      if (outcome.alteredQuery) altered[id] = outcome.alteredQuery
      const pushed = outcome.pushdownApplied === false ? 0 : (p.adapter.pushedRuleCount?.(p.plan) ?? 0)
      if (pushed > 0) base.pushedRuleCount = pushed
      if (outcome.pushdownApplied === false) base.detail = 'block rules were not applied upstream'
      return { kind: 'ok', run: base, results: outcome.results, softFail: false }
    }
    // Zero results while upstream engines failed: the gateway answered, but another engine may do better.
    const softFail = upstream?.some((u) => u.errorClass !== 'unknown') === true
    return { kind: 'empty', run: base, results: [], softFail }
  }

  const needsHop = (a: Attempt): boolean => {
    if (a.kind === 'skipped') return true
    if (a.kind === 'failed') return ERROR_POLICY[a.errorClass].fallback
    if (a.kind === 'empty') return a.softFail
    return false
  }

  const reasonOf = (a: Attempt): FanoutHop['reason'] => {
    if (a.kind === 'skipped') return a.reason
    if (a.kind === 'failed') return a.errorClass
    return 'upstream_failed'
  }

  const lane = async (start: PlannedEngine): Promise<{ runs: EngineRun[]; raw: RawResult[] }> => {
    const runs: EngineRun[] = []
    const raw: RawResult[] = []
    const take = (a: Attempt) => {
      runs.push(a.run)
      if (a.kind === 'ok' || a.kind === 'empty') raw.push(...a.results)
    }

    let last = await attempt(start)
    take(last)
    // The engine we are falling back from, why it was left, and its run (to patch an offline guess later).
    let from: EngineId = start.adapter.id
    let fromReason = reasonOf(last)
    let fromRun = last.run
    let hopCount = 0
    while (needsHop(last) && hopCount < maxFallbacks && !signal.aborted) {
      const next = takeFallback()
      if (!next) break
      const result = await attempt(next)
      take(result)
      last = result
      // A candidate that cannot be called is passed over: it costs no hop and `from` stays put.
      if (result.kind === 'skipped') continue
      hopCount += 1
      const hop: FanoutHop = { from, to: next.adapter.id, reason: fromReason }
      hops.push(hop)
      warnings.push({ code: 'engine_fallback', from, to: next.adapter.id })
      const offline = offlineRuns.find((o) => o.run === fromRun)
      if (offline) offline.hop = hop
      from = next.adapter.id
      fromReason = reasonOf(result)
      fromRun = result.run
    }
    return { runs, raw }
  }

  const lanes = await Promise.all(opts.plans.map((p) => lane(p)))

  // An "offline" failure next to a working engine is really that engine being unreachable.
  for (const o of offlineRuns) {
    if (!gotResponse) continue
    o.run.errorClass = 'unreachable'
    const id = o.p.adapter.id
    const lone = await isLone(id)
    const prev = (await health.get(id)) ?? emptyHealth()
    await health.put(id, nextHealth(prev, { ok: false, errorClass: 'unreachable', lone }, now()))
    if (o.hop) o.hop.reason = 'unreachable'
  }

  return {
    raw: lanes.flatMap((l) => l.raw),
    runs: lanes.flatMap((l) => l.runs),
    warnings,
    original,
    attempted: attemptedOrder,
    hops,
    altered,
    quota,
  }
}
