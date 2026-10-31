// SPDX-License-Identifier: Apache-2.0
/**
 * The virtualised search log: a real <table> (native semantics in every browser and screen
 * reader) where only the rows in view are rendered, between two spacer rows. TanStack Virtual
 * computes the window; TanStack Table renders the columns for the rows in it. Rows have a fixed
 * height and only the expanded results row is measured, so 100k loaded rows scroll smoothly.
 */
import { useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, CircleAlert, RotateCw } from 'lucide-react'
import {
  type MouseEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { messageOf } from '../../lib/api.ts'
import type { LogEntry, LogResult } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount } from '../../lib/format.ts'
import { anyDialogOpen } from '../../lib/hotkeys.ts'
import { indexOfId } from '../../lib/logState.ts'
import type { QuickVerb } from '../../lib/ruleActions.ts'
import { LOG_COLUMN_COUNT, LOG_COLUMN_LAYOUT, logColumns, logFeatures } from './columns.tsx'
import { type DetailState, ResultsPanel } from './ResultsPanel.tsx'

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 36
/** Load the next older page when the window gets this close to the end. */
const LOAD_AHEAD = 40

export interface RevealTarget {
  searchId: number
  /** A result of the expanded search (1-based position), or the search row itself. */
  position?: number | undefined
}

export interface LogTableHandle {
  /** Scroll a row or result into view and focus it. */
  reveal(target: RevealTarget): void
  scrollToTop(): void
  contains(node: Node | null): boolean
}

export interface LogTableProps {
  rows: readonly LogEntry[]
  expandedId: number | undefined
  detail: DetailState
  selectedId: number | undefined
  selectedPosition: number | undefined
  hasMore: boolean
  olderLoading: boolean
  olderError: unknown
  onToggle(searchId: number): void
  onSelectSearch(searchId: number): void
  onSelectResult(searchId: number, position: number): void
  onVerb(verb: QuickVerb, result: LogResult): void
  onLoadOlder(): void
  /** True while the user reads: pointer over the table, focus in it, or scrolled down. */
  onReadingChange(reading: boolean): void
  handleRef: Ref<LogTableHandle>
}

type Item = { kind: 'search' | 'results'; entry: LogEntry; rowIndex: number }

/** Focus an element once the virtualiser has rendered it (a few frames at most). */
function focusWhenRendered(container: HTMLElement | null, selector: string, framesLeft = 10): void {
  if (!container) return
  requestAnimationFrame(() => {
    // A dialog opened meanwhile (⌘K right after Undo): its focus wins.
    if (anyDialogOpen()) return
    const el = container.querySelector<HTMLElement>(selector)
    if (el) {
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    } else if (framesLeft > 0) {
      focusWhenRendered(container, selector, framesLeft - 1)
    }
  })
}

function estimateResultsHeight(detail: DetailState): number {
  if (detail.status !== 'success') return 200
  const n = detail.data?.results.length ?? 0
  return n === 0 ? 96 : 88 + n * 52
}

export function LogTable(props: LogTableProps) {
  // TanStack Virtual returns one mutable instance; the compiler must not cache what it reads.
  'use no memo'
  const {
    rows,
    expandedId,
    detail,
    selectedId,
    selectedPosition,
    hasMore,
    olderLoading,
    olderError,
    onToggle,
    onSelectSearch,
    onSelectResult,
    onVerb,
    onLoadOlder,
    onReadingChange,
    handleRef,
  } = props
  const scrollRef = useRef<HTMLDivElement>(null)

  const expandedIndex = expandedId === undefined ? -1 : indexOfId(rows, expandedId)
  const count = rows.length + (expandedIndex >= 0 ? 1 : 0)

  const itemAt = (i: number): Item => {
    if (expandedIndex >= 0 && i > expandedIndex) {
      if (i === expandedIndex + 1)
        return { kind: 'results', entry: rows[expandedIndex] as LogEntry, rowIndex: expandedIndex }
      return { kind: 'search', entry: rows[i - 1] as LogEntry, rowIndex: i - 1 }
    }
    return { kind: 'search', entry: rows[i] as LogEntry, rowIndex: i }
  }
  const itemIndexOfRow = (rowIndex: number) =>
    expandedIndex >= 0 && rowIndex > expandedIndex ? rowIndex + 1 : rowIndex

  // Both callbacks must keep their identity between renders: virtual-core re-measures every
  // item when `getItemKey` changes, which is ~30 ms per frame at 100k rows.
  const getItemKey = useCallback(
    (i: number) => {
      if (expandedIndex >= 0 && i > expandedIndex) {
        return i === expandedIndex + 1
          ? `r${(rows[expandedIndex] as LogEntry).searchId}`
          : `s${(rows[i - 1] as LogEntry).searchId}`
      }
      return `s${(rows[i] as LogEntry).searchId}`
    },
    [rows, expandedIndex],
  )
  const resultsHeight = estimateResultsHeight(detail)
  const estimateSize = useCallback(
    (i: number) => (expandedIndex >= 0 && i === expandedIndex + 1 ? resultsHeight : ROW_HEIGHT),
    [expandedIndex, resultsHeight],
  )

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 12,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    useFlushSync: false,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const windowItems = virtualItems.map((v) => ({ v, item: itemAt(v.index) }))
  const windowEntries = windowItems.filter((w) => w.item.kind === 'search').map((w) => w.item.entry)

  // Table models only the rows in view: building row models for 100k rows on every live
  // insert would cost ~100 ms; the window costs well under one.
  const table = useTable({
    features: logFeatures,
    columns: logColumns,
    data: windowEntries,
    getRowId: (entry) => String(entry.searchId),
  })
  const tableRows = new Map(table.getRowModel().rows.map((row) => [row.original.searchId, row]))
  const headers = table.getHeaderGroups()[0]?.headers ?? []

  const first = virtualItems[0]
  const last = virtualItems[virtualItems.length - 1]
  const padBefore = first ? first.start - HEADER_HEIGHT : 0
  const padAfter = last ? virtualizer.getTotalSize() - (last.end - HEADER_HEIGHT) : 0

  // Infinite scroll back in time.
  const lastIndex = last?.index ?? -1
  useEffect(() => {
    if (hasMore && !olderLoading && !olderError && lastIndex >= count - LOAD_AHEAD) onLoadOlder()
  }, [hasMore, olderLoading, olderError, lastIndex, count, onLoadOlder])

  // Reading = hovering, focused inside, or scrolled away from the top: new rows then wait.
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const reading = hovering || focused || scrolled
  useEffect(() => {
    onReadingChange(reading)
  }, [reading, onReadingChange])

  // Observed with listeners, not JSX handlers: the scroll box is not an interactive element.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setScrolled(el.scrollTop > 4)
    const onEnter = () => setHovering(true)
    const onLeave = () => setHovering(false)
    const onFocusIn = () => setFocused(true)
    const onFocusOut = (event: FocusEvent) => {
      if (!el.contains(event.relatedTarget as Node | null)) setFocused(false)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  useImperativeHandle(handleRef, () => ({
    reveal({ searchId, position }) {
      const rowIndex = indexOfId(rows, searchId)
      if (rowIndex < 0) return
      const inResults = position !== undefined && rowIndex === expandedIndex
      virtualizer.scrollToIndex(inResults ? expandedIndex + 1 : itemIndexOfRow(rowIndex), { align: 'auto' })
      focusWhenRendered(
        scrollRef.current,
        inResults
          ? `[data-result="${searchId}:${position}"]`
          : `[data-search="${searchId}"] button[aria-expanded]`,
      )
    },
    scrollToTop() {
      scrollRef.current?.scrollTo({ top: 0 })
    },
    contains(node) {
      return Boolean(node && scrollRef.current?.contains(node))
    },
  }))

  const focusableId =
    selectedId !== undefined && indexOfId(rows, selectedId) >= 0 ? selectedId : rows[0]?.searchId

  return (
    <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto overscroll-contain">
      <table
        aria-label="Search log"
        aria-rowcount={hasMore ? -1 : count + 1}
        className="w-full min-w-[56rem] table-fixed border-separate border-spacing-0 text-[13px]"
      >
        <colgroup>
          {headers.map((header) => (
            <col key={header.id} style={{ width: LOG_COLUMN_LAYOUT[header.column.id]?.width }} />
          ))}
        </colgroup>
        <thead>
          <tr aria-rowindex={1}>
            {headers.map((header) => (
              <th
                key={header.id}
                scope="col"
                className={cx(
                  'row-36 sticky top-0 z-10 border-b border-border bg-surface px-3 text-[11px] font-medium tracking-wide text-fg-muted uppercase',
                  LOG_COLUMN_LAYOUT[header.column.id]?.end ? 'text-end' : 'text-start',
                  header.column.id === 'query' && 'ps-8',
                )}
              >
                <table.FlexRender header={header} />
              </th>
            ))}
          </tr>
        </thead>
        {/* Spacers stand in for the rows outside the window; they are hidden from assistive tech. */}
        {padBefore > 0 ? (
          <tbody aria-hidden="true">
            <tr>
              <td colSpan={LOG_COLUMN_COUNT} className="p-0" style={{ height: padBefore }} />
            </tr>
          </tbody>
        ) : null}
        <tbody>
          {windowItems.map(({ v, item }) => {
            const ariaRowIndex = v.index + 2
            if (item.kind === 'results') {
              return (
                <tr
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  aria-rowindex={ariaRowIndex}
                >
                  <td colSpan={LOG_COLUMN_COUNT} className="p-0">
                    <ResultsPanel
                      entry={item.entry}
                      detail={detail}
                      selectedPosition={selectedId === item.entry.searchId ? selectedPosition : undefined}
                      onSelect={(position) => onSelectResult(item.entry.searchId, position)}
                      onVerb={onVerb}
                    />
                  </td>
                </tr>
              )
            }
            const row = tableRows.get(item.entry.searchId)
            if (!row) return null
            const id = item.entry.searchId
            const expanded = id === expandedId
            const selected = id === selectedId && (selectedPosition === undefined || !expanded)
            const activate = (event: MouseEvent) => {
              event.stopPropagation()
              onSelectSearch(id)
              onToggle(id)
            }
            return (
              <tr
                key={v.key}
                data-search={id}
                aria-rowindex={ariaRowIndex}
                data-selected={selected || undefined}
                onClick={activate}
                className={cx(
                  'group row-36 scroll-mt-10 transition-colors [&>td]:border-b [&>td]:border-border',
                  selected ? 'bg-surface-3' : expanded ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                {row.getAllCells().map((cell, i) => {
                  const end = LOG_COLUMN_LAYOUT[cell.column.id]?.end
                  const edge =
                    i === 0 ? cx('border-s-2', selected ? 'border-s-focus' : 'border-s-transparent') : ''
                  if (cell.column.id === 'query') {
                    return (
                      <td key={cell.id} className="px-1.5">
                        <button
                          type="button"
                          tabIndex={id === focusableId ? 0 : -1}
                          aria-expanded={expanded}
                          {...(expanded ? { 'aria-controls': `results-${id}` } : {})}
                          onClick={activate}
                          title={item.entry.query}
                          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded px-1.5 text-start text-fg focus-visible:outline-offset-0"
                        >
                          <ChevronRight
                            aria-hidden="true"
                            className={cx(
                              'size-3.5 shrink-0 text-fg-muted transition-transform',
                              expanded && 'rotate-90',
                            )}
                          />
                          <table.FlexRender cell={cell} />
                        </button>
                      </td>
                    )
                  }
                  return (
                    <td key={cell.id} className={cx('truncate px-3', end ? 'text-end' : 'text-start', edge)}>
                      <table.FlexRender cell={cell} />
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        {padAfter > 0 ? (
          <tbody aria-hidden="true">
            <tr>
              <td colSpan={LOG_COLUMN_COUNT} className="p-0" style={{ height: padAfter }} />
            </tr>
          </tbody>
        ) : null}
      </table>
      <TableFooter
        rows={rows.length}
        hasMore={hasMore}
        loading={olderLoading}
        error={olderError}
        onRetry={onLoadOlder}
      />
    </div>
  )
}

function TableFooter({
  rows,
  hasMore,
  loading,
  error,
  onRetry,
}: {
  rows: number
  hasMore: boolean
  loading: boolean
  error: unknown
  onRetry: () => void
}) {
  if (error) {
    return (
      <div role="alert" className="flex items-center justify-center gap-3 px-4 py-4 text-[13px] text-danger">
        <CircleAlert aria-hidden="true" className="size-4" />
        Couldn't load older searches: {messageOf(error)}
        <Button size="sm" onClick={onRetry}>
          <RotateCw aria-hidden="true" className="size-3.5" />
          Retry
        </Button>
      </div>
    )
  }
  if (loading || hasMore) {
    return (
      <div className="space-y-2 px-4 py-3" aria-busy={loading}>
        {loading ? <span className="sr-only">Loading older searches…</span> : null}
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-6">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <p className="px-4 py-4 text-center text-xs text-fg-muted">
      Start of the log · <span className="tabular font-mono">{formatCount(rows)}</span> searches
    </p>
  )
}
