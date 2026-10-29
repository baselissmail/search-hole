// SPDX-License-Identifier: Apache-2.0
/**
 * ADR-0008 "Consequences" properties, checked with fast-check, plus an
 * exhaustive pairwise check of (tier × action × important × list-important)
 * against an independent oracle of the precedence table.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ListMode, Profile, RuleAction, RuleDecision, RuleScope } from '../../shared/types.ts'
import { compileRuleSet, type RuleSetInput, weightFactor } from './engine.ts'
import { buildInput, type ListSpec, type RuleSpec } from './testkit.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const URLS = [
  'https://www.example.com/docs/page',
  'https://example.com/',
  'https://spam.example.com/x?y=1',
  'https://other.org/a',
] as const
const MATCHES = [
  'example.com',
  '*.example.com',
  '=www.example.com',
  'example.com/docs/',
  '|https://*.example.com/^',
  '/^https:\\/\\/www\\./',
  'other.org',
  'notexample.com',
  'com',
] as const
const PROFILES: Profile[] = [
  { name: 'coding', prefer: { lists: ['a'] } },
  { name: 'news' },
  { name: 'strict', defaultAction: 'block' },
]
const LIST_IDS = ['a', 'b', 'c'] as const
const ACTIONS: readonly RuleAction[] = ['block', 'allow', 'pin', 'raise', 'lower', 'normal']
const USER_SCOPES: readonly RuleScope[] = ['session', 'project', 'global']

const urlArb = fc.constantFrom(...URLS)
const profileArb = fc.constantFrom('default', 'coding', 'news', 'strict')
const modeArb = fc.constantFrom<ListMode>('enforce', 'enforce', 'audit', 'disabled')
const listsArb: fc.Arbitrary<Record<string, ListSpec>> = fc
  .record({ a: modeArb, b: modeArb, c: modeArb })
  .map((m) => ({
    a: { mode: m.a, kind: 'official' },
    b: { mode: m.b },
    c: { mode: m.c },
  }))

interface SpecOpts {
  scopes?: readonly RuleScope[]
  allowImportant?: boolean
  match?: string
  timeless?: boolean
}
function specArb(o: SpecOpts = {}): fc.Arbitrary<RuleSpec> {
  return fc
    .record({
      scope: fc.constantFrom(...(o.scopes ?? (['session', 'project', 'global', 'list'] as const))),
      action: fc.constantFrom(...ACTIONS),
      match: o.match ? fc.constant(o.match) : fc.constantFrom(...MATCHES),
      weight: fc.integer({ min: 1, max: 10 }),
      important: fc.boolean(),
      listImportant: fc.boolean(),
      list: fc.constantFrom(...LIST_IDS),
      profiles: fc.option(fc.subarray(['coding', 'news'], { minLength: 1 }), { nil: undefined }),
      until: o.timeless
        ? fc.constant(undefined)
        : fc.option(fc.constantFrom('2026-01-01', '2027-01-01'), { nil: undefined }),
    })
    .map((r) => {
      const s: RuleSpec = { scope: r.scope, action: r.action, match: r.match, weight: r.weight }
      if (r.scope === 'list') {
        s.list = r.list
        s.listImportant = r.listImportant
      } else if (r.scope !== 'project' && (o.allowImportant ?? true)) s.important = r.important
      if (r.profiles) s.profiles = r.profiles
      if (r.until) s.until = r.until
      return s
    })
}
const specsArb = (o?: SpecOpts) => fc.array(specArb(o), { maxLength: 12 })

const decide = (input: RuleSetInput, url: string, profile: string): RuleDecision =>
  compileRuleSet(input).decide(url, { profile, now: NOW })

const visibleCore = (d: RuleDecision) => ({
  visibility: d.visibility,
  visibilityRule: d.visibilityRule,
  hiddenReason: d.hiddenReason,
  pin: d.pin,
  weight: d.weight,
  preferFactor: d.preferFactor,
  matches: d.matches,
})

const RUNS = { numRuns: 300 }

describe('ADR-0008 properties', () => {
  it('idempotence: deciding twice, or with every rule duplicated, gives the same outcome', () => {
    fc.assert(
      fc.property(specsArb(), listsArb, urlArb, profileArb, (specs, lists, url, profile) => {
        const input = buildInput(specs, lists, PROFILES)
        const set = compileRuleSet(input)
        const a = set.decide(url, { profile, now: NOW })
        expect(set.decide(url, { profile, now: NOW })).toEqual(a)
        expect(decide(input, url, profile)).toEqual(a)
        const dup = decide(buildInput([...specs, ...specs], lists, PROFILES), url, profile)
        expect(dup.visibility).toBe(a.visibility)
        expect(dup.hiddenReason).toBe(a.hiddenReason)
        expect(dup.weight.factor).toBe(a.weight.factor)
        expect(dup.preferFactor).toBe(a.preferFactor)
        expect(dup.pin === undefined).toBe(a.pin === undefined)
        expect(dup.audit?.wouldBe).toBe(a.audit?.wouldBe)
      }),
      RUNS,
    )
  })

  it('user supremacy: any user allow keeps a result against any list rules, including $important', () => {
    fc.assert(
      fc.property(
        specsArb({ scopes: ['list'] }),
        listsArb,
        fc.constantFrom(...USER_SCOPES),
        fc.boolean(),
        profileArb,
        (listSpecs, lists, scope, important, profile) => {
          const allow: RuleSpec = { scope, action: 'allow', match: 'example.com' }
          if (scope !== 'project') allow.important = important
          const d = decide(buildInput([...listSpecs, allow], lists, PROFILES), URLS[0], profile)
          expect(d.visibility).toBe('kept')
          expect(d.visibilityRule?.tier).not.toBe('T4')
          expect(d.audit).toBeUndefined()
        },
      ),
      RUNS,
    )
  })

  it('monotonicity: list rules never change a visibility a user tier decided', () => {
    fc.assert(
      fc.property(
        specsArb({ scopes: USER_SCOPES }),
        specsArb({ scopes: ['list'] }),
        listsArb,
        urlArb,
        profileArb,
        (userSpecs, listSpecs, lists, url, profile) => {
          const before = decide(buildInput(userSpecs, lists, PROFILES), url, profile)
          if (!before.visibilityRule || before.visibilityRule.tier === 'T4') return
          const after = decide(buildInput([...userSpecs, ...listSpecs], lists, PROFILES), url, profile)
          expect(after.visibility).toBe(before.visibility)
          expect(after.visibilityRule).toEqual(before.visibilityRule)
          expect(after.pin).toEqual(before.pin)
        },
      ),
      RUNS,
    )
  })

  it('monotonicity: adding a list block never hides a result a user rule keeps', () => {
    fc.assert(
      fc.property(
        specsArb(),
        listsArb,
        fc.constantFrom(...LIST_IDS),
        fc.boolean(),
        urlArb,
        profileArb,
        (specs, lists, list, listImportant, url, profile) => {
          const before = decide(buildInput(specs, lists, PROFILES), url, profile)
          if (before.visibility !== 'kept' || !before.visibilityRule || before.visibilityRule.tier === 'T4')
            return
          const block: RuleSpec = { scope: 'list', action: 'block', match: '|https://', list, listImportant }
          expect(decide(buildInput([...specs, block], lists, PROFILES), url, profile).visibility).toBe('kept')
        },
      ),
      RUNS,
    )
  })

  it('determinism: permuting lists or the user-rule array never changes the outcome', () => {
    fc.assert(
      fc.property(
        specsArb(),
        listsArb,
        urlArb,
        profileArb,
        fc.integer(),
        (specs, lists, url, profile, seed) => {
          const input = buildInput(specs, lists, PROFILES)
          const shuffle = <T>(xs: readonly T[]): T[] => {
            const out = [...xs]
            let s = seed
            for (let i = out.length - 1; i > 0; i--) {
              s = (Math.imul(s, 1103515245) + 12345) | 0
              const j = Math.abs(s) % (i + 1)
              const tmp = out[i] as T
              out[i] = out[j] as T
              out[j] = tmp
            }
            return out
          }
          const permuted: RuleSetInput = {
            ...input,
            rules: shuffle(input.rules ?? []),
            lists: shuffle(input.lists ?? []).map((l) => ({ ...l, rules: shuffle(l.rules) })),
          }
          expect(decide(permuted, url, profile)).toEqual(decide(input, url, profile))
        },
      ),
      RUNS,
    )
  })

  it('adding an audit-mode list never changes the visible output', () => {
    fc.assert(
      fc.property(
        specsArb(),
        listsArb,
        specsArb({ scopes: ['list'] }),
        urlArb,
        profileArb,
        (specs, lists, auditSpecs, url, profile) => {
          const base = buildInput(specs, lists, PROFILES)
          const extra = buildInput(
            auditSpecs.map((s) => ({ ...s, list: 'trial' })),
            { trial: { mode: 'audit' } },
          )
          const withAudit: RuleSetInput = {
            ...base,
            lists: [
              ...(base.lists ?? []),
              ...(extra.lists ?? []).map((l) => ({
                ...l,
                cancel: [{ match: 'example.com', action: 'block' as const }],
                rules: l.rules.map((r) => ({ ...r, id: `audit-${r.id}` })),
              })),
            ],
          }
          expect(visibleCore(decide(withAudit, url, profile))).toEqual(
            visibleCore(decide(base, url, profile)),
          )
        },
      ),
      RUNS,
    )
  })

  it('important lifts a user rule above scope order', () => {
    fc.assert(
      fc.property(specsArb({ allowImportant: false }), urlArb, profileArb, (specs, url, profile) => {
        const block: RuleSpec = { scope: 'global', action: 'block', match: '|https://', important: true }
        const d = decide(buildInput([...specs, block], {}, PROFILES), url, profile)
        expect(d.visibility).toBe('hidden')
        expect(d.visibilityRule).toMatchObject({ ruleId: `r${specs.length}`, tier: 'T0g' })
        const allow: RuleSpec = { scope: 'session', action: 'allow', match: '|https://', important: true }
        const k = decide(buildInput([...specs, block, allow], {}, PROFILES), url, profile)
        expect(k.visibility).toBe('kept')
        expect(k.visibilityRule?.tier).toBe('T0s')
      }),
      RUNS,
    )
  })

  it('raise, lower and normal never change visibility or pins', () => {
    fc.assert(
      fc.property(specsArb(), listsArb, urlArb, profileArb, (specs, lists, url, profile) => {
        const all = decide(buildInput(specs, lists, PROFILES), url, profile)
        const visOnly = specs.map((s) =>
          ['raise', 'lower', 'normal'].includes(s.action) ? { ...s, match: 'unrelated.invalid' } : s,
        )
        const d = decide(buildInput(visOnly, lists, PROFILES), url, profile)
        expect(d.visibility).toBe(all.visibility)
        expect(d.visibilityRule).toEqual(all.visibilityRule)
        expect(d.pin).toEqual(all.pin)
      }),
      RUNS,
    )
  })

  it('a matching user weight rule replaces list weights', () => {
    fc.assert(
      fc.property(
        specsArb({ scopes: ['list'] }),
        listsArb,
        fc.constantFrom(...USER_SCOPES),
        fc.constantFrom<RuleAction>('raise', 'lower', 'normal'),
        fc.integer({ min: 1, max: 10 }),
        profileArb,
        (listSpecs, lists, scope, action, weight, profile) => {
          const user: RuleSpec = { scope, action, weight, match: 'example.com' }
          const d = decide(buildInput([...listSpecs, user], lists, PROFILES), URLS[0], profile)
          expect(d.weight.rule?.tier).not.toBe('T4')
          expect(d.weight.factor).toBeCloseTo(weightFactor(action, weight), 12)
        },
      ),
      RUNS,
    )
  })
})

// ── Oracle: the precedence table written independently of the engine ─────

interface Combo {
  scope: RuleScope
  action: RuleAction
  important: boolean
  listImportant: boolean
  weight: number
}
const COMBOS: Combo[] = []
for (const scope of ['session', 'project', 'global', 'list'] as const)
  for (const action of ACTIONS)
    for (const important of scope === 'list' || scope === 'project' ? [false] : [false, true])
      for (const listImportant of scope === 'list' ? [false, true] : [false])
        COMBOS.push({ scope, action, important, listImportant, weight: 3 })

const oracleTier = (c: Combo): number =>
  c.scope === 'session'
    ? c.important
      ? 0
      : 2
    : c.scope === 'global'
      ? c.important
        ? 1
        : 4
      : c.scope === 'project'
        ? 3
        : 5

function oracle(rules: readonly Combo[]): {
  visibility: 'kept' | 'hidden'
  winner: number | null
  pinned: boolean
  weight: number | null
} {
  let visibility: 'kept' | 'hidden' = 'kept'
  let winner: number | null = null
  for (let t = 0; t <= 5 && winner === null; t++) {
    const idx = rules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => oracleTier(r) === t && ['allow', 'block', 'pin'].includes(r.action))
    if (idx.length === 0) continue
    const first = (pred: (r: Combo) => boolean) => idx.find(({ r }) => pred(r))?.i ?? null
    const order =
      t < 5
        ? [
            (r: Combo) => r.action === 'allow',
            (r: Combo) => r.action === 'block',
            (r: Combo) => r.action === 'pin',
          ]
        : [
            (r: Combo) => r.action === 'allow' && r.listImportant,
            (r: Combo) => r.action === 'block' && r.listImportant,
            (r: Combo) => r.action === 'allow',
            (r: Combo) => r.action === 'block',
            (r: Combo) => r.action === 'pin',
          ]
    for (const pred of order) {
      winner = first(pred)
      if (winner !== null) break
    }
    visibility = rules[winner ?? -1]?.action === 'block' ? 'hidden' : 'kept'
  }
  const pinned = visibility === 'kept' && rules.some((r) => r.scope !== 'list' && r.action === 'pin')
  let weight: number | null = null
  for (let t = 0; t <= 5 && weight === null; t++) {
    const w = rules
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => oracleTier(r) === t && ['raise', 'lower', 'normal'].includes(r.action))
    if (w.length === 0) continue
    if (t < 5) weight = w[0]?.i ?? null
    else {
      const strength = (r: Combo) => (r.action === 'raise' ? r.weight : r.action === 'lower' ? -r.weight : 0)
      weight = w.reduce((best, cur) => (strength(cur.r) > strength(best.r) ? cur : best)).i
    }
  }
  return { visibility, winner, pinned, weight }
}

function checkAgainstOracle(combos: readonly Combo[]): void {
  const specs: RuleSpec[] = combos.map((c, i) => {
    const s: RuleSpec = { scope: c.scope, action: c.action, weight: c.weight }
    if (c.important) s.important = true
    if (c.scope === 'list') {
      s.listImportant = c.listImportant
      // One list per rule, named so list order equals file order (T4 ties break by list id, then order).
      s.list = `L${String(i).padStart(3, '0')}`
    }
    return s
  })
  const d = decide(buildInput(specs), URLS[0], 'default')
  const o = oracle(combos)
  expect(d.visibility).toBe(o.visibility)
  expect(d.visibilityRule?.ruleId).toBe(o.winner === null ? undefined : `r${o.winner}`)
  expect(d.pin !== undefined).toBe(o.pinned)
  expect(d.weight.rule?.ruleId).toBe(o.weight === null ? undefined : `r${o.weight}`)
}

describe('precedence oracle', () => {
  it(`agrees on every ordered pair of the ${COMBOS.length} (tier × action × important × list-important) combinations`, () => {
    for (const a of COMBOS) for (const b of COMBOS) checkAgainstOracle([a, b])
  })

  it('agrees on random rule sets', () => {
    const comboArb = fc.record({
      c: fc.constantFrom(...COMBOS),
      weight: fc.integer({ min: 1, max: 10 }),
    })
    fc.assert(
      fc.property(fc.array(comboArb, { minLength: 1, maxLength: 10 }), (xs) => {
        checkAgainstOracle(xs.map(({ c, weight }) => ({ ...c, weight })))
      }),
      { numRuns: 500 },
    )
  })
})
