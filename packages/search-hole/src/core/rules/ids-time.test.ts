// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { assignRuleIds, ruleIdBase, ruleText } from './ids.ts'
import { isExpired, parseDuration, ttlToUntil, untilToMs } from './time.ts'

describe('rule ids', () => {
  const base = {
    scope: 'global',
    match: 'pinterest.com',
    action: 'block',
    weight: 1,
    important: false,
  } as const

  it('is r_ + 10 hex characters, stable for the same tuple', () => {
    const id = ruleIdBase(base)
    expect(id).toMatch(/^r_[0-9a-f]{10}$/)
    expect(ruleIdBase({ ...base })).toBe(id)
  })
  it('changes with every tuple field', () => {
    const id = ruleIdBase(base)
    expect(ruleIdBase({ ...base, scope: 'project' })).not.toBe(id)
    expect(ruleIdBase({ ...base, match: 'pinterest.co' })).not.toBe(id)
    expect(ruleIdBase({ ...base, action: 'allow' })).not.toBe(id)
    expect(ruleIdBase({ ...base, important: true })).not.toBe(id)
    expect(ruleIdBase({ ...base, profiles: ['coding'] })).not.toBe(id)
    expect(ruleIdBase({ ...base, action: 'raise', weight: 2 })).not.toBe(
      ruleIdBase({ ...base, action: 'raise', weight: 3 }),
    )
  })
  it('ignores profile order, duplicate profiles and the weight of unweighted actions', () => {
    expect(ruleIdBase({ ...base, profiles: ['b', 'a', 'a'] })).toBe(
      ruleIdBase({ ...base, profiles: ['a', 'b'] }),
    )
    expect(ruleIdBase({ ...base, weight: 7 })).toBe(ruleIdBase(base))
  })
  it('suffixes exact duplicates -2, -3 in file order', () => {
    const other = { ...base, match: 'x.com' }
    const ids = assignRuleIds([base, other, base, base])
    const first = ruleIdBase(base)
    expect(ids).toEqual([
      { id: first },
      { id: ruleIdBase(other) },
      { id: `${first}-2`, duplicateOf: 0 },
      { id: `${first}-3`, duplicateOf: 0 },
    ])
  })
  it('renders a text snapshot', () => {
    expect(
      ruleText({
        id: 'r',
        scope: 'global',
        match: '*.medium.com',
        matchKind: 'domain',
        action: 'lower',
        weight: 3,
        important: true,
        profiles: ['coding'],
        until: '2026-12-31',
        order: 0,
      }),
    ).toBe('lower 3 *.medium.com profile=coding important until=2026-12-31')
  })
})

describe('until and ttl', () => {
  it('treats a date as the whole UTC day', () => {
    expect(untilToMs('2026-12-31')).toBe(Date.parse('2027-01-01T00:00:00Z'))
    expect(isExpired('2026-12-31', Date.parse('2026-12-31T23:59:59.999Z'))).toBe(false)
    expect(isExpired('2026-12-31', Date.parse('2027-01-01T00:00:00Z'))).toBe(true)
  })
  it('requires a zone on date-times and rejects impossible dates', () => {
    expect(untilToMs('2026-12-31T10:00:00Z')).toBe(Date.parse('2026-12-31T10:00:00Z'))
    expect(untilToMs('2026-12-31T10:00:00+02:00')).toBe(Date.parse('2026-12-31T08:00:00Z'))
    expect(untilToMs('2026-12-31T10:00:00')).toBeNull()
    expect(untilToMs('2026-02-30')).toBeNull()
    expect(untilToMs('tomorrow')).toBeNull()
    expect(isExpired('garbage', 0)).toBe(true)
    expect(isExpired(undefined, Number.MAX_SAFE_INTEGER)).toBe(false)
  })
  it('converts a ttl with the injected clock', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('2w')).toBe(1_209_600_000)
    expect(parseDuration('0d')).toBeNull()
    expect(parseDuration('7 days')).toBeNull()
    expect(ttlToUntil('7d', Date.parse('2026-10-30T00:00:00Z'))).toBe('2026-11-06T00:00:00.000Z')
    expect(ttlToUntil('x', 0)).toBeNull()
  })
})
