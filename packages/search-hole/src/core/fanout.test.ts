// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { makeCtx, makePlan, NOW } from '../../test/mock-engine/helpers.ts'
import type {
  EngineId,
  EnginePlan,
  EngineRun,
  ErrorClass,
  HttpRequest,
  HttpResponse,
  ParseOutcome,
  UpstreamDiag,
} from '../shared/types.ts'
import {
  createLocalAllowance,
  type FanoutAdapter,
  type HealthPort,
  LOCAL_ALLOWANCE_PER_DAY,
  type PlannedEngine,
  type ReserveResult,
  type RunEnginesOptions,
  runEngines,
  type Transport,
  type TransportResult,
  type UsagePort,
} from './fanout.ts'
import { type EngineHealth, isSuspended } from './health.ts'

// ── Fakes ───────────────────────────────────────────────────────────────

interface FakeOpts {
  billed?: boolean
  retries?: number
  attribution?: string
  pushed?: number
  throwOnParse?: boolean
  inactive?: boolean
  parse?: (res: HttpResponse) => ParseOutcome
}

const STATUS_CLASS: Record<number, ErrorClass> = {
  401: 'auth',
  402: 'quota',
  403: 'json_disabled',
  429: 'rate_limited',
  500: 'server',
}

function fakeAdapter(id: EngineId, o: FakeOpts = {}): FanoutAdapter {
  return {
    id,
    displayName: id,
    capabilities: {
      domainInclude: null,
      domainExclude: null,
      dateFilter: 'none',
      goggles: false,
      dates: 'none',
      maxPerCall: 20,
      paging: false,
      requiresKey: false,
      endpoint: 'fixed',
      officialApi: true,
      billed: o.billed ?? false,
      attribution: o.attribution ?? null,
    },
    retention: { log: 'full', payloadTtlHours: null },
    defaults: {
      timeoutMs: 1000,
      concurrency: 2,
      overFetch: 2,
      retry: { sameEngineRetries: o.retries ?? 1, backoffMs: 250 },
    },
    setup: () => (o.inactive ? { active: false, reason: 'missing_key', detail: 'no key' } : { active: true }),
    buildRequest: (_plan: EnginePlan): HttpRequest => ({
      method: 'GET',
      url: `https://${id}.example/search`,
      headers: {},
    }),
    parseResponse: (res) => {
      if (o.throwOnParse) throw new Error('boom')
      if (o.parse) return o.parse(res)
      if (res.status === 200) {
        return {
          kind: 'ok',
          results: [1, 2].map((rank) => ({
            engine: id,
            rank,
            url: `https://${id}.example/r${rank}`,
            title: `${id} ${rank}`,
            snippet: '',
            dates: [],
          })),
        }
      }
      if (res.status === 204) return { kind: 'empty' }
      const retryAfter = res.headers['retry-after']
      return {
        kind: 'error',
        errorClass: STATUS_CLASS[res.status] ?? 'malformed',
        detail: `HTTP ${res.status}`,
        ...(retryAfter ? { retryAfterMs: Number(retryAfter) * 1000 } : {}),
      }
    },
    ...(o.pushed === undefined ? {} : { pushedRuleCount: () => o.pushed as number }),
  }
}

const planned = (adapter: FanoutAdapter, ctxOverrides = {}): PlannedEngine => ({
  adapter,
  plan: makePlan(),
  ctx: makeCtx({ timeoutMs: 1000, ...ctxOverrides }),
})

const ok = (status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  text: '',
  durationMs: 5,
})

type Step = TransportResult | (() => Promise<TransportResult>)

/** A transport that answers by engine, from a script; the last step repeats. */
function scripted(script: Partial<Record<EngineId, Step[]>>) {
  const calls: EngineId[] = []
  const seen: Partial<Record<EngineId, number>> = {}
  const transport: Transport = async (req) => {
    const id = new URL(req.url).hostname.split('.')[0] as EngineId
    calls.push(id)
    const steps = script[id] ?? [ok()]
    const n = seen[id] ?? 0
    seen[id] = n + 1
    const step = steps[Math.min(n, steps.length - 1)] ?? ok()
    return typeof step === 'function' ? step() : step
  }
  return { transport, calls, count: (id: EngineId) => calls.filter((c) => c === id).length }
}

function memHealth(initial: Partial<Record<EngineId, EngineHealth>> = {}) {
  const map = new Map<EngineId, EngineHealth>(Object.entries(initial) as Array<[EngineId, EngineHealth]>)
  const puts: Array<[EngineId, EngineHealth]> = []
  const port: HealthPort = {
    get: (e) => map.get(e),
    put: (e, s) => {
      map.set(e, s)
      puts.push([e, s])
    },
  }
  return { port, map, puts }
}

function memUsage(script: Partial<Record<EngineId, ReserveResult[]>> = {}) {
  const reserved: EngineId[] = []
  const refunded: EngineId[] = []
  const seen: Partial<Record<EngineId, number>> = {}
  const port: UsagePort = {
    reserve: async (e) => {
      reserved.push(e)
      const steps = script[e] ?? ['ok']
      const n = seen[e] ?? 0
      seen[e] = n + 1
      return steps[Math.min(n, steps.length - 1)] ?? 'ok'
    },
    refund: (e) => {
      refunded.push(e)
    },
  }
  return { port, reserved, refunded }
}

function harness(over: Partial<RunEnginesOptions> & Pick<RunEnginesOptions, 'plans' | 'transport'>) {
  const health = memHealth()
  const usage = memUsage()
  const sleeps: number[] = []
  const base: RunEnginesOptions = {
    health: health.port,
    usage: usage.port,
    fallback: [],
    now: () => NOW,
    signal: new AbortController().signal,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    allowance: createLocalAllowance(),
    ...over,
  }
  return { opts: base, health, usage, sleeps }
}

const statuses = (runs: EngineRun[]) =>
  runs.map(
    (r) =>
      `${r.engine}:${r.status}${r.errorClass ? `/${r.errorClass}` : ''}${r.inactiveReason ? `/${r.inactiveReason}` : ''}`,
  )

// ── Tests ───────────────────────────────────────────────────────────────

describe('runEngines: basics', () => {
  it('runs planned engines concurrently and returns raw results with attribution and pushdown counts', async () => {
    let started = 0
    let release!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const transport: Transport = async () => {
      started += 1
      if (started === 2) release()
      await barrier // would deadlock if the engines ran one after the other
      return ok()
    }
    const a = fakeAdapter('searxng')
    const b = fakeAdapter('tavily', { billed: true, pushed: 3, attribution: 'Results from Tavily' })
    const { opts } = harness({ plans: [planned(a), planned(b)], transport })
    const res = await runEngines(opts)

    expect(res.raw.map((r) => r.engine)).toEqual(['searxng', 'searxng', 'tavily', 'tavily'])
    expect(statuses(res.runs)).toEqual(['searxng:ok', 'tavily:ok'])
    expect(res.runs[0]).toMatchObject({ returned: 2, latencyMs: 5 })
    expect(res.runs[0]?.attribution).toBeUndefined()
    expect(res.runs[1]).toMatchObject({ attribution: 'Results from Tavily', pushedRuleCount: 3 })
    expect(res.warnings).toEqual([])
    expect(res.hops).toEqual([])
    expect(res.original).toEqual(['searxng', 'tavily'])
  })

  it('records an empty answer as empty and does not fall back', async () => {
    const s = scripted({ searxng: [ok(204)] })
    const { opts } = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:empty'])
    expect(res.raw).toEqual([])
    expect(s.calls).toEqual(['searxng'])
  })

  it('records spellcheck rewrites and quota information', async () => {
    const adapter = fakeAdapter('brave', {
      parse: () => ({
        kind: 'ok',
        results: [
          { engine: 'brave', rank: 1, url: 'https://x.example/', title: 't', snippet: '', dates: [] },
        ],
        alteredQuery: 'react compiler',
        quota: { remaining: 10, limit: 100 },
      }),
    })
    const { opts } = harness({ plans: [planned(adapter)], transport: scripted({}).transport })
    const res = await runEngines(opts)
    expect(res.altered).toEqual({ brave: 'react compiler' })
    expect(res.quota).toEqual({ brave: { remaining: 10, limit: 100 } })
  })

  it('reports a block rule set the engine ignored', async () => {
    const adapter = fakeAdapter('brave', {
      pushed: 4,
      parse: () => ({
        kind: 'ok',
        results: [
          { engine: 'brave', rank: 1, url: 'https://x.example/', title: 't', snippet: '', dates: [] },
        ],
        pushdownApplied: false,
      }),
    })
    const { opts } = harness({ plans: [planned(adapter)], transport: scripted({}).transport })
    const res = await runEngines(opts)
    expect(res.runs[0]?.pushedRuleCount).toBeUndefined()
    expect(res.runs[0]?.detail).toBe('block rules were not applied upstream')
  })
})

describe('runEngines: fallback walk', () => {
  it('falls back to a different engine immediately on a timeout, and records the hop', async () => {
    const s = scripted({ searxng: [{ networkError: 'ETIMEDOUT' }] })
    const { opts, health, sleeps } = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/timeout', 'tavily:ok'])
    expect(res.warnings).toEqual([{ code: 'engine_fallback', from: 'searxng', to: 'tavily' }])
    expect(res.hops).toEqual([{ from: 'searxng', to: 'tavily', reason: 'timeout' }])
    expect(res.attempted).toEqual(['searxng', 'tavily'])
    expect(sleeps).toEqual([]) // a timeout is never retried on the same engine
    expect(s.count('searxng')).toBe(1)
    // searxng is suspended 5 s; tavily is healthy.
    expect(health.map.get('searxng')?.suspendedUntil).toBe(NOW + 5000)
    expect(health.map.get('tavily')?.lastOk).toBe(true)
  })

  it('retries the same engine only for server errors, once, with backoff', async () => {
    const s = scripted({ tavily: [ok(500), ok(200)] })
    const { opts, usage, sleeps, health } = harness({
      plans: [planned(fakeAdapter('tavily', { billed: true }))],
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['tavily:ok'])
    expect(s.count('tavily')).toBe(2)
    expect(sleeps).toEqual([250])
    expect(usage.reserved).toEqual(['tavily', 'tavily']) // each try is a billed call
    expect(health.map.get('tavily')).toMatchObject({ consecutiveFailures: 0, lastOk: true })
    expect(health.puts).toHaveLength(1) // the failed first try is not recorded on its own
  })

  it('retries a persistent server error once, then walks to another engine and records one failure', async () => {
    const s = scripted({ searxng: [ok(500)] })
    const { opts, sleeps, health } = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('brave'))],
      fallback: ['searxng', 'brave'],
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/server', 'brave:ok'])
    expect(s.count('searxng')).toBe(2)
    expect(sleeps).toEqual([250])
    expect(health.map.get('searxng')).toMatchObject({ consecutiveFailures: 1 })
  })

  it('does not retry when the adapter allows no same-engine retries', async () => {
    const s = scripted({ searxng: [ok(500)] })
    const { opts } = harness({
      plans: [planned(fakeAdapter('searxng', { retries: 0 }))],
      transport: s.transport,
    })
    await runEngines(opts)
    expect(s.count('searxng')).toBe(1)
  })

  it('suspends on a 429 with its Retry-After, skips the engine next time, and falls back', async () => {
    const s = scripted({ searxng: [ok(429, { 'retry-after': '120' })] })
    const make = () =>
      harness({
        plans: [planned(fakeAdapter('searxng'))],
        standby: [planned(fakeAdapter('tavily'))],
        fallback: ['searxng', 'tavily'],
        transport: s.transport,
      })
    const first = make()
    const res1 = await runEngines(first.opts)
    expect(statuses(res1.runs)).toEqual(['searxng:error/rate_limited', 'tavily:ok'])
    expect(first.health.map.get('searxng')?.suspendedUntil).toBe(NOW + 120_000)
    expect(s.count('searxng')).toBe(1) // 429 is not retried

    // A second search with the shared health: searxng is not called at all.
    const second = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: s.transport,
      health: first.health.port,
    })
    const res2 = await runEngines(second.opts)
    expect(statuses(res2.runs)).toEqual(['searxng:skipped/suspended', 'tavily:ok'])
    expect(res2.hops).toEqual([{ from: 'searxng', to: 'tavily', reason: 'suspended' }])
    expect(s.count('searxng')).toBe(1)
    // Time passes: after the suspension, searxng is called again.
    const later = harness({
      plans: [planned(fakeAdapter('searxng'))],
      transport: scripted({}).transport,
      health: first.health.port,
      now: () => NOW + 121_000,
    })
    expect(statuses((await runEngines(later.opts)).runs)).toEqual(['searxng:ok'])
  })

  it('reports json_disabled as its own inactive reason', async () => {
    const s = scripted({ searxng: [ok(403)] })
    const first = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: s.transport,
    })
    await runEngines(first.opts)
    expect(first.health.map.get('searxng')).toMatchObject({
      suspendedUntilEvent: 'config_change',
      suspendedClass: 'json_disabled',
    })
    const second = harness({
      plans: [planned(fakeAdapter('searxng'))],
      transport: s.transport,
      health: first.health.port,
    })
    const res = await runEngines(second.opts)
    expect(statuses(res.runs)).toEqual(['searxng:skipped/json_disabled'])
  })

  it('stops after maxFallbacks real hops (default 2)', async () => {
    const all = ['searxng', 'tavily', 'brave', 'exa', 'mojeek'] as const
    const s = scripted(Object.fromEntries(all.map((id) => [id, [ok(500)]])))
    const { opts } = harness({
      plans: [planned(fakeAdapter('searxng', { retries: 0 }))],
      standby: all.slice(1).map((id) => planned(fakeAdapter(id, { retries: 0 }))),
      fallback: all,
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/server', 'tavily:error/server', 'brave:error/server'])
    expect(res.hops).toHaveLength(2)
    expect(res.attempted).toEqual(['searxng', 'tavily', 'brave'])
    expect(s.count('exa')).toBe(0)

    const wide = harness({
      plans: [planned(fakeAdapter('searxng', { retries: 0 }))],
      standby: all.slice(1).map((id) => planned(fakeAdapter(id, { retries: 0 }))),
      fallback: all,
      transport: s.transport,
      maxFallbacks: 4,
    })
    expect((await runEngines(wide.opts)).runs).toHaveLength(5)
  })

  it('never calls one engine for two lanes: the attempted set is shared', async () => {
    const s = scripted({ searxng: [ok(500)], brave: [ok(500)], tavily: [ok(200)] })
    const { opts } = harness({
      plans: [planned(fakeAdapter('searxng', { retries: 0 })), planned(fakeAdapter('brave', { retries: 0 }))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'brave', 'tavily'],
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(s.count('tavily')).toBe(1)
    expect(res.hops).toHaveLength(1)
    expect(res.runs.filter((r) => r.engine === 'tavily')).toHaveLength(1)
    expect(res.raw.filter((r) => r.engine === 'tavily')).toHaveLength(2)
    expect(res.runs.filter((r) => r.status === 'error')).toHaveLength(2)
  })

  it('skips an inactive adapter and substitutes a fallback', async () => {
    const s = scripted({})
    const { opts } = harness({
      plans: [planned(fakeAdapter('brave', { inactive: true }))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['brave', 'tavily'],
      transport: s.transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['brave:skipped/missing_key', 'tavily:ok'])
    expect(s.count('brave')).toBe(0)
  })

  it('treats an empty answer with failing upstream engines as a reason to try another engine', async () => {
    const upstream: UpstreamDiag[] = [
      { name: 'duckduckgo', errorClass: 'captcha', message: 'CAPTCHA', suspended: false },
    ]
    const searx = fakeAdapter('searxng', { parse: () => ({ kind: 'empty', upstream }) })
    const { opts, health } = harness({
      plans: [planned(searx)],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: scripted({}).transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:empty', 'tavily:ok'])
    expect(res.runs[0]?.upstream).toEqual(upstream)
    expect(res.hops).toEqual([{ from: 'searxng', to: 'tavily', reason: 'upstream_failed' }])
    // SearXNG itself answered, so its own health is fine.
    expect(health.map.get('searxng')).toMatchObject({ lastOk: true, consecutiveFailures: 0 })
  })

  it('does not hop for an empty answer whose upstream diagnostics are all unknown', async () => {
    const searx = fakeAdapter('searxng', {
      parse: () => ({
        kind: 'empty',
        upstream: [{ name: 'x', errorClass: 'unknown', message: '?', suspended: false }],
      }),
    })
    const s = scripted({})
    const { opts } = harness({
      plans: [planned(searx)],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: s.transport,
    })
    await runEngines(opts)
    expect(s.count('tavily')).toBe(0)
  })
})

describe('runEngines: spend caps', () => {
  it('skips a capped engine without calling it and walks on, without counting skips as hops', async () => {
    const s = scripted({})
    const usage = memUsage({ tavily: ['capped'], brave: ['capped'] })
    const { opts } = harness({
      plans: [planned(fakeAdapter('tavily', { billed: true }))],
      standby: [planned(fakeAdapter('brave', { billed: true })), planned(fakeAdapter('searxng'))],
      fallback: ['tavily', 'brave', 'searxng'],
      transport: s.transport,
      usage: usage.port,
      maxFallbacks: 1,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['tavily:skipped/spend_cap', 'brave:skipped/spend_cap', 'searxng:ok'])
    expect(s.calls).toEqual(['searxng'])
    expect(res.hops).toEqual([{ from: 'tavily', to: 'searxng', reason: 'spend_cap' }])
    expect(res.warnings).toEqual([{ code: 'engine_fallback', from: 'tavily', to: 'searxng' }])
  })

  it('refunds a reservation only when the connection failed before the request was sent', async () => {
    for (const [code, refunded] of [
      ['ECONNREFUSED', true],
      ['ENOTFOUND', true],
      ['ETIMEDOUT', false],
      ['ECONNRESET', false],
    ] as const) {
      const usage = memUsage()
      const { opts } = harness({
        plans: [planned(fakeAdapter('tavily', { billed: true }))],
        transport: scripted({ tavily: [{ networkError: code }] }).transport,
        usage: usage.port,
      })
      await runEngines(opts)
      expect(usage.refunded, code).toEqual(refunded ? ['tavily'] : [])
    }
  })

  it('does not refund after an HTTP error response (the call may have been billed)', async () => {
    const usage = memUsage()
    const { opts } = harness({
      plans: [planned(fakeAdapter('tavily', { billed: true, retries: 0 }))],
      transport: scripted({ tavily: [ok(429)] }).transport,
      usage: usage.port,
    })
    await runEngines(opts)
    expect(usage.refunded).toEqual([])
  })

  it('lets a billed engine run on a local allowance of 20 per day when usage cannot be reserved', async () => {
    expect(LOCAL_ALLOWANCE_PER_DAY).toBe(20)
    const allowance = createLocalAllowance()
    const usage = memUsage({ brave: ['unavailable'] })
    let last = await runEngines(
      harness({
        plans: [planned(fakeAdapter('brave', { billed: true }))],
        transport: scripted({}).transport,
        usage: usage.port,
        allowance,
      }).opts,
    )
    expect(last.warnings).toEqual([{ code: 'spend_cap_local', engine: 'brave' }])
    for (let i = 2; i <= 20; i++) {
      last = await runEngines(
        harness({
          plans: [planned(fakeAdapter('brave', { billed: true }))],
          transport: scripted({}).transport,
          usage: usage.port,
          allowance,
        }).opts,
      )
      expect(statuses(last.runs), `call ${i}`).toEqual(['brave:ok'])
    }
    const s = scripted({})
    last = await runEngines(
      harness({
        plans: [planned(fakeAdapter('brave', { billed: true }))],
        transport: s.transport,
        usage: usage.port,
        allowance,
      }).opts,
    )
    expect(statuses(last.runs)).toEqual(['brave:skipped/spend_cap'])
    expect(last.runs[0]?.detail).toContain('not shared')
    expect(s.count('brave')).toBe(0)

    // The allowance is per UTC day.
    const tomorrow = await runEngines(
      harness({
        plans: [planned(fakeAdapter('brave', { billed: true }))],
        transport: scripted({}).transport,
        usage: usage.port,
        allowance,
        now: () => NOW + 86_400_000,
      }).opts,
    )
    expect(statuses(tomorrow.runs)).toEqual(['brave:ok'])
  })

  it('lets free engines proceed without limit when usage cannot be reserved, and does not warn', async () => {
    const usage = memUsage({ searxng: ['unavailable'] })
    const allowance = createLocalAllowance(1)
    for (let i = 0; i < 5; i++) {
      const res = await runEngines(
        harness({
          plans: [planned(fakeAdapter('searxng'))],
          transport: scripted({}).transport,
          usage: usage.port,
          allowance,
        }).opts,
      )
      expect(statuses(res.runs)).toEqual(['searxng:ok'])
      expect(res.warnings).toEqual([])
    }
  })

  it('treats a throwing usage port as unavailable', async () => {
    const usage: UsagePort = {
      reserve: async () => {
        throw new Error('db locked')
      },
      refund: () => undefined,
    }
    const res = await runEngines(
      harness({
        plans: [planned(fakeAdapter('brave', { billed: true }))],
        transport: scripted({}).transport,
        usage,
      }).opts,
    )
    expect(statuses(res.runs)).toEqual(['brave:ok'])
    expect(res.warnings).toEqual([{ code: 'spend_cap_local', engine: 'brave' }])
  })

  it('returns an allowance slot when the request never left', async () => {
    const allowance = createLocalAllowance(1)
    const usage = memUsage({ brave: ['unavailable'] })
    const refused = scripted({ brave: [{ networkError: 'ECONNREFUSED' }] })
    await runEngines(
      harness({
        plans: [planned(fakeAdapter('brave', { billed: true }))],
        transport: refused.transport,
        usage: usage.port,
        allowance,
      }).opts,
    )
    const res = await runEngines(
      harness({
        plans: [planned(fakeAdapter('brave', { billed: true }))],
        transport: scripted({}).transport,
        usage: usage.port,
        allowance,
      }).opts,
    )
    expect(statuses(res.runs)).toEqual(['brave:ok'])
  })
})

describe('runEngines: the lone-engine rule', () => {
  it('does not suspend the only engine on timeouts, server errors or a bare 429', async () => {
    for (const step of [{ networkError: 'ETIMEDOUT' }, ok(500), ok(429)] as const) {
      const { opts, health } = harness({
        plans: [planned(fakeAdapter('searxng', { retries: 0 }))],
        transport: scripted({ searxng: [step] }).transport,
      })
      const res = await runEngines(opts)
      expect(res.runs[0]?.status).toBe('error')
      const h = health.map.get('searxng')
      expect(h && isSuspended(h, NOW)).toBe(false)
      expect(h).toMatchObject({ lastOk: false, consecutiveFailures: 1 })
    }
  })

  it('suspends the only engine on explicit signals: auth, quota, json_disabled, 429 with a reset', async () => {
    for (const step of [ok(401), ok(402), ok(403), ok(429, { 'retry-after': '30' })]) {
      const { opts, health } = harness({
        plans: [planned(fakeAdapter('searxng', { retries: 0 }))],
        transport: scripted({ searxng: [step] }).transport,
      })
      await runEngines(opts)
      const h = health.map.get('searxng')
      expect(h && isSuspended(h, NOW), `status ${step && 'status' in step ? step.status : '?'}`).toBe(true)
    }
  })

  it('treats an engine as lone when its alternatives are suspended or inactive', async () => {
    const shared = memHealth({
      tavily: { ...emptyLike(), suspendedUntil: NOW + 60_000, suspendedClass: 'rate_limited' },
    })
    const { opts } = harness({
      plans: [planned(fakeAdapter('searxng', { retries: 0 }))],
      standby: [planned(fakeAdapter('tavily')), planned(fakeAdapter('brave', { inactive: true }))],
      fallback: ['searxng', 'tavily', 'brave'],
      transport: scripted({ searxng: [{ networkError: 'ETIMEDOUT' }] }).transport,
      health: shared.port,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual([
      'searxng:error/timeout',
      'tavily:skipped/suspended',
      'brave:skipped/missing_key',
    ])
    expect(shared.map.get('searxng')?.suspendedUntil).toBeNull() // lone: not suspended on a timeout
    expect(shared.map.get('searxng')?.lastOk).toBe(false)
  })
})

function emptyLike(): EngineHealth {
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

describe('runEngines: timeouts, cancellation, errors as data', () => {
  it('times out an engine whose transport ignores the signal', async () => {
    const hang: Step = () => new Promise<TransportResult>(() => undefined)
    const started = Date.now()
    const { opts, health } = harness({
      plans: [planned(fakeAdapter('searxng'), { timeoutMs: 60 })],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: scripted({ searxng: [hang] }).transport,
    })
    const res = await runEngines(opts)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(statuses(res.runs)).toEqual(['searxng:error/timeout', 'tavily:ok'])
    expect(health.map.get('searxng')?.lastErrorClass).toBe('timeout')
  })

  it('passes the per-engine timeout and an abortable signal to the transport', async () => {
    const seen: Array<{ timeoutMs: number; aborted: boolean }> = []
    const transport: Transport = async (_req, signal, timeoutMs) => {
      seen.push({ timeoutMs, aborted: signal.aborted })
      return ok()
    }
    const { opts } = harness({ plans: [planned(fakeAdapter('searxng'), { timeoutMs: 321 })], transport })
    await runEngines(opts)
    expect(seen).toEqual([{ timeoutMs: 321, aborted: false }])
  })

  it('does nothing when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const s = scripted({})
    const { opts, health, usage } = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: s.transport,
      signal: ac.signal,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/cancelled'])
    expect(s.calls).toEqual([])
    expect(health.puts).toEqual([])
    expect(usage.reserved).toEqual([])
    expect(res.warnings).toEqual([])
  })

  it('cancels in-flight calls without touching health or falling back', async () => {
    const ac = new AbortController()
    const transport: Transport = (_req, signal) =>
      new Promise<TransportResult>((resolve) => {
        signal.addEventListener('abort', () => resolve({ networkError: 'AbortError' }), { once: true })
        queueMicrotask(() => ac.abort())
      })
    const s = scripted({})
    const { opts, health } = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport,
      signal: ac.signal,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/cancelled'])
    expect(health.puts).toEqual([])
    expect(res.hops).toEqual([])
    expect(s.calls).toEqual([])
  })

  it('turns a throwing transport into a network error and a throwing parser into malformed (adapter_broken)', async () => {
    const throwing: Transport = async () => {
      throw new Error('kaboom')
    }
    const a = harness({ plans: [planned(fakeAdapter('searxng'))], transport: throwing })
    const resA = await runEngines(a.opts)
    expect(resA.runs[0]).toMatchObject({ status: 'error', errorClass: 'unreachable' })

    const b = harness({
      plans: [planned(fakeAdapter('searxng', { throwOnParse: true }))],
      transport: scripted({}).transport,
    })
    const resB = await runEngines(b.opts)
    expect(resB.runs[0]).toMatchObject({ status: 'error', errorClass: 'malformed' })
    expect(b.health.map.get('searxng')?.adapterBroken).toBe(true)
  })

  it('does not put the API key or URLs (which can carry the query) in run details', async () => {
    const key = 'sk-live-0123456789abcdef'
    const { opts } = harness({
      plans: [planned(fakeAdapter('tavily', { billed: true }), { apiKey: key })],
      transport: scripted({
        tavily: [{ networkError: `connect failed for https://api.example/?q=my+secret+query using ${key}` }],
      }).transport,
    })
    const res = await runEngines(opts)
    expect(JSON.stringify(res)).not.toContain(key)
    expect(JSON.stringify(res)).not.toContain('secret+query')
    expect(res.runs[0]?.detail).toContain('[redacted]')
    expect(res.runs[0]?.detail).toContain('[url]')
  })
})

describe('runEngines: offline versus unreachable', () => {
  it('leaves health alone when everything is offline', async () => {
    const { opts, health } = harness({
      plans: [planned(fakeAdapter('searxng'))],
      standby: [planned(fakeAdapter('tavily'))],
      fallback: ['searxng', 'tavily'],
      transport: scripted({
        searxng: [{ networkError: 'ENOTFOUND' }],
        tavily: [{ networkError: 'ENOTFOUND' }],
      }).transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/offline', 'tavily:error/offline'])
    expect(health.puts).toEqual([])
  })

  it('reclassifies one offline failure as unreachable when another engine got a response', async () => {
    const { opts, health } = harness({
      plans: [planned(fakeAdapter('searxng')), planned(fakeAdapter('tavily'))],
      fallback: [],
      transport: scripted({ searxng: [{ networkError: 'ENOTFOUND' }], tavily: [ok()] }).transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/unreachable', 'tavily:ok'])
    expect(health.map.get('searxng')).toMatchObject({
      lastErrorClass: 'unreachable',
      suspendedUntil: NOW + 30_000,
    })
  })

  it('reports ECONNREFUSED as unreachable and suspends for 30 s when another engine is available', async () => {
    const { opts, health } = harness({
      plans: [planned(fakeAdapter('searxng')), planned(fakeAdapter('tavily'))],
      transport: scripted({ searxng: [{ networkError: 'ECONNREFUSED' }] }).transport,
    })
    const res = await runEngines(opts)
    expect(statuses(res.runs)).toEqual(['searxng:error/unreachable', 'tavily:ok'])
    expect(health.map.get('searxng')?.suspendedUntil).toBe(NOW + 30_000)
  })
})
