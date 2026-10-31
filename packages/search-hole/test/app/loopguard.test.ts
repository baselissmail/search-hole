// SPDX-License-Identifier: Apache-2.0
// The per-session loop guard (ADR-0019).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LoopGuard, REPEAT_WINDOW_MS, searchKey } from '../../src/app/loopguard.ts'
import type { RequestCtx } from '../../src/app/types.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { loadSettings } from '../../src/shared/settings.ts'
import { type MockEngines, startMockEngines } from '../mock-engine/server.ts'
import { fallbackSession, hookSession, mockSettings, setup } from './helpers.ts'

const LIMITS = { searchesPerTurn: 3, searchesPerHour: 5, repeatQuery: 3 }

function guard() {
  let t = 0
  return { g: new LoopGuard(() => t), advance: (ms: number) => (t += ms) }
}

describe('LoopGuard', () => {
  it('stops a hook-keyed turn at searchesPerTurn; the next prompt resets it', () => {
    const { g } = guard()
    const ctx = hookSession('s1')
    for (let i = 0; i < 3; i++) {
      expect(g.check(ctx, `q${i}`, LIMITS)).toBeNull()
      g.note(ctx, `q${i}`)
    }
    const stop = g.check(ctx, 'q9', LIMITS)
    expect(stop?.code).toBe('search_limit')
    expect(stop?.toUserText()).toContain('this turn already ran 3 searches')
    expect(stop?.toUserText()).toContain('→')
    g.newTurn('s1')
    expect(g.check(ctx, 'q9', LIMITS)).toBeNull()
  })

  it('counts a sliding hour; fallback sessions get twice the limit', () => {
    const { g, advance } = guard()
    const limits = { ...LIMITS, searchesPerTurn: 0 }
    const meta: RequestCtx = { session: { key: 'm', source: 'meta' } }
    for (let i = 0; i < 5; i++) g.note(meta, `q${i}`)
    expect(g.check(meta, 'next', limits)?.details).toMatchObject({ limit: 'searchesPerHour' })
    advance(60 * 60_000)
    expect(g.check(meta, 'next', limits)).toBeNull()

    const fb = fallbackSession('fallback:x')
    for (let i = 0; i < 9; i++) g.note(fb, `q${i}`)
    expect(g.check(fb, 'next', limits)).toBeNull()
    g.note(fb, 'q9')
    expect(g.check(fb, 'next', limits)?.details).toMatchObject({ limit: 'searchesPerHour', value: 10 })
  })

  it('refuses the third identical search in 10 minutes, not a different one', () => {
    const { g, advance } = guard()
    const ctx: RequestCtx = { session: { key: 'e', source: 'env' } }
    const key = searchKey('React  Compiler ', ['standard'])
    expect(searchKey('react compiler', ['standard'])).toBe(key)
    expect(searchKey('react compiler', ['deep'])).not.toBe(key)
    g.note(ctx, key)
    g.note(ctx, key)
    expect(g.check(ctx, key, LIMITS)?.toUserText()).toContain("its results won't change")
    expect(g.check(ctx, searchKey('react compiler 1.0'), LIMITS)).toBeNull()
    advance(REPEAT_WINDOW_MS)
    expect(g.check(ctx, key, LIMITS)).toBeNull()
  })

  it('0 turns every limit off; repeatQuery 1 is rejected in settings', () => {
    const { g } = guard()
    const ctx = hookSession('s')
    for (let i = 0; i < 50; i++) g.note(ctx, 'same')
    expect(g.check(ctx, 'same', { searchesPerTurn: 0, searchesPerHour: 0, repeatQuery: 0 })).toBeNull()
    expect(loadSettings('version: 1\n').settings.limits).toEqual({
      searchesPerTurn: 40,
      searchesPerHour: 120,
      repeatQuery: 3,
    })
    expect(() => loadSettings('version: 1\nlimits: { repeatQuery: 1 }\n')).toThrow(/repeatQuery/)
  })
})

describe('loop guard in the App', () => {
  let mock: MockEngines
  beforeAll(async () => {
    mock = await startMockEngines()
  })
  afterAll(async () => {
    await mock.close()
  })

  const settings = () =>
    mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily'), 'limits: { searchesPerTurn: 2 }\n')

  it('our search and built-in WebSearch share the turn budget; failures are free', async () => {
    const h = await setup({ settings: settings() })
    const ctx = hookSession('s1')
    await h.app.openTurn(ctx)
    await h.app.search({ query: 'react compiler', depth: 'quick' }, ctx)
    expect(await h.app.searchBudget?.('vite 8', ctx)).toEqual({ allowed: true })
    await h.app.filterBuiltinResults('vite 8', [{ title: 'Vite', url: 'https://vite.dev/' }], ctx)
    const budget = await h.app.searchBudget?.('bun 2', ctx)
    expect(budget).toMatchObject({ allowed: false })
    const err = await h.app.search({ query: 'deno 3', depth: 'quick' }, ctx).catch((e: unknown) => e)
    expect(isSearchHoleError(err) && err.code).toBe('search_limit')
    await h.app.openTurn(ctx)
    expect(await h.app.searchBudget?.('bun 2', ctx)).toEqual({ allowed: true })
  })

  it('the CLI is the user typing: never limited', async () => {
    const h = await setup({ settings: settings(), host: 'cli' })
    for (const q of ['a', 'b', 'c', 'c', 'c']) await h.app.search({ query: `react ${q}`, depth: 'quick' }, {})
  })
})
