// SPDX-License-Identifier: Apache-2.0
/**
 * Every list, one row each: what it is, its mode (changed at once, with Undo), its rules, when it
 * was updated and will be next, what it did this week, and its error with the fix. A row expands
 * to explain itself. List names, descriptions and addresses come from the network: text only.
 */
import { useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileInput,
  LoaderCircle,
  type LucideIcon,
  Package,
  RefreshCw,
  Rss,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Chip } from '../../components/ui/Chip.tsx'
import { IconButton } from '../../components/ui/IconButton.tsx'
import { UrlText } from '../../components/ui/UrlText.tsx'
import type { ListSource, ListStatus } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount } from '../../lib/format.ts'
import { ALL_LISTS, removeListWithUndo, setListModeWithUndo, updateListNow } from '../../lib/listActions.ts'
import {
  canRemove,
  canUpdate,
  contributionText,
  formatWord,
  intervalText,
  KIND_HINTS,
  kindWord,
  licenseText,
  listErrorAdvice,
  MODE_HINTS,
  MODE_WORDS,
  SOURCE_HINTS,
  sourceWord,
} from '../../lib/lists.ts'
import { formatAgo, formatExact, formatRelative, isPast } from '../../lib/time.ts'
import { ModeControl } from './ModeControl.tsx'

const SOURCE_ICONS: Record<ListSource, LucideIcon> = {
  bundled: Package,
  vendored: Sparkles,
  subscribed: Rss,
  local: FileInput,
}

export function SourceChip({ source }: { source: ListSource }) {
  return (
    <Chip tone="neutral" icon={SOURCE_ICONS[source] ?? Package} title={SOURCE_HINTS[source]}>
      {sourceWord(source)}
    </Chip>
  )
}

/** The current time, ticking once a minute so relative times stay true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** A time as words, the exact time on hover. `past` events never read as "in …". */
function When({
  at,
  children,
  now,
  past = false,
}: {
  at: string
  children?: string
  now: Date
  past?: boolean
}) {
  return (
    <time dateTime={at} title={formatExact(at)}>
      {children ? `${children} ` : null}
      {past ? formatAgo(at, now) : formatRelative(at, now)}
    </time>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const COPY_WORDS: Partial<Record<ListStatus['copy'], string>> = {
  shipped: 'Shipped copy,',
  downloaded: 'Downloaded',
  imported: 'Imported',
}

/** Last update on the first line, the next one on the second. */
function UpdatedCell({ list, now }: { list: ListStatus; now: Date }) {
  let last: ReactNode
  if (list.copy === 'built-in') last = 'Built in'
  else if (list.copy === 'none' || list.lastUpdate === null) {
    last = <span className="text-fg-muted">Not downloaded yet</span>
  } else
    last = (
      <When at={list.lastUpdate} now={now} past>
        {COPY_WORDS[list.copy] ?? 'Updated'}
      </When>
    )

  let next: ReactNode
  if (list.copy === 'built-in') next = 'Updates with search-hole'
  else if (list.source === 'local') next = 'Never refreshed'
  else if (list.mode === 'disabled') next = 'Off: not refreshed'
  else if (list.nextUpdate === null) next = 'Not refreshed'
  else if (isPast(list.nextUpdate, now)) next = list.lastError ? 'Retry due now' : 'Check due now'
  else
    next = (
      <When at={list.nextUpdate} now={now}>
        {list.lastError ? 'Retry' : 'Next check'}
      </When>
    )

  return (
    <>
      <div className="truncate text-fg">{last}</div>
      <div className="truncate text-xs text-fg-muted">{next}</div>
    </>
  )
}

function skippedTitle(list: ListStatus): string {
  return Object.entries(list.skipReasons)
    .map(([reason, n]) => `${formatCount(n)} × ${reason}`)
    .join('\n')
}

function DetailItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-muted">{term}</dt>
      <dd className="mt-0.5 break-words text-fg">{children}</dd>
    </div>
  )
}

/** The expanded row: everything the list's row stands for, in words. */
function ListDetails({ list, now }: { list: ListStatus; now: Date }) {
  const reasons = Object.entries(list.skipReasons)
  return (
    <div className="ms-5 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-xs">
      {list.description ? (
        <p className="mb-2.5 max-w-prose text-[13px] break-words text-fg">{list.description}</p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <DetailItem term={`Source: ${sourceWord(list.source)}`}>{SOURCE_HINTS[list.source]}</DetailItem>
        <DetailItem term={`Kind: ${kindWord(list.kind)}`}>{KIND_HINTS[list.kind] ?? list.kind}</DetailItem>
        <DetailItem term={`Mode: ${MODE_WORDS[list.mode] ?? list.mode}`}>
          {MODE_HINTS[list.mode]}
          {list.mode !== list.defaultMode ? ` Its default is ${MODE_WORDS[list.defaultMode]}.` : null}
        </DetailItem>
        {list.url ? (
          <DetailItem term="Address">
            <UrlText url={list.url} max={64} />
          </DetailItem>
        ) : null}
        {list.homepage ? (
          <DetailItem term="Homepage">
            <UrlText url={list.homepage} max={64} />
          </DetailItem>
        ) : null}
        <DetailItem term="Licence">{licenseText(list.license)}</DetailItem>
        <DetailItem term="Format">
          {formatWord(list.format)}
          {list.format === 'auto' && list.detectedFormat
            ? ` (read as ${formatWord(list.detectedFormat)})`
            : null}
        </DetailItem>
        {list.update ? (
          <DetailItem term="Refresh">
            {capitalize(intervalText(list.update))}
            {list.lastCheck ? (
              <>
                {'; last checked '}
                <When at={list.lastCheck} now={now} past />
              </>
            ) : null}
            .
          </DetailItem>
        ) : null}
        {list.sha256 ? (
          <DetailItem term="Pinned SHA-256">
            <span className="font-mono break-all">{list.sha256}</span>
          </DetailItem>
        ) : null}
        <DetailItem term="Rules in force">
          {formatCount(list.ruleCount)}
          {list.skipped > 0 ? `; ${formatCount(list.skipped)} lines skipped:` : null}
          {reasons.length > 0 ? (
            <ul className="mt-0.5 list-disc ps-4 text-fg-muted">
              {reasons.map(([reason, n]) => (
                <li key={reason}>
                  <span className="tabular font-mono text-fg">{formatCount(n)}</span> {reason}
                </li>
              ))}
            </ul>
          ) : null}
        </DetailItem>
        {list.warnings.length > 0 ? (
          <DetailItem term="Importer notes">
            <ul className="list-disc ps-4">
              {list.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </DetailItem>
        ) : null}
        <DetailItem term="Id">
          <span className="font-mono">{list.id}</span>
        </DetailItem>
      </dl>
    </div>
  )
}

/** A failed refresh: the state, what it means, the message, and the one-click fix. */
function ListError({ list, busy, now }: { list: ListStatus; busy: boolean; now: Date }) {
  const queryClient = useQueryClient()
  const error = list.lastError
  if (!error) return null
  const advice = listErrorAdvice(error.code)
  return (
    <div
      className={cx(
        'ms-5 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border px-3 py-2',
        advice.tone === 'warn' ? 'border-warn-line bg-warn-soft' : 'border-danger-line bg-danger-soft',
      )}
    >
      <Chip tone={advice.tone} icon={advice.tone === 'warn' ? TriangleAlert : CircleAlert}>
        {advice.word}
      </Chip>
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-fg">{advice.advice}</p>
        <p className="mt-0.5 break-words text-fg-muted">{error.message}</p>
        <p className="mt-0.5 text-fg-muted">
          <When at={error.at} now={now} past>
            Failed
          </When>
          . {list.copy === 'none' ? 'Nothing is loaded from it yet.' : 'The copy in force is kept.'}
        </p>
      </div>
      {advice.action ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void updateListNow(queryClient, list, advice.action === 'force')}
          aria-label={`${advice.action === 'force' ? 'Update anyway' : 'Try again'}: ${list.name}`}
        >
          <RefreshCw aria-hidden="true" className={cx('size-3.5', busy && 'animate-spin')} />
          {advice.action === 'force' ? 'Update anyway' : 'Try again'}
        </Button>
      ) : null}
    </div>
  )
}

const COLUMNS = 6

function ListRows({
  list,
  expanded,
  onToggle,
  updating,
  now,
}: {
  list: ListStatus
  expanded: boolean
  onToggle: () => void
  updating: ReadonlySet<string>
  now: Date
}) {
  const queryClient = useQueryClient()
  const detailsId = `list-details-${list.id}`
  const busyHere = updating.has(list.id) || (updating.has(ALL_LISTS) && canUpdate(list))
  const busyAny = busyHere || updating.has(ALL_LISTS)
  const { hidden7d, wouldHide7d } = list.contribution
  const cell = 'px-3 py-2.5 align-top'
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <tbody
      aria-busy={busyHere || undefined}
      className="[&>tr:last-child>td]:border-b [&>tr:last-child>td]:border-border last:[&>tr:last-child>td]:border-b-0"
    >
      <tr className="hover:bg-surface-2/60">
        <td className={cell}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            onClick={onToggle}
            className="group -ms-1 flex max-w-full min-w-0 items-start gap-1 rounded px-1 text-start"
          >
            <Chevron
              aria-hidden="true"
              className={cx('mt-0.5 size-3.5 shrink-0 text-fg-subtle', !expanded && 'rtl:-scale-x-100')}
            />
            <span className="line-clamp-2 font-medium break-words text-fg group-hover:underline">
              {list.name}
            </span>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ps-5 text-xs text-fg-muted">
            <SourceChip source={list.source} />
            <span>{kindWord(list.kind)}</span>
            {list.license ? <span>· {licenseText(list.license)}</span> : null}
          </div>
        </td>
        <td className={cell}>
          <ModeControl
            mode={list.mode}
            label={`Mode of ${list.name}`}
            onChange={(mode) => void setListModeWithUndo(queryClient, list, mode)}
          />
          {list.mode !== list.defaultMode ? (
            <div className="mt-1 text-xs text-fg-muted">Default: {MODE_WORDS[list.defaultMode]}</div>
          ) : null}
        </td>
        <td className={cx(cell, 'text-end')}>
          <div className="tabular font-mono text-fg">
            {list.copy === 'none' && list.ruleCount === 0 ? '–' : formatCount(list.ruleCount)}
          </div>
          {list.skipped > 0 ? (
            <div className="text-xs text-fg-muted" title={skippedTitle(list)}>
              {formatCount(list.skipped)} skipped
            </div>
          ) : null}
        </td>
        <td className={cx(cell, 'min-w-0')}>
          <UpdatedCell list={list} now={now} />
        </td>
        <td className={cell}>
          <span className={cx('tabular', hidden7d > 0 || wouldHide7d > 0 ? 'text-fg' : 'text-fg-muted')}>
            {contributionText(list)}
          </span>
        </td>
        <td className={cx(cell, 'text-end')}>
          <div className="-me-1.5 flex justify-end gap-0.5">
            {canUpdate(list) ? (
              <IconButton
                icon={busyHere ? LoaderCircle : RefreshCw}
                iconClassName={busyHere ? 'animate-spin' : undefined}
                label={busyHere ? `Updating ${list.name}…` : `Update ${list.name} now`}
                disabled={busyAny}
                onClick={() => void updateListNow(queryClient, list)}
              />
            ) : null}
            {canRemove(list) ? (
              <IconButton
                icon={Trash2}
                label={`Remove ${list.name}`}
                disabled={busyHere}
                onClick={() => void removeListWithUndo(queryClient, list)}
              />
            ) : null}
          </div>
        </td>
      </tr>
      {list.lastError ? (
        <tr>
          <td colSpan={COLUMNS} className="px-3 pb-2.5">
            <ListError list={list} busy={busyAny} now={now} />
          </td>
        </tr>
      ) : null}
      {expanded ? (
        <tr id={detailsId}>
          <td colSpan={COLUMNS} className="px-3 pb-3">
            <ListDetails list={list} now={now} />
          </td>
        </tr>
      ) : null}
    </tbody>
  )
}

export function ListsTable({ lists, updating }: { lists: ListStatus[]; updating: ReadonlySet<string> }) {
  const now = useNow()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) =>
    setExpanded((open) => {
      const next = new Set(open)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const head =
    'border-b border-border px-3 text-start text-[11px] font-medium tracking-wide text-fg-muted uppercase'
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Your lists"
        className="w-full min-w-[60rem] table-fixed border-separate border-spacing-0 text-[13px]"
      >
        <colgroup>
          <col />
          <col className="w-60" />
          <col className="w-24" />
          <col className="w-48" />
          <col className="w-48" />
          <col className="w-20" />
        </colgroup>
        <thead>
          <tr className="h-9">
            <th scope="col" className={head}>
              List
            </th>
            <th scope="col" className={head}>
              Mode
            </th>
            <th scope="col" className={cx(head, 'text-end')}>
              Rules
            </th>
            <th scope="col" className={head}>
              Updated
            </th>
            <th scope="col" className={head}>
              This week
            </th>
            <th scope="col" className={head}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {lists.map((list) => (
          <ListRows
            key={list.id}
            list={list}
            expanded={expanded.has(list.id)}
            onToggle={() => toggle(list.id)}
            updating={updating}
            now={now}
          />
        ))}
      </table>
    </div>
  )
}
