// SPDX-License-Identifier: Apache-2.0
/**
 * Live log (§8.3): every search, newest first, live. The filter, the selected row or result and
 * the expanded row are in the URL. Keyboard: j/k move, Enter expands, b/a/p/r/l act on the
 * selected result's site, each with an Undo toast.
 */
import { useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import {
  ArrowUp,
  CircleAlert,
  CircleDashed,
  EyeOff,
  type LucideIcon,
  Radio,
  RotateCw,
  SearchX,
  Telescope,
  Timer,
} from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { messageOf } from '../../lib/api.ts'
import type { LogResult } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount } from '../../lib/format.ts'
import { isInteractiveTarget, usePageKeys } from '../../lib/hotkeys.ts'
import type { LogSearch } from '../../lib/logSearch.ts'
import { indexOfId } from '../../lib/logState.ts'
import { useSearchDetail } from '../../lib/queries.ts'
import { applyVerb, type QuickVerb, VERB_BY_KEY } from '../../lib/ruleActions.ts'
import { usePageTitle } from '../../lib/usePageTitle.ts'
import { LogTable, type LogTableHandle, type RevealTarget } from './LogTable.tsx'
import type { DetailState } from './ResultsPanel.tsx'
import { type LiveStatus, useLiveLog } from './useLiveLog.ts'

const routeApi = getRouteApi('/')

const STATUS: Record<LiveStatus, { icon: LucideIcon; label: string; className: string }> = {
  idle: { icon: CircleDashed, label: 'Starting…', className: 'text-fg-muted' },
  connecting: { icon: CircleDashed, label: 'Connecting…', className: 'text-fg-muted' },
  live: { icon: Radio, label: 'Live', className: 'text-ok' },
  reconnecting: { icon: RotateCw, label: 'Reconnecting…', className: 'text-warn' },
  polling: { icon: Timer, label: 'Updating every 2 s', className: 'text-warn' },
}

function LiveIndicator({ status, phase }: { status: LiveStatus; phase: string }) {
  const s =
    phase === 'resyncing'
      ? { icon: RotateCw, label: 'Reloading…', className: 'text-fg-muted' }
      : phase === 'loading'
        ? { icon: CircleDashed, label: 'Loading…', className: 'text-fg-muted' }
        : STATUS[status]
  return (
    <span role="status" className={cx('inline-flex items-center gap-1.5 text-xs font-medium', s.className)}>
      <s.icon aria-hidden="true" className="size-3.5" />
      {s.label}
    </span>
  )
}

function LoadingTable() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" aria-busy="true">
      <span className="sr-only">Loading searches…</span>
      <div className="row-36 flex items-center gap-6 border-b border-border bg-surface px-4">
        {['w-16', 'w-40', 'w-14', 'w-18'].map((width) => (
          <Skeleton key={width} className={`h-2.5 ${width}`} />
        ))}
      </div>
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} className="row-36 flex items-center gap-6 border-b border-border px-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-10" />
        </div>
      ))}
    </div>
  )
}

export function LiveLogPage() {
  usePageTitle('Live log')
  const search = routeApi.useSearch()
  const navigate = routeApi.useNavigate()
  const queryClient = useQueryClient()
  const tableRef = useRef<LogTableHandle>(null)

  const hiddenOnly = search.hidden === true
  const log = useLiveLog({ hidden: hiddenOnly })
  const { rows, phase, pending, nextBefore } = log.state

  // The URL may name rows that aren't loaded (an old link); they simply aren't shown.
  const expandedId =
    search.expanded !== undefined && indexOfId(rows, search.expanded) >= 0 ? search.expanded : undefined
  const detailQuery = useSearchDetail(expandedId)
  const detail: DetailState = {
    status: detailQuery.status,
    data: detailQuery.data,
    error: detailQuery.error,
    retry: () => void detailQuery.refetch(),
  }
  const results = detailQuery.data?.results ?? []
  const selectedPosition = search.result

  const setSearch = (patch: LogSearch) => {
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }
  const select = (target: RevealTarget, reveal: boolean) => {
    setSearch({
      selected: target.searchId,
      result: target.position,
      ...(target.position !== undefined ? { expanded: target.searchId } : {}),
    })
    if (reveal) tableRef.current?.reveal(target)
  }
  const toggle = (searchId: number) => {
    setSearch(
      expandedId === searchId
        ? { expanded: undefined, result: undefined, selected: searchId }
        : { expanded: searchId, result: undefined, selected: searchId },
    )
  }
  const onVerb = (verb: QuickVerb, result: LogResult) => {
    void applyVerb(queryClient, verb, result.domain)
  }

  /** The next row or result in reading order (results sit under their expanded search). */
  const step = (dir: 1 | -1): RevealTarget | null => {
    const current = search.selected !== undefined ? indexOfId(rows, search.selected) : -1
    if (current < 0) {
      const first = rows[0]
      return first ? { searchId: first.searchId } : null
    }
    const id = (rows[current] as (typeof rows)[number]).searchId
    const open = id === expandedId ? results.length : 0
    const pos = id === expandedId ? selectedPosition : undefined
    if (dir === 1) {
      if (pos === undefined && open > 0) return { searchId: id, position: 1 }
      if (pos !== undefined && pos < open) return { searchId: id, position: pos + 1 }
      const below = rows[current + 1]
      return below ? { searchId: below.searchId } : null
    }
    if (pos !== undefined) return pos > 1 ? { searchId: id, position: pos - 1 } : { searchId: id }
    const above = rows[current - 1]
    if (!above) return null
    const aboveOpen = above.searchId === expandedId ? results.length : 0
    return aboveOpen > 0 ? { searchId: above.searchId, position: aboveOpen } : { searchId: above.searchId }
  }

  usePageKeys((event) => {
    if (rows.length === 0) return false
    const target = event.target as Element | null
    const inTable = tableRef.current?.contains(target) ?? false
    const onPage = inTable || target === document.body || target === document.getElementById('main')
    const key = event.key
    const id = search.selected
    const pos = id !== undefined && id === expandedId ? selectedPosition : undefined

    if (key === 'j' || (key === 'ArrowDown' && onPage)) {
      const next = step(1)
      if (next) select(next, true)
      return true
    }
    if (key === 'k' || (key === 'ArrowUp' && onPage)) {
      const next = step(-1)
      if (next) select(next, true)
      return true
    }
    if ((key === 'Home' || key === 'End') && onPage) {
      const row = key === 'Home' ? rows[0] : rows[rows.length - 1]
      if (row) select({ searchId: row.searchId }, true)
      return true
    }
    if ((key === 'Enter' && onPage && !isInteractiveTarget(target)) || (key === 'ArrowRight' && onPage)) {
      if (id === undefined || pos !== undefined) return false
      if (key === 'ArrowRight' && id === expandedId) return false
      toggle(id)
      tableRef.current?.reveal({ searchId: id })
      return true
    }
    if ((key === 'Escape' || key === 'ArrowLeft') && (onPage || key === 'Escape')) {
      if (id === undefined) return false
      if (pos !== undefined) {
        select({ searchId: id }, true)
        return true
      }
      if (id === expandedId) {
        toggle(id)
        tableRef.current?.reveal({ searchId: id })
        return true
      }
      return false
    }
    const verb = VERB_BY_KEY[key]
    if (verb && pos !== undefined) {
      const result = results[pos - 1]
      if (result) onVerb(verb, result)
      return true
    }
    return false
  })

  const toggleHiddenOnly = () => {
    void navigate({
      search: (prev) => ({
        ...prev,
        hidden: hiddenOnly ? undefined : true,
        selected: undefined,
        expanded: undefined,
        result: undefined,
      }),
    })
  }

  let body: ReactNode
  if (rows.length === 0 && log.error) {
    body = (
      <div role="alert" className="flex flex-1 items-start justify-center p-6">
        <EmptyState icon={CircleAlert} title="Couldn't load the log">
          <p>{messageOf(log.error)}</p>
          <Button size="sm" className="mt-4" onClick={log.retry}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Try again
          </Button>
        </EmptyState>
      </div>
    )
  } else if (rows.length === 0 && phase !== 'ready') {
    body = <LoadingTable />
  } else if (rows.length === 0) {
    body = hiddenOnly ? (
      <EmptyState icon={SearchX} title="No search has hidden anything yet" className="flex-1">
        <p>Searches where a rule or list hid a result show up here, live.</p>
        <Button size="sm" className="mt-4" onClick={toggleHiddenOnly}>
          Show every search
        </Button>
      </EmptyState>
    ) : (
      <EmptyState icon={Telescope} title="No searches yet" className="flex-1">
        <p>Ask Claude to look something up; searches appear here live.</p>
        <p className="mt-3 text-xs">
          Not connected yet? Install the plugin in Claude Code with{' '}
          <code className="font-mono text-fg">/plugin install search-hole@search-hole-local</code>, then run{' '}
          <code className="font-mono text-fg">/search-hole:doctor</code>.
        </p>
      </EmptyState>
    )
  } else {
    body = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {pending.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-11 z-20 flex justify-center">
            <button
              type="button"
              onClick={() => {
                log.flush()
                tableRef.current?.scrollToTop()
              }}
              className="pointer-events-auto inline-flex h-7 items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 text-xs font-medium text-fg shadow-md animate-fade-in hover:bg-surface-2"
            >
              <ArrowUp aria-hidden="true" className="size-3.5" />
              <span className="tabular font-mono">{formatCount(pending.length)}</span> new{' '}
              {pending.length === 1 ? 'search' : 'searches'}
            </button>
          </div>
        ) : null}
        <LogTable
          handleRef={tableRef}
          rows={rows}
          expandedId={expandedId}
          detail={detail}
          selectedId={search.selected}
          selectedPosition={selectedPosition}
          hasMore={nextBefore !== null}
          olderLoading={log.olderLoading}
          olderError={log.olderError}
          onToggle={toggle}
          onSelectSearch={(searchId) => select({ searchId }, false)}
          onSelectResult={(searchId, position) => select({ searchId, position }, false)}
          onVerb={onVerb}
          onLoadOlder={log.loadOlder}
          onReadingChange={log.setPaused}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Live log</h1>
          <LiveIndicator status={log.status} phase={phase} />
        </div>
        <div className="flex items-center gap-3">
          {rows.length > 0 ? (
            <span className="text-xs text-fg-muted">
              <span className="tabular font-mono text-fg">{formatCount(rows.length)}</span> loaded
            </span>
          ) : null}
          <button
            type="button"
            aria-pressed={hiddenOnly}
            onClick={toggleHiddenOnly}
            className={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
              hiddenOnly
                ? 'border-fg bg-fg text-inverse'
                : 'border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            <EyeOff aria-hidden="true" className="size-3.5" />
            Only searches that hid results
          </button>
        </div>
      </div>
      {body}
    </div>
  )
}
