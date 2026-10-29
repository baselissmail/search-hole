// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  RETRY_MAX_AGE_MS,
  RETRY_MAX_ENTRIES,
  type RetryOutcome,
  RetryQueue,
} from '../../src/store/retry-queue.ts'

describe('RetryQueue', () => {
  it('flushes oldest first and stops at the first still-busy item', () => {
    const q = new RetryQueue<string>()
    q.push('a', 0)
    q.push('b', 0)
    q.push('c', 0)
    const tried: string[] = []
    const res = q.flush(1000, (item) => {
      tried.push(item)
      return item === 'a' ? 'done' : 'retry'
    })
    expect(tried).toEqual(['a', 'b']) // c was not tried: the database is still busy
    expect(res).toEqual({ written: 1, dropped: 0, remaining: 2 })
  })

  it('drops entries older than 10 s, whether or not they were tried', () => {
    const q = new RetryQueue<string>()
    q.push('old', 0)
    q.push('old2', 100)
    q.push('young', 9_000)
    const res = q.flush(RETRY_MAX_AGE_MS + 200, () => 'retry')
    expect(res).toEqual({ written: 0, dropped: 2, remaining: 1 })
    expect(q.dropped).toBe(2)
    expect(q.length).toBe(1)
  })

  it('keeps an entry of exactly 10 s and drops one of 10 s + 1 ms', () => {
    const q = new RetryQueue<string>()
    q.push('edge', 0)
    expect(q.flush(RETRY_MAX_AGE_MS, () => 'retry').remaining).toBe(1)
    expect(q.flush(RETRY_MAX_AGE_MS + 1, () => 'retry').dropped).toBe(1)
  })

  it('drops items that can never be written when told to', () => {
    const q = new RetryQueue<string>()
    q.push('x', 0)
    expect(q.flush(1, () => 'drop')).toEqual({ written: 0, dropped: 1, remaining: 0 })
  })

  it('is bounded: overflow drops the oldest and reports it', () => {
    const q = new RetryQueue<number>()
    let overflow = 0
    for (let i = 0; i < RETRY_MAX_ENTRIES + 5; i++) overflow += q.push(i, 0)
    expect(overflow).toBe(5)
    expect(q.length).toBe(RETRY_MAX_ENTRIES)
    const seen: number[] = []
    q.flush(1, (n) => {
      seen.push(n)
      return 'done'
    })
    expect(seen[0]).toBe(5)
  })

  it('clear() counts what it throws away', () => {
    const q = new RetryQueue<string>()
    q.push('a', 0)
    q.push('b', 0)
    expect(q.clear()).toBe(2)
    expect(q.dropped).toBe(2)
  })

  it('property: every pushed item ends up written, dropped or remaining, exactly once', () => {
    const outcome = fc.constantFrom<RetryOutcome>('done', 'retry', 'drop')
    fc.assert(
      fc.property(
        fc.array(fc.record({ age: fc.integer({ min: 0, max: 20_000 }), out: outcome }), { maxLength: 60 }),
        (items) => {
          const q = new RetryQueue<number>()
          const now = 30_000
          items.forEach((it, i) => {
            q.push(i, now - it.age)
          })
          const res = q.flush(now, (i) => items[i]?.out ?? 'done')
          expect(res.written + res.dropped + res.remaining).toBe(items.length)
          expect(q.length).toBe(res.remaining)
          expect(q.dropped).toBe(res.dropped)
        },
      ),
    )
  })
})
