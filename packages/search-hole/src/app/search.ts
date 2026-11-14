// SPDX-License-Identifier: Apache-2.0
/**
 * The search pipeline (ARCHITECTURE "A search, step by step"; ADR-0008/0009/0010/0012/0015):
 * hygiene → rules and profile → plan per depth → fan-out with fallback → merge → outcome →
 * log → receipt. Engine failures are data; only "nothing could answer" is an error.
 */
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { type RunEnginesOptions, runEngines } from '../core/fanout.ts'
import { checkQuery, queryBlockedError, redact } from '../core/hygiene.ts'
import { merge, summarizeHidden } from '../core/merge/index.ts'
import { normalizeHost } from '../core/rules/index.ts'
import { canonicalize, hostOf, normalizeOriginal } from '../core/url.ts'
import { SearchHoleError } from '../shared/errors.ts'
import { retentionDaysFor } from '../shared/settings.ts'
import {
  AVAILABLE_ENGINES,
  type Depth,
  ENGINE_ID_LIST,
  type EngineId,
  type EnginePlan,
  type EngineRetention,
  type EngineRun,
  type ErrorClass,
  type FallbackHop,
  type Freshness,
  type HealthState,
  type HiddenReason,
  type InactiveReason,
  type MergedResult,
  type Profile,
  type RawResult,
  type RuleDecision,
  type RuleRef,
  type SearchOutcome,
  type Warning,
} from '../shared/types.ts'
import type { RecordedResult, Store } from '../store/index.ts'
import type { AppContext } from './context.ts'
import type { Engines, ResolvedEngine } from './engines.ts'
import { type LoopGuard, searchKey } from './loopguard.ts'
import type { Receipts } from './receipts.ts'
import { type RuleContext, type RulesService, safeBlockHosts } from './rules.ts'
import type { RequestCtx, SearchArgs } from './types.ts'

/** Output slots per depth: default and maximum (ADR-0012). */
export const LIMITS: Readonly<Record<Depth, { def: number; max: number }>> = {
  quick: { def: 8, max: 10 },
  standard: { def: 10, max: 12 },
  deep: { def: 15, max: 20 },
}
/** Engines called at once per depth (ADR-0017 point 5). */
const ENGINE_COUNT: Readonly<Record<Depth, number>> = {
  quick: 1,
  standard: 2,
  deep: Number.POSITIVE_INFINITY,
}
/** Over-fetch factor per depth (ADR-0009 point 7); quick asks one engine for its top 10. */
const OVER_FETCH: Readonly<Record<Depth, number>> = { quick: 1, standard: 2, deep: 3 }
const QUICK_TOP = 10
const DAY_MS = 86_400_000

const searchArgsSchema = z.object({
  query: z.string().trim().min(1, 'query is empty').max(400, 'query is longer than 400 characters'),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  profile: z.string().trim().min(1).max(64).optional(),
  engines: z.array(z.enum(AVAILABLE_ENGINES)).max(AVAILABLE_ENGINES.length).optional(),
  maxAgeDays: z.number().int().min(1).max(36_500).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  receiptId: z.string().max(100).optional(),
})

/** Parses tool or CLI input; `invalid_argument` names the first problem. */
export function parseSearchArgs(args: SearchArgs): z.infer<typeof searchArgsSchema> {
  const r = searchArgsSchema.safeParse(args)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const path = issue?.path.map(String).join('.') ?? ''
  throw new SearchHoleError(
    'invalid_argument',
    `Invalid search arguments: ${path ? `${path}: ` : ''}${issue?.message ?? 'invalid'}.`,
  )
}

const INACTIVE_TEXT: Readonly<Record<InactiveReason, string>> = {
  missing_key: 'no API key',
  no_endpoint: 'no URL configured',
  disabled: 'disabled',
  spend_cap: 'spend cap reached',
  suspended: 'paused after errors',
  json_disabled: 'JSON output disabled',
  unhealthy: 'unhealthy',
}
const ERROR_TEXT: Readonly<Record<ErrorClass, string>> = {
  offline: 'offline',
  unreachable: 'not reachable',
  timeout: 'timed out',
  rate_limited: 'rate-limited',
  quota: 'quota used up',
  auth: 'key rejected',
  forbidden: 'refused the request',
  json_disabled: 'JSON output disabled',
  captcha: 'blocked by a CAPTCHA',
  server: 'server error',
  malformed: 'unreadable response',
  bad_request: 'rejected the query',
  cancelled: 'cancelled',
}

/** "searxng: not reachable" for one engine run. */
export function describeRun(run: EngineRun): string {
  if (run.status === 'skipped') return `${run.engine}: ${INACTIVE_TEXT[run.inactiveReason ?? 'unhealthy']}`
  if (run.status === 'error') return `${run.engine}: ${ERROR_TEXT[run.errorClass ?? 'server']}`
  return `${run.engine}: ok`
}

/** The ADR-0012 error: "No healthy engine (brave: key rejected; searxng: not reachable) → add an engine…". */
export function noHealthyEngine(states: readonly string[]): SearchHoleError {
  const why =
    states.length > 0 ? `No healthy engine (${states.join('; ')}).` : 'No search engine is configured.'
  return new SearchHoleError('no_healthy_engine', why, {
    fix: 'add an engine with `searchhole searxng up` (private, needs Docker) or `searchhole keys set tavily` (free key); `searchhole doctor` shows what is set up',
    details: { engines: [...states] },
  })
}

const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** `site:` and `-site:` operators in a query (ADR-0012): enforced locally, pushed where supported. */
export function siteOperators(query: string): { include: string[]; exclude: string[] } {
  const include: string[] = []
  const exclude: string[] = []
  for (const token of query.split(/\s+/)) {
    const m = /^(-?)site:(\S+)$/i.exec(token)
    if (!m?.[2]) continue
    const host = normalizeHost(m[2].replace(/^\*\./, '').replace(/\/.*$/, ''))
    if (host === null) continue
    const list = m[1] === '-' ? exclude : include
    if (!list.includes(host)) list.push(host)
  }
  return { include, exclude }
}

const siteRef = (text: string): RuleRef => ({ ruleId: 'query:site', tier: 'T0s', text, source: 'query' })

/** Wraps the rule decision with the query's `site:` operators. */
export function withSiteOperators(
  decide: (url: string) => RuleDecision,
  ops: { include: readonly string[]; exclude: readonly string[] },
): (url: string) => RuleDecision {
  if (ops.include.length === 0 && ops.exclude.length === 0) return decide
  return (url) => {
    const d = decide(url)
    if (d.visibility === 'hidden') return d
    const host = hostOf(url) ?? ''
    const excluded = ops.exclude.find((e) => within(host, e))
    const outside = ops.include.length > 0 && !ops.include.some((i) => within(host, i))
    if (excluded === undefined && !outside) return d
    const text = excluded !== undefined ? `-site:${excluded}` : `site:${ops.include.join(',')}`
    return {
      visibility: 'hidden',
      hiddenReason: 'rule',
      visibilityRule: siteRef(text),
      weight: { factor: 1 },
      preferFactor: 1,
      matches: d.matches,
    }
  }
}

/** Attaches each result's per-engine payloads (so the store can apply each engine's terms). */
export function withHits(results: readonly MergedResult[], raw: readonly RawResult[]): MergedResult[] {
  const byKey = new Map<string, RawResult[]>()
  const byUrl = new Map<string, RawResult[]>()
  for (const r of raw) {
    const url = normalizeOriginal(r.url)
    if (url === null) continue
    const c = canonicalize(url)
    if (c) byKey.set(c.key, [...(byKey.get(c.key) ?? []), r])
    byUrl.set(url, [...(byUrl.get(url) ?? []), r])
  }
  return results.map((m) => {
    const urls = new Set(m.urls)
    const ruleHidden =
      m.hiddenReason === 'rule' || m.hiddenReason === 'list' || m.hiddenReason === 'allowlist_mode'
    const members = ruleHidden
      ? m.urls.flatMap((u) => byUrl.get(u) ?? [])
      : (byKey.get(m.canonicalKey) ?? []).filter((r) => urls.has(normalizeOriginal(r.url) ?? ''))
    const hits = members
      .filter((r) => m.engines.includes(r.engine))
      .map((r) => ({ engine: r.engine, url: r.url, title: r.title, snippet: r.snippet, rank: r.rank }))
    return { ...m, hits }
  })
}

const HEALTH_RANK: Readonly<Record<HealthState, number>> = { healthy: 0, unknown: 1, unhealthy: 2 }

/** The engine count for one engine at a depth: over-fetch × wanted, at most `maxPerCall`. */
function countFor(depth: Depth, limit: number, maxPerCall: number): number {
  const wanted = depth === 'quick' ? Math.max(QUICK_TOP, limit) : Math.ceil(limit * OVER_FETCH[depth])
  return Math.max(1, Math.min(maxPerCall, wanted))
}

export interface SearchDeps {
  ctx: AppContext
  engines: Engines
  rules: RulesService
  receipts: Receipts
  loop: LoopGuard
}

/** Effective freshness: the profile's, with a model argument that can only tighten it (ADR-0008). */
export function effectiveFreshness(
  profile: Omit<Profile, 'name'>,
  maxAgeDays: number | undefined,
): Freshness {
  const f: Freshness = { ...(profile.freshness ?? {}) }
  if (maxAgeDays !== undefined) f.maxAgeDays = Math.min(maxAgeDays, f.maxAgeDays ?? Number.POSITIVE_INFINITY)
  return f
}

/** Retention per engine, honouring `storageRights` (ADR-0009 point 9). */
function retentionOf(resolved: readonly ResolvedEngine[]): Partial<Record<EngineId, EngineRetention>> {
  const out: Partial<Record<EngineId, EngineRetention>> = {}
  for (const r of resolved) {
    out[r.id] = r.settings.storageRights ? { log: 'full', payloadTtlHours: null } : r.adapter.retention
  }
  return out
}

/** Runs one search. Throws `invalid_argument`, `query_blocked` or `no_healthy_engine`. */
export async function runSearch(d: SearchDeps, input: SearchArgs, rctx: RequestCtx): Promise<SearchOutcome> {
  const started = performance.now()
  const { ctx, engines, rules, receipts, loop } = d
  const args = parseSearchArgs(input)
  const settings = ctx.settings.settings

  // 1. Query hygiene (ADR-0015 point 4): before anything else sees the query.
  const hygiene = checkQuery(args.query, {
    mode: settings.queryHygiene.mode,
    hosts: settings.queryHygiene.hosts,
    allow: settings.queryHygiene.allow,
    internalHosts: settings.queryHygiene.internalHosts,
    flagLoopback: settings.queryHygiene.flagLoopback,
  })
  if (hygiene.action === 'block') throw queryBlockedError(hygiene.findings)
  const query = hygiene.query

  // Loop guard (ADR-0019). The terminal is the user's own command, so the CLI is exempt.
  const loopKey = searchKey(query, [args.depth, args.profile, args.engines?.join(',')])
  if (ctx.host !== 'cli') {
    const stop = loop.check(rctx, loopKey, settings.limits)
    if (stop !== null) throw stop
  }

  // 2. Rules and profile.
  const store = await ctx.store.write()
  const now = ctx.now()
  const rc: RuleContext = rules.context(rctx, store)
  const { name: profileName, profile } = rules.resolveProfile(
    rc,
    query,
    args.profile,
    settings.profiles_default,
  )
  const depth: Depth = args.depth ?? profile.depth ?? 'standard'
  const limits = LIMITS[depth]
  const limit = Math.min(args.limit ?? limits.def, limits.max)
  const freshness = effectiveFreshness(profile, args.maxAgeDays)

  // 3. Plan.
  const resolved = await engines.resolveAll(store)
  const configured = resolved.filter((r) => r.configured)
  let order: EngineId[]
  if (args.engines !== undefined && args.engines.length > 0) {
    const unknown = args.engines.filter((id) => !configured.some((r) => r.id === id))
    if (unknown.length > 0) {
      throw new SearchHoleError('invalid_argument', `Engine not configured: ${unknown.join(', ')}.`, {
        fix:
          configured.length > 0
            ? `Use one of: ${configured.map((r) => r.id).join(', ')}, or omit engines.`
            : 'Omit engines; run `searchhole doctor` to set one up.',
      })
    }
    order = [...new Set(args.engines)]
  } else {
    const fromProfile = (profile.engines ?? []).filter((id) => configured.some((r) => r.id === id))
    const base = fromProfile.length > 0 ? fromProfile : [...settings.fallback]
    order = [...new Set([...base, ...ENGINE_ID_LIST])]
  }
  const candidates = order
    .map((id) => configured.find((r) => r.id === id))
    .filter((r): r is ResolvedEngine => r !== undefined)
  if (candidates.length === 0) {
    throw noHealthyEngine(
      resolved.map((r) => `${r.id}: ${INACTIVE_TEXT[r.setup.active ? 'unhealthy' : r.setup.reason]}`),
    )
  }
  const ranked = await Promise.all(
    candidates.map(async (r, i) => {
      const h = await engines.health(r.id, r.keyFp, store)
      const suspended = h !== null && (h.suspendedUntilEvent !== null || (h.suspendedUntil ?? 0) > now)
      return { r, i, suspended, state: await engines.state(r, store) }
    }),
  )
  const callable = ranked
    .filter((x) => !x.suspended)
    .sort((a, b) => HEALTH_RANK[a.state] - HEALTH_RANK[b.state] || a.i - b.i)
  const wantEngines = Math.max(ENGINE_COUNT[depth], args.engines?.length ?? 0)
  const planned = callable.slice(0, wantEngines).map((x) => x.r)
  if (planned.length === 0) {
    throw noHealthyEngine(
      ranked.map((x) => `${x.r.id}: ${INACTIVE_TEXT[x.suspended ? 'suspended' : 'unhealthy']}`),
    )
  }
  const standby = candidates.filter((r) => !planned.includes(r))

  const ops = siteOperators(query)
  const allowlist = profile.defaultAction === 'block'
  const pushed = allowlist ? [] : safeBlockHosts(rc.userRules, profileName, now)
  const sinceDate =
    freshness.requireDate === true &&
    freshness.maxAgeDays !== undefined &&
    Number.isFinite(freshness.maxAgeDays)
      ? new Date(now - freshness.maxAgeDays * DAY_MS).toISOString().slice(0, 10)
      : undefined
  const planFor = (r: ResolvedEngine): EnginePlan => {
    const caps = r.adapter.capabilities
    const pushdown = r.settings.pushdown === 'blocks' && (caps.domainExclude !== null || caps.goggles)
    const plan: EnginePlan = {
      query,
      count: countFor(depth, limit, caps.maxPerCall),
      depth,
      language: 'all',
      safesearch: 1,
      includeDomains: ops.include,
      excludeDomains: ops.exclude,
      pushdownBlockHosts: pushdown ? pushed.map((p) => p.host) : [],
    }
    if (sinceDate !== undefined) plan.sinceDate = sinceDate
    return plan
  }

  // 4. Fan-out.
  const fanOpts: RunEnginesOptions = {
    plans: planned.map((r) => ({ adapter: r.adapter, plan: planFor(r), ctx: r.ctx })),
    standby: standby.map((r) => ({ adapter: r.adapter, plan: planFor(r), ctx: r.ctx })),
    transport: engines.fanoutTransport(),
    health: engines.healthPort(resolved, store),
    usage: engines.usagePort(resolved, store),
    fallback: candidates.map((r) => r.id),
    now: ctx.now,
    signal: rctx.signal ?? new AbortController().signal,
  }
  const fan = await runEngines(fanOpts)
  if (!fan.runs.some((r) => r.status === 'ok' || r.status === 'empty')) {
    if (rctx.signal?.aborted) throw new SearchHoleError('engine_failed', 'The search was cancelled.')
    const ran = new Set(fan.runs.map((r) => r.engine))
    throw noHealthyEngine([
      ...fan.runs.map(describeRun),
      ...resolved
        .filter((r) => !ran.has(r.id))
        .map(
          (r) =>
            `${r.id}: ${r.configured ? 'not tried' : INACTIVE_TEXT[r.setup.active ? 'unhealthy' : r.setup.reason]}`,
        ),
    ])
  }

  // The receipt only once something answered, so a failed search leaves no empty receipt.
  const assigned = receipts.assign(rctx, args.receiptId, store)

  // 5–7. Decide per original URL, merge, annotate.
  const decide = withSiteOperators((u) => rc.ruleSet.decide(u, { profile: profileName, now }), ops)
  const weights: Partial<Record<EngineId, number>> = {}
  for (const r of resolved) weights[r.id] = r.settings.weight
  const merged = merge({
    raw: fan.raw,
    decide,
    depth,
    limit,
    freshness,
    now,
    engineOrder: fan.attempted,
    engineWeights: weights,
    sourceType: rules.sourceTypeOf(rc, profileName, now),
  })
  const hiddenSummary = summarizeHidden(merged.hidden)
  const results = withHits(merged.results, fan.raw)
  const hidden = withHits(merged.hidden, fan.raw)

  const warnings: Warning[] = [...assigned.warnings, ...fan.warnings, ...merged.warnings]
  if (hygiene.action === 'redact') {
    warnings.unshift({ code: 'query_redacted', classes: [...new Set(hygiene.findings.map((f) => f.class))] })
  }
  const tookMs = Math.max(0, Math.round(performance.now() - started))
  const outcome: SearchOutcome = {
    receiptId: assigned.receiptId,
    query,
    profile: profileName,
    depth,
    results,
    hidden,
    hiddenSummary,
    engines: fan.runs,
    warnings,
    tookMs,
  }
  if (rctx.session) outcome.sessionId = rctx.session.key
  if (rctx.toolUseId !== undefined) outcome.toolUseId = rctx.toolUseId
  const pushingRuns = fan.runs.filter((r) => (r.pushedRuleCount ?? 0) > 0)
  if (pushingRuns.length > 0) {
    const most = Math.max(...pushingRuns.map((r) => r.pushedRuleCount ?? 0))
    outcome.pushedRuleIds = [...new Set(pushed.slice(0, most).map((p) => p.ruleId))]
  }
  if (fan.hops.length > 0) {
    outcome.fallbackTrail = fan.hops.map(
      (h): FallbackHop => ({
        from: h.from,
        to: h.to,
        errorClass: h.reason === 'upstream_failed' ? 'server' : h.reason,
      }),
    )
  }
  const altered = Object.values(fan.altered).find((q) => typeof q === 'string' && q !== '')
  if (altered !== undefined) outcome.alteredQuery = altered

  // 8. Record (never blocks or fails the search), then the receipt line.
  const queryRedacted = redact(query, { hosts: true })
  recordOutcome(ctx, store, outcome, resolved, queryRedacted, rctx)
  const byReason: Partial<Record<HiddenReason, number>> = { ...hiddenSummary.byReason }
  receipts.noteSearch(assigned.receiptId, {
    query: queryRedacted,
    at: new Date(now).toISOString(),
    mode: 'engines',
    engines: fan.runs.filter((r) => r.status === 'ok' || r.status === 'empty').map((r) => r.engine),
    kept: results.length,
    hidden: hidden.length,
    hiddenByReason: byReason,
  })
  if (fan.runs.some((r) => r.status === 'ok' || r.status === 'empty')) loop.note(rctx, loopKey)
  return outcome
}

function recordOutcome(
  ctx: AppContext,
  store: Store | null,
  outcome: SearchOutcome,
  resolved: readonly ResolvedEngine[],
  queryRedacted: string,
  rctx: RequestCtx,
): void {
  if (!store) {
    const w = ctx.store.loggingWarning()
    if (w) outcome.warnings.push(w)
    return
  }
  const rows: RecordedResult[] = [
    ...outcome.results.map(
      (m, i): RecordedResult => ({ merged: m, hits: m.hits ?? [], visibility: 'kept', outRank: i + 1 }),
    ),
    ...outcome.hidden.map(
      (m): RecordedResult => ({
        merged: m,
        hits: m.hits ?? [],
        visibility: 'hidden',
        ...(m.hiddenReason === undefined ? {} : { reason: m.hiddenReason }),
      }),
    ),
  ]
  try {
    const res = store.recordSearch({
      receiptId: outcome.receiptId,
      ...(rctx.session ? { sessionId: rctx.session.key } : {}),
      queryRedacted,
      profile: outcome.profile,
      depth: outcome.depth,
      engines: outcome.engines,
      latencyMs: outcome.tookMs,
      keptCount: outcome.results.length,
      hiddenCount: outcome.hidden.length,
      ...(outcome.toolUseId === undefined ? {} : { toolUseId: outcome.toolUseId }),
      ...(outcome.pushedRuleIds === undefined ? {} : { pushedRuleIds: outcome.pushedRuleIds }),
      retention: retentionOf(resolved),
      retentionDays: retentionDaysFor(ctx.settings.settings.retention, 'resultPayloads'),
      results: rows,
    })
    if (res.status === 'skipped') outcome.warnings.push(res.warning)
  } catch (e) {
    ctx.logger.warn({ err: e }, 'could not log the search')
    outcome.warnings.push({ code: 'logging_unavailable', detail: 'the search could not be logged' })
  }
}
