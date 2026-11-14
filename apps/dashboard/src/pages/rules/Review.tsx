// SPDX-License-Identifier: Apache-2.0
/**
 * Sites that kept showing up in results while the assistant never opened one of their pages
 * (ADR-0025). The list only points at them: Block and Lower add an ordinary global rule, Keep
 * says "this site is fine". Each can be undone for 8 seconds, and a kept site can be listed
 * again from the foot of the card. Site names, titles and URLs come from the web: text only.
 */
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Ban, Check, CircleAlert, RotateCw, Telescope } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { UrlText } from '../../components/ui/UrlText.tsx'
import { messageOf } from '../../lib/api.ts'
import type { ReviewList, ReviewSite } from '../../lib/contract.ts'
import { formatCount } from '../../lib/format.ts'
import { sourceTypeLabel } from '../../lib/labels.ts'
import { useReview } from '../../lib/queries.ts'
import { actOnSite, type ReviewAction, restoreSite } from '../../lib/reviewActions.ts'
import { formatAgo, formatExact } from '../../lib/time.ts'

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** The line under the card title. */
export function reviewSummary(list: ReviewList | undefined): string {
  if (!list || list.total === 0) {
    return 'Sites that keep showing up in results while the assistant never opens them.'
  }
  return `${formatCount(list.total)} ${plural(list.total, 'site', 'sites')} appeared in ${list.minSearches} or more searches in the last ${list.days} ${plural(list.days, 'day', 'days')}, and the assistant never opened a page from ${plural(list.total, 'it', 'them')}.`
}

function Site({
  site,
  busy,
  onAct,
}: {
  site: ReviewSite
  busy: boolean
  onAct: (action: ReviewAction) => void
}) {
  return (
    <li data-review-site={site.domain} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-[13px] font-medium text-fg" title={site.domain}>
            {site.domain}
          </h3>
          <p className="mt-0.5 text-xs text-fg-muted">
            <span className="tabular font-mono text-fg">{formatCount(site.searches)}</span>{' '}
            {plural(site.searches, 'search', 'searches')} ·{' '}
            <span className="tabular font-mono text-fg">{formatCount(site.results)}</span>{' '}
            {plural(site.results, 'result', 'results')} · {sourceTypeLabel(site.sourceType)} · last seen{' '}
            <time dateTime={site.lastSeen} title={formatExact(site.lastSeen)}>
              {formatAgo(site.lastSeen)}
            </time>
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => onAct('block')}
            aria-label={`Block ${site.domain}`}
            title="Hide this site from results"
          >
            <Ban aria-hidden="true" className="size-3.5" />
            Block
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onAct('lower')}
            aria-label={`Lower ${site.domain}`}
            title="Move this site down in results"
          >
            <ArrowDown aria-hidden="true" className="size-3.5" />
            Lower
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onAct('keep')}
            aria-label={`Keep ${site.domain}`}
            title="This site is fine: stop listing it"
          >
            <Check aria-hidden="true" className="size-3.5" />
            Keep
          </Button>
        </div>
      </div>
      {site.examples.length > 0 ? (
        <ul aria-label={`Pages from ${site.domain}`} className="space-y-1">
          {site.examples.map((page) => (
            <li key={page.url} className="min-w-0">
              {page.title ? (
                <div className="truncate text-[13px] text-fg" title={page.title}>
                  {page.title}
                </div>
              ) : null}
              <UrlText url={page.url} max={96} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-fg-muted italic">
          No titles or URLs are stored for this site: the engine that returned it keeps only the decision.
        </p>
      )}
    </li>
  )
}

function KeptSites({
  kept,
  busy,
  onRestore,
}: {
  kept: ReviewList['dismissed']
  busy: string | null
  onRestore: (domain: string) => void
}) {
  return (
    <details className="border-t border-border px-4 py-3">
      <summary className="cursor-pointer text-[13px] text-fg-muted hover:text-fg">
        <span className="tabular font-mono">{formatCount(kept.length)}</span> kept{' '}
        {plural(kept.length, 'site is', 'sites are')} not listed
      </summary>
      <ul aria-label="Kept sites" className="mt-2 divide-y divide-border">
        {kept.map((site) => (
          <li key={site.domain} className="flex items-center justify-between gap-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-fg" title={site.domain}>
              {site.domain}
            </span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-fg-muted">
              <time dateTime={site.at} title={formatExact(site.at)}>
                kept {formatAgo(site.at)}
              </time>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === site.domain}
                onClick={() => onRestore(site.domain)}
                aria-label={`Review ${site.domain} again`}
              >
                Review again
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function Review() {
  const queryClient = useQueryClient()
  const review = useReview()
  const [busy, setBusy] = useState<string | null>(null)
  // After a row is gone, the keyboard focus moves to the next one ('' = the card itself).
  const [focusOn, setFocusOn] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const list = review.data
  const sites = list?.sites ?? []

  useEffect(() => {
    if (focusOn === null) return
    const card = cardRef.current
    const row = Array.from(card?.querySelectorAll<HTMLElement>('[data-review-site]') ?? []).find(
      (el) => el.dataset.reviewSite === focusOn,
    )
    ;(row?.querySelector<HTMLElement>('button') ?? card)?.focus()
    setFocusOn(null)
  }, [focusOn])

  const act = async (site: ReviewSite, action: ReviewAction) => {
    const at = sites.findIndex((s) => s.domain === site.domain)
    const next = sites[at + 1] ?? sites[at - 1]
    setBusy(site.domain)
    try {
      if (await actOnSite(queryClient, action, site.domain)) setFocusOn(next?.domain ?? '')
    } finally {
      setBusy(null)
    }
  }

  const restore = async (domain: string) => {
    setBusy(domain)
    try {
      await restoreSite(queryClient, domain)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={cardRef} tabIndex={-1} className="rounded-lg outline-none">
      <Card id="review" title="Review" description={reviewSummary(list)}>
        {review.isPending ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <span className="sr-only">Loading the sites to review…</span>
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ) : review.isError ? (
          <div role="alert" className="flex items-center justify-between gap-3 p-4 text-[13px] text-danger">
            <span className="flex items-center gap-2">
              <CircleAlert aria-hidden="true" className="size-4" />
              {messageOf(review.error)}
            </span>
            <Button size="sm" onClick={() => void review.refetch()}>
              <RotateCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          </div>
        ) : sites.length === 0 ? (
          <EmptyState icon={Telescope} title="Nothing to review yet">
            <p>
              A site shows up here after it appears in {list?.minSearches ?? 3} searches and the assistant
              never opens it.
            </p>
          </EmptyState>
        ) : (
          <>
            <ul aria-label="Sites to review" className="divide-y divide-border">
              {sites.map((site) => (
                <Site
                  key={site.domain}
                  site={site}
                  busy={busy === site.domain}
                  onAct={(action) => void act(site, action)}
                />
              ))}
            </ul>
            {list && list.total > sites.length ? (
              <p className="border-t border-border px-4 py-2.5 text-xs text-fg-muted">
                Showing the <span className="tabular font-mono">{formatCount(sites.length)}</span> most-seen
                of <span className="tabular font-mono">{formatCount(list.total)}</span>.
              </p>
            ) : null}
          </>
        )}
        {list && list.dismissed.length > 0 ? (
          <KeptSites kept={list.dismissed} busy={busy} onRestore={(domain) => void restore(domain)} />
        ) : null}
      </Card>
    </div>
  )
}
