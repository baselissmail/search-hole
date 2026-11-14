// SPDX-License-Identifier: Apache-2.0
/**
 * The results of one search, shown under its row: rank, domain, title and URL, the decision
 * with the reason and the rule that fired, whether the assistant opened the page, the source
 * type, and one-click rule actions.
 * Everything from the web is rendered as text; only http(s) URLs become links.
 */
import { CircleAlert, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ACTION_ICONS, DecisionChip, OpenedMark } from '../../components/status.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { IconButton } from '../../components/ui/IconButton.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { UrlText } from '../../components/ui/UrlText.tsx'
import { messageOf } from '../../lib/api.ts'
import type { LogDetail, LogEntry, LogResult } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount } from '../../lib/format.ts'
import { engineName, hiddenReasonLabel, sourceTypeLabel, tierLabel } from '../../lib/labels.ts'
import { type QuickVerb, VERB_HINT, VERBS } from '../../lib/ruleActions.ts'
import { middleTruncate } from '../../lib/text.ts'

/** Geist Mono at 12px: about 0.6em per character. */
const MONO_CHAR_PX = 7.3

export interface DetailState {
  status: 'pending' | 'error' | 'success'
  data: LogDetail | undefined
  error: unknown
  retry(): void
}

const VERB_KEYS: Record<QuickVerb, string> = { block: 'B', allow: 'A', pin: 'P', raise: 'R', lower: 'L' }
const VERB_WORDS: Record<QuickVerb, string> = {
  block: 'Block',
  allow: 'Allow',
  pin: 'Pin',
  raise: 'Raise',
  lower: 'Lower',
}

/** How many mono characters fit in the URL column, so URLs are cut in the middle, not the end. */
function useCharCapacity() {
  const ref = useRef<HTMLTableCellElement>(null)
  const [capacity, setCapacity] = useState(64)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      if (width > 0) setCapacity(Math.max(16, Math.floor(width / MONO_CHAR_PX) - 2))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, capacity] as const
}

/** "opened 3 of 19": the results the assistant opened, of those it was shown (hidden ones are neither). */
export function openedSummary(results: readonly LogResult[]): { opened: number; shown: number } {
  let opened = 0
  let shown = 0
  for (const r of results) {
    if (r.decision === 'hidden') continue
    shown++
    if (r.opened) opened++
  }
  return { opened, shown }
}

function Why({ result }: { result: LogResult }) {
  const reason = result.reason ? hiddenReasonLabel(result.reason) : result.rule ? 'Rule' : null
  if (!reason && !result.rule) return <span className="text-fg-muted">–</span>
  return (
    <div className="min-w-0">
      {reason ? <div className="truncate text-xs text-fg">{reason}</div> : null}
      {result.rule ? (
        <div
          className="truncate font-mono text-xs text-fg-muted"
          title={`${result.rule.text} (${tierLabel(result.rule.tier)}, rule ${result.rule.ruleId})`}
        >
          {result.rule.text}
          <span className="font-sans"> · {tierLabel(result.rule.tier)}</span>
        </div>
      ) : null}
    </div>
  )
}

function ResultRow({
  searchId,
  position,
  result,
  selected,
  focusable,
  urlChars,
  onSelect,
  onVerb,
}: {
  searchId: number
  /** 1-based position in the list: the selection key (ranks may repeat across engines). */
  position: number
  result: LogResult
  selected: boolean
  focusable: boolean
  urlChars: number
  onSelect: (position: number) => void
  onVerb: (verb: QuickVerb, result: LogResult) => void
}) {
  return (
    <tr
      data-result={`${searchId}:${position}`}
      data-selected={selected || undefined}
      tabIndex={focusable ? 0 : -1}
      onClick={() => onSelect(position)}
      onFocus={(event) => {
        if (event.target === event.currentTarget && !selected) onSelect(position)
      }}
      className={cx(
        'row-52 scroll-mt-12 scroll-mb-2 outline-none transition-colors',
        'focus-visible:bg-surface-3 [&>td]:border-b [&>td]:border-border last:[&>td]:border-b-0',
        selected ? 'bg-surface-3' : 'hover:bg-surface-2',
      )}
    >
      <td
        className={cx(
          'border-s-2 pe-2 text-end align-middle',
          selected ? 'border-s-focus' : 'border-s-transparent',
        )}
      >
        <span className="tabular font-mono text-xs text-fg-muted">{result.rank}</span>
      </td>
      <td className="px-2 align-middle">
        <span className="block truncate font-mono text-xs text-fg" title={result.domain}>
          {middleTruncate(result.domain, 32)}
        </span>
      </td>
      <td className="px-2 align-middle">
        <div className="min-w-0">
          {result.title ? (
            <div className="truncate text-[13px] text-fg" title={result.title}>
              {result.title}
            </div>
          ) : (
            <div className="truncate text-[13px] text-fg-muted italic">Title not kept</div>
          )}
          {result.url ? (
            <UrlText url={result.url} max={urlChars} />
          ) : (
            <span className="block truncate text-xs text-fg-muted">URL not kept for this engine</span>
          )}
        </div>
      </td>
      <td className="px-2 align-middle">
        <div className="flex flex-col items-start gap-0.5">
          <DecisionChip decision={result.decision} />
          {result.decision === 'hidden' ? null : <OpenedMark opened={result.opened} />}
        </div>
      </td>
      <td className="px-2 align-middle">
        <Why result={result} />
      </td>
      <td className="px-2 align-middle">
        <div className="truncate text-xs text-fg">
          {result.sourceType ? sourceTypeLabel(result.sourceType) : '–'}
        </div>
        <div className="truncate text-xs text-fg-muted">
          {result.engine === 'builtin' ? 'Built-in' : engineName(result.engine)}
        </div>
      </td>
      <td className="pe-2 align-middle">
        <div className="flex items-center justify-end gap-0.5">
          {VERBS.map((verb) => (
            <IconButton
              key={verb}
              icon={ACTION_ICONS[verb]}
              label={`${VERB_WORDS[verb]} ${result.domain}`}
              shortcut={VERB_KEYS[verb]}
              tabIndex={focusable ? 0 : -1}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(position)
                onVerb(verb, result)
              }}
            />
          ))}
        </div>
      </td>
    </tr>
  )
}

export function ResultsPanel({
  entry,
  detail,
  selectedPosition,
  onSelect,
  onVerb,
}: {
  entry: LogEntry
  detail: DetailState
  selectedPosition: number | undefined
  onSelect: (position: number) => void
  onVerb: (verb: QuickVerb, result: LogResult) => void
}) {
  const [urlHeader, urlChars] = useCharCapacity()
  const results = detail.data?.results ?? []
  const pinned = results.filter((r) => r.decision === 'pinned').length
  const hidden = results.filter((r) => r.decision === 'hidden').length
  const { opened, shown } = openedSummary(results)
  const focusPosition = selectedPosition ?? 1

  return (
    <div id={`results-${entry.searchId}`} className="border-t border-border bg-bg px-3 pt-2 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>
          {detail.status === 'success' ? (
            <>
              <span className="tabular font-mono text-fg">{formatCount(results.length)}</span> results ·{' '}
              <span className="tabular font-mono text-fg">{formatCount(hidden)}</span> hidden ·{' '}
              <span className="tabular font-mono text-fg">{formatCount(pinned)}</span> pinned ·{' '}
              <span title="Results the assistant opened, of those it was shown">
                opened <span className="tabular font-mono text-fg">{formatCount(opened)}</span> of{' '}
                <span className="tabular font-mono text-fg">{formatCount(shown)}</span>
              </span>
            </>
          ) : (
            'Results'
          )}
          <span className="ms-3">
            Profile <span className="text-fg">{entry.profile}</span> · depth{' '}
            <span className="text-fg">{entry.depth}</span>
          </span>
        </span>
        <span className="font-mono">
          search {entry.searchId} · receipt {entry.receiptId}
        </span>
      </div>

      {detail.status === 'pending' ? (
        <div className="mt-2 space-y-2" aria-busy="true">
          <span className="sr-only">Loading results…</span>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex h-11 items-center gap-4 rounded-md border border-border bg-surface px-3"
            >
              <Skeleton className="h-3 w-6" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-4 w-16 rounded-full" />
            </div>
          ))}
        </div>
      ) : detail.status === 'error' ? (
        <div
          role="alert"
          className="mt-2 flex items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5 text-[13px] text-danger"
        >
          <span className="flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            Couldn't load the results: {messageOf(detail.error)}
          </span>
          <Button size="sm" onClick={detail.retry}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : results.length === 0 ? (
        <p className="mt-2 rounded-md border border-border bg-surface px-3 py-3 text-[13px] text-fg-muted">
          This search returned no results.
        </p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-md border border-border bg-surface">
          <table
            aria-label={`Results for “${entry.query}”`}
            className="w-full table-fixed border-separate border-spacing-0"
          >
            <colgroup>
              <col className="w-11" />
              <col className="w-44" />
              <col />
              <col className="w-26" />
              <col className="w-52" />
              <col className="w-28" />
              <col className="w-42" />
            </colgroup>
            <thead>
              <tr className="h-8 text-start text-[11px] font-medium tracking-wide text-fg-muted uppercase [&>th]:border-b [&>th]:border-border [&>th]:font-medium">
                <th scope="col" className="pe-2 text-end">
                  #
                </th>
                <th scope="col" className="px-2 text-start">
                  Domain
                </th>
                <th scope="col" ref={urlHeader} className="px-2 text-start">
                  Result
                </th>
                <th scope="col" className="px-2 text-start">
                  Decision
                </th>
                <th scope="col" className="px-2 text-start">
                  Why
                </th>
                <th scope="col" className="px-2 text-start">
                  Source
                </th>
                <th scope="col" className="pe-2 text-end">
                  <span className="sr-only">Rule actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, i) => (
                <ResultRow
                  key={i}
                  searchId={entry.searchId}
                  position={i + 1}
                  result={result}
                  selected={selectedPosition === i + 1}
                  focusable={focusPosition === i + 1}
                  urlChars={urlChars}
                  onSelect={onSelect}
                  onVerb={onVerb}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="sr-only">{VERBS.map((v) => `${VERB_KEYS[v]}: ${VERB_HINT[v]}.`).join(' ')}</p>
    </div>
  )
}
