// SPDX-License-Identifier: Apache-2.0
/**
 * The live log's data: the first page (snapshot), older pages on demand, and the live tail on
 * top, all through the pure reducer in lib/logState.ts.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react'
import { api, isAbort } from '../../lib/api.ts'
import { LiveTail, type TailStatus } from '../../lib/liveTail.ts'
import { createLogState, type LogFilter, type LogState, logReducer } from '../../lib/logState.ts'
import { keys } from '../../lib/queries.ts'
import { endSession } from '../../lib/session.ts'

const FIRST_PAGE = 100
const OLDER_PAGE = 200
const OVERVIEW_REFRESH_MS = 10_000

export type LiveStatus = TailStatus | 'idle'

export interface LiveLog {
  state: LogState
  status: LiveStatus
  /** The first page failed. */
  error: unknown
  olderLoading: boolean
  olderError: unknown
  loadOlder(): void
  retry(): void
  setPaused(paused: boolean): void
  flush(): void
}

export function useLiveLog(filter: LogFilter): LiveLog {
  const [state, dispatch] = useReducer(logReducer, filter, createLogState)
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [error, setError] = useState<unknown>(null)
  // An older-page failure belongs to the epoch it happened in; a reset or new filter starts clean.
  const [older, setOlder] = useState<{ loading: boolean; error: unknown; epoch: number }>({
    loading: false,
    error: null,
    epoch: 0,
  })
  const olderInFlight = useRef(false)
  const queryClient = useQueryClient()

  const { phase, epoch, nextBefore } = state
  const hidden = state.filter.hidden

  // A new filter starts over (new epoch, new snapshot, new tail).
  useEffect(() => {
    if (filter.hidden !== hidden) dispatch({ type: 'filter', filter: { hidden: filter.hidden } })
  }, [filter.hidden, hidden])

  // The snapshot: the first page, fetched whenever the log isn't ready (first load, reset).
  useEffect(() => {
    if (phase === 'ready') return
    const ctrl = new AbortController()
    setError(null)
    api
      .searches({ limit: FIRST_PAGE, hidden }, ctrl.signal)
      .then((page) => dispatch({ type: 'snapshot', epoch, page }))
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted && !isAbort(err)) setError(err)
      })
    return () => ctrl.abort()
  }, [phase, epoch, hidden])

  // The cursor is read once, when a tail starts; the tail tracks it from there.
  const startCursor = useEffectEvent(() => state.cursor)
  const refreshOverview = useEffectEvent(() => {
    void queryClient.invalidateQueries({ queryKey: keys.overview })
  })

  // The live tail: one per epoch, started once the snapshot is in.
  useEffect(() => {
    if (phase !== 'ready') return
    let overviewAt = Date.now()
    const tail = new LiveTail({
      after: startCursor(),
      openStream: api.openStream,
      poll: (after, limit, signal) => api.searches({ after, limit, hidden }, signal),
      onEntries: (entries) => {
        dispatch({ type: 'live', entries })
        if (Date.now() - overviewAt > OVERVIEW_REFRESH_MS) {
          overviewAt = Date.now()
          refreshOverview()
        }
      },
      onReset: () => dispatch({ type: 'reset' }),
      onStatus: setStatus,
      onUnauthorized: () => endSession('expired'),
    })
    tail.start()
    return () => {
      tail.stop()
      setStatus('idle')
    }
  }, [phase, epoch, hidden])

  const loadOlder = () => {
    if (phase !== 'ready' || nextBefore === null || olderInFlight.current) return
    olderInFlight.current = true
    setOlder({ loading: true, error: null, epoch })
    api
      .searches({ before: nextBefore, limit: OLDER_PAGE, hidden })
      .then((page) => {
        dispatch({ type: 'older', epoch, page })
        setOlder({ loading: false, error: null, epoch })
      })
      .catch((err: unknown) => setOlder({ loading: false, error: err, epoch }))
      .finally(() => {
        olderInFlight.current = false
      })
  }

  return {
    state,
    status,
    error,
    olderLoading: older.loading,
    olderError: older.epoch === epoch ? older.error : null,
    loadOlder,
    // A new epoch refetches the first page.
    retry: () => dispatch({ type: 'reset' }),
    setPaused: (paused) => dispatch({ type: 'pause', paused }),
    flush: () => dispatch({ type: 'flush' }),
  }
}
