// SPDX-License-Identifier: Apache-2.0
/**
 * Golden tests: the ADR-0010 worked-examples table (k = 20) and a fixed multi-engine
 * fixture whose expected output is checked in under test/fixtures/merge/.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  EngineId,
  ListKind,
  MergedResult,
  RawResult,
  RuleDecision,
  RuleRef,
  Tier,
} from '../../shared/types.ts'
import { classifySource } from '../sourcetype.ts'
import { hostOf } from '../url.ts'
import { merge, RRF_K, rrfTerm, summarizeHidden, weightMultiplier } from './index.ts'
import { keptDecision, ruleRef } from './testing.ts'

const NOW = Date.UTC(2026, 9, 30)

// ── ADR-0010 §3–4 worked examples ────────────────────────────────────────

/** One engine returning `n` results; `target`'s rank gets `factor`. Returns 1-based positions. */
function singleEngine(target: number, factor: number, n = 32) {
  const url = (r: number) => `https://r${r}.example/`
  const raw: RawResult[] = Array.from({ length: n }, (_, i) => ({
    engine: 'brave',
    rank: i + 1,
    url: url(i + 1),
    title: '',
    snippet: '',
    dates: [],
  }))
  const out = merge({
    raw,
    decide: (u) => (u === url(target) ? keptDecision({ weight: { factor } }) : keptDecision()),
    depth: 'standard',
    limit: 40,
    freshness: {},
    now: NOW,
    engineOrder: ['brave'],
    sourceType: () => 'unknown',
  })
  const position = (rank: number) => out.results.findIndex((r) => r.url === url(rank)) + 1
  const score = out.results.find((r) => r.url === url(target))?.adjusted ?? Number.NaN
  return { position, score }
}

describe('ADR-0010 worked examples (k = 20)', () => {
  it('uses k = 20: rank 1 = .0476, rank 10 = .0333, ratio 1.43', () => {
    expect(RRF_K).toBe(20)
    expect(rrfTerm(1)).toBeCloseTo(0.0476, 4)
    expect(rrfTerm(10)).toBeCloseTo(0.0333, 4)
    expect(rrfTerm(1) / rrfTerm(10)).toBeCloseTo(1.43, 2)
  })

  it('agreement dominates: rank 5 on two engines (.0800) beats rank 1 on one (.0476)', () => {
    expect(2 * rrfTerm(5)).toBeCloseTo(0.08, 4)
    const out = merge({
      raw: [
        { engine: 'brave', rank: 1, url: 'https://solo.example/', title: '', snippet: '', dates: [] },
        { engine: 'brave', rank: 5, url: 'https://both.example/', title: '', snippet: '', dates: [] },
        { engine: 'searxng', rank: 5, url: 'https://both.example/', title: '', snippet: '', dates: [] },
      ],
      decide: () => keptDecision(),
      depth: 'standard',
      limit: 10,
      freshness: {},
      now: NOW,
      engineOrder: ['searxng', 'brave'],
      sourceType: () => 'unknown',
    })
    expect(out.results.map((r) => r.url)).toEqual(['https://both.example/', 'https://solo.example/'])
  })

  it('rank 10, raise 1 (×1.15) = .0383: position 7, just below rank 6 (.0385)', () => {
    const { position, score } = singleEngine(10, weightMultiplier('raise', 1))
    expect(weightMultiplier('raise', 1)).toBeCloseTo(1.15, 12)
    expect(score).toBeCloseTo(0.0383, 4)
    expect(rrfTerm(6)).toBeCloseTo(0.0385, 4)
    expect(position(10)).toBe(7)
    expect(position(6)).toBe(6)
  })

  it('rank 10, raise 3 (×1.45) = .0483: rank 1 (a promotion)', () => {
    const { position, score } = singleEngine(10, weightMultiplier('raise', 3))
    expect(score).toBeCloseTo(0.0483, 4)
    expect(position(10)).toBe(1)
  })

  it('rank 20, raise 3 = .0363: lands at rank 7–8', () => {
    const { position, score } = singleEngine(20, weightMultiplier('raise', 3))
    expect(Math.abs(score - 0.0363)).toBeLessThan(1e-4)
    expect(position(20)).toBe(8)
    expect(position(7)).toBe(7)
  })

  it('rank 1, lower 3 (÷1.45) = .0328: lands at rank 10–11', () => {
    const { position, score } = singleEngine(1, weightMultiplier('lower', 3))
    expect(score).toBeCloseTo(0.0328, 4)
    expect(position(1)).toBe(10)
    expect(position(11)).toBe(11)
  })

  it('raw rank ≤ 32, raise 10 (×2.5) ≥ .0481: above every unweighted single-engine result', () => {
    for (let rank = 1; rank <= 32; rank++) {
      const { position, score } = singleEngine(rank, weightMultiplier('raise', 10))
      expect(score).toBeGreaterThan(rrfTerm(1))
      expect(position(rank)).toBe(1)
    }
    expect(Math.abs(singleEngine(32, 2.5).score - 0.0481)).toBeLessThan(1e-4)
    // The bound is tight: rank 33 × 2.5 falls below rank 1.
    expect(singleEngine(33, 2.5, 40).position(33)).toBe(2)
  })

  it('…but not against multi-engine agreement: rank 7 × 2.5 = .0926 < rank 1 on two engines = .0952', () => {
    expect(2.5 * rrfTerm(7)).toBeCloseTo(0.0926, 4)
    expect(2 * rrfTerm(1)).toBeCloseTo(0.0952, 4)
    const out = merge({
      raw: [
        { engine: 'brave', rank: 1, url: 'https://agreed.example/', title: '', snippet: '', dates: [] },
        { engine: 'searxng', rank: 1, url: 'https://agreed.example/', title: '', snippet: '', dates: [] },
        { engine: 'brave', rank: 7, url: 'https://raised.example/', title: '', snippet: '', dates: [] },
      ],
      decide: (u) => (u.includes('raised') ? keptDecision({ weight: { factor: 2.5 } }) : keptDecision()),
      depth: 'standard',
      limit: 10,
      freshness: {},
      now: NOW,
      engineOrder: ['searxng', 'brave'],
      sourceType: () => 'unknown',
    })
    expect(out.results.map((r) => r.url)).toEqual(['https://agreed.example/', 'https://raised.example/'])
  })
})

// ── Multi-engine fixture ─────────────────────────────────────────────────

const ENGINE = z.enum(['searxng', 'brave', 'tavily', 'exa', 'mojeek', 'kagi', 'marginalia'])
const TIER = z.enum(['T0s', 'T0g', 'T1', 'T2', 'T3', 'T4'])
const FixtureRule = z.object({
  id: z.string(),
  match: z.string(),
  action: z.enum(['block', 'allow', 'pin', 'raise', 'lower', 'normal']),
  tier: TIER,
  weight: z.number().int().min(1).max(10).optional(),
  order: z.number().int().optional(),
  listId: z.string().optional(),
  audit: z.boolean().optional(),
})
type FixtureRule = z.infer<typeof FixtureRule>
const FoundDateSchema = z.object({
  value: z.string(),
  kind: z.enum(['published', 'modified', 'crawled', 'existed_by']),
  method: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  tzAssumed: z.boolean(),
})
const Fixture = z.object({
  now: z.iso.datetime(),
  depth: z.enum(['quick', 'standard', 'deep']),
  limit: z.number().int(),
  freshness: z.object({ maxAgeDays: z.number().optional() }),
  engineOrder: z.array(ENGINE),
  typedLists: z.record(z.string(), z.array(z.enum(['block', 'allow', 'official', 'content-farm', 'clone']))),
  rules: z.array(FixtureRule),
  raw: z.array(
    z.object({
      engine: ENGINE,
      rank: z.number(),
      url: z.string(),
      title: z.string(),
      snippet: z.string(),
      dates: z.array(FoundDateSchema),
      via: z.array(z.string()).optional(),
    }),
  ),
})

const TIERS: readonly Tier[] = ['T0s', 'T0g', 'T1', 'T2', 'T3', 'T4']

/**
 * A minimal ADR-0008 tier walk over domain rules, enough for the fixture. The real rules
 * engine lives in core/rules; this keeps the golden test independent of it.
 */
function fixtureDecide(rules: readonly FixtureRule[]): (url: string) => RuleDecision {
  const ref = (r: FixtureRule): RuleRef => ruleRef(r.id, r.tier, `${r.match} ${r.action}`, r.listId)
  return (url) => {
    const host = hostOf(url) ?? ''
    const matches = rules.filter((r) => host === r.match || host.endsWith(`.${r.match}`))
    const enforced = matches.filter((r) => !r.audit)
    let decision: RuleDecision = keptDecision({ matches: matches.map(ref) })
    for (const tier of TIERS) {
      const vis = enforced.filter((r) => r.tier === tier && ['allow', 'block', 'pin'].includes(r.action))
      const win = vis.find((r) => r.action === 'allow') ?? vis.find((r) => r.action === 'block') ?? vis[0]
      if (!win) continue
      decision =
        win.action === 'block'
          ? {
              ...decision,
              visibility: 'hidden',
              visibilityRule: ref(win),
              hiddenReason: tier === 'T4' ? 'list' : 'rule',
            }
          : { ...decision, visibilityRule: ref(win) }
      break
    }
    const pin = enforced.find((r) => r.action === 'pin' && r.tier !== 'T4')
    if (decision.visibility === 'kept' && pin)
      decision = { ...decision, pin: { rule: ref(pin), order: pin.order ?? 0 } }
    for (const tier of TIERS) {
      const w = enforced.find(
        (r) => r.tier === tier && (r.action === 'raise' || r.action === 'lower' || r.action === 'normal'),
      )
      if (!w || (w.action !== 'raise' && w.action !== 'lower' && w.action !== 'normal')) continue
      decision = { ...decision, weight: { factor: weightMultiplier(w.action, w.weight ?? 1), rule: ref(w) } }
      break
    }
    const audit = matches.find((r) => r.audit && r.action === 'block')
    if (audit && decision.visibility === 'kept')
      decision = { ...decision, audit: { wouldBe: 'hidden', rule: ref(audit) } }
    return decision
  }
}

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../test/fixtures/merge/${name}`, import.meta.url), 'utf8'))
}

const round = (x: number) => Math.round(x * 1e6) / 1e6

/** The fields the expected file pins down for a kept result. */
function summarize(r: MergedResult) {
  return {
    url: r.url,
    canonicalKey: r.canonicalKey,
    urls: r.urls,
    engines: r.engines,
    positions: r.positions,
    fused: round(r.fused),
    adjusted: round(r.adjusted),
    title: r.title,
    snippet: r.snippet,
    ...(r.effectiveDate ? { effectiveDate: r.effectiveDate.value } : {}),
    sourceType: r.sourceType,
    flags: r.flags,
    ...(r.keptReason ? { keptReason: r.keptReason } : {}),
  }
}

describe('golden multi-engine fixture (deep)', () => {
  const fx = Fixture.parse(load('multi-engine.input.json'))
  const expected = load('multi-engine.expected.json') as {
    results: unknown[]
    overflow: { url: string; adjusted: number; flags: string[] }[]
    hidden: { url: string; hiddenReason: string; positions: object; ruleId?: string; flags?: string[] }[]
    warnings: unknown[]
    hiddenSummary: unknown
  }
  const typed = (host: string): ListKind[] => fx.typedLists[host] ?? []
  const raw: RawResult[] = fx.raw.map(({ via, ...r }) => (via ? { ...r, via } : r))
  const input = {
    raw,
    decide: fixtureDecide(fx.rules),
    depth: fx.depth,
    limit: fx.limit,
    freshness: fx.freshness.maxAgeDays === undefined ? {} : { maxAgeDays: fx.freshness.maxAgeDays },
    now: Date.parse(fx.now),
    engineOrder: fx.engineOrder as EngineId[],
    sourceType: (url: string) => classifySource(url, { typedLists: typed }),
  }
  const out = merge(input)

  it('orders kept results: pin, scores, AMP/www/tracking dedupe, coverage swap', () => {
    expect(out.results.map(summarize)).toEqual(expected.results)
  })

  it('keeps the overflow in order, with the searxng/brave tie broken by engine order', () => {
    expect(out.overflow.map((r) => ({ url: r.url, adjusted: round(r.adjusted), flags: r.flags }))).toEqual(
      expected.overflow,
    )
  })

  it('records every hidden raw result individually, plus stale groups', () => {
    expect(
      out.hidden.map((h) => ({
        url: h.url,
        hiddenReason: h.hiddenReason,
        positions: h.positions,
        ...(h.decision.visibilityRule ? { ruleId: h.decision.visibilityRule.ruleId } : {}),
        ...(h.hiddenReason === 'stale' ? { flags: h.flags } : {}),
      })),
    ).toEqual(expected.hidden)
    expect(summarizeHidden(out.hidden)).toEqual(expected.hiddenSummary)
  })

  it('raises no gap warnings for this fixture', () => {
    expect(out.warnings).toEqual(expected.warnings)
    expect(out.invalid).toEqual([])
  })

  it('is stable when the raw input is reversed', () => {
    expect(merge({ ...input, raw: [...raw].reverse() })).toEqual(out)
  })
})
