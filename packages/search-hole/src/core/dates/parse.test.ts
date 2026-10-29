// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FUTURE_TOLERANCE_MS, MIN_DATE_MS, parseStrictDate } from './parse.ts'
import { extractUrlDate } from './urlDates.ts'

const NOW = Date.UTC(2026, 9, 30, 12)
const p = (raw: string) => parseStrictDate(raw, { now: NOW })

describe('parseStrictDate', () => {
  it.each([
    ['2023-04-12T10:00:00Z', '2023-04-12T10:00:00.000Z', false],
    ['2023-04-12T10:00:00.123456+02:00', '2023-04-12T08:00:00.123Z', false],
    ['2023-04-12T10:00+0530', '2023-04-12T04:30:00.000Z', false],
    ['2023-04-12T10:00:00-07', '2023-04-12T17:00:00.000Z', false],
    ['2023-04-12 10:00:00', '2023-04-12T10:00:00.000Z', true],
    ['2023-04-12', '2023-04-12T00:00:00.000Z', true],
    ['Wed, 12 Apr 2023 10:00:00 GMT', '2023-04-12T10:00:00.000Z', false],
    ['12 Apr 2023 10:00 -0500', '2023-04-12T15:00:00.000Z', false],
    ['Wed, 12 Apr 2023 10:00:00 PDT', '2023-04-12T17:00:00.000Z', false],
    ['12 April 2023', '2023-04-12T00:00:00.000Z', true],
    ['April 12, 2023', '2023-04-12T00:00:00.000Z', true],
    ['Sept. 3rd, 2021', '2021-09-03T00:00:00.000Z', true],
    ['2023/04/12', '2023-04-12T00:00:00.000Z', true],
    ['2023.4.12', '2023-04-12T00:00:00.000Z', true],
    ['2023年4月12日', '2023-04-12T00:00:00.000Z', true],
    ['2023년 4월 12일 09:30', '2023-04-12T09:30:00.000Z', true],
  ])('parses %s', (raw, value, tzAssumed) => {
    expect(p(raw)).toMatchObject({ value, tzAssumed })
  })

  it.each([
    'yesterday',
    '2 days ago',
    '12/04/2023',
    '04/12/2023',
    '2023-02-30',
    '2023-13-01',
    '2023-04-12T24:00:00Z',
    '2023-04-12T10:60:00Z',
    '2023-04-12T10:00:00+15:00',
    '2023-04-12T10:00:00 CET',
    'Foo, 12 Apr 2023 10:00:00 GMT',
    '12 Smarch 2023',
    '2023',
    '2023-04',
    '1994-12-31T23:59:59Z',
    '2026-11-01T00:00:00Z',
    '',
    `2023-04-12${' '.repeat(100)}x`,
  ])('rejects %j', (raw) => {
    expect(p(raw)).toBeNull()
  })

  it('accepts up to one day in the future and nothing beyond', () => {
    expect(p('2026-10-31T11:59:59Z')).not.toBeNull()
    expect(p('2026-10-31T12:00:01Z')).toBeNull()
  })

  it('property: any instant in range round-trips through ISO with any offset', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_DATE_MS, max: NOW }),
        fc.integer({ min: -14 * 60, max: 14 * 60 }),
        (ms, offsetMin) => {
          const ms0 = Math.floor(ms / 1000) * 1000
          const local = new Date(ms0 + offsetMin * 60_000).toISOString().slice(0, 19)
          const sign = offsetMin < 0 ? '-' : '+'
          const abs = Math.abs(offsetMin)
          const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
          const parsed = p(`${local}${zone}`)
          if (ms0 < MIN_DATE_MS) return parsed === null
          return parsed !== null && parsed.ms === ms0 && parsed.tzAssumed === false
        },
      ),
    )
  })

  it('property: never throws, output is UTC ISO inside the plausible window', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const parsed = p(raw)
        if (parsed === null) return true
        return (
          parsed.value.endsWith('Z') &&
          parsed.ms >= MIN_DATE_MS &&
          parsed.ms <= NOW + FUTURE_TOLERANCE_MS &&
          new Date(parsed.value).getTime() === parsed.ms
        )
      }),
    )
  })
})

describe('extractUrlDate', () => {
  it.each([
    ['https://a.example/2023/04/12/slug', '2023-04-12T00:00:00.000Z', 'medium'],
    ['https://a.example/2023/4/2/', '2023-04-02T00:00:00.000Z', 'medium'],
    ['https://a.example/posts/2023-04-12-hello-world', '2023-04-12T00:00:00.000Z', 'medium'],
    ['https://a.example/blog/2023-04-12/', '2023-04-12T00:00:00.000Z', 'medium'],
    ['https://a.example/archive/2021/07/', '2021-07-01T00:00:00.000Z', 'low'],
  ])('%s', (url, value, confidence) => {
    expect(extractUrlDate(url, NOW)).toEqual({
      value,
      kind: 'published',
      method: 'url-path',
      confidence,
      tzAssumed: true,
    })
  })

  it.each([
    'https://a.example/2023/02/30/bad-day',
    'https://a.example/v2/1234/56/',
    'https://a.example/products/20230412',
    'https://a.example/1990/01/01/too-old',
    'https://a.example/2027/01/01/future',
    'https://a.example/?d=2023-04-12',
    'not a url',
  ])('no date in %s', (url) => {
    expect(extractUrlDate(url, NOW)).toBeNull()
  })

  it('property: /YYYY/MM/DD/ paths give that day', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_DATE_MS, max: NOW }), fc.webSegment(), (ms, slug) => {
        const d = new Date(ms)
        const y = d.getUTCFullYear()
        const m = String(d.getUTCMonth() + 1).padStart(2, '0')
        const day = String(d.getUTCDate()).padStart(2, '0')
        const found = extractUrlDate(`https://x.example/${y}/${m}/${day}/${slug}`, NOW)
        return found?.value === `${y}-${m}-${day}T00:00:00.000Z`
      }),
    )
  })
})
