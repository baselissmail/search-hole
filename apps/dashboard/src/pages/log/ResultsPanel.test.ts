// SPDX-License-Identifier: Apache-2.0
/**
 * The results panel rendered to static markup: every result says Opened, Seen or Hidden
 * (ADR-0025), and the header counts what the assistant opened of what it was shown.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LogDetail, LogEntry, LogResult } from '../../lib/contract.ts'
import { type DetailState, openedSummary, ResultsPanel } from './ResultsPanel.tsx'

const entry: LogEntry = {
  searchId: 12,
  receiptId: 'rcpt_b',
  at: '2026-10-30T14:02:11.000Z',
  query: 'react compiler',
  profile: 'coding',
  depth: 'standard',
  mode: 'engines',
  engines: ['searxng'],
  kept: 3,
  hidden: 1,
  latencyMs: 812,
}

const results: LogResult[] = [
  {
    rank: 1,
    engine: 'searxng',
    domain: 'react.dev',
    url: 'https://react.dev/learn/react-compiler',
    title: 'React Compiler',
    decision: 'pinned',
    opened: true,
  },
  {
    rank: 2,
    engine: 'searxng',
    domain: 'geeksforgeeks.org',
    url: 'https://www.geeksforgeeks.org/react-compiler/',
    title: 'React Compiler explained',
    decision: 'kept',
    opened: false,
  },
  { rank: 3, engine: 'brave', domain: 'brave-only.example', decision: 'kept', opened: false },
  {
    rank: 2,
    engine: 'searxng',
    domain: 'pinterest.com',
    url: 'https://pinterest.com/pin/123',
    title: 'Pin 123',
    decision: 'hidden',
    opened: false,
    reason: 'rule',
  },
]

function render(detail: Partial<DetailState>): string {
  const state: DetailState = { status: 'success', data: undefined, error: null, retry: () => {}, ...detail }
  return renderToStaticMarkup(
    createElement(ResultsPanel, {
      entry,
      detail: state,
      selectedPosition: undefined,
      onSelect: () => {},
      onVerb: () => {},
    }),
  )
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The decision cell (4th) of each result row, as text. */
function decisions(html: string): string[] {
  const body = html.slice(html.indexOf('<tbody>'))
  return body
    .split('<tr ')
    .slice(1)
    .map((tr) => text(`<td ${tr.split('<td ')[4] ?? ''}`))
}

describe('ResultsPanel', () => {
  const data: LogDetail = { ...entry, opened: 1, results }

  it('labels every result Opened, Seen or Hidden', () => {
    const html = render({ data })
    expect(decisions(html)).toEqual(['Pinned Opened', 'Kept Seen', 'Kept Seen', 'Hidden'])
    // Each mark explains itself on hover, and is a word next to an icon, never colour alone.
    expect(html).toContain('title="The assistant opened this page in the same session"')
    expect(html).toContain('title="In the results the assistant got; it did not open this page"')
    expect(html.match(/lucide-book-open-check/g)).toHaveLength(1)
    expect(html.match(/lucide-eye /g)).toHaveLength(2)
  })

  it('counts what was opened of what was shown in the header', () => {
    const html = render({ data })
    expect(text(html)).toContain('4 results · 1 hidden · 1 pinned · opened 1 of 3')
    const none = render({ data: { ...data, results: results.map((r) => ({ ...r, opened: false })) } })
    expect(text(none)).toContain('opened 0 of 3')
    expect(decisions(none)).toEqual(['Pinned Seen', 'Kept Seen', 'Kept Seen', 'Hidden'])
  })

  it('shows no count while loading, on an error, or for a search without results', () => {
    expect(text(render({ status: 'pending' }))).not.toContain('opened')
    expect(text(render({ status: 'error', error: new Error('nope') }))).not.toContain('opened')
    expect(text(render({ data: { ...data, results: [] } }))).toContain('opened 0 of 0')
  })
})

describe('openedSummary', () => {
  it('leaves hidden results out of both numbers, even one wrongly flagged as opened', () => {
    expect(openedSummary(results)).toEqual({ opened: 1, shown: 3 })
    expect(openedSummary([{ ...(results[3] as LogResult), opened: true }])).toEqual({ opened: 0, shown: 0 })
    expect(openedSummary([])).toEqual({ opened: 0, shown: 0 })
  })
})
