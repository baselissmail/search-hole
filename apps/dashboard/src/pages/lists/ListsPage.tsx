// SPDX-License-Identifier: Apache-2.0
/**
 * Rules & lists, the lists view (§8.3, ADR-0022): every list with its mode, update state and
 * contribution, the catalog (`?catalog=1`), and subscribing by address. Loaded as its own chunk.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  CircleAlert,
  Library,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { messageOf } from '../../lib/api.ts'
import type { ListStatus } from '../../lib/contract.ts'
import { formatCount } from '../../lib/format.ts'
import { ALL_LISTS, updateAllLists, useListsActivity } from '../../lib/listActions.ts'
import { type ContributionSummary, contributionSummary, summaryText } from '../../lib/lists.ts'
import { useLists, useSettings } from '../../lib/queries.ts'
import { usePageTitle } from '../../lib/usePageTitle.ts'
import { RulesHeader } from '../rules/RulesTabs.tsx'
import { AddListForm } from './AddListForm.tsx'
import { CatalogDialog } from './CatalogDialog.tsx'
import { ListsTable } from './ListsTable.tsx'

/** The contribution summary at the top of the section, and the lists whose refresh failed. */
function Summary({ summary, failing }: { summary: ContributionSummary; failing: ListStatus[] }) {
  return (
    <>
      {summaryText(summary)}
      {failing.length > 0 ? (
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-fg">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warn" />
          <span className="font-medium">
            {failing.length === 1 ? '1 list needs attention:' : `${failing.length} lists need attention:`}
          </span>
          {failing.map((l, i) => (
            <span key={l.id} className="max-w-56 truncate" title={l.name}>
              {l.name}
              {i < failing.length - 1 ? ',' : null}
            </span>
          ))}
        </span>
      ) : null}
      {summary.top.length > 0 ? (
        <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
          <span>Most:</span>
          {summary.top.map((t) => (
            <span key={t.id} className="inline-flex min-w-0 items-baseline gap-1">
              <span className="max-w-56 truncate text-fg" title={t.name}>
                {t.name}
              </span>
              <span className="tabular font-mono">{formatCount(t.count)}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  )
}

/** How lists stay current, and a pointer to the switch when background updates are off. */
function UpdatesNote() {
  const settings = useSettings()
  const off = settings.data?.lists?.autoUpdate === false
  return (
    <p className="border-t border-border px-4 py-2.5 text-xs text-fg-muted">
      {off ? (
        <>
          Background updates are off, so lists change only when you update them here.{' '}
          <Link to="/settings" hash="lists" className="text-fg underline underline-offset-2">
            Turn them on in Settings
          </Link>
          .
        </>
      ) : (
        'Starter lists and subscriptions refresh in the background after a search, each on its own schedule. A failed refresh keeps the copy in force.'
      )}
    </p>
  )
}

function ListsSection({ onBrowse }: { onBrowse: () => void }) {
  const queryClient = useQueryClient()
  const lists = useLists()
  const { updating, removing } = useListsActivity()
  const shown = (lists.data ?? []).filter((l) => !removing.has(l.id))
  const updatingAll = updating.has(ALL_LISTS)
  return (
    <Card
      id="lists"
      title="Your lists"
      description={
        lists.data ? (
          <Summary summary={contributionSummary(shown)} failing={shown.filter((l) => l.lastError)} />
        ) : undefined
      }
      actions={
        <>
          <Button size="sm" onClick={onBrowse}>
            <Library aria-hidden="true" className="size-3.5" />
            Browse catalog
          </Button>
          <Button
            size="sm"
            disabled={updatingAll}
            aria-busy={updatingAll || undefined}
            onClick={() => void updateAllLists(queryClient)}
          >
            {updatingAll ? (
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw aria-hidden="true" className="size-3.5" />
            )}
            {updatingAll ? 'Updating…' : 'Update all'}
          </Button>
        </>
      }
    >
      {lists.isPending ? (
        <div className="space-y-4 p-4" aria-busy="true">
          <span className="sr-only">Loading your lists…</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-6">
              <Skeleton className="h-3 w-64" />
              <Skeleton className="h-6 w-48 rounded-md" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : lists.isError ? (
        <div role="alert" className="flex items-center justify-between gap-3 p-4 text-[13px] text-danger">
          <span className="flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4" />
            Couldn't load your lists: {messageOf(lists.error)}
          </span>
          <Button size="sm" onClick={() => void lists.refetch()}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={ListChecks} title="No lists">
          <p>
            Lists are rule sets that others maintain. Browse the catalog to add one, or subscribe by address
            below.
          </p>
        </EmptyState>
      ) : (
        <ListsTable lists={shown} updating={updating} />
      )}
      <UpdatesNote />
    </Card>
  )
}

export function ListsPage() {
  usePageTitle('Lists')
  const navigate = useNavigate()
  const search = useSearch({ from: '/rules/lists' })
  const setCatalog = (open: boolean) =>
    void navigate({ to: '/rules/lists', search: open ? { catalog: true } : {}, replace: !open })
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 md:px-6">
      <RulesHeader description="Lists are rule sets that others maintain. Your own rules always beat them; Audit shows what a list would hide before it hides anything." />
      <ListsSection onBrowse={() => setCatalog(true)} />
      <AddListForm />
      <CatalogDialog open={search.catalog === true} onOpenChange={setCatalog} />
    </div>
  )
}
