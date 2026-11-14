// SPDX-License-Identifier: Apache-2.0
/**
 * The Review card rendered to static markup (no DOM, no browser): what each state shows, that
 * every action has a name a screen reader can tell apart, and that text from the web stays text.
 * Clicking, Undo and focus are covered by lib/reviewActions.test.ts and the browser e2e.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReviewList } from '../../lib/contract.ts'
import { keys } from '../../lib/queries.ts'
import { Review, reviewSummary } from './Review.tsx'

const HOUR = 3_600_000

function sample(over: Partial<ReviewList> = {}): ReviewList {
  return {
    days: 30,
    minSearches: 3,
    total: 3,
    sites: [
      {
        domain: 'geeksforgeeks.org',
        searches: 9,
        results: 14,
        lastSeen: new Date(Date.now() - 2 * HOUR).toISOString(),
        sourceType: 'blog',
        examples: [
          { url: 'https://www.geeksforgeeks.org/react-compiler/', title: 'React Compiler explained' },
          { url: 'https://www.geeksforgeeks.org/node-sqlite/' },
        ],
      },
      {
        domain: 'brave-only.example',
        searches: 5,
        results: 5,
        lastSeen: new Date(Date.now() - 30 * HOUR).toISOString(),
        sourceType: 'unknown',
        examples: [],
      },
      {
        domain: 'evil.example',
        searches: 3,
        results: 1,
        lastSeen: new Date(Date.now() - 50 * HOUR).toISOString(),
        sourceType: 'content_farm',
        examples: [{ url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)> Free prizes' }],
      },
    ],
    dismissed: [],
    ...over,
  }
}

/** Renders the card with the review query already answered, pending, or failed. */
async function render(state: ReviewList | 'pending' | Error): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  if (state instanceof Error) {
    await client.prefetchQuery({ queryKey: keys.review, queryFn: () => Promise.reject(state) })
  } else if (state !== 'pending') {
    client.setQueryData(keys.review, state)
  }
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Review)))
}

/** The markup of one site's row. */
function row(html: string, domain: string): string {
  const start = html.indexOf(`data-review-site="${domain}"`)
  if (start < 0) throw new Error(`no row for ${domain}`)
  const next = html.indexOf('data-review-site="', start + 1)
  return html.slice(start, next < 0 ? undefined : next)
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('Review card', () => {
  it('lists each site with its counts, source type, pages and three named actions', async () => {
    const html = await render(sample())
    expect(html).toContain('aria-label="Sites to review"')
    expect(text(html)).toContain(
      '3 sites appeared in 3 or more searches in the last 30 days, and the assistant never opened a page from them.',
    )
    const first = row(html, 'geeksforgeeks.org')
    expect(text(first)).toContain('geeksforgeeks.org 9 searches · 14 results · Blog · last seen')
    expect(first).toMatch(/<time dateTime="\d{4}-\d\d-\d\dT[^"]+Z" title="[^"]+">/)
    expect(text(first)).toContain('React Compiler explained')
    expect(first).toContain('href="https://www.geeksforgeeks.org/react-compiler/"')
    expect(first).toContain('href="https://www.geeksforgeeks.org/node-sqlite/"')
    for (const site of ['geeksforgeeks.org', 'brave-only.example', 'evil.example']) {
      const r = row(html, site)
      for (const verb of ['Block', 'Lower', 'Keep']) {
        expect(r, `${verb} ${site}`).toContain(`aria-label="${verb} ${site}"`)
      }
      // Real buttons, reachable with Tab, none disabled while nothing is in flight.
      expect(r.match(/<button type="button"/g)).toHaveLength(3)
      expect(r).not.toContain(' disabled=""')
    }
    // Sites are headings under the card's own heading, so a screen reader can jump between them.
    expect(html).toMatch(/<h2 id="review-title"[^>]*>Review<\/h2>/)
    expect(html.match(/<h3 /g)).toHaveLength(3)
  })

  it('says so when no title or URL is stored for a site (a decisions-only engine)', async () => {
    const r = row(await render(sample()), 'brave-only.example')
    expect(text(r)).toContain('5 searches · 5 results · Unknown')
    expect(text(r)).toContain(
      'No titles or URLs are stored for this site: the engine that returned it keeps only the decision.',
    )
    expect(r).not.toContain('<a ')
  })

  it('renders web text as text: markup is escaped and a javascript: URL is not a link', async () => {
    const html = await render(sample())
    const r = row(html, 'evil.example')
    expect(r).toContain('&lt;img src=x onerror=alert(1)&gt; Free prizes')
    expect(html).not.toContain('<img')
    expect(r).not.toContain('href="javascript:')
    expect(r).not.toContain('<a ')
    expect(text(r)).toContain('3 searches · 1 result · Content farm')
  })

  it('has an empty state that says when a site shows up', async () => {
    const html = await render(sample({ total: 0, sites: [] }))
    expect(text(html)).toContain(
      'Nothing to review yet A site shows up here after it appears in 3 searches and the assistant never opens it.',
    )
    expect(html).not.toContain('aria-label="Sites to review"')
    expect(text(html)).toContain(
      'Sites that keep showing up in results while the assistant never opens them.',
    )
  })

  it('shows a labelled loading state, and an error with Retry', async () => {
    const pending = await render('pending')
    expect(pending).toContain('aria-busy="true"')
    expect(text(pending)).toContain('Loading the sites to review…')
    const failed = await render(new Error('The log could not be read.'))
    expect(failed).toContain('role="alert"')
    expect(text(failed)).toContain('The log could not be read. Retry')
  })

  it('lists kept sites behind a disclosure, each with a named way back', async () => {
    const html = await render(
      sample({
        dismissed: [
          { domain: 'stackoverflow.com', at: new Date(Date.now() - 5 * HOUR).toISOString() },
          { domain: 'developer.mozilla.org', at: new Date(Date.now() - 80 * HOUR).toISOString() },
        ],
      }),
    )
    expect(html).toMatch(/<details[^>]*><summary/)
    expect(text(html)).toContain('2 kept sites are not listed')
    expect(html).toContain('aria-label="Review stackoverflow.com again"')
    expect(html).toContain('aria-label="Review developer.mozilla.org again"')
    // Kept sites are shown even when nothing is left to review.
    const empty = await render(
      sample({ total: 0, sites: [], dismissed: [{ domain: 'only.example', at: new Date().toISOString() }] }),
    )
    expect(text(empty)).toContain('Nothing to review yet')
    expect(text(empty)).toContain('1 kept site is not listed')
    expect(await render(sample())).not.toContain('<details')
  })

  it('says how many more there are when the list was cut', async () => {
    const html = await render(sample({ total: 240 }))
    expect(text(html)).toContain('Showing the 3 most-seen of 240 .')
    expect(text(await render(sample()))).not.toContain('most-seen')
  })
})

describe('reviewSummary', () => {
  it('uses the singular for one site and one day', () => {
    expect(reviewSummary(sample({ total: 1, days: 1 }))).toBe(
      '1 site appeared in 3 or more searches in the last 1 day, and the assistant never opened a page from it.',
    )
    expect(reviewSummary(undefined)).toBe(
      'Sites that keep showing up in results while the assistant never opens them.',
    )
  })
})
