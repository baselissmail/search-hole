// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { EngineId, EngineRetention, RuleDecision } from '../../src/shared/types.ts'
import { planRecord, urlHash } from '../../src/store/record.ts'
import type { RecordedResult } from '../../src/store/types.ts'
import { mergedResult, recorded, searchInput } from './helpers.ts'

const ENGINES: readonly EngineId[] = ['searxng', 'brave', 'tavily', 'exa', 'mojeek', 'kagi', 'marginalia']
const NOW = Date.UTC(2026, 9, 30)

const retentionArb = fc.record({
  log: fc.constantFrom('full', 'metadata', 'decisions-only'),
  payloadTtlHours: fc.option(fc.integer({ min: 0, max: 24 * 400 }), { nil: null }),
}) as fc.Arbitrary<EngineRetention>

describe('planRecord (ADR-0009 point 9: retention is enforced by the store, not by trust)', () => {
  it('is deterministic', () => {
    const input = searchInput()
    expect(planRecord(input, NOW)).toEqual(planRecord(input, NOW))
  })

  it('property: decisions-only engines never leave a title, snippet or URL in any row', () => {
    const engineSubset = fc.uniqueArray(fc.constantFrom(...ENGINES), { minLength: 1, maxLength: 4 })
    fc.assert(
      fc.property(
        engineSubset,
        fc.dictionary(fc.constantFrom(...ENGINES), retentionArb),
        fc.integer({ min: 1, max: 365 }),
        (engines, retention, retentionDays) => {
          const url = 'https://leak.example.org/private/path'
          const merged = mergedResult(url, {
            engines: [...engines],
            positions: Object.fromEntries(engines.map((e, i) => [e, i + 1])),
            title: 'LEAK-TITLE',
            snippet: 'LEAK-SNIPPET',
          })
          const r: RecordedResult = {
            merged,
            hits: engines.map((engine) => ({ engine, url, title: 'LEAK-TITLE', snippet: 'LEAK-SNIPPET' })),
            visibility: 'kept',
            outRank: 1,
          }
          const plan = planRecord(searchInput({ retention, retentionDays, results: [r] }), NOW)
          const row = plan.results[0]
          if (!row) throw new Error('no row')
          const restricted = engines.some((e) => (retention[e]?.log ?? 'decisions-only') === 'decisions-only')

          // Payloads exist only for engines whose policy allows them, and respect the TTL cap.
          for (const p of row.payloads) {
            const policy = retention[p.engine as EngineId]
            expect(policy).toBeDefined()
            expect(policy?.log).not.toBe('decisions-only')
            expect(p.expiresAt).toBeGreaterThan(NOW)
            expect(p.expiresAt - NOW).toBeLessThanOrEqual(retentionDays * 86_400_000)
          }
          // The URL itself is stored only when no engine in the group restricts it.
          expect(row.canonicalKey === null).toBe(restricted)
          // Outside the payload rows, no title or snippet appears anywhere in the plan, and the URL
          // only appears when every engine in the group allows storing it.
          const { payloads: _payloads, ...rest } = row
          const flat = JSON.stringify({ search: plan.search, rest, stats: plan.stats })
          expect(flat).not.toContain('LEAK-TITLE')
          expect(flat).not.toContain('LEAK-SNIPPET')
          if (restricted) expect(flat).not.toContain('private/path')
          // The hash is always present and never the URL.
          expect(row.urlHash).toBe(urlHash(merged.canonicalKey))
        },
      ),
    )
  })

  it('picks the engine with the best raw rank, breaking ties by the group order', () => {
    const m = mergedResult('https://example.com/a', {
      engines: ['tavily', 'searxng'],
      positions: { searxng: 2, tavily: 2 },
    })
    expect(
      planRecord(searchInput({ results: [recorded('https://example.com/a', {}, m)] }), NOW).results[0],
    ).toMatchObject({
      engine: 'tavily',
      rawRank: 2,
    })
    const none = mergedResult('https://example.com/a', { engines: [], positions: {} })
    expect(
      planRecord(searchInput({ results: [{ merged: none, hits: [], visibility: 'kept' }] }), NOW).results[0],
    ).toMatchObject({
      engine: 'unknown',
      rawRank: 0,
      canonicalKey: null,
    })
  })

  it('records the deciding rule: the visibility rule, else the pin, else the weight rule', () => {
    const rule = (id: string) => ({ ruleId: id, tier: 'T1' as const, text: id })
    const base = { visibility: 'kept' as const, weight: { factor: 1 }, preferFactor: 1, matches: [] }
    const row = (decision: RuleDecision) =>
      planRecord(searchInput({ results: [recorded('https://example.com/a', {}, { decision })] }), NOW)
        .results[0]
    expect(row({ ...base, visibilityRule: rule('vis'), pin: { rule: rule('pin'), order: 1 } })?.ruleId).toBe(
      'vis',
    )
    expect(
      row({ ...base, pin: { rule: rule('pin'), order: 1 }, weight: { factor: 2, rule: rule('w') } })?.ruleId,
    ).toBe('pin')
    expect(row({ ...base, weight: { factor: 2, rule: rule('w') } })?.ruleId).toBe('w')
    expect(row(base)?.ruleId).toBeNull()
  })

  it('computes the UTC day and per-engine rollup rows, skipping skipped engines', () => {
    const plan = planRecord(
      searchInput({
        engines: [
          { engine: 'searxng', status: 'ok', returned: 4, latencyMs: 100 },
          { engine: 'brave', status: 'skipped', inactiveReason: 'spend_cap', returned: 0 },
          { engine: 'tavily', status: 'error', errorClass: 'timeout', returned: 0, latencyMs: 6000 },
        ],
        keptCount: 3,
        hiddenCount: 1,
        latencyMs: 6100,
      }),
      Date.UTC(2026, 9, 30, 23, 59, 59),
    )
    expect(plan.day).toBe('2026-10-30')
    expect(plan.stats.map((s) => [s.engine, s.searches, s.errors])).toEqual([
      ['searxng', 1, 0],
      ['tavily', 1, 1],
      ['*', 1, 1],
    ])
  })
})
