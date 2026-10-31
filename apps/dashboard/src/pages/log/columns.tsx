// SPDX-License-Identifier: Apache-2.0
/** Live log columns (TanStack Table v9). Cells render web-sourced strings as text only. */
import { createColumnHelper, tableFeatures } from '@tanstack/react-table'
import { Globe, Sparkles } from 'lucide-react'
import type { LogEntry } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { formatCount, formatDateTime, formatLatency, formatLogTime } from '../../lib/format.ts'
import { engineName } from '../../lib/labels.ts'

export const logFeatures = tableFeatures({})

const helper = createColumnHelper<typeof logFeatures, LogEntry>()

export const logColumns = helper.columns([
  helper.accessor('at', {
    id: 'time',
    header: 'Time',
    cell: (info) => (
      <time
        dateTime={info.getValue()}
        title={formatDateTime(info.getValue())}
        className="tabular font-mono text-xs"
      >
        {formatLogTime(info.getValue())}
      </time>
    ),
  }),
  helper.accessor('query', {
    header: 'Query',
    cell: (info) => <span className="truncate">{info.getValue()}</span>,
  }),
  helper.accessor('mode', {
    header: 'Mode',
    cell: (info) =>
      info.getValue() === 'builtin' ? (
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <Sparkles aria-hidden="true" className="size-3.5" />
          Built-in
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <Globe aria-hidden="true" className="size-3.5" />
          Engines
        </span>
      ),
  }),
  helper.accessor('engines', {
    header: 'Engines',
    cell: (info) => {
      const names = info.getValue().map(engineName).join(', ')
      return (
        <span className="truncate text-fg-muted" title={names}>
          {names || '–'}
        </span>
      )
    },
  }),
  helper.accessor('kept', {
    header: 'Kept',
    cell: (info) => <span className="tabular font-mono text-xs">{formatCount(info.getValue())}</span>,
  }),
  helper.accessor('hidden', {
    header: 'Hidden',
    cell: (info) => (
      <span
        className={cx('tabular font-mono text-xs', info.getValue() > 0 ? 'text-danger' : 'text-fg-muted')}
      >
        {formatCount(info.getValue())}
      </span>
    ),
  }),
  helper.accessor('latencyMs', {
    header: 'Latency',
    cell: (info) => (
      <span className="tabular font-mono text-xs text-fg-muted">{formatLatency(info.getValue())}</span>
    ),
  }),
  helper.accessor('client', {
    header: 'Client',
    cell: (info) => (
      <span className="truncate text-fg-muted" title={info.getValue() ?? ''}>
        {info.getValue() ?? '–'}
      </span>
    ),
  }),
])

/** Column layout: widths for <col>, alignment for cells. Numbers align to the end. */
export const LOG_COLUMN_LAYOUT: Readonly<Record<string, { width: string; end?: boolean }>> = {
  time: { width: '7rem' },
  query: { width: 'auto' },
  mode: { width: '6.5rem' },
  engines: { width: '8.5rem' },
  kept: { width: '4.25rem', end: true },
  hidden: { width: '4.75rem', end: true },
  latencyMs: { width: '5.75rem', end: true },
  client: { width: '8.5rem' },
}

export const LOG_COLUMN_COUNT = 8
