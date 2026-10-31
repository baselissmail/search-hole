// SPDX-License-Identifier: Apache-2.0
/**
 * The live log's state, as a pure reducer (ADR-0004 point 6, after mitmweb):
 *
 * 1. Live events that arrive before the first page ("snapshot") are buffered.
 * 2. The snapshot replaces the rows, then the buffer is replayed on top of it.
 * 3. Every merge is idempotent by search id, so a replayed or duplicated event never adds a row.
 * 4. A `reset` from the stream bumps the epoch and refetches the snapshot. Responses that belong
 *    to an older epoch are ignored.
 *
 * While the user reads (scrolled down, hovering or focused in the table) new rows wait in
 * `pending` and the page shows an "N new" pill instead of moving the rows.
 *
 * Rows are kept newest first (descending `searchId`) and unique, which lets every lookup be a
 * binary search; that keeps 100k loaded rows cheap.
 */
import type { LogEntry, SearchPage } from './contract.ts'

export interface LogFilter {
  /** Only searches that hid at least one result (`hidden=1` on the API). */
  hidden: boolean
}

export type LogPhase = 'loading' | 'ready' | 'resyncing'

export interface LogState {
  /** Bumped by `reset` and `filter`; responses carry the epoch they were requested in. */
  readonly epoch: number
  readonly phase: LogPhase
  readonly filter: LogFilter
  /** Shown rows, newest first. */
  readonly rows: readonly LogEntry[]
  /** Arrived while paused; shown on `flush` or when the pause ends. */
  readonly pending: readonly LogEntry[]
  /** Arrived before the snapshot landed. */
  readonly buffer: readonly LogEntry[]
  /** `before` for the next older page; null when the oldest row is loaded. */
  readonly nextBefore: number | null
  /** The newest search id seen: where the stream or the polling fallback resumes. */
  readonly cursor: number
  readonly paused: boolean
}

export type LogAction =
  | { type: 'snapshot'; epoch: number; page: SearchPage }
  | { type: 'older'; epoch: number; page: SearchPage }
  | { type: 'live'; entries: readonly LogEntry[] }
  | { type: 'reset' }
  | { type: 'filter'; filter: LogFilter }
  | { type: 'pause'; paused: boolean }
  | { type: 'flush' }

export function createLogState(filter: LogFilter): LogState {
  return {
    epoch: 0,
    phase: 'loading',
    filter,
    rows: [],
    pending: [],
    buffer: [],
    nextBefore: null,
    cursor: 0,
    paused: false,
  }
}

export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
  return !filter.hidden || entry.hidden > 0
}

/** Sorted newest first, duplicates removed (the first copy wins). */
export function normalize(entries: readonly LogEntry[]): LogEntry[] {
  const sorted = [...entries].sort((a, b) => b.searchId - a.searchId)
  const out: LogEntry[] = []
  let last = Number.NaN
  for (const entry of sorted) {
    if (entry.searchId === last) continue
    out.push(entry)
    last = entry.searchId
  }
  return out
}

/** Index of `searchId` in rows sorted newest first, or -1. */
export function indexOfId(rows: readonly LogEntry[], searchId: number): number {
  let lo = 0
  let hi = rows.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const id = (rows[mid] as LogEntry).searchId
    if (id === searchId) return mid
    if (id > searchId) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

/**
 * Merge two lists that are each newest first and unique. Returns `a` itself when `b` adds
 * nothing, so React sees no change. Rows already in `a` win over copies in `b`.
 */
export function mergeNewestFirst(a: readonly LogEntry[], b: readonly LogEntry[]): readonly LogEntry[] {
  const aFirst = a[0]
  const aLast = a[a.length - 1]
  const bFirst = b[0]
  const bLast = b[b.length - 1]
  if (!bFirst || !bLast) return a
  if (!aFirst || !aLast) return b
  if (bLast.searchId > aFirst.searchId) return [...b, ...a]
  if (bFirst.searchId < aLast.searchId) return [...a, ...b]
  const out: LogEntry[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a[i] as LogEntry
    const y = b[j] as LogEntry
    if (x.searchId > y.searchId) {
      out.push(x)
      i++
    } else if (x.searchId < y.searchId) {
      out.push(y)
      j++
    } else {
      out.push(x)
      i++
      j++
    }
  }
  while (i < a.length) out.push(a[i++] as LogEntry)
  while (j < b.length) out.push(b[j++] as LogEntry)
  return out.length === a.length ? a : out
}

function maxId(entries: readonly LogEntry[]): number {
  let max = 0
  for (const entry of entries) if (entry.searchId > max) max = entry.searchId
  return max
}

function withoutShown(entries: readonly LogEntry[], rows: readonly LogEntry[]): LogEntry[] {
  return entries.filter((entry) => indexOfId(rows, entry.searchId) === -1)
}

export function logReducer(state: LogState, action: LogAction): LogState {
  switch (action.type) {
    case 'snapshot': {
      if (action.epoch !== state.epoch || state.phase === 'ready') return state
      const items = normalize(action.page.items.filter((e) => matchesFilter(e, state.filter)))
      return {
        ...state,
        phase: 'ready',
        rows: mergeNewestFirst(items, state.buffer),
        pending: [],
        buffer: [],
        nextBefore: action.page.nextBefore,
        cursor: Math.max(action.page.maxId, maxId(state.buffer)),
      }
    }
    case 'older': {
      if (action.epoch !== state.epoch || state.phase !== 'ready') return state
      const items = normalize(action.page.items.filter((e) => matchesFilter(e, state.filter)))
      const rows = mergeNewestFirst(state.rows, items)
      if (rows === state.rows && action.page.nextBefore === state.nextBefore) return state
      return { ...state, rows, nextBefore: action.page.nextBefore }
    }
    case 'live': {
      const cursor = Math.max(state.cursor, maxId(action.entries))
      const entries = normalize(action.entries.filter((e) => matchesFilter(e, state.filter)))
      if (entries.length === 0) return cursor === state.cursor ? state : { ...state, cursor }
      if (state.phase !== 'ready') {
        return { ...state, cursor, buffer: mergeNewestFirst(state.buffer, entries) }
      }
      if (state.paused) {
        const fresh = withoutShown(entries, state.rows)
        const pending = fresh.length > 0 ? mergeNewestFirst(state.pending, fresh) : state.pending
        return pending === state.pending && cursor === state.cursor ? state : { ...state, cursor, pending }
      }
      const rows = mergeNewestFirst(state.rows, entries)
      return rows === state.rows && cursor === state.cursor ? state : { ...state, cursor, rows }
    }
    case 'reset':
      // Keep the rows on screen until the new snapshot replaces them; drop everything else.
      // The cursor restarts from the new snapshot: the old one may point past deleted rows.
      return {
        ...state,
        epoch: state.epoch + 1,
        phase: 'resyncing',
        pending: [],
        buffer: [],
        cursor: 0,
      }
    case 'filter':
      if (action.filter.hidden === state.filter.hidden) return state
      return { ...createLogState(action.filter), epoch: state.epoch + 1, paused: state.paused }
    case 'pause': {
      if (action.paused === state.paused) return state
      if (action.paused || state.pending.length === 0) return { ...state, paused: action.paused }
      return { ...state, paused: false, rows: mergeNewestFirst(state.rows, state.pending), pending: [] }
    }
    case 'flush':
      if (state.pending.length === 0) return state
      return { ...state, rows: mergeNewestFirst(state.rows, state.pending), pending: [] }
  }
}
