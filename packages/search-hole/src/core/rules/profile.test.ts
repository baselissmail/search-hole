// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { isSearchHoleError } from '../../shared/errors.ts'
import type { Profile } from '../../shared/types.ts'
import { hasKeyword, matchProfile, resolveProfiles } from './profile.ts'

const global: Profile[] = [
  { name: 'coding', match: { keywords: ['docs', 'api', 'npm', 'c++', 'node.js'] }, depth: 'standard' },
  { name: 'prices-news', match: { regex: ['(?i)\\bprice(s)?\\b'] }, freshness: { maxAgeDays: 30 } },
]
const project: Profile[] = [
  { name: 'coding', match: { keywords: ['react'] }, engines: ['searxng'] },
  { name: 'infra', match: { keywords: ['terraform', 'api'] } },
]

describe('hasKeyword', () => {
  it.each([
    ['REST API docs', 'api', true],
    ['rapid prototyping', 'api', false],
    ['apis', 'api', false],
    ['learn c++ fast', 'c++', true],
    ['Node.js streams', 'node.js', true],
    ['react native navigation', 'react native', true],
    ['preact', 'react', false],
    ['日本語 api', 'api', true],
    ['', 'api', false],
  ] as const)('%j has %j → %s', (q, k, out) => {
    expect(hasKeyword(q, k)).toBe(out)
  })
})

describe('matchProfile', () => {
  it('an explicit argument wins', () => {
    expect(matchProfile('react docs', { project, global }, 'prices-news')).toMatchObject({
      name: 'prices-news',
      via: 'explicit',
    })
  })
  it('rejects an unknown explicit profile, except the default name', () => {
    try {
      matchProfile('x', { global }, 'nope')
      expect.unreachable()
    } catch (e) {
      expect(isSearchHoleError(e) && e.code).toBe('invalid_argument')
    }
    expect(matchProfile('x', { global }, 'default')).toEqual({ name: 'default', via: 'explicit' })
  })
  it('checks project profiles first, then global, in file order', () => {
    // 'api' is in global coding and project infra: project wins.
    expect(matchProfile('stripe API', { project, global })).toMatchObject({
      name: 'infra',
      via: 'keyword',
      matched: 'api',
    })
    // The project 'coding' replaces the global one: its keywords only.
    expect(matchProfile('npm install', { project, global })).toMatchObject({
      name: 'default',
      via: 'default',
    })
    expect(matchProfile('npm install', { global })).toMatchObject({ name: 'coding' })
    expect(matchProfile('React hooks', { project, global })).toMatchObject({
      name: 'coding',
      profile: project[0],
    })
  })
  it('matches regexes with re2js', () => {
    expect(matchProfile('GPU Prices today', { global })).toMatchObject({ name: 'prices-news', via: 'regex' })
    expect(matchProfile('priceless', { global }).via).toBe('default')
  })
  it('skips invalid regexes instead of throwing', () => {
    const bad: Profile[] = [{ name: 'x', match: { regex: ['(?=a)'] } }]
    expect(matchProfile('a', bad).via).toBe('default')
  })
  it('takes an array as already ordered and supports a custom default name', () => {
    expect(matchProfile('nothing', [], undefined, 'standard')).toEqual({ name: 'standard', via: 'default' })
  })
})

describe('resolveProfiles', () => {
  it('project replaces global by name; omitted fields fall through to project, then global defaults', () => {
    const r = resolveProfiles({
      project,
      global,
      projectDefaults: { depth: 'quick' },
      globalDefaults: { engines: ['searxng', 'brave'], depth: 'deep', freshness: { maxAgeDays: 365 } },
    })
    expect(r.defaults).toEqual({
      engines: ['searxng', 'brave'],
      depth: 'quick',
      freshness: { maxAgeDays: 365 },
    })
    expect(r.profiles.map((p) => p.name)).toEqual(['coding', 'infra', 'prices-news'])
    expect(r.profiles[0]).toEqual({
      name: 'coding',
      match: { keywords: ['react'] },
      engines: ['searxng'],
      depth: 'quick',
      freshness: { maxAgeDays: 365 },
    })
    expect(r.profiles[2]?.freshness).toEqual({ maxAgeDays: 30 })
  })
})
