// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import type { LogEntry, SearchPage } from './contract.ts'
import {
  createLogState,
  indexOfId,
  type LogAction,
  type LogState,
  logReducer,
  mergeNewestFirst,
} from './logState.ts'

function entry(searchId: number, hidden = 0): LogEntry {
  return {
    searchId,
    receiptId: `r${searchId}`,
    at: '2026-10-31T10:00:00Z',
    query: `query ${searchId}`,
    profile: 'default',
    depth: 'standard',
    mode: 'engines',
    engines: ['brave'],
    kept: 5,
    hidden,
    latencyMs: 100,
  }
}

function page(
  ids: number[],
  opts: { maxId?: number; nextBefore?: number | null; hidden?: number[] } = {},
): SearchPage {
  const items = ids.map((id) => entry(id, opts.hidden?.includes(id) ? 1 : 0))
  return { items, maxId: opts.maxId ?? Math.max(0, ...ids), nextBefore: opts.nextBefore ?? null }
}

const ids = (rows: readonly LogEntry[]) => rows.map((r) => r.searchId)

function run(state: LogState, ...actions: LogAction[]): LogState {
  return actions.reduce(logReducer, state)
}

const initial = () => createLogState({ hidden: false })

describe('snapshot and buffer (ADR-0004 point 6)', () => {
  it('buffers live events until the snapshot lands, then replays them on top', () => {
    const s1 = run(initial(), { type: 'live', entries: [entry(11), entry(12)] })
    expect(s1.rows).toEqual([])
    expect(ids(s1.buffer)).toEqual([12, 11])
    const s2 = run(s1, { type: 'snapshot', epoch: 0, page: page([10, 9, 8], { nextBefore: 8 }) })
    expect(s2.phase).toBe('ready')
    expect(ids(s2.rows)).toEqual([12, 11, 10, 9, 8])
    expect(s2.buffer).toEqual([])
    expect(s2.nextBefore).toBe(8)
    expect(s2.cursor).toBe(12)
  })

  it('is idempotent when the buffer overlaps the snapshot', () => {
    const s = run(
      initial(),
      { type: 'live', entries: [entry(9), entry(10), entry(11)] },
      { type: 'snapshot', epoch: 0, page: page([10, 9, 8]) },
    )
    expect(ids(s.rows)).toEqual([11, 10, 9, 8])
  })

  it('takes the cursor from maxId when it is newer than every row', () => {
    const s = run(initial(), { type: 'snapshot', epoch: 0, page: page([5], { maxId: 20 }) })
    expect(s.cursor).toBe(20)
  })

  it('ignores a snapshot from an older epoch', () => {
    const s = run(initial(), { type: 'reset' }, { type: 'snapshot', epoch: 0, page: page([1]) })
    expect(s.phase).toBe('resyncing')
    expect(s.rows).toEqual([])
  })
})

describe('live events', () => {
  const ready = () => run(initial(), { type: 'snapshot', epoch: 0, page: page([3, 2, 1]) })

  it('adds new rows on top, newest first', () => {
    const s = run(ready(), { type: 'live', entries: [entry(4), entry(5)] })
    expect(ids(s.rows)).toEqual([5, 4, 3, 2, 1])
    expect(s.cursor).toBe(5)
  })

  it('is idempotent by search id', () => {
    const once = run(ready(), { type: 'live', entries: [entry(4)] })
    const twice = run(once, { type: 'live', entries: [entry(4), entry(3)] })
    expect(ids(twice.rows)).toEqual([4, 3, 2, 1])
    expect(twice).toBe(once)
  })

  it('dedupes within one batch', () => {
    const s = run(ready(), { type: 'live', entries: [entry(4), entry(4), entry(5)] })
    expect(ids(s.rows)).toEqual([5, 4, 3, 2, 1])
  })

  it('puts an out-of-order entry in its place', () => {
    const s = run(
      initial(),
      { type: 'snapshot', epoch: 0, page: page([10, 8, 6]) },
      { type: 'live', entries: [entry(7)] },
    )
    expect(ids(s.rows)).toEqual([10, 8, 7, 6])
  })

  it('holds new rows while paused and shows them on flush or unpause', () => {
    const paused = run(
      ready(),
      { type: 'pause', paused: true },
      { type: 'live', entries: [entry(4), entry(5)] },
    )
    expect(ids(paused.rows)).toEqual([3, 2, 1])
    expect(ids(paused.pending)).toEqual([5, 4])
    // Duplicates of shown or pending rows are not counted twice.
    const again = run(paused, { type: 'live', entries: [entry(5), entry(3)] })
    expect(ids(again.pending)).toEqual([5, 4])
    expect(ids(run(again, { type: 'flush' }).rows)).toEqual([5, 4, 3, 2, 1])
    const resumed = run(again, { type: 'pause', paused: false })
    expect(ids(resumed.rows)).toEqual([5, 4, 3, 2, 1])
    expect(resumed.pending).toEqual([])
  })

  it('keeps the same state object when nothing changes', () => {
    const s = ready()
    expect(run(s, { type: 'flush' })).toBe(s)
    expect(run(s, { type: 'pause', paused: false })).toBe(s)
    expect(run(s, { type: 'live', entries: [] })).toBe(s)
  })
})

describe('older pages', () => {
  it('appends older rows and moves nextBefore', () => {
    const s = run(
      initial(),
      { type: 'snapshot', epoch: 0, page: page([10, 9], { nextBefore: 9 }) },
      { type: 'older', epoch: 0, page: page([9, 8, 7], { nextBefore: 7 }) },
    )
    expect(ids(s.rows)).toEqual([10, 9, 8, 7])
    expect(s.nextBefore).toBe(7)
  })

  it('ignores pages from another epoch', () => {
    const s0 = run(
      initial(),
      { type: 'snapshot', epoch: 0, page: page([10], { nextBefore: 10 }) },
      { type: 'reset' },
    )
    const s1 = run(s0, { type: 'snapshot', epoch: 1, page: page([20], { nextBefore: 20 }) })
    const s2 = run(s1, { type: 'older', epoch: 0, page: page([9]) })
    expect(s2).toBe(s1)
  })
})

describe('reset and filter', () => {
  it('keeps the rows on screen during a resync, then replaces them', () => {
    const s0 = run(initial(), { type: 'snapshot', epoch: 0, page: page([5, 4, 3]) })
    const s1 = run(
      s0,
      { type: 'pause', paused: true },
      { type: 'live', entries: [entry(6)] },
      { type: 'reset' },
    )
    expect(s1.phase).toBe('resyncing')
    expect(s1.epoch).toBe(1)
    expect(ids(s1.rows)).toEqual([5, 4, 3])
    expect(s1.pending).toEqual([])
    expect(s1.cursor).toBe(0)
    const s2 = run(
      s1,
      { type: 'live', entries: [entry(9)] },
      { type: 'snapshot', epoch: 1, page: page([8, 7]) },
    )
    expect(ids(s2.rows)).toEqual([9, 8, 7])
    expect(s2.cursor).toBe(9)
  })

  it('applies the hidden filter to snapshots and live events', () => {
    const s = run(
      createLogState({ hidden: true }),
      { type: 'snapshot', epoch: 0, page: page([3, 2, 1], { hidden: [3, 1] }) },
      { type: 'live', entries: [entry(4, 0), entry(5, 2)] },
    )
    expect(ids(s.rows)).toEqual([5, 3, 1])
    // Filtered-out entries still move the cursor, so polling never asks for them again.
    expect(s.cursor).toBe(5)
  })

  it('starts over when the filter changes', () => {
    const s0 = run(initial(), { type: 'snapshot', epoch: 0, page: page([2, 1]) })
    const s1 = run(s0, { type: 'filter', filter: { hidden: true } })
    expect(s1.phase).toBe('loading')
    expect(s1.rows).toEqual([])
    expect(s1.epoch).toBe(1)
    expect(run(s1, { type: 'filter', filter: { hidden: true } })).toBe(s1)
  })
})

describe('helpers', () => {
  it('finds ids in rows sorted newest first', () => {
    const rows = [9, 7, 5, 3, 1].map((id) => entry(id))
    expect([9, 7, 5, 3, 1, 2, 10, 0].map((id) => indexOfId(rows, id))).toEqual([0, 1, 2, 3, 4, -1, -1, -1])
    expect(indexOfId([], 1)).toBe(-1)
  })

  it('merges with fast paths and keeps the original array when nothing is added', () => {
    const a = [9, 7, 5].map((id) => entry(id))
    expect(ids(mergeNewestFirst(a, [entry(12), entry(10)]))).toEqual([12, 10, 9, 7, 5])
    expect(ids(mergeNewestFirst(a, [entry(3)]))).toEqual([9, 7, 5, 3])
    expect(ids(mergeNewestFirst(a, [entry(8), entry(7), entry(1)]))).toEqual([9, 8, 7, 5, 1])
    expect(mergeNewestFirst(a, [entry(7)])).toBe(a)
    expect(mergeNewestFirst(a, [])).toBe(a)
  })

  it('stays fast with 100k rows', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => entry(100_000 - i))
    const s0 = run(initial(), {
      type: 'snapshot',
      epoch: 0,
      page: { items: big, maxId: 100_000, nextBefore: 1 },
    })
    const started = performance.now()
    let s = s0
    for (let i = 1; i <= 50; i++) s = logReducer(s, { type: 'live', entries: [entry(100_000 + i)] })
    expect(s.rows).toHaveLength(100_050)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
