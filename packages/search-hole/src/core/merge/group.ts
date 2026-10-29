// SPDX-License-Identifier: Apache-2.0
/**
 * Building one MergedResult from the raw results that share a canonical key
 * (ADR-0010 §2). Every choice is made from the data alone, never from input order, so
 * permuting the raw input never changes the output.
 */
import type {
  EngineId,
  FoundDate,
  MergedResult,
  RawResult,
  ResultFlag,
  RuleDecision,
  SourceType,
} from '../../shared/types.ts'
import { effectiveDate, type FreshnessBasis, isPlausibleDate, isUpdated } from '../freshness.ts'
import { type Canonical, hostOf, registrableDomain } from '../url.ts'
import { fuse, sanitizeFactor } from './score.ts'

/** Engine order from the plan, then any other engine by id. */
export interface EngineIndex {
  indexOf(engine: EngineId): number
  sort(engines: Iterable<EngineId>): EngineId[]
}

/** Builds the engine order: the plan's order first, then unplanned engines by id. */
export function engineIndex(order: readonly EngineId[], seen: Iterable<EngineId>): EngineIndex {
  const all = [...order]
  const extra = [...new Set(seen)].filter((e) => !order.includes(e)).sort()
  for (const e of extra) all.push(e)
  const idx = new Map<EngineId, number>()
  all.forEach((e, i) => {
    if (!idx.has(e)) idx.set(e, i)
  })
  const indexOf = (e: EngineId): number => idx.get(e) ?? all.length
  return {
    indexOf,
    sort: (engines) => [...new Set(engines)].sort((a, b) => indexOf(a) - indexOf(b)),
  }
}

/** One raw result after normalisation and its rule decision. */
export interface Member {
  raw: RawResult
  /** `normalizeOriginal(raw.url)`. */
  url: string
  canonical: Canonical
  decision: RuleDecision
}

/** What building needs besides the members. */
export interface GroupCtx {
  engines: EngineIndex
  weightOf: (engine: EngineId) => number
  basis: FreshnessBasis | undefined
  now: number
  sourceType: (url: string, host: string) => SourceType
}

/** A built result plus the tie-break keys ordering needs. */
export interface Draft {
  result: MergedResult
  bestRank: number
  bestEngineIdx: number
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Total order on raw results by content: rank, engine order, URL, title, snippet, dates. */
export function compareRaw(a: RawResult, b: RawResult, engines: EngineIndex): number {
  return (
    a.rank - b.rank ||
    engines.indexOf(a.engine) - engines.indexOf(b.engine) ||
    cmp(a.url, b.url) ||
    cmp(a.title, b.title) ||
    cmp(a.snippet, b.snippet) ||
    cmp(JSON.stringify(a.dates), JSON.stringify(b.dates)) ||
    cmp(JSON.stringify(a.via ?? []), JSON.stringify(b.via ?? []))
  )
}

/** Display preference: https, fewest variant marks, best raw rank, engine order, shortest, lexical. */
function compareDisplay(a: Member, b: Member, engines: EngineIndex): number {
  const https = (m: Member): number => (m.url.startsWith('https:') ? 0 : 1)
  return (
    https(a) - https(b) ||
    a.canonical.marks - b.canonical.marks ||
    a.raw.rank - b.raw.rank ||
    engines.indexOf(a.raw.engine) - engines.indexOf(b.raw.engine) ||
    a.url.length - b.url.length ||
    cmp(a.url, b.url)
  )
}

/**
 * The member whose decision speaks for the group: a pin on any member pins the group
 * (lowest pin order), otherwise the display URL's own decision.
 */
function representative(byDisplay: readonly Member[]): Member | undefined {
  let best: Member | undefined
  for (const m of byDisplay) {
    const pin = m.decision.pin
    if (pin && (best?.decision.pin === undefined || pin.order < best.decision.pin.order)) best = m
  }
  return best ?? byDisplay[0]
}

function longest(values: readonly string[]): string {
  let best = ''
  for (const v of values) if (v.length > best.length) best = v
  return best
}

const KIND_ORDER = { published: 0, modified: 1, crawled: 2, existed_by: 3 } as const

/**
 * Union of the members' dates, every source kept (ADR-0011: nothing is overwritten),
 * minus implausible ones (ADR-0011 point 5), deduplicated and in a fixed order.
 */
export function mergeDates(lists: readonly (readonly FoundDate[])[], now: number): FoundDate[] {
  const byKey = new Map<string, FoundDate>()
  for (const list of lists) {
    for (const d of list) {
      if (!isPlausibleDate(d.value, now)) continue
      const key = JSON.stringify([d.kind, d.value, d.method, d.confidence, d.tzAssumed])
      if (!byKey.has(key)) byKey.set(key, d)
    }
  }
  return [...byKey.entries()]
    .sort(
      ([ka, a], [kb, b]) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || cmp(a.value, b.value) || cmp(ka, kb),
    )
    .map(([, d]) => ({ ...d }))
}

/** Flags that follow from the decision and dates alone (freshness and coverage add more). */
function baseFlags(decision: RuleDecision, multiplier: number, dates: readonly FoundDate[], now: number) {
  const flags = new Set<ResultFlag>()
  if (decision.pin) flags.add('pinned')
  // A tolerance, so `lower 3` × `prefer 1.45` (= 1 up to rounding) is neither.
  if (multiplier > 1 + 1e-9) flags.add('raised')
  if (multiplier < 1 - 1e-9) flags.add('lowered')
  if (isUpdated(dates, now)) flags.add('updated')
  if (decision.audit?.wouldBe === 'hidden' && decision.visibility === 'kept') flags.add('would_hide')
  if (decision.audit?.wouldBe === 'kept' && decision.visibility === 'hidden') flags.add('would_show')
  return flags
}

/** Fixed flag order, so output is stable. */
export const FLAG_ORDER: readonly ResultFlag[] = [
  'pinned',
  'coverage',
  'raised',
  'lowered',
  'stale',
  'date_unknown',
  'updated',
  'would_hide',
  'would_show',
]

/** Flags in `FLAG_ORDER`. */
export function orderFlags(flags: ReadonlySet<ResultFlag>): ResultFlag[] {
  return FLAG_ORDER.filter((f) => flags.has(f))
}

/**
 * Builds one MergedResult (ADR-0010 §2): `positions[e]` = min raw rank, fused over those,
 * adjusted by the rule and prefer multipliers; longest title and snippet; union of engines
 * in plan order; https preferred for display; all plausible dates kept.
 */
export function buildDraft(members: readonly Member[], ctx: GroupCtx): Draft {
  const { engines } = ctx
  const byContent = [...members].sort((a, b) => compareRaw(a.raw, b.raw, engines))
  const byDisplay = [...members].sort((a, b) => compareDisplay(a, b, engines))
  const display = byDisplay[0]
  const rep = representative(byDisplay)
  if (!display || !rep) throw new RangeError('buildDraft needs at least one member')

  const minRank = new Map<EngineId, number>()
  for (const m of members) {
    const prev = minRank.get(m.raw.engine)
    if (prev === undefined || m.raw.rank < prev) minRank.set(m.raw.engine, m.raw.rank)
  }
  const engineList = engines.sort(minRank.keys())
  const positions: Partial<Record<EngineId, number>> = {}
  let bestRank = Number.POSITIVE_INFINITY
  let bestEngineIdx = Number.POSITIVE_INFINITY
  for (const e of engineList) {
    const r = minRank.get(e) ?? Number.POSITIVE_INFINITY
    positions[e] = r
    if (r < bestRank) {
      bestRank = r
      bestEngineIdx = engines.indexOf(e)
    }
  }

  const decision = rep.decision
  const fused = fuse(positions, engineList, ctx.weightOf)
  const multiplier = sanitizeFactor(decision.weight.factor) * sanitizeFactor(decision.preferFactor)
  const dates = mergeDates(
    byContent.map((m) => m.raw.dates),
    ctx.now,
  )
  const effective = effectiveDate(dates, ctx.basis, ctx.now)
  const host = hostOf(display.url) ?? ''
  const urls = [...new Set(byDisplay.map((m) => m.url))]

  const result: MergedResult = {
    canonicalKey: display.canonical.key,
    url: display.url,
    urls,
    title: longest(byContent.map((m) => m.raw.title)),
    snippet: longest(byContent.map((m) => m.raw.snippet)),
    engines: engineList,
    positions,
    dates,
    ...(effective ? { effectiveDate: effective } : {}),
    sourceType: ctx.sourceType(display.url, host),
    registrableDomain: registrableDomain(host),
    fused,
    adjusted: fused * multiplier,
    decision,
    flags: orderFlags(baseFlags(decision, multiplier, dates, ctx.now)),
  }
  return { result, bestRank, bestEngineIdx }
}
