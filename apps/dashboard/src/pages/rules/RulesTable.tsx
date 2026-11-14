// SPDX-License-Identifier: Apache-2.0
/** Your rules, sortable and filterable, each removable with Undo. */
import { useQueryClient } from '@tanstack/react-query'
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown, CircleAlert, ListFilter, RotateCw, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { ActionChip } from '../../components/status.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { inputClass } from '../../components/ui/Field.tsx'
import { IconButton } from '../../components/ui/IconButton.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { messageOf } from '../../lib/api.ts'
import type { RuleListing } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount, formatDate } from '../../lib/format.ts'
import { useRules } from '../../lib/queries.ts'
import { removeRuleWithUndo } from '../../lib/ruleActions.ts'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
})

/** A rule's source as a short name: the file's name for a path (full path in the tooltip). */
export function sourceLabel(source: string): string {
  return /[\\/]/.test(source) ? (source.split(/[\\/]/).pop() ?? source) : source
}

const helper = createColumnHelper<typeof features, RuleListing>()

const SCOPE_WORDS: Record<RuleListing['scope'], string> = {
  global: 'Global',
  project: 'Project',
  session: 'Session',
}

const columns = helper.columns([
  helper.accessor('match', {
    header: 'Match',
    sortFn: 'alphanumeric',
    cell: (info) => (
      <span className="block truncate font-mono text-xs text-fg" title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  helper.accessor('action', {
    header: 'Action',
    cell: (info) => <ActionChip action={info.getValue()} />,
  }),
  helper.accessor('weight', {
    header: 'Weight',
    cell: (info) => {
      const action = info.row.original.action
      return action === 'raise' || action === 'lower' ? (
        <span className="tabular font-mono text-xs">{info.getValue()}</span>
      ) : (
        <span className="text-fg-muted">–</span>
      )
    },
  }),
  helper.accessor('scope', {
    header: 'Scope',
    cell: (info) => (
      <span className="text-fg-muted">
        {SCOPE_WORDS[info.getValue()] ?? info.getValue()}
        {info.row.original.important ? <span className="ms-1.5 text-xs text-fg">· important</span> : null}
        {info.row.original.needsTrust ? (
          <span
            className="ms-1.5 text-xs text-fg"
            title="Saved, but it doesn't apply until you run `searchhole trust` in that project."
          >
            · not trusted
          </span>
        ) : null}
      </span>
    ),
  }),
  helper.accessor('source', {
    header: 'Source',
    cell: (info) => (
      <span className="block truncate font-mono text-xs text-fg-muted" title={info.getValue()}>
        {sourceLabel(info.getValue())}
      </span>
    ),
  }),
  helper.display({
    id: 'details',
    header: 'Note',
    cell: (info) => {
      const { until, note, profiles } = info.row.original
      if (!until && !note && !profiles?.length) return <span className="text-fg-muted">–</span>
      return (
        <div className="min-w-0 text-xs">
          {note ? (
            <div className="truncate text-fg" title={note}>
              {note}
            </div>
          ) : null}
          <div className="truncate text-fg-muted">
            {until ? `Until ${formatDate(until)}` : null}
            {until && profiles?.length ? ' · ' : null}
            {profiles?.length ? `Profiles: ${profiles.join(', ')}` : null}
          </div>
        </div>
      )
    },
  }),
])

const WIDTHS: Record<string, string> = {
  match: 'w-auto',
  action: 'w-28',
  weight: 'w-20',
  scope: 'w-32',
  source: 'w-40',
  details: 'w-56',
}

function SortIcon({ dir }: { dir: false | 'asc' | 'desc' }) {
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown
  return <Icon aria-hidden="true" className={cx('size-3', dir ? 'text-fg' : 'text-fg-subtle')} />
}

function RulesGrid({ rules }: { rules: RuleListing[] }) {
  const queryClient = useQueryClient()
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useTable({
    features,
    columns,
    data: rules,
    getRowId: (rule) => `${rule.scope}:${rule.id}`,
    state: { sorting },
    onSortingChange: setSorting,
  })
  return (
    <div className="overflow-x-auto">
      <table
        aria-label="Your rules"
        className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-[13px]"
      >
        <colgroup>
          {table.getHeaderGroups()[0]?.headers.map((header) => (
            <col key={header.id} className={WIDTHS[header.column.id]} />
          ))}
          <col className="w-14" />
        </colgroup>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="h-9">
              {group.headers.map((header) => {
                const dir = header.column.getIsSorted()
                const canSort = header.column.getCanSort()
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      canSort
                        ? dir === 'asc'
                          ? 'ascending'
                          : dir === 'desc'
                            ? 'descending'
                            : 'none'
                        : undefined
                    }
                    className="border-b border-border px-3 text-start text-[11px] font-medium tracking-wide text-fg-muted uppercase"
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase hover:text-fg"
                      >
                        <table.FlexRender header={header} />
                        <SortIcon dir={dir} />
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                )
              })}
              <th scope="col" className="border-b border-border px-3">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="h-11 hover:bg-surface-2 [&>td]:border-b [&>td]:border-border last:[&>td]:border-b-0"
            >
              {row.getAllCells().map((cell) => (
                <td key={cell.id} className="truncate px-3 align-middle">
                  <table.FlexRender cell={cell} />
                </td>
              ))}
              <td className="px-3 text-end align-middle">
                <IconButton
                  icon={Trash2}
                  label={`Remove rule ${row.original.match}`}
                  onClick={() => void removeRuleWithUndo(queryClient, row.original)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RulesTable() {
  const rules = useRules()
  const filterId = useId()
  const [filter, setFilter] = useState('')
  const all = rules.data ?? []
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? all.filter((r) =>
        `${r.match} ${r.action} ${r.scope} ${r.source} ${r.note ?? ''}`.toLowerCase().includes(needle),
      )
    : all

  return (
    <Card
      id="rules"
      title="Your rules"
      description={
        rules.data
          ? `${formatCount(all.length)} ${all.length === 1 ? 'rule' : 'rules'}. Remove any with Undo.`
          : undefined
      }
      actions={
        all.length > 0 ? (
          <div className="relative">
            <label htmlFor={filterId} className="sr-only">
              Filter rules
            </label>
            <ListFilter
              aria-hidden="true"
              className="pointer-events-none absolute start-2.5 top-2 size-4 text-fg-subtle"
            />
            <input
              id={filterId}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter rules"
              className={cx(inputClass, 'w-56 ps-8')}
            />
          </div>
        ) : null
      }
    >
      {rules.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true">
          <span className="sr-only">Loading rules…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-6">
              <Skeleton className="h-3 w-48" />
              <Skeleton className="h-4 w-16 rounded-full" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : rules.isError ? (
        <div role="alert" className="flex items-center justify-between gap-3 p-4 text-[13px] text-danger">
          <span className="flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4" />
            Couldn't load your rules: {messageOf(rules.error)}
          </span>
          <Button size="sm" onClick={() => void rules.refetch()}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : all.length === 0 ? (
        <EmptyState icon={ListFilter} title="No rules yet">
          <p>
            Add one above, or select a result in the live log and press <span className="font-mono">B</span>{' '}
            to block its site.
          </p>
        </EmptyState>
      ) : shown.length === 0 ? (
        <p className="p-4 text-[13px] text-fg-muted">No rule matches “{filter}”.</p>
      ) : (
        <RulesGrid rules={shown} />
      )}
    </Card>
  )
}
