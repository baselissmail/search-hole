// SPDX-License-Identifier: Apache-2.0
/**
 * The in-memory retry queue for log writes that hit SQLITE_BUSY (ADR-0003 point 4).
 * `node:sqlite` is synchronous, so the search path waits at most 100 ms for the lock; a
 * busy write is parked here and retried on a timer, then dropped (and counted) after 10 s.
 * Logging never blocks or fails a search. Deterministic: the caller passes the clock.
 */

/** How long a parked write is retried before it is dropped. */
export const RETRY_MAX_AGE_MS = 10_000
/** Bound on parked writes, so a long outage cannot grow memory without limit. */
export const RETRY_MAX_ENTRIES = 200

interface Entry<T> {
  readonly item: T
  readonly firstAttemptAt: number
}

/** `done`: written. `retry`: still busy. `drop`: cannot ever be written (counted as dropped). */
export type RetryOutcome = 'done' | 'retry' | 'drop'

export interface FlushResult {
  readonly written: number
  readonly dropped: number
  readonly remaining: number
}

export class RetryQueue<T> {
  private entries: Entry<T>[] = []
  private droppedTotal = 0

  get length(): number {
    return this.entries.length
  }

  get dropped(): number {
    return this.droppedTotal
  }

  /** Parks an item. Returns how many older entries were dropped to stay within the bound. */
  push(item: T, now: number): number {
    this.entries.push({ item, firstAttemptAt: now })
    let overflow = 0
    while (this.entries.length > RETRY_MAX_ENTRIES) {
      this.entries.shift()
      overflow++
    }
    this.droppedTotal += overflow
    return overflow
  }

  /**
   * Tries each parked item once, oldest first. Items whose attempt returns `done` leave the
   * queue; `retry` items stay unless they are older than 10 s, in which case they are dropped.
   * Stops at the first `retry` result for items younger than the limit (the database is still
   * busy, so trying the rest would only wait again).
   */
  flush(now: number, attempt: (item: T) => RetryOutcome): FlushResult {
    let written = 0
    let dropped = 0
    const kept: Entry<T>[] = []
    let busy = false
    for (const entry of this.entries) {
      if (busy) {
        if (now - entry.firstAttemptAt > RETRY_MAX_AGE_MS) dropped++
        else kept.push(entry)
        continue
      }
      const outcome = attempt(entry.item)
      if (outcome === 'done') {
        written++
      } else if (outcome === 'drop' || now - entry.firstAttemptAt > RETRY_MAX_AGE_MS) {
        dropped++
      } else {
        kept.push(entry)
        busy = true
      }
    }
    this.entries = kept
    this.droppedTotal += dropped
    return { written, dropped, remaining: kept.length }
  }

  /** Drops everything (on close). Returns how many entries were dropped. */
  clear(): number {
    const n = this.entries.length
    this.entries = []
    this.droppedTotal += n
    return n
  }
}
