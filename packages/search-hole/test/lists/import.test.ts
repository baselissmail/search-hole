// SPDX-License-Identifier: Apache-2.0
/**
 * Importer behaviours the golden fixtures do not pin down: list kinds, the
 * `$badfilter` variants, detection, headers, caps, ids and syntax corners.
 */
import { describe, expect, it } from 'vitest'
import { compileRuleSet } from '../../src/core/rules/engine.ts'
import { ruleText } from '../../src/core/rules/ids.ts'
import {
  detectFormat,
  expiresToMs,
  type ImportOptions,
  importList,
  toListInput,
} from '../../src/lists/import/index.ts'
import type { ListKind } from '../../src/shared/types.ts'

const imp = (text: string, o: Partial<ImportOptions> = {}) =>
  importList(text, { format: 'auto', listId: 't', kind: 'block', ...o })
const texts = (text: string, o: Partial<ImportOptions> = {}) => imp(text, o).rules.map(ruleText)
const NOW = Date.parse('2026-10-31T00:00:00Z')

describe('list kinds (ADR-0008 "List role defines meaning")', () => {
  const ub = '*://*.a.example/*\n@*://*.b.example/*\n@4 *://*.c.example/*\n'
  it.each<[ListKind, string[], string[]]>([
    ['block', ['block a.example', 'allow b.example', 'raise 4 c.example'], []],
    ['content-farm', ['block a.example', 'allow b.example', 'raise 4 c.example'], []],
    ['clone', ['block a.example', 'allow b.example', 'raise 4 c.example'], []],
    ['allow', ['allow a.example', 'allow b.example', 'raise 4 c.example'], []],
    [
      'official',
      ['normal a.example', 'normal c.example'],
      ['exception in an official (annotation-only) list'],
    ],
  ])('%s', (kind, rules, skips) => {
    const r = imp(ub, { kind })
    expect(r.rules.map(ruleText)).toEqual(rules)
    expect(Object.keys(r.skipReasons)).toEqual(skips)
  })

  it('an official list never hides or weights, it only annotates membership', () => {
    const r = imp('||ads.example^$important\n$discard,site=b.example\n', { kind: 'official', format: 'abp' })
    const rules = compileRuleSet({ lists: [toListInput(r)] })
    const d = rules.decide('https://ads.example/', { profile: 'default', now: NOW })
    expect(d.visibility).toBe('kept')
    expect(d.weight.factor).toBe(1)
    expect(rules.listMemberships('https://ads.example/', { profile: 'default', now: NOW })).toEqual(['t'])
  })

  it('a Goggles discard has no meaning in an allow list', () => {
    const r = imp('$discard,site=a.example\n$boost=2,site=b.example\n', { kind: 'allow' })
    expect(r.rules.map(ruleText)).toEqual(['raise 2 b.example'])
    expect(r.skipReasons).toEqual({ 'discard in an allow list': 1 })
  })

  it('ABP @@ in an allow list is an exception too', () => {
    expect(texts('||a.example^\n@@||b.example^\n', { kind: 'allow', format: 'abp' })).toEqual([
      'allow a.example',
      'allow b.example',
    ])
  })
})

describe('$badfilter', () => {
  it('cancels the identical rule (action and $important) across lists, and nothing else', () => {
    const a = imp('||x.example^\n||y.example^$important\n@@||z.example^\n||w.example^\n', {
      listId: 'a',
      format: 'abp',
    })
    const b = imp(
      '||x.example^$badfilter\n||y.example^$important,badfilter\n@@||z.example^$badfilter\n||w.example^$important,badfilter\n',
      { listId: 'b', format: 'abp' },
    )
    expect(b.rules).toEqual([])
    expect(b.cancel).toEqual([
      { match: 'x.example', action: 'block' },
      { match: 'y.example', action: 'block', listImportant: true },
      { match: 'z.example', action: 'allow' },
      { match: 'w.example', action: 'block', listImportant: true },
    ])
    const rules = compileRuleSet({ lists: [toListInput(a), toListInput(b)] })
    const vis = (u: string) => rules.decide(u, { profile: 'default', now: NOW }).visibility
    expect(vis('https://x.example/')).toBe('kept')
    expect(vis('https://y.example/')).toBe('kept')
    expect(vis('https://w.example/')).toBe('hidden') // the plain rule is not the $important one
    const why = rules.explainAll('https://x.example/')
    expect(why.map((m) => m.skipped)).toEqual(['cancelled'])
  })

  it('a cancel only applies while its list is enforced', () => {
    const a = imp('||x.example^\n', { listId: 'a', format: 'abp' })
    const b = imp('||x.example^$badfilter\n', { listId: 'b', format: 'abp' })
    const rules = compileRuleSet({ lists: [toListInput(a), toListInput(b, 'audit')] })
    expect(rules.decide('https://x.example/', { profile: 'default', now: NOW }).visibility).toBe('hidden')
  })
})

describe('format detection', () => {
  it.each([
    ['', 'domains'],
    ['example.com\nfoo.org\n', 'domains'],
    ['0.0.0.0 a.example\n0.0.0.0 b.example\n', 'hosts'],
    ['! Title: x\n||a.example^\n||b.example^$important\n', 'abp'],
    ['[Adblock Plus 2.0]\nexample.com\n', 'abp'],
    ['||a.example^$dnstype=A\n||b.example^\n', 'adguard'],
    ['[AdGuard]\n', 'adguard'],
    ['*://*.a.example/*\n@*://b.example/*\n', 'ublacklist'],
    ['---\nname: x\n---\n', 'ublacklist'],
    ['! name: g\n$boost=2,site=a.example\n$discard\n', 'goggles'],
    ['/blog/$downrank=2\n', 'goggles'],
    ['version: 1\nrules:\n  - { match: a.example, action: block }\n', 'searchhole'],
  ])('%j → %s', (text, format) => {
    expect(detectFormat(text)).toBe(format)
    expect(imp(text).format).toBe(format)
  })
})

describe('headers', () => {
  it('reads ABP/hosts header comments, first value wins, placeholders ignored', () => {
    const r = imp(
      '! Title: First\n! Title: Second\n! Version: %VERSION%\n! Last modified: 2026-10-30\n! Licence: MIT\n||a.example^\n! Homepage: https://late.example/\n',
      { format: 'abp' },
    )
    expect(r.header).toEqual({ title: 'First', lastModified: '2026-10-30', license: 'MIT' })
  })

  it('reads Goggles metadata including transferred_to', () => {
    const r = imp('! name: g\n! transferred_to: https://new.example/g.goggle\n$site=a.example\n')
    expect(r.header).toEqual({ title: 'g', transferredTo: 'https://new.example/g.goggle' })
  })

  it.each([
    ['4 days (update frequency)', 4 * 86_400_000],
    ['12h', 12 * 3_600_000],
    ['1w', 7 * 86_400_000],
    ['30 minutes', 30 * 60_000],
    ['5', 5 * 86_400_000],
    ['0', null],
    ['soon', null],
    ['3 fortnights', null],
  ])('expiresToMs(%j) = %s', (v, ms) => {
    expect(expiresToMs(v)).toBe(ms)
  })
})

describe('caps (ADR-0008: 2,000,000 rules, 64 MiB, 20,000 regex)', () => {
  it('skips rules past the rule cap with a warning', () => {
    const r = imp('a.example\nb.example\nc.example\n', { format: 'domains', caps: { rules: 2 } })
    expect(r.rules).toHaveLength(2)
    expect(r.skipReasons).toEqual({ 'over the per-list rule cap': 1 })
    expect(r.warnings).toEqual(['list has more than 2 rules; the rest were skipped'])
  })

  it('skips regex past the regex cap, but keeps other rules', () => {
    const r = imp('/a1/\n/a2/\n*://*.c.example/*\n/a3/\n', { format: 'ublacklist', caps: { regex: 1 } })
    expect(r.rules.map(ruleText)).toEqual(['block /a1/', 'block c.example'])
    expect(r.skipReasons).toEqual({ 'over the per-list regex cap': 2 })
  })

  it('never raises a cap above the ADR limits', () => {
    const r = imp('a.example\n', { format: 'domains', caps: { rules: 10_000_000 } })
    expect(r.rules).toHaveLength(1)
  })
})

describe('rule shape', () => {
  it('ids carry the list and line; a hosts line with several names numbers them', () => {
    const r = imp('# c\n0.0.0.0 a.example b.example\n', { listId: 'hl', format: 'hosts' })
    expect(r.rules.map((x) => [x.id, x.match, x.text])).toEqual([
      ['l_hl_2', '=a.example', '0.0.0.0 a.example b.example'],
      ['l_hl_2_2', '=b.example', '0.0.0.0 a.example b.example'],
    ])
  })

  it('keeps the source line only when it differs from the match', () => {
    const r = imp('a.example\n*.b.example\n', { format: 'domains' })
    expect(r.rules.map((x) => x.text)).toEqual([undefined, '*.b.example'])
  })
})

describe('syntax corners', () => {
  it('uBlacklist: JS regex escapes are translated for RE2', () => {
    const r = imp('/\\u0041BC\\.example/\n', { format: 'ublacklist' })
    expect(r.rules.map((x) => x.match)).toEqual(['/\\x{0041}BC\\.example/'])
    const rules = compileRuleSet({ lists: [toListInput(r)] })
    expect(rules.decide('https://ABC.example/', { profile: 'd', now: NOW }).visibility).toBe('kept') // host is lower-cased
    expect(rules.decide('https://x.example/ABC.example/', { profile: 'd', now: NOW }).visibility).toBe(
      'hidden',
    )
  })

  it('uBlacklist: unknown regex flags are skipped, s/m/u are harmless', () => {
    expect(texts('/a/g\n/b/smu\n/c/i\n', { format: 'ublacklist' })).toEqual(['block /b/', 'block /c/i'])
  })

  it('uBlacklist: front matter that never closes is read as rules', () => {
    const r = imp('---\n*://*.a.example/*\n', { format: 'ublacklist' })
    expect(r.rules.map(ruleText)).toEqual(['block a.example'])
    expect(r.warnings[0]).toContain('front matter')
  })

  it('ABP: options after a regex, and a $ inside a regex', () => {
    expect(texts('/ads\\d+/$important\n/end$/\n', { format: 'abp' })).toEqual([
      'block /ads\\d+/i $important',
      'block /end$/i',
    ])
  })

  it('ABP: match-case keeps a regex case-sensitive', () => {
    expect(texts('/Ads/$match-case\n', { format: 'abp' })).toEqual(['block /Ads/'])
  })

  it('ABP: a plain substring pattern stays a substring (not a host or regex)', () => {
    const r = imp('/ads/banner\nexample.com/promo\n', { format: 'abp' })
    const rules = compileRuleSet({ lists: [toListInput(r)] })
    const vis = (u: string) => rules.decide(u, { profile: 'd', now: NOW }).visibility
    expect(vis('https://x.example/a/ads/banner/1')).toBe('hidden')
    expect(vis('https://y.example/?u=example.com/promo')).toBe('hidden')
    expect(vis('https://example.com/other')).toBe('kept')
  })

  it('Goggles: a pattern with site= is matched in the path and query of that site', () => {
    const r = imp('rust$boost=2,site=reddit.example\n', { format: 'goggles' })
    const rules = compileRuleSet({ lists: [toListInput(r)] })
    const w = (u: string) => rules.decide(u, { profile: 'd', now: NOW }).weight.factor
    expect(w('https://www.reddit.example/r/rust/')).toBeCloseTo(1.3)
    expect(w('https://reddit.example/?q=rust')).toBeCloseTo(1.3)
    expect(w('https://other.example/r/rust/')).toBe(1)
    expect(w('https://reddit.example.evil/r/rust/')).toBe(1)
    expect(r.warnings.join(' ')).toContain('approximate')
  })

  it('Goggles: a start-anchored pattern with site= is counted, not guessed', () => {
    const r = imp('|https://x$site=a.example\n', { format: 'goggles' })
    expect(r.rules).toEqual([])
    expect(r.skipReasons).toEqual({ 'unsupported pattern with site=': 1 })
  })

  it('searchhole: a file that does not load is one counted skip', () => {
    const r = imp('version: 1\nrules:\n  - { match: a.example, action: block, weight: 99 }\n', {
      format: 'searchhole',
    })
    expect(r.rules).toEqual([])
    expect(Object.keys(r.skipReasons)).toEqual(['invalid search-hole rules file'])
    expect(r.stats.entries).toBe(1)
  })

  it('toListInput passes the mode through', () => {
    const r = imp('a.example\n', { format: 'domains', listId: 'm' })
    expect(toListInput(r, 'audit')).toMatchObject({ id: 'm', kind: 'block', mode: 'audit', cancel: [] })
  })
})
