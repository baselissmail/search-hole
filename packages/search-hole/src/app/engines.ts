// SPDX-License-Identifier: Apache-2.0
/**
 * Engine wiring for one App (ADR-0007, ADR-0009, ADR-0017): the configured P1 adapters,
 * their keys and key fingerprints, shared health and spend-cap usage backed by the store
 * (in-memory when it is unavailable), the origin-pinned engine transport with per-engine
 * concurrency limits, and status and probes for `doctor` and the hooks.
 */
import { createHmac, randomBytes } from 'node:crypto'
import type { HealthPort, Transport, UsagePort } from '../core/fanout.ts'
import {
  type EngineHealth,
  ERROR_POLICY,
  emptyHealth,
  healthStateOf,
  inactiveReasonOf,
  isSuspended,
  nextHealth,
  type SuspendEvent,
} from '../core/health.ts'
import { createP1Adapters } from '../engines/index.ts'
import {
  createEngineTransport,
  type EngineOriginPolicy,
  type EngineTransport,
  isTransportFailure,
  type TransportErrorCode,
  type TransportFailure,
} from '../fetch/transport.ts'
import { isSearchHoleError } from '../shared/errors.ts'
import {
  createKeyCache,
  createKeyStores,
  describeKeyResolution,
  type KeyCache,
  type KeyResolution,
  resolveKey,
  type SecretStore,
} from '../shared/keys/index.ts'
import type { EngineSettings } from '../shared/settings.ts'
import type {
  AdapterCtx,
  EngineAdapter,
  EngineId,
  ErrorClass,
  HttpResponse,
  InactiveReason,
} from '../shared/types.ts'
import { SHARED_KEY_FP, type Store, type UsageReservation } from '../store/index.ts'
import type { AppContext } from './context.ts'
import { Semaphore } from './semaphore.ts'
import type { EngineStatus } from './types.ts'

/** Engines with a shipped adapter (ADR-0017), in display order. */
export const P1_ENGINES = ['searxng', 'brave', 'tavily'] as const satisfies readonly EngineId[]

const FIXED_ORIGINS: Readonly<Partial<Record<EngineId, string>>> = {
  brave: 'https://api.search.brave.com',
  tavily: 'https://api.tavily.com',
}
const AUTH_HEADERS: Readonly<Partial<Record<EngineId, readonly string[]>>> = {
  brave: ['X-Subscription-Token'],
  tavily: ['Authorization'],
}
/** SearXNG's own limiter and upstreams degrade under bursts: at most 4 in flight per process. */
const SEARXNG_MAX_IN_FLIGHT = 4
const INSTALL_SECRET_KEY = 'install_secret'

/** A configured engine slot (one per shipped adapter). */
export interface EngineSlot {
  readonly id: EngineId
  readonly adapter: EngineAdapter
  readonly settings: EngineSettings
  /** Passed to the adapter; null = the adapter's own fixed origin. */
  readonly endpoint: string | null
  /** The origin the transport allows for this engine, if any. */
  readonly origin: string | null
}

/** A slot with its key resolved for this request. */
export interface ResolvedEngine extends EngineSlot {
  readonly key: KeyResolution
  /** First 16 hex of HMAC-SHA256(install secret, key); '' for keyless engines. */
  readonly keyFp: string
  readonly ctx: AdapterCtx
  readonly setup: ReturnType<EngineAdapter['setup']>
  /** Enabled in settings and set up (key or endpoint present). */
  readonly configured: boolean
}

function originOf(url: string | null): string | null {
  if (url === null) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const ERROR_CLASSES = new Set(Object.keys(ERROR_POLICY))
const isErrorClass = (v: string | null): v is ErrorClass => v !== null && ERROR_CLASSES.has(v)

/** Transport failure codes as the Node-style codes the fan-out classifies (core/health.ts). */
function networkCode(f: TransportFailure): string {
  const map: Record<TransportErrorCode, string> = {
    invalid_request: 'ERR_INVALID_REQUEST',
    origin_not_allowed: 'ERR_ORIGIN_NOT_ALLOWED',
    redirect_not_allowed: 'ERR_REDIRECT_NOT_ALLOWED',
    too_many_redirects: 'ERR_TOO_MANY_REDIRECTS',
    dns: 'ENOTFOUND',
    refused: 'ECONNREFUSED',
    reset: 'ECONNRESET',
    tls: 'ERR_TLS_CERT',
    timeout: 'ETIMEDOUT',
    cancelled: 'AbortError',
    body_too_large: 'ERR_BODY_TOO_LARGE',
    network: f.errorClass === 'offline' ? 'ENETUNREACH' : 'EHOSTUNREACH',
  }
  return map[f.code]
}

/** Health as stored (`engine_health`), mapped from the pure health record. */
function toRowFields(h: EngineHealth, now: number) {
  const suspended = isSuspended(h, now)
  const state =
    h.lastAttemptAt === null ? 'unknown' : h.lastOk === true && !suspended ? 'healthy' : 'unhealthy'
  const marker = h.suspendedUntilEvent === null ? '' : `[until ${h.suspendedUntilEvent}] `
  const text = `${marker}${h.lastErrorClass ?? ''}`.trim()
  return {
    state,
    reasonClass: h.suspendedClass ?? h.lastErrorClass,
    until: h.suspendedUntil,
    consecutiveFailures: h.consecutiveFailures,
    lastSuccessAt: h.lastSuccessAt,
    lastErrorRedacted: text === '' ? null : text,
  } as const
}

/** The pure health record from a stored row (the inverse of `toRowFields`). */
export function healthFromRow(row: {
  state: string
  reasonClass: string | null
  until: number | null
  consecutiveFailures: number
  lastSuccessAt: number | null
  lastErrorRedacted: string | null
  updatedAt: number
}): EngineHealth {
  const m = /^\[until (key_change|config_change)\]/.exec(row.lastErrorRedacted ?? '')
  const event: SuspendEvent | null = m?.[1] === 'key_change' || m?.[1] === 'config_change' ? m[1] : null
  const reason = isErrorClass(row.reasonClass) ? row.reasonClass : null
  return {
    consecutiveFailures: row.consecutiveFailures,
    lastAttemptAt: row.state === 'unknown' ? null : row.updatedAt,
    lastOk: row.state === 'healthy' ? true : row.state === 'unhealthy' ? false : null,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorClass: row.state === 'healthy' ? null : reason,
    suspendedUntil: row.until,
    suspendedUntilEvent: event,
    suspendedClass: row.until !== null || event !== null ? reason : null,
    adapterBroken: reason === 'malformed',
  }
}

/** Longest engine timeout (settings allow 120 s), so a replaced transport outlives its requests. */
const TRANSPORT_DRAIN_MS = 125_000

/** Engine plumbing shared by every request of one App. */
export class Engines {
  slots: readonly EngineSlot[]
  private transportInstance: EngineTransport | null = null
  private readonly keyCache: KeyCache
  private stores: { write: SecretStore; read: readonly SecretStore[] } | null = null
  private secret: { value: string; fromStore: boolean } | null = null
  private readonly memHealth = new Map<string, EngineHealth>()
  private readonly semaphores = new Map<EngineId, Semaphore>()

  constructor(private readonly ctx: AppContext) {
    this.keyCache = createKeyCache(ctx.now)
    this.slots = this.buildSlots()
  }

  /**
   * Applies changed settings: new slots, while health and cached keys carry over. The old
   * transport may still serve a search in flight, so it closes once any request has timed out.
   */
  reconfigure(): void {
    this.slots = this.buildSlots()
    const old = this.transportInstance
    this.transportInstance = null
    if (old) setTimeout(() => void old.close().catch(() => undefined), TRANSPORT_DRAIN_MS).unref()
  }

  /** Builds the slots from the current settings. */
  private buildSlots(): EngineSlot[] {
    const adapters = createP1Adapters({ now: this.ctx.now })
    const settings = this.ctx.settings.settings
    return P1_ENGINES.map((id) => {
      const s = settings.engines[id]
      const endpoint = s.url
      return {
        id,
        adapter: adapters[id],
        settings: s,
        endpoint,
        origin: originOf(endpoint ?? FIXED_ORIGINS[id] ?? null),
      }
    })
  }

  /** The key stores (seam, or the OS store plus the insecure file). */
  keyStores(): { write: SecretStore; read: readonly SecretStore[] } {
    if (this.stores) return this.stores
    const seam = this.ctx.seams.keyStores
    if (seam) this.stores = seam
    else {
      const s = createKeyStores({ platform: this.ctx.platform, secretsDir: this.ctx.layout.secrets })
      this.stores = { write: s.os, read: s.readChain }
    }
    return this.stores
  }

  /** Forgets cached keys (after `keys set/remove`). */
  forgetKey(engine?: EngineId): void {
    this.keyCache.clear(engine)
  }

  /** Resolves one engine's key, never throwing (a misconfiguration becomes `missing` with detail). */
  async key(engine: EngineId, cached = true): Promise<KeyResolution> {
    try {
      return await resolveKey(engine, {
        env: this.ctx.env,
        store: this.keyStores().read,
        ...(cached ? { cache: this.keyCache } : {}),
      })
    } catch (e) {
      return { key: null, source: 'missing', detail: isSearchHoleError(e) ? e.why : 'key lookup failed' }
    }
  }

  private async installSecret(store: Store | null): Promise<string> {
    if (this.secret?.fromStore) return this.secret.value
    let stored: string | undefined
    try {
      stored = store?.meta.getOrInit(INSTALL_SECRET_KEY, () => randomBytes(32).toString('hex'))
    } catch {
      stored = undefined
    }
    if (stored !== undefined) {
      this.secret = { value: stored, fromStore: true }
      return stored
    }
    this.secret ??= { value: randomBytes(32).toString('hex'), fromStore: false }
    return this.secret.value
  }

  /** ADR-0009 point 4: first 16 hex characters of HMAC-SHA256(install secret, key). */
  async keyFp(key: string | null, store: Store | null): Promise<string> {
    if (key === null) return SHARED_KEY_FP
    const secret = await this.installSecret(store)
    return createHmac('sha256', secret).update(key, 'utf8').digest('hex').slice(0, 16)
  }

  /** Resolves every slot for one request. `store` is used for the install secret. */
  async resolveAll(store: Store | null): Promise<ResolvedEngine[]> {
    return Promise.all(
      this.slots.map(async (slot) => {
        const key = await this.key(slot.id)
        const keyFp = await this.keyFp(key.key, store)
        const ctx: AdapterCtx = {
          endpoint: slot.endpoint,
          apiKey: key.key,
          timeoutMs: slot.settings.timeoutMs ?? slot.adapter.defaults.timeoutMs,
        }
        let setup: ReturnType<EngineAdapter['setup']>
        try {
          setup = slot.adapter.setup(ctx)
        } catch {
          setup = { active: false, reason: 'disabled', detail: 'adapter setup failed' }
        }
        if (!slot.settings.enabled)
          setup = { active: false, reason: 'disabled', detail: 'disabled in settings' }
        return { ...slot, key, keyFp, ctx, setup, configured: setup.active }
      }),
    )
  }

  // ── Health ──────────────────────────────────────────────────────────────

  private memKey(engine: EngineId, fp: string): string {
    return `${engine}|${fp}`
  }

  /** Shared health for (engine, key fp): the newer of the store row and this process's memory. */
  async health(engine: EngineId, fp: string, store: Store | null): Promise<EngineHealth | null> {
    let fromStore: EngineHealth | null = null
    try {
      const row = store?.engineHealth.get(engine, fp)
      if (row) fromStore = healthFromRow(row)
    } catch {
      fromStore = null
    }
    const mem = this.memHealth.get(this.memKey(engine, fp)) ?? null
    if (!fromStore) return mem
    if (!mem) return fromStore
    return (mem.lastAttemptAt ?? 0) > (fromStore.lastAttemptAt ?? 0) ? mem : fromStore
  }

  /** Writes health to memory and (when writable) to the store. */
  putHealth(r: ResolvedEngine, h: EngineHealth, store: Store | null): void {
    this.memHealth.set(this.memKey(r.id, r.keyFp), h)
    if (!store) return
    try {
      store.engineHealth.put({
        engine: r.id,
        keyFp: r.keyFp,
        subEngine: '',
        ...toRowFields(h, this.ctx.now()),
        ewmaSuccess: null,
        p50Ms: null,
        p95Ms: null,
        keyPresent: r.key.key !== null,
        keySource: r.key.key === null ? null : r.key.source,
      })
    } catch (e) {
      this.ctx.logger.warn({ err: e, engine: r.id }, 'could not store engine health')
    }
  }

  /** The three-state health of a resolved engine. */
  async state(r: ResolvedEngine, store: Store | null): Promise<ReturnType<typeof healthStateOf>> {
    if (!r.configured) return 'unhealthy'
    return healthStateOf(await this.health(r.id, r.keyFp, store), this.ctx.now())
  }

  /** The fan-out's health port for this request. */
  healthPort(resolved: readonly ResolvedEngine[], store: Store | null): HealthPort {
    const byId = new Map(resolved.map((r) => [r.id, r]))
    return {
      get: async (engine) => {
        const r = byId.get(engine)
        return r ? this.health(engine, r.keyFp, store) : null
      },
      put: (engine, state) => {
        const r = byId.get(engine)
        if (r) this.putHealth(r, state, store)
      },
    }
  }

  /** The fan-out's usage port: shared spend caps, or 'unavailable' (local allowance) without a store. */
  usagePort(resolved: readonly ResolvedEngine[], store: Store | null): UsagePort {
    const byId = new Map(resolved.map((r) => [r.id, r]))
    const held = new Map<EngineId, UsageReservation[]>()
    return {
      reserve: async (engine) => {
        const r = byId.get(engine)
        if (!r || !store) return 'unavailable'
        let res: ReturnType<Store['engineUsage']['reserve']>
        try {
          res = store.engineUsage.reserve(engine, r.keyFp, {
            day: r.settings.caps.day,
            month: r.settings.caps.month,
          })
        } catch {
          return 'unavailable'
        }
        if (res.ok) {
          const list = held.get(engine) ?? []
          list.push(res.reservation)
          held.set(engine, list)
          return 'ok'
        }
        return res.reason === 'store_unavailable' ? 'unavailable' : 'capped'
      },
      refund: (engine) => {
        const reservation = held.get(engine)?.pop()
        if (reservation && store) {
          try {
            store.engineUsage.refund(reservation)
          } catch {
            // A failed refund only over-counts one call.
          }
        }
      },
    }
  }

  // ── Transport ───────────────────────────────────────────────────────────

  private engineTransport(): EngineTransport {
    if (this.transportInstance) return this.transportInstance
    const allowed = new Map<string, EngineOriginPolicy>()
    for (const s of this.slots) {
      if (s.origin === null) continue
      allowed.set(s.origin, { engineId: s.id, authHeaderNames: AUTH_HEADERS[s.id] ?? [] })
    }
    this.transportInstance = createEngineTransport({ allowedOrigins: allowed })
    return this.transportInstance
  }

  private semaphore(id: EngineId): Semaphore {
    let sem = this.semaphores.get(id)
    if (!sem) {
      const slot = this.slots.find((s) => s.id === id)
      const max =
        id === 'searxng'
          ? Math.min(SEARXNG_MAX_IN_FLIGHT, slot?.adapter.defaults.concurrency ?? SEARXNG_MAX_IN_FLIGHT)
          : (slot?.adapter.defaults.concurrency ?? 4)
      sem = new Semaphore(max)
      this.semaphores.set(id, sem)
    }
    return sem
  }

  /** In-flight calls per engine (for tests and doctor). */
  inFlight(id: EngineId): number {
    return this.semaphores.get(id)?.inFlight ?? 0
  }

  private engineForUrl(url: string): EngineId | undefined {
    const origin = originOf(url)
    return this.slots.find((s) => s.origin !== null && s.origin === origin)?.id
  }

  /** The fan-out transport: origin-pinned, concurrency-limited, never throws. */
  fanoutTransport(): Transport {
    const t = this.engineTransport()
    return async (req, signal, timeoutMs) => {
      const id = this.engineForUrl(req.url)
      const call = () => t(req, signal, timeoutMs)
      let res: Awaited<ReturnType<EngineTransport>>
      try {
        res = id ? await this.semaphore(id).run(call, signal) : await call()
      } catch {
        return { networkError: 'AbortError' }
      }
      return isTransportFailure(res) ? { networkError: networkCode(res) } : res
    }
  }

  /** One raw GET through the engine transport (doctor and probes). */
  async get(
    url: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<HttpResponse | { failure: TransportFailure }> {
    const res = await this.engineTransport()(
      { method: 'GET', url, headers: { Accept: 'application/json' } },
      signal,
      timeoutMs,
    )
    return isTransportFailure(res) ? { failure: res } : res
  }

  // ── Status and probes ───────────────────────────────────────────────────

  /** Status of every shipped engine. */
  async status(store: Store | null): Promise<EngineStatus[]> {
    const resolved = await this.resolveAll(store)
    const now = this.ctx.now()
    return Promise.all(
      resolved.map(async (r) => {
        const h = r.configured ? await this.health(r.id, r.keyFp, store) : null
        let capped = false
        if (r.configured && store) {
          try {
            const c = store.engineUsage.counts(r.id, r.keyFp)
            const caps = r.settings.caps
            capped =
              (caps.day !== null && c.day >= caps.day) || (caps.month !== null && c.month >= caps.month)
          } catch {
            capped = false
          }
        }
        const inactive: InactiveReason | undefined = !r.setup.active
          ? r.setup.reason
          : capped
            ? 'spend_cap'
            : h
              ? (inactiveReasonOf(h, now) ?? undefined)
              : undefined
        const status: EngineStatus = {
          engine: r.id,
          configured: r.configured,
          active: r.configured && inactive === undefined,
          health: healthStateOf(h, now, { capped, inactive: !r.configured }),
        }
        if (inactive !== undefined) status.inactiveReason = inactive
        if (h?.lastErrorClass) status.lastError = h.lastErrorClass
        if (r.key.key !== null) status.keySource = describeKeyResolution(r.key)
        if (h?.suspendedUntil !== null && h?.suspendedUntil !== undefined && h.suspendedUntil > now)
          status.suspendedUntil = new Date(h.suspendedUntil).toISOString()
        if (r.adapter.capabilities.attribution) status.attribution = r.adapter.capabilities.attribution
        return status
      }),
    )
  }

  /**
   * Bounded probe of configured engines whose health is `unknown` (ADR-0014 point 2):
   * SearXNG `GET /config` must answer JSON; a keyed engine passes when its key is present
   * and not rejected. Results update shared health. Never exceeds `budgetMs`.
   */
  async probe(budgetMs: number, store: Store | null): Promise<void> {
    const budget = Math.max(50, Math.min(budgetMs, 10_000))
    const deadline = AbortSignal.timeout(budget)
    const resolved = await this.resolveAll(store)
    const now = this.ctx.now()
    await Promise.all(
      resolved.map(async (r) => {
        if (!r.configured) return
        const before = await this.health(r.id, r.keyFp, store)
        if (healthStateOf(before, now) !== 'unknown') return
        const prev = before ?? emptyHealth()
        if (r.adapter.capabilities.requiresKey) {
          // Key present (setup passed) and not rejected (an auth suspension is not `unknown`).
          this.putHealth(r, nextHealth(prev, { ok: true }, this.ctx.now()), store)
          return
        }
        if (r.endpoint === null) return
        const base = r.endpoint.replace(/\/+$/, '')
        const res = await this.get(`${base}/config`, deadline, budget)
        if ('failure' in res) {
          if (res.failure.code === 'timeout' || res.failure.code === 'cancelled') return
          const cls: ErrorClass =
            res.failure.errorClass === 'offline' ? 'unreachable' : res.failure.errorClass
          this.putHealth(r, nextHealth(prev, { ok: false, errorClass: cls }, this.ctx.now()), store)
          return
        }
        let json = false
        try {
          const body: unknown = JSON.parse(res.text)
          json = typeof body === 'object' && body !== null
        } catch {
          json = false
        }
        const outcome =
          res.status === 200 && json
            ? ({ ok: true } as const)
            : ({ ok: false, errorClass: res.status === 403 ? 'json_disabled' : 'malformed' } as const)
        this.putHealth(r, nextHealth(prev, outcome, this.ctx.now()), store)
      }),
    )
  }

  async close(): Promise<void> {
    const t = this.transportInstance
    this.transportInstance = null
    if (t) await t.close().catch(() => undefined)
  }
}
