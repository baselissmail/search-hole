// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Profile, Rule, Visibility } from '../../shared/types.ts'
import { compileRuleSet, DEFAULT_PREFER_FACTOR, weightFactor } from './engine.ts'
import { buildInput, type ListSpec, makeRule, type RuleSpec } from './testkit.ts'

interface PrecedenceCase {
  name: string
  profile?: string
  rules: RuleSpec[]
  lists?: Record<string, ListSpec>
  expect: {
    visibility: Visibility
    rule?: number | null
    hiddenReason?: string
    pin?: number | null
    weightRule?: number | null
    factor?: number
    audit?: { wouldBe: Visibility; rule: number } | null
  }
}

const table = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/rules/precedence.json', import.meta.url), 'utf8'),
) as { url: string; now: string; cases: PrecedenceCase[] }

const NOW = Date.parse(table.now)
const PROFILES: Profile[] = [{ name: 'coding' }, { name: 'news' }, { name: 'strict', defaultAction: 'block' }]
const id = (i: number | null | undefined) => (i === null || i === undefined ? undefined : `r${i}`)

describe('ADR-0008 precedence table (test/fixtures/rules/precedence.json)', () => {
  it.each(table.cases)('$name', (c) => {
    const set = compileRuleSet(buildInput(c.rules, c.lists, PROFILES))
    expect(set.issues).toEqual([])
    const d = set.decide(table.url, { profile: c.profile ?? 'default', now: NOW })
    expect(d.visibility).toBe(c.expect.visibility)
    if (c.expect.rule !== undefined) expect(d.visibilityRule?.ruleId).toBe(id(c.expect.rule))
    expect(d.hiddenReason).toBe(c.expect.hiddenReason)
    if (c.expect.pin !== undefined) expect(d.pin?.rule.ruleId).toBe(id(c.expect.pin))
    if (c.expect.weightRule !== undefined) expect(d.weight.rule?.ruleId).toBe(id(c.expect.weightRule))
    if (c.expect.factor !== undefined) expect(d.weight.factor).toBeCloseTo(c.expect.factor, 10)
    if (c.expect.audit !== undefined) {
      expect(d.audit && { wouldBe: d.audit.wouldBe, rule: d.audit.rule.ruleId }).toEqual(
        c.expect.audit === null
          ? undefined
          : { wouldBe: c.expect.audit.wouldBe, rule: id(c.expect.audit.rule) },
      )
    }
  })
})

describe('decide', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  const opts = { profile: 'default', now }

  it('records tier, list id and a text snapshot on every RuleRef', () => {
    const set = compileRuleSet(
      buildInput([
        { scope: 'global', action: 'lower', weight: 3, match: '*.medium.com', profiles: ['default'] },
        { scope: 'list', action: 'block', match: 'spam.medium.com', list: 'seo-spam', listImportant: true },
      ]),
    )
    const d = set.decide('https://spam.medium.com/p/1', opts)
    expect(d.visibility).toBe('hidden')
    expect(d.visibilityRule).toEqual({
      ruleId: 'r1',
      tier: 'T4',
      listId: 'seo-spam',
      text: 'block spam.medium.com $important',
    })
    expect(d.weight.rule).toEqual({ ruleId: 'r0', tier: 'T3', text: 'lower 3 *.medium.com profile=default' })
    expect(d.matches.map((m) => m.ruleId)).toEqual(['r0', 'r1'])
  })

  it('uses ADR-0010 multipliers', () => {
    expect(weightFactor('raise', 3)).toBeCloseTo(1.45)
    expect(weightFactor('lower', 3)).toBeCloseTo(1 / 1.45)
    expect(weightFactor('normal', 1)).toBe(1)
    expect(weightFactor('block', 1)).toBe(1)
  })

  it('assigns pin order by tier, then file order', () => {
    const set = compileRuleSet(
      buildInput([
        { scope: 'global', action: 'pin', match: 'a.example' },
        { scope: 'global', action: 'pin', match: 'b.example' },
        { scope: 'session', action: 'pin', match: 'c.example' },
        { scope: 'global', action: 'pin', match: 'c.example', important: true },
      ]),
    )
    const order = (u: string) => set.decide(u, opts).pin?.order
    expect(order('https://c.example/')).toBe(0) // T0g important first
    expect(order('https://a.example/')).toBe(2)
    expect(order('https://b.example/')).toBe(3)
    expect(set.decide('https://c.example/', opts).pin?.rule.tier).toBe('T0g')
  })

  it('applies profile prefer to enforce-list members, stacked with the tier weight', () => {
    const profiles: Profile[] = [
      { name: 'coding', prefer: { lists: ['official-docs'] } },
      { name: 'health', prefer: { lists: ['official-health'], factor: 2 } },
    ]
    const set = compileRuleSet(
      buildInput(
        [
          { scope: 'list', action: 'normal', match: 'developer.mozilla.org', list: 'official-docs' },
          { scope: 'list', action: 'normal', match: 'nih.gov', list: 'official-health' },
          { scope: 'global', action: 'lower', weight: 1, match: 'mozilla.org' },
          { scope: 'list', action: 'normal', match: 'developer.mozilla.org', list: 'trial' },
        ],
        {
          'official-docs': { kind: 'official' },
          'official-health': { kind: 'official' },
          trial: { mode: 'audit' },
        },
        profiles,
      ),
    )
    const mdn = set.decide('https://developer.mozilla.org/en-US/', { profile: 'coding', now })
    expect(mdn.preferFactor).toBe(DEFAULT_PREFER_FACTOR)
    expect(mdn.weight.rule?.ruleId).toBe('r2')
    expect(set.decide('https://developer.mozilla.org/', { profile: 'default', now }).preferFactor).toBe(1)
    expect(set.decide('https://www.nih.gov/', { profile: 'health', now }).preferFactor).toBe(2)
    expect(set.listMemberships('https://developer.mozilla.org/', opts)).toEqual(['official-docs'])
  })

  it('cancels identical list rules with $badfilter (enforce lists only)', () => {
    const base = buildInput([
      { scope: 'list', action: 'block', match: 'Example.com', list: 'a' },
      { scope: 'list', action: 'block', match: 'other.example', list: 'a' },
    ])
    const url = 'https://www.example.com/'
    const withCancel = (mode: 'enforce' | 'audit') =>
      compileRuleSet({
        ...base,
        lists: [
          ...(base.lists ?? []),
          { id: 'b', kind: 'block', mode, rules: [], cancel: [{ match: 'example.com', action: 'block' }] },
        ],
      })
    const enforced = withCancel('enforce').decide(url, opts)
    expect(enforced.visibility).toBe('kept')
    expect(enforced.matches).toEqual([])
    expect(withCancel('enforce').explainAll(url)[0]?.skipped).toBe('cancelled')
    expect(withCancel('enforce').decide('https://other.example/', opts).visibility).toBe('hidden')
    const audited = withCancel('audit').decide(url, opts)
    expect(audited.visibility).toBe('hidden')
    expect(audited.audit).toEqual({ wouldBe: 'kept', rule: audited.visibilityRule })
  })

  it('does not cancel a rule that differs in action or $important', () => {
    const set = compileRuleSet({
      lists: [
        {
          id: 'a',
          kind: 'block',
          mode: 'enforce',
          rules: [makeRule({ scope: 'list', action: 'block', listImportant: true, list: 'a' }, 0)],
          cancel: [{ match: 'example.com', action: 'block' }],
        },
      ],
    })
    expect(set.decide('https://example.com/', opts).visibility).toBe('hidden')
  })

  it('treats unparsable URLs as unmatched', () => {
    const set = compileRuleSet(buildInput([{ scope: 'global', action: 'block', match: 'com' }], {}, PROFILES))
    expect(set.decide('not a url', opts)).toMatchObject({ visibility: 'kept', matches: [] })
    expect(set.decide('not a url', { profile: 'strict', now })).toMatchObject({
      visibility: 'hidden',
      hiddenReason: 'allowlist_mode',
    })
  })

  it('skips invalid rules and reports them instead of throwing', () => {
    const bad: Rule[] = [
      { ...makeRule({ scope: 'global', action: 'block', match: '/(?=x)/' }, 0) },
      { ...makeRule({ scope: 'global', action: 'block', match: 'ok.example' }, 1), until: 'someday' },
      { ...makeRule({ scope: 'global', action: 'raise', match: 'ok.example' }, 2), weight: 11 },
      { ...makeRule({ scope: 'global', action: 'block', match: 'ok.example' }, 3), matchKind: 'regex' },
      { ...makeRule({ scope: 'list', action: 'block', match: 'ok.example' }, 4) },
      { ...makeRule({ scope: 'project', action: 'block', match: 'ok.example' }, 5), important: true },
    ]
    const set = compileRuleSet({ rules: bad })
    expect(set.issues.map((i) => i.code)).toEqual([
      'invalid_match',
      'invalid_until',
      'invalid_weight',
      'invalid_match',
      'list_rule_in_user_rules',
      'project_important_ignored',
    ])
    const d = set.decide('https://ok.example/', opts)
    expect(d.visibilityRule).toMatchObject({ ruleId: 'r5', tier: 'T2' })
  })

  it('explains every match with its skip reason', () => {
    const set = compileRuleSet(
      buildInput(
        [
          { scope: 'global', action: 'allow', until: '2026-01-01' },
          { scope: 'global', action: 'pin', profiles: ['coding'] },
          { scope: 'list', action: 'block', list: 'trial' },
          { scope: 'list', action: 'normal', list: 'docs' },
          { scope: 'global', action: 'block', match: 'unrelated.example' },
        ],
        { trial: { mode: 'audit' }, docs: { kind: 'official' } },
      ),
    )
    const info = set.explainAll('https://example.com/', { profile: 'news', now })
    expect(info.map((i) => [i.ref.ruleId, i.skipped, i.annotationOnly])).toEqual([
      ['r0', 'expired', undefined],
      ['r1', 'profile', undefined],
      ['r3', undefined, true],
      ['r2', 'audit_list', undefined],
    ])
    expect(set.explainAll('https://example.com/').map((i) => i.skipped)).toEqual([
      undefined,
      undefined,
      undefined,
      'audit_list',
    ])
  })

  it('ignores the order of the input array (sorted by order, then id)', () => {
    const specs: RuleSpec[] = [
      { scope: 'global', action: 'raise', weight: 1 },
      { scope: 'global', action: 'raise', weight: 4 },
    ]
    const a = compileRuleSet(buildInput(specs))
    const input = buildInput(specs)
    const b = compileRuleSet({ ...input, rules: [...(input.rules ?? [])].reverse() })
    expect(b.decide('https://example.com/', opts)).toEqual(a.decide('https://example.com/', opts))
  })

  it('indexes large lists by host label', () => {
    const rules: Rule[] = []
    for (let i = 0; i < 50_000; i++)
      rules.push(makeRule({ scope: 'list', action: 'block', match: `spam${i}.example` }, i))
    const set = compileRuleSet({ lists: [{ id: 'big', kind: 'block', mode: 'enforce', rules }] })
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) set.decide(`https://www.spam${i}.example/x`, opts)
    const perUrl = (performance.now() - t0) / 1000
    expect(set.decide('https://www.spam49999.example/', opts).visibility).toBe('hidden')
    expect(set.decide('https://notspam1.example/', opts).visibility).toBe('kept')
    expect(perUrl).toBeLessThan(1)
  })
})
