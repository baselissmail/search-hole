// SPDX-License-Identifier: Apache-2.0
/**
 * The Overview header (§8.3): this week's numbers as text plus simple CSS bars. No chart
 * library (ADR-0020 point 2).
 */
import type { ReactNode } from 'react'
import { messageOf } from '../lib/api.ts'
import type { Overview } from '../lib/contract.ts'
import { formatCount, formatShare } from '../lib/format.ts'
import { engineName, searchModeLabel, sourceTypeLabel } from '../lib/labels.ts'
import { OVERVIEW_DAYS, useOverview } from '../lib/queries.ts'
import { Skeleton } from './ui/Skeleton.tsx'

function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">{label}</dt>
      <dd className="mt-0.5 flex min-h-6 items-center gap-2 text-[13px] text-fg">{children}</dd>
    </div>
  )
}

function Big({ children }: { children: ReactNode }) {
  return <span className="tabular font-mono text-base leading-6 font-semibold">{children}</span>
}

/** A horizontal bar of proportional segments; the numbers are always written next to it. */
function Bar({ parts, width = 'w-20' }: { parts: readonly number[]; width?: string }) {
  const total = parts.reduce((a, b) => a + b, 0)
  return (
    <span
      aria-hidden="true"
      className={`flex h-1.5 ${width} shrink-0 gap-px overflow-hidden rounded-full bg-bar-track`}
    >
      {total > 0
        ? parts.map((part, i) =>
            part > 0 ? (
              <span
                key={i}
                className={i === 0 ? 'bg-bar' : 'bg-fg-subtle/45'}
                style={{ inlineSize: `${(part / total) * 100}%` }}
              />
            ) : null,
          )
        : null}
    </span>
  )
}

function Stats({ o }: { o: Overview }) {
  const results = o.kept + o.hidden
  const engineSearches = Math.max(0, o.searches - o.builtin)
  const sources = Object.entries(o.sourceTypes)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
  const sourceTotal = sources.reduce((sum, [, n]) => sum + n, 0)
  const engines = [...o.engines].sort((a, b) => b.searches - a.searches)
  const mode =
    o.mode.configured === o.mode.effective
      ? searchModeLabel(o.mode.effective)
      : `${searchModeLabel(o.mode.configured)} → ${searchModeLabel(o.mode.effective)}`

  const topHidden = (
    <Stat label="Top hidden" className="hidden min-w-0 md:block">
      {o.topHidden.length === 0 ? (
        <span className="text-fg-muted">Nothing hidden yet</span>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-x-3">
          {o.topHidden.slice(0, 3).map((d) => (
            <li key={d.domain} className="flex min-w-0 items-baseline gap-1">
              <span className="max-w-44 truncate font-mono text-xs" title={d.domain}>
                {d.domain}
              </span>
              <span className="tabular font-mono text-xs text-fg-muted">{formatCount(d.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </Stat>
  )

  // Numbers first, then the lists, which wrap as a group; phones get the numbers only.
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      <Stat label={`Searches · ${o.days} days`}>
        <Big>{formatCount(o.searches)}</Big>
      </Stat>
      <Stat label="Hidden">
        <Big>{formatCount(o.hidden)}</Big>
        <span className="text-fg-muted">{formatShare(o.hidden, results)} of results</span>
      </Stat>
      <Stat label="Built-in vs engines">
        <Bar parts={[o.builtin, engineSearches]} width="w-14" />
        <span className="tabular whitespace-nowrap text-fg-muted">
          <span className="font-mono text-fg">{formatCount(o.builtin)}</span> built-in ·{' '}
          <span className="font-mono text-fg">{formatCount(engineSearches)}</span> engines
        </span>
      </Stat>
      <Stat label="Mode">
        <span className="whitespace-nowrap">{mode}</span>
      </Stat>
      <Stat label="Engines used" className="hidden md:block">
        {engines.length === 0 ? (
          <span className="text-fg-muted">None this week</span>
        ) : (
          <span className="whitespace-nowrap text-fg-muted">
            {engines.slice(0, 3).map((e, i) => (
              <span key={e.engine}>
                {i > 0 ? ' · ' : ''}
                {engineName(e.engine)}{' '}
                <span className="tabular font-mono text-fg">{formatCount(e.searches)}</span>
              </span>
            ))}
          </span>
        )}
      </Stat>
      <Stat label="Sources kept" className="hidden md:block">
        {sourceTotal === 0 ? (
          <span className="text-fg-muted">No results yet</span>
        ) : (
          <>
            <Bar parts={sources.map(([, n]) => n)} width="w-14" />
            <span className="whitespace-nowrap text-fg-muted">
              {sources.slice(0, 3).map(([type, n], i) => (
                <span key={type}>
                  {i > 0 ? ' · ' : ''}
                  {sourceTypeLabel(type)}{' '}
                  <span className="tabular font-mono text-fg">{formatShare(n, sourceTotal)}</span>
                </span>
              ))}
            </span>
          </>
        )}
      </Stat>
      {topHidden}
    </dl>
  )
}

export function OverviewHeader() {
  const overview = useOverview()
  return (
    <section
      aria-labelledby="overview-title"
      className="shrink-0 border-b border-border bg-surface px-4 py-2.5"
    >
      <h2 id="overview-title" className="sr-only">
        Overview of the last {OVERVIEW_DAYS} days
      </h2>
      {overview.isPending ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2" aria-busy="true">
          <span className="sr-only">Loading the overview…</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex flex-col gap-1.5 py-0.5">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      ) : overview.isError ? (
        <p className="py-1.5 text-xs text-fg-muted">
          The overview is unavailable: {messageOf(overview.error)}
        </p>
      ) : (
        <Stats o={overview.data} />
      )}
    </section>
  )
}
