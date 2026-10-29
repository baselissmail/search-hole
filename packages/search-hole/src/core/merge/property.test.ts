// SPDX-License-Identifier: Apache-2.0
/** Merge properties (ADR-0010 §5, Principle 5): determinism and order independence. */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Depth, EngineId, FoundDate, Freshness, RawResult, RuleDecision } from '../../shared/types.ts'
import { classifySource } from '../sourcetype.ts'
import { hostOf } from '../url.ts'
import { type MergeInput, merge, weightMultiplier } from './index.ts'
import { hiddenDecision, keptDecision, ruleRef } from './testing.ts'

const NOW = Date.UTC(2026, 9, 30)
const ENGINES: EngineId[] = ['searxng', 'brave', 'exa', 'mojeek']

/** Variants of a few pages, so groups form: www, AMP, mobile, tracking, scheme, v=. */
const URLS = [
  'https://example.com/a',
  'http://www.example.com/a/',
  'https://amp.example.com/a?utm_source=x',
  'https://m.example.com/a#frag',
  'https://example.com/a/amp',
  'https://www-example-com.cdn.ampproject.org/c/s/www.example.com/a',
  'https://docs.example.org/guide',
  'https://docs.example.org/guide?ref=hn',
  'https://youtube.com/watch?v=AAA',
  'https://m.youtube.com/watch?v=AAA&fbclid=1',
  'https://youtube.com/watch?v=BBB',
  'https://pinterest.com/pin/1',
  'https://www.pinterest.com/pin/1',
  'https://pinned.example/x',
  'https://up.example/',
  'https://down.example/',
  'https://audit.example/',
  'https://farm.example/',
  'https://github.com/org/repo/releases',
  'https://blog.example.net/post',
  'mailto:nobody@example.com',
]

const DATES: FoundDate[] = [
  { value: '2026-10-01', kind: 'published', method: 'engine:a', confidence: 'medium', tzAssumed: false },
  { value: '2020-01-01', kind: 'published', method: 'engine:b', confidence: 'medium', tzAssumed: false },
  {
    value: '2026-09-01',
    kind: 'modified',
    method: 'engine:mojeek.date',
    confidence: 'low',
    tzAssumed: false,
  },
  {
    value: '2025-06-01T10:00:00Z',
    kind: 'modified',
    method: 'jsonld:dateModified',
    confidence: 'high',
    tzAssumed: false,
  },
  { value: '2031-01-01', kind: 'published', method: 'engine:c', confidence: 'high', tzAssumed: false },
]

const rawArb: fc.Arbitrary<RawResult> = fc.record({
  engine: fc.constantFrom(...ENGINES),
  rank: fc.integer({ min: 1, max: 15 }),
  url: fc.constantFrom(...URLS),
  title: fc.constantFrom('A', 'Longer title', 'Title'),
  snippet: fc.constantFrom('', 'snippet', 'a longer snippet'),
  dates: fc.subarray(DATES, { maxLength: 2 }),
})

/** A pure decide: the decision depends only on the host. */
function decide(url: string): RuleDecision {
  const host = hostOf(url) ?? ''
  if (host.endsWith('pinterest.com')) return hiddenDecision(ruleRef('r_block'))
  if (host === 'farm.example') return hiddenDecision(ruleRef('l_farm', 'T4'), 'list')
  if (host === 'pinned.example') return keptDecision({ pin: { rule: ruleRef('r_pin'), order: 0 } })
  if (host === 'github.com') return keptDecision({ pin: { rule: ruleRef('r_pin2'), order: 1 } })
  if (host === 'up.example') return keptDecision({ weight: { factor: weightMultiplier('raise', 3) } })
  if (host === 'down.example') return keptDecision({ weight: { factor: weightMultiplier('lower', 2) } })
  if (host === 'audit.example')
    return keptDecision({ audit: { wouldBe: 'hidden', rule: ruleRef('a', 'T4') } })
  return keptDecision()
}

const inputArb = fc.record({
  raw: fc.array(rawArb, { maxLength: 30 }),
  depth: fc.constantFrom<Depth>('quick', 'standard', 'deep'),
  limit: fc.integer({ min: 0, max: 12 }),
  freshness: fc.constantFrom<Freshness>(
    {},
    { maxAgeDays: 365 },
    { maxAgeDays: 30, requireDate: true },
    { basis: 'newest', maxAgeDays: 200 },
  ),
  engineOrder: fc.shuffledSubarray(ENGINES, { minLength: 1 }),
  weights: fc.constantFrom<Partial<Record<EngineId, number>>>({}, { brave: 1.5 }, { searxng: 0.5, exa: 2 }),
})

type Generated = typeof inputArb extends fc.Arbitrary<infer T> ? T : never

function toInput(x: Generated): MergeInput {
  return {
    raw: x.raw,
    decide,
    depth: x.depth,
    limit: x.limit,
    freshness: x.freshness,
    now: NOW,
    engineOrder: x.engineOrder,
    engineWeights: x.weights,
    sourceType: (url) => classifySource(url, { typedLists: () => [] }),
  }
}

describe('merge properties', () => {
  it('is deterministic: the same input gives the same output', () => {
    fc.assert(
      fc.property(inputArb, (x) => {
        expect(merge(toInput(x))).toEqual(merge(toInput(x)))
      }),
      { numRuns: 300 },
    )
  })

  it('does not depend on the order of the raw input', () => {
    const arb = inputArb.chain((x) =>
      fc.tuple(
        fc.constant(x),
        fc.shuffledSubarray(x.raw, { minLength: x.raw.length, maxLength: x.raw.length }),
      ),
    )
    fc.assert(
      fc.property(arb, ([x, shuffled]) => {
        expect(merge({ ...toInput(x), raw: shuffled })).toEqual(merge(toInput(x)))
      }),
      { numRuns: 500 },
    )
  })

  it('keeps the invariants: limit, visibility, pins first, accounting', () => {
    fc.assert(
      fc.property(inputArb, (x) => {
        const out = merge(toInput(x))
        expect(out.results.length).toBeLessThanOrEqual(x.limit)
        // Kept results only contain kept URLs; rule-hidden URLs never join a group.
        for (const r of [...out.results, ...out.overflow]) {
          for (const u of r.urls) expect(decide(u).visibility).toBe('kept')
        }
        for (const h of out.hidden) {
          if (h.hiddenReason === 'rule' || h.hiddenReason === 'list') expect(h.urls).toHaveLength(1)
        }
        // Pins come first, in pin order.
        const pinOrders = out.results.map((r) => r.decision.pin?.order ?? Number.POSITIVE_INFINITY)
        const firstUnpinned = pinOrders.indexOf(Number.POSITIVE_INFINITY)
        const pins = firstUnpinned === -1 ? pinOrders : pinOrders.slice(0, firstUnpinned)
        expect(pins).toEqual([...pins].sort((a, b) => a - b))
        if (firstUnpinned !== -1) {
          expect(pinOrders.slice(firstUnpinned).every((o) => o === Number.POSITIVE_INFINITY)).toBe(true)
        }
        // Every valid raw result is accounted for exactly once (kept groups by URL, hidden by entry).
        const valid = x.raw.length - out.invalid.length
        const keptMembers = x.raw.filter(
          (r) => !out.invalid.includes(r) && decide(r.url.replace(/#.*$/, '')).visibility === 'kept',
        ).length
        const ruleHidden = out.hidden.filter(
          (h) => h.hiddenReason === 'rule' || h.hiddenReason === 'list',
        ).length
        expect(keptMembers + ruleHidden).toBe(valid)
        // No duplicate canonical keys among kept output.
        const keys = [...out.results, ...out.overflow].map((r) => r.canonicalKey)
        expect(new Set(keys).size).toBe(keys.length)
        // Coverage only in deep, and only on results that carry the coverage flag.
        for (const r of out.results) {
          expect(r.keptReason === 'coverage').toBe(r.flags.includes('coverage'))
          if (r.keptReason) expect(x.depth).toBe('deep')
        }
      }),
      { numRuns: 300 },
    )
  })

  it('ranks each engine by its minimum raw rank only (duplicates add nothing)', () => {
    fc.assert(
      fc.property(fc.array(rawArb, { minLength: 1, maxLength: 10 }), (raw) => {
        const base = merge({
          ...toInput({ raw, depth: 'standard', limit: 50, freshness: {}, engineOrder: ENGINES, weights: {} }),
        })
        const doubled = merge({
          ...toInput({ raw, depth: 'standard', limit: 50, freshness: {}, engineOrder: ENGINES, weights: {} }),
          raw: [...raw, ...raw.map((r) => ({ ...r, rank: r.rank + 5 }))],
        })
        const fused = (rs: typeof base.results) =>
          Object.fromEntries(rs.map((r) => [r.canonicalKey, r.fused]))
        expect(fused([...doubled.results, ...doubled.overflow])).toEqual(
          fused([...base.results, ...base.overflow]),
        )
      }),
      { numRuns: 200 },
    )
  })
})
