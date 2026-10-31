// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { cardModel, fallbackCommand, readPanelData, safeHttpUrl, siteOf } from './model.ts'

const receipt = {
  receiptId: 'rcpt_A',
  startedAt: '2026-10-31T10:00:00.000Z',
  searches: [
    {
      query: 'a',
      at: 'x',
      mode: 'builtin' as const,
      engines: [],
      kept: 5,
      hidden: 2,
      hiddenByReason: { rule: 2 },
    },
    {
      query: 'b',
      at: 'x',
      mode: 'engines' as const,
      engines: ['searxng'],
      kept: 8,
      hidden: 1,
      hiddenByReason: { stale: 1 },
    },
  ],
  sources: [
    {
      url: 'https://react.dev/learn',
      dates: [],
      sourceType: 'official' as const,
      freshness: 'fresh' as const,
    },
    {
      url: 'https://www.w3schools.com/x',
      dates: [],
      sourceType: 'blog' as const,
      freshness: 'stale' as const,
    },
  ],
  warnings: [],
  summaryLine: 's',
}

describe('readPanelData', () => {
  it('prefers _meta, falls back to structuredContent, and ignores junk', () => {
    const meta = {
      receipts: [receipt],
      blockable: [{ site: 'w3schools.com', token: 't' }],
      suggestions: [],
      host: 'claude-desktop',
    }
    expect(readPanelData({ _meta: { 'search-hole/panel': meta } })?.blockable).toEqual(meta.blockable)
    expect(readPanelData({ structuredContent: { receipts: [receipt] } })).toMatchObject({
      blockable: [],
      host: 'generic',
    })
    expect(readPanelData(null)).toBeNull()
    expect(readPanelData({ _meta: { 'search-hole/panel': 'nope' } })).toBeNull()
  })
})

describe('cardModel', () => {
  it('counts searches, kept, hidden with the top reason, opened, official and stale', () => {
    const m = cardModel({ receipts: [receipt], blockable: [], suggestions: [], host: 'generic' })
    expect(m).toMatchObject({
      searches: 2,
      builtin: 1,
      kept: 13,
      hidden: 3,
      topHiddenReason: 'rule',
      opened: 2,
      official: 1,
      stale: 1,
    })
  })
})

describe('helpers', () => {
  it('maps a URL to its blockable site, words fallbacks per host, and keeps only http(s) links', () => {
    expect(siteOf('https://www.w3schools.com/x', [{ site: 'w3schools.com' }])).toBe('w3schools.com')
    expect(siteOf('https://evilw3schools.com/', [{ site: 'w3schools.com' }])).toBeUndefined()
    expect(fallbackCommand('claude-code', 'block', 'a.com')).toBe('/search-hole:block a.com')
    expect(fallbackCommand('claude-desktop', 'approve', '7')).toBe('searchhole approve 7')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('https://a.com/x')).toBe('https://a.com/x')
  })
})
