// SPDX-License-Identifier: Apache-2.0
/**
 * The list catalog: lists others maintain, what each does, its licence and size, and whether it
 * is already on. "Add" subscribes in the recommended mode (Audit for anything not in the starter
 * set) and downloads the list at once; a failed download shows on the list's row, not here.
 */
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, ExternalLink, LoaderCircle, Plus, RotateCw, Search, Sparkles } from 'lucide-react'
import { type ReactNode, useId, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Chip } from '../../components/ui/Chip.tsx'
import { AppDialog } from '../../components/ui/Dialog.tsx'
import { FieldError, inputClass } from '../../components/ui/Field.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { ApiFailure, messageOf } from '../../lib/api.ts'
import type { ListCatalogEntry } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount } from '../../lib/format.ts'
import { addListWithUndo } from '../../lib/listActions.ts'
import { catalogAddMode, catalogUndo, hostOf, kindWord, licenseText, MODE_WORDS } from '../../lib/lists.ts'
import { useListCatalog } from '../../lib/queries.ts'
import { EXTERNAL_LINK, safeHttpUrl } from '../../lib/safeUrl.ts'
import { ModeChip } from './ModeControl.tsx'

interface Problem {
  id: string
  message: string
  fix?: string | undefined
}

function Meta({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-1">
      <dt className="shrink-0 text-fg-muted">{term}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  )
}

function OutLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a
      href={href}
      {...EXTERNAL_LINK}
      className="inline-flex items-center gap-0.5 underline decoration-border-strong underline-offset-2 hover:decoration-fg"
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function CatalogItem({
  entry,
  adding,
  busy,
  problem,
  onAdd,
}: {
  entry: ListCatalogEntry
  adding: boolean
  busy: boolean
  problem: Problem | null
  onAdd: () => void
}) {
  const id = useId()
  const host = hostOf(entry.url)
  const verb = entry.mode === 'disabled' ? 'Turn on' : 'Add'
  const addMode = catalogAddMode(entry)
  const homepage = safeHttpUrl(entry.homepage)
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-[13px] font-medium break-words text-fg">{entry.name}</h3>
          {entry.starter ? (
            <Chip tone="neutral" icon={Sparkles} title="Ships with search-hole and is on by default">
              Starter
            </Chip>
          ) : null}
        </div>
        {entry.notes ? <p className="mt-1 text-xs break-words text-fg-muted">{entry.notes}</p> : null}
        <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Meta term="Kind:">{kindWord(entry.kind)}</Meta>
          {entry.approxRules !== undefined ? (
            <Meta term="Rules:">about {formatCount(entry.approxRules)}</Meta>
          ) : null}
          <Meta term="Licence:">
            <OutLink href={safeHttpUrl(entry.licenseUrl)}>{licenseText(entry.license)}</OutLink>
          </Meta>
          <Meta term="Recommended:">
            {entry.recommendedMode === 'off' ? 'Audit first' : MODE_WORDS[entry.recommendedMode]}
          </Meta>
          {host ? (
            <Meta term="Downloads from:">
              <span className="font-mono">{host}</span>
            </Meta>
          ) : null}
          {homepage ? (
            <Meta term="Home:">
              <OutLink href={homepage}>Project page</OutLink>
            </Meta>
          ) : null}
        </dl>
        {problem ? <FieldError id={`${id}-error`} message={problem.message} fix={problem.fix} /> : null}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        {entry.enabled && entry.mode ? (
          <>
            <ModeChip mode={entry.mode} />
            <span className="text-xs text-fg-muted">In your lists</span>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              aria-busy={adding || undefined}
              aria-describedby={problem ? `${id}-error` : undefined}
              aria-label={`${verb} ${entry.name} in ${MODE_WORDS[addMode]} mode`}
              onClick={onAdd}
            >
              {adding ? (
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <Plus aria-hidden="true" className="size-3.5" />
              )}
              {adding ? 'Downloading…' : verb}
            </Button>
            <span className="text-xs text-fg-muted">as {MODE_WORDS[addMode]}</span>
          </>
        )}
      </div>
    </li>
  )
}

const rank = (e: ListCatalogEntry) => (e.starter ? 0 : 1)

export function CatalogDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const catalog = useListCatalog(open)
  const filterId = useId()
  const filterRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState<ListCatalogEntry | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)

  const needle = filter.trim().toLowerCase()
  const entries = [...(catalog.data ?? [])]
    .sort((a, b) => rank(a) - rank(b))
    .filter(
      (e) =>
        needle === '' || `${e.name} ${e.id} ${e.notes} ${e.kind} ${e.license}`.toLowerCase().includes(needle),
    )

  const add = async (entry: ListCatalogEntry) => {
    setAdding(entry)
    setProblem(null)
    try {
      await addListWithUndo(
        queryClient,
        { source: entry.id, mode: catalogAddMode(entry) },
        catalogUndo(entry),
      )
    } catch (err) {
      setProblem({
        id: entry.id,
        message: messageOf(err),
        fix: err instanceof ApiFailure ? err.fix : undefined,
      })
    } finally {
      setAdding(null)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="List catalog"
      description="Lists that others maintain. Adding one downloads it from its address now, then again every 7 days. Only the list is fetched: no queries, no cookies."
      initialFocus={filterRef}
      size="lg"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 pb-3">
        <div className="relative w-full sm:w-64">
          <label htmlFor={filterId} className="sr-only">
            Filter the catalog
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-2.5 top-2 size-4 text-fg-subtle"
          />
          <input
            ref={filterRef}
            id={filterId}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter the catalog"
            className={cx(inputClass, 'ps-8')}
          />
        </div>
        <p className="min-w-0 flex-1 text-xs text-fg-muted">
          Lists outside the starter set start in Audit: they record what they would hide and hide nothing
          until you switch them to Enforce.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        {catalog.isPending ? (
          <div className="space-y-4 p-4" aria-busy="true">
            <span className="sr-only">Loading the catalog…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ))}
          </div>
        ) : catalog.isError ? (
          <div role="alert" className="flex items-center justify-between gap-3 p-4 text-[13px] text-danger">
            <span className="flex items-center gap-2">
              <CircleAlert aria-hidden="true" className="size-4" />
              Couldn't load the catalog: {messageOf(catalog.error)}
            </span>
            <Button size="sm" onClick={() => void catalog.refetch()}>
              <RotateCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <p className="p-4 text-[13px] text-fg-muted">No list matches “{filter}”.</p>
        ) : (
          <ul aria-label="Catalog lists" className="divide-y divide-border">
            {entries.map((entry) => (
              <CatalogItem
                key={entry.id}
                entry={entry}
                adding={adding?.id === entry.id}
                busy={adding !== null}
                problem={problem?.id === entry.id ? problem : null}
                onAdd={() => void add(entry)}
              />
            ))}
          </ul>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {adding ? `Adding ${adding.name}: downloading it from its address…` : ''}
      </p>
    </AppDialog>
  )
}
