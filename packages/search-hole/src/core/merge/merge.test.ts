// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest'
import type { EngineId, FoundDate, RawResult, RuleDecision, SourceType } from '../../shared/types.ts'
import { classifySource } from '../sourcetype.ts'
import { hostOf } from '../url.ts'
import { type MergeInput, merge, summarizeHidden, weightMultiplier } from './index.ts'
import { hiddenDecision, keptDecision, ruleRef } from './testing.ts'

const NOW = Date.UTC(2026, 9, 30)
const ORDER: EngineId[] = ['searxng', 'brave', 'exa']

const pub = (
  value: string,
  confidence: FoundDate['confidence'] = 'medium',
  method = 'engine:x',
): FoundDate => ({
  value,
  kind: 'published',
  method,
  confidence,
  tzAssumed: false,
})

/** A raw result, dated fresh by default so `date_unknown` only shows where a test wants it. */
function raw(engine: EngineId, rank: number, url: string, extra: Partial<RawResult> = {}): RawResult {
  return { engine, rank, url, title: `t${rank}`, snippet: '', dates: [pub('2026-10-01')], ...extra }
}

const sourceType = (url: string): SourceType => classifySource(url, { typedLists: () => [] })

function run(rawResults: RawResult[], over: Partial<MergeInput> = {}) {
  return merge({
    raw: rawResults,
    decide: () => keptDecision(),
    depth: 'standard',
    limit: 10,
    freshness: {},
    now: NOW,
    engineOrder: ORDER,
    sourceType,
    ...over,
  })
}

/** decide() from a host → decision map (exact host or parent domain). */
function byHost(map: Record<string, RuleDecision>): (url: string) => RuleDecision {
  return (url) => {
    const host = hostOf(url) ?? ''
    for (const [h, d] of Object.entries(map)) if (host === h || host.endsWith(`.${h}`)) return d
    return keptDecision()
  }
}

describe('visibility first, per original URL', () => {
  it('hidden URLs never join a group, and each keeps its raw rank', () => {
    const block = hiddenDecision(ruleRef('r_b'))
    const out = run(
      [
        raw('searxng', 1, 'https://example.com/a'),
        raw('brave', 3, 'http://www.example.com/a/'),
        raw('exa', 2, 'https://www.example.com/a?utm_source=x'),
      ],
      { decide: (u) => (u.startsWith('http://www.') || u.includes('utm_') ? block : keptDecision()) },
    )
    expect(out.results).toHaveLength(1)
    expect(out.results[0]?.engines).toEqual(['searxng'])
    expect(out.results[0]?.positions).toEqual({ searxng: 1 })
    expect(out.hidden.map((h) => [h.url, h.positions, h.hiddenReason])).toEqual([
      ['https://www.example.com/a?utm_source=x', { exa: 2 }, 'rule'],
      ['http://www.example.com/a/', { brave: 3 }, 'rule'],
    ])
    // Each hidden result keeps its would-be score, for replay.
    expect(out.hidden[0]?.fused).toBeCloseTo(1 / 22, 12)
  })

  it('calls decide once per losslessly normalised URL', () => {
    const decide = vi.fn((_url: string) => keptDecision())
    run(
      [
        raw('searxng', 1, 'HTTPS://Example.com:443/a#x'),
        raw('brave', 1, 'https://example.com/a'),
        raw('exa', 1, 'https://www.example.com/a'),
      ],
      { decide },
    )
    expect(decide.mock.calls.map((c) => c[0])).toEqual(['https://example.com/a', 'https://www.example.com/a'])
  })

  it('copies list and allowlist reasons, defaulting to rule', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://a.example/'),
        raw('searxng', 2, 'https://b.example/'),
        raw('searxng', 3, 'https://c.example/'),
      ],
      {
        decide: byHost({
          'a.example': hiddenDecision(ruleRef('l', 'T4'), 'list'),
          'b.example': hiddenDecision(ruleRef('d'), 'allowlist_mode'),
          'c.example': { ...keptDecision(), visibility: 'hidden' },
        }),
      },
    )
    expect(out.hidden.map((h) => h.hiddenReason)).toEqual(['list', 'allowlist_mode', 'rule'])
  })
})

describe('grouping and fusion', () => {
  it('positions are the minimum raw rank per engine: no self-agreement bonus', () => {
    const out = run([
      raw('searxng', 2, 'https://example.com/a'),
      raw('searxng', 5, 'https://amp.example.com/a/amp'),
      raw('brave', 4, 'https://m.example.com/a'),
    ])
    expect(out.results[0]?.positions).toEqual({ searxng: 2, brave: 4 })
    expect(out.results[0]?.fused).toBeCloseTo(1 / 22 + 1 / 24, 12)
  })

  it('engine weights are additive per engine', () => {
    const out = run([raw('searxng', 1, 'https://example.com/'), raw('brave', 1, 'https://example.com/')], {
      engineWeights: { brave: 2 },
    })
    expect(out.results[0]?.fused).toBeCloseTo(1 / 21 + 2 / 21, 12)
  })

  it('adjusted = fused × weight factor × prefer factor', () => {
    const out = run([raw('searxng', 1, 'https://example.com/')], {
      decide: () => keptDecision({ weight: { factor: weightMultiplier('raise', 2) }, preferFactor: 1.45 }),
    })
    expect(out.results[0]?.adjusted).toBeCloseTo((1 / 21) * 1.3 * 1.45, 12)
    expect(out.results[0]?.flags).toContain('raised')
  })

  it('keeps the longest title and snippet, all engines in plan order, https for display', () => {
    const out = run([
      raw('exa', 3, 'http://example.com/a', { title: 'A much longer title', snippet: 'short' }),
      raw('searxng', 2, 'https://www.example.com/a?utm_source=s', {
        title: 'Short',
        snippet: 'the longest snippet here',
      }),
      raw('brave', 1, 'http://www.example.com/a/', { title: 'Mid title', snippet: 'mid snippet' }),
    ])
    const r = out.results[0]
    expect(r?.title).toBe('A much longer title')
    expect(r?.snippet).toBe('the longest snippet here')
    expect(r?.engines).toEqual(['searxng', 'brave', 'exa'])
    expect(r?.url).toBe('https://www.example.com/a?utm_source=s')
    expect(r?.urls).toEqual([
      'https://www.example.com/a?utm_source=s',
      'http://www.example.com/a/',
      'http://example.com/a',
    ])
    expect(r?.canonicalKey).toBe('//example.com/a')
    expect(r?.registrableDomain).toBe('example.com')
  })

  it('prefers the cleanest https URL for display (fewest AMP, mobile, tracking marks)', () => {
    const out = run([
      raw('searxng', 1, 'https://amp.example.com/a'),
      raw('brave', 2, 'https://example.com/a'),
      raw('exa', 1, 'https://example-com.cdn.ampproject.org/c/s/example.com/a'),
    ])
    expect(out.results[0]?.url).toBe('https://example.com/a')
  })

  it('keeps every plausible date from every member, in a fixed order', () => {
    const modified: FoundDate = {
      ...pub('2026-01-05'),
      kind: 'modified',
      method: 'engine:mojeek.date',
      confidence: 'low',
    }
    const out = run([
      raw('searxng', 1, 'https://example.com/a', { dates: [pub('2025-03-01', 'medium', 'engine:searxng')] }),
      raw('brave', 1, 'https://www.example.com/a', {
        dates: [pub('2025-02-01', 'medium', 'engine:brave.page_age'), pub('2031-01-01'), modified],
      }),
    ])
    const r = out.results[0]
    expect(r?.dates.map((d) => d.value)).toEqual(['2025-02-01', '2025-03-01', '2026-01-05'])
    expect(r?.effectiveDate?.method).toBe('engine:brave.page_age')
  })
})

describe('order (ADR-0010 §5)', () => {
  it('pins come first in pin order, whatever their score', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://top.example/'),
        raw('searxng', 9, 'https://pin-b.example/'),
        raw('searxng', 8, 'https://pin-a.example/'),
      ],
      {
        decide: byHost({
          'pin-a.example': keptDecision({ pin: { rule: ruleRef('p1'), order: 1 } }),
          'pin-b.example': keptDecision({ pin: { rule: ruleRef('p0'), order: 0 } }),
        }),
      },
    )
    expect(out.results.map((r) => r.url)).toEqual([
      'https://pin-b.example/',
      'https://pin-a.example/',
      'https://top.example/',
    ])
    expect(out.results[0]?.flags).toEqual(['pinned'])
  })

  it('pins sharing one pin order are ordered by score', () => {
    const pin = keptDecision({ pin: { rule: ruleRef('p'), order: 0 } })
    const out = run(
      [raw('searxng', 5, 'https://mdn.example/b'), raw('searxng', 2, 'https://mdn.example/a')],
      {
        decide: () => pin,
      },
    )
    expect(out.results.map((r) => r.url)).toEqual(['https://mdn.example/a', 'https://mdn.example/b'])
  })

  it('a pin on any member pins the group', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://other.example/'),
        raw('brave', 9, 'https://example.com/a'),
        raw('exa', 9, 'http://example.com/a'),
      ],
      {
        decide: (u) =>
          u.startsWith('http:') ? keptDecision({ pin: { rule: ruleRef('p'), order: 0 } }) : keptDecision(),
      },
    )
    expect(out.results[0]?.url).toBe('https://example.com/a')
    expect(out.results[0]?.decision.pin?.rule.ruleId).toBe('p')
  })

  it('ties break by best raw rank, then plan engine order, then canonical key', () => {
    // Same fused score (one rank-3 term each) but different best ranks are impossible, so
    // build ties explicitly: equal adjusted, then compare the keys.
    const out = run([
      raw('brave', 3, 'https://b.example/'),
      raw('searxng', 3, 'https://z.example/'),
      raw('exa', 3, 'https://a.example/'),
      raw('searxng', 3, 'https://y.example/'),
    ])
    expect(out.results.map((r) => r.url)).toEqual([
      'https://y.example/',
      'https://z.example/',
      'https://b.example/',
      'https://a.example/',
    ])
  })

  it('best raw rank breaks a score tie before engine order does', () => {
    // A weight makes searxng rank 2 score exactly like brave rank 1.
    const out = run([raw('searxng', 2, 'https://a.example/'), raw('brave', 1, 'https://b.example/')], {
      engineWeights: { searxng: 22 / 21 },
    })
    expect(out.results[0]?.adjusted).toBeCloseTo(out.results[1]?.adjusted ?? 0, 12)
    expect(out.results.map((r) => r.url)).toEqual(['https://b.example/', 'https://a.example/'])
  })
})

describe('freshness (ADR-0010 §6)', () => {
  const fresh = [pub('2026-10-01')]
  const old = [pub('2024-01-01')]

  it('hides stale results with reason stale; they never take a slot', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://old.example/', { dates: old }),
        raw('searxng', 2, 'https://new.example/', { dates: fresh }),
      ],
      { freshness: { maxAgeDays: 90 }, limit: 1 },
    )
    expect(out.results.map((r) => r.url)).toEqual(['https://new.example/'])
    expect(out.hidden.map((h) => [h.url, h.hiddenReason, h.flags])).toEqual([
      ['https://old.example/', 'stale', ['stale']],
    ])
  })

  it('keeps pinned stale results, flagged stale', () => {
    const out = run([raw('searxng', 1, 'https://old.example/', { dates: old })], {
      freshness: { maxAgeDays: 90 },
      decide: () => keptDecision({ pin: { rule: ruleRef('p'), order: 0 } }),
    })
    expect(out.results[0]?.flags).toEqual(['pinned', 'stale'])
    expect(out.hidden).toEqual([])
  })

  it('flags unknown and low-confidence dates date_unknown', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://none.example/', { dates: [] }),
        raw('searxng', 2, 'https://low.example/', { dates: [pub('2026-10-01', 'low')] }),
      ],
      { freshness: { maxAgeDays: 90 } },
    )
    expect(out.results.map((r) => r.flags)).toEqual([['date_unknown'], ['date_unknown']])
    expect(out.results[1]?.effectiveDate).toBeUndefined()
  })

  it('requireDate hides undated results with reason date_required, except pins', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://none.example/', { dates: [] }),
        raw('searxng', 2, 'https://pinned.example/', { dates: [] }),
      ],
      {
        freshness: { requireDate: true },
        decide: byHost({ 'pinned.example': keptDecision({ pin: { rule: ruleRef('p'), order: 0 } }) }),
      },
    )
    expect(out.results.map((r) => [r.url, r.flags])).toEqual([
      ['https://pinned.example/', ['pinned', 'date_unknown']],
    ])
    expect(out.hidden.map((h) => [h.url, h.hiddenReason])).toEqual([
      ['https://none.example/', 'date_required'],
    ])
  })

  it('uses the profile basis and flags updated pages', () => {
    const dates: FoundDate[] = [
      pub('2022-11-01'),
      { ...pub('2026-10-01', 'high', 'jsonld:dateModified'), kind: 'modified' },
    ]
    const byPublished = run([raw('searxng', 1, 'https://x.example/', { dates })], {
      freshness: { maxAgeDays: 90 },
    })
    expect(byPublished.hidden[0]?.hiddenReason).toBe('stale')
    const byModified = run([raw('searxng', 1, 'https://x.example/', { dates })], {
      freshness: { maxAgeDays: 90, basis: 'modified' },
    })
    expect(byModified.results[0]?.flags).toEqual(['updated'])
    expect(byModified.results[0]?.effectiveDate?.kind).toBe('modified')
  })
})

describe('deep coverage guarantee (ADR-0010 §7)', () => {
  const many = (engine: EngineId, n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => raw(engine, i + 1, `https://${prefix}${i + 1}.example/`))

  it('swaps an uncovered engine into the lowest free slot', () => {
    const out = run([...many('searxng', 5, 's'), raw('brave', 9, 'https://b.example/')], {
      depth: 'deep',
      limit: 3,
    })
    expect(out.results.map((r) => r.url)).toEqual([
      'https://s1.example/',
      'https://s2.example/',
      'https://b.example/',
    ])
    expect(out.results[2]?.keptReason).toBe('coverage')
    expect(out.results[2]?.flags).toEqual(['coverage'])
    expect(out.overflow.map((r) => r.url)).toEqual([
      'https://s3.example/',
      'https://s4.example/',
      'https://s5.example/',
    ])
    expect(out.warnings).not.toContainEqual({ code: 'coverage_skipped' })
  })

  it('does not run outside deep', () => {
    const out = run([...many('searxng', 5, 's'), raw('brave', 9, 'https://b.example/')], { limit: 3 })
    expect(out.results.map((r) => r.url)).not.toContain('https://b.example/')
  })

  it('never swaps out a pin, an earlier coverage result or an engine’s only result', () => {
    const out = run(
      [
        ...many('searxng', 3, 's'),
        raw('brave', 1, 'https://bonly.example/'),
        raw('exa', 20, 'https://e.example/'),
        raw('mojeek', 25, 'https://mj.example/'),
      ],
      {
        depth: 'deep',
        limit: 3,
        decide: byHost({ 's3.example': keptDecision({ pin: { rule: ruleRef('p'), order: 0 } }) }),
      },
    )
    // Before coverage: s3 (pin), s1, bonly (ties s1; searxng first), then s2, e, mj.
    // Exa skips bonly (brave's only result) and takes s1's slot. Mojeek then finds only
    // bonly, the exa coverage result and the pin: skipped.
    expect(out.results.map((r) => r.url)).toEqual([
      'https://s3.example/',
      'https://e.example/',
      'https://bonly.example/',
    ])
    expect(out.results[1]?.keptReason).toBe('coverage')
    expect(out.overflow.map((r) => r.url)).toEqual([
      'https://s1.example/',
      'https://s2.example/',
      'https://mj.example/',
    ])
    expect(out.warnings).toContainEqual({ code: 'coverage_skipped' })
  })

  it('warns coverage_skipped when no slot is eligible', () => {
    const pin = keptDecision({ pin: { rule: ruleRef('p'), order: 0 } })
    const out = run([...many('searxng', 3, 's'), raw('brave', 1, 'https://b.example/')], {
      depth: 'deep',
      limit: 2,
      decide: byHost({ 's1.example': pin, 's2.example': pin }),
    })
    expect(out.results.map((r) => r.url)).toEqual(['https://s1.example/', 'https://s2.example/'])
    expect(out.warnings).toContainEqual({ code: 'coverage_skipped' })
  })

  it('passes over an engine whose results were all hidden', () => {
    const out = run([...many('searxng', 3, 's'), raw('brave', 1, 'https://blocked.example/')], {
      depth: 'deep',
      limit: 2,
      decide: byHost({ 'blocked.example': hiddenDecision(ruleRef('b')) }),
    })
    expect(out.results.map((r) => r.url)).toEqual(['https://s1.example/', 'https://s2.example/'])
    expect(out.warnings).not.toContainEqual({ code: 'coverage_skipped' })
  })
})

describe('gap warnings (deep only)', () => {
  it('no_official_source and single_source', () => {
    const rs = [raw('searxng', 1, 'https://a.example.com/x'), raw('searxng', 2, 'https://b.example.com/y')]
    expect(run(rs, { depth: 'deep' }).warnings).toEqual([
      { code: 'no_official_source' },
      { code: 'single_source' },
    ])
    expect(run(rs).warnings).toEqual([])
  })

  it('an official or docs result clears no_official_source', () => {
    const out = run(
      [raw('searxng', 1, 'https://docs.python.org/3/'), raw('brave', 1, 'https://example.com/')],
      {
        depth: 'deep',
      },
    )
    expect(out.warnings).toEqual([])
  })

  it('all_stale when something was stale and nothing dated was fresh', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://old.example/', { dates: [pub('2020-01-01')] }),
        raw('brave', 1, 'https://undated.example/', { dates: [] }),
        raw('brave', 2, 'https://docs.example.org/', { dates: [] }),
      ],
      { depth: 'deep', freshness: { maxAgeDays: 30 } },
    )
    expect(out.warnings).toEqual([{ code: 'all_stale' }])
  })
})

describe('flags, limit and invalid input', () => {
  it('raised, lowered, would_hide and would_show', () => {
    const audit = { wouldBe: 'hidden' as const, rule: ruleRef('a', 'T4') }
    const out = run(
      [
        raw('searxng', 1, 'https://up.example/'),
        raw('searxng', 2, 'https://down.example/'),
        raw('searxng', 3, 'https://audit.example/'),
        raw('searxng', 4, 'https://shown.example/'),
        raw('searxng', 5, 'https://net.example/'),
      ],
      {
        decide: byHost({
          'up.example': keptDecision({ weight: { factor: weightMultiplier('raise', 1) } }),
          'down.example': keptDecision({ weight: { factor: weightMultiplier('lower', 1) } }),
          'audit.example': keptDecision({ audit }),
          'shown.example': hiddenDecision(ruleRef('b'), 'rule', {
            audit: { wouldBe: 'kept', rule: ruleRef('x') },
          }),
          'net.example': keptDecision({
            weight: { factor: weightMultiplier('lower', 3) },
            preferFactor: 1.45,
          }),
        }),
      },
    )
    const flags = Object.fromEntries([...out.results, ...out.hidden].map((r) => [r.url, r.flags]))
    expect(flags).toEqual({
      'https://up.example/': ['raised'],
      'https://down.example/': ['lowered'],
      'https://audit.example/': ['would_hide'],
      'https://shown.example/': ['would_show'],
      'https://net.example/': [],
    })
  })

  it('applies the limit after ordering; hidden results never use a slot', () => {
    const rs = Array.from({ length: 6 }, (_, i) => raw('searxng', i + 1, `https://r${i + 1}.example/`))
    const out = run(rs, { limit: 2, decide: byHost({ 'r1.example': hiddenDecision(ruleRef('b')) }) })
    expect(out.results.map((r) => r.url)).toEqual(['https://r2.example/', 'https://r3.example/'])
    expect(out.overflow.map((r) => r.url)).toEqual([
      'https://r4.example/',
      'https://r5.example/',
      'https://r6.example/',
    ])
    expect(run(rs, { limit: 0 }).results).toEqual([])
    expect(run(rs, { limit: Number.NaN }).results).toEqual([])
  })

  it('sets aside raw results without an http(s) URL or a rank ≥ 1', () => {
    const out = run([
      raw('searxng', 1, 'javascript:alert(1)'),
      raw('searxng', 0, 'https://zero.example/'),
      raw('brave', 1, 'not a url'),
      raw('brave', 2, 'https://ok.example/'),
    ])
    expect(out.results.map((r) => r.url)).toEqual(['https://ok.example/'])
    expect(out.invalid.map((r) => r.url)).toEqual([
      'https://zero.example/',
      'javascript:alert(1)',
      'not a url',
    ])
  })

  it('summarizeHidden counts reasons and top domains', () => {
    const out = run(
      [
        raw('searxng', 1, 'https://a.pinterest.com/1'),
        raw('brave', 1, 'https://pinterest.com/2'),
        raw('exa', 1, 'https://farm.example/'),
        raw('exa', 2, 'https://old.example/', { dates: [pub('2001-01-01')] }),
      ],
      {
        freshness: { maxAgeDays: 30 },
        decide: byHost({
          'pinterest.com': hiddenDecision(ruleRef('b')),
          'farm.example': hiddenDecision(ruleRef('l', 'T4'), 'list'),
        }),
      },
    )
    expect(summarizeHidden(out.hidden)).toEqual({
      count: 4,
      byReason: { rule: 2, list: 1, stale: 1 },
      topDomains: ['pinterest.com', 'farm.example', 'old.example'],
    })
  })
})
