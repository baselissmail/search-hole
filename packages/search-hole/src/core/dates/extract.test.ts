// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BODY_SCAN_LIMIT, extractPageDates } from './extract.ts'
import { jsonLdDateCandidates } from './jsonld.ts'

const NOW = Date.UTC(2026, 9, 30, 12)
const ctx = { url: 'https://example.com/page', fetchedAt: NOW }

describe('extractPageDates', () => {
  it('scans the whole head plus only the first 512 KiB of body', () => {
    const filler = `<p>${'lorem ipsum '.repeat(1000)}</p>`
    const pad = filler.repeat(Math.ceil((BODY_SCAN_LIMIT + 64 * 1024) / filler.length))
    const html = `<html><head><meta name="date" content="2020-01-01"></head><body>${pad}<article><time datetime="2021-01-01">x</time></article><span itemprop="datePublished" content="2022-02-02"></span></body></html>`
    const dates = extractPageDates(html, ctx)
    expect(dates.map((d) => d.method)).toEqual(['meta:date'])
  })

  it('still reads an article <time> early in the body', () => {
    const html = `<html><head></head><body><article><time datetime="2021-01-01">x</time></article>${'x'.repeat(BODY_SCAN_LIMIT * 2)}</body></html>`
    expect(extractPageDates(html, ctx).map((d) => d.method)).toEqual(['time:datetime'])
  })

  it('handles fragments without head or body', () => {
    const html = '<meta property="article:published_time" content="2020-05-05T05:05:05Z">'
    expect(extractPageDates(html, ctx)).toEqual([
      {
        value: '2020-05-05T05:05:05.000Z',
        kind: 'published',
        method: 'og:article:published_time',
        confidence: 'high',
        tzAssumed: false,
      },
    ])
  })

  it('drops exact duplicates but keeps corroborating sources', () => {
    const html = `<head>
      <meta property="article:published_time" content="2020-05-05T05:05:05Z">
      <meta property="article:published_time" content="2020-05-05T07:05:05+02:00">
      <meta name="date" content="2020-05-05T05:05:05Z">
    </head>`
    expect(extractPageDates(html, ctx).map((d) => d.method)).toEqual([
      'og:article:published_time',
      'meta:date',
    ])
  })

  it('works on an empty document (URL and Last-Modified only)', () => {
    const dates = extractPageDates('', {
      url: 'https://example.com/2024/01/02/x',
      fetchedAt: NOW,
      httpLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    })
    expect(dates.map((d) => [d.method, d.value])).toEqual([
      ['url-path', '2024-01-02T00:00:00.000Z'],
      ['http:last-modified', '2024-01-01T00:00:00.000Z'],
    ])
  })

  it('ignores a Last-Modified within 5 minutes either side of the fetch', () => {
    const lm = (ms: number) => new Date(ms).toUTCString()
    const at = (ms: number) =>
      extractPageDates('', { url: ctx.url, fetchedAt: NOW, httpLastModified: lm(ms) })
    expect(at(NOW - 4 * 60_000)).toEqual([])
    expect(at(NOW + 4 * 60_000)).toEqual([])
    expect(at(NOW - 6 * 60_000)).toHaveLength(1)
  })

  it('property: never throws on arbitrary markup, every date is valid and in range', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.string({ maxLength: 40 }), (markup, value) => {
        const html = `<head><meta name="date" content="${value}">${markup}</head><body>${markup}</body>`
        const dates = extractPageDates(html, ctx)
        return dates.every(
          (d) =>
            d.value.endsWith('Z') &&
            Date.parse(d.value) >= Date.UTC(1995, 0, 1) &&
            Date.parse(d.value) <= NOW + 86_400_000,
        )
      }),
    )
  })
})

describe('jsonLdDateCandidates', () => {
  it('accepts prefixed and array types, and @value objects', () => {
    const out = jsonLdDateCandidates(
      JSON.stringify({
        '@type': ['schema:Thing', 'schema:ScholarlyArticle'],
        datePublished: { '@value': '2020-01-01' },
      }),
    )
    expect(out).toEqual([{ raw: '2020-01-01', kind: 'published', method: 'jsonld:datePublished', rank: 0 }])
  })

  it('ignores unlisted types and nested non-entity dates', () => {
    const out = jsonLdDateCandidates(
      JSON.stringify({
        '@type': 'Product',
        datePublished: '2020-01-01',
        review: { '@type': 'Article', datePublished: '2021-01-01' },
      }),
    )
    expect(out).toEqual([])
  })

  it('returns nothing for invalid JSON and survives deep nesting', () => {
    expect(jsonLdDateCandidates('{')).toEqual([])
    let deep: unknown = { '@type': 'Article', datePublished: '2020-01-01' }
    for (let i = 0; i < 50; i++) deep = { '@graph': [deep] }
    expect(jsonLdDateCandidates(JSON.stringify(deep))).toEqual([])
  })
})
