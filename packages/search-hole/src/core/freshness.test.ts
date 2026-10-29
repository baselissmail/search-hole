// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Confidence, DateKind, FoundDate } from '../shared/types.ts'
import {
  ageDays,
  DAY_MS,
  datePair,
  effectiveDate,
  isPlausibleDate,
  isStale,
  isUpdated,
  judgeFreshness,
  parseDateMs,
} from './freshness.ts'

const NOW = Date.UTC(2026, 9, 30) // 2026-10-30T00:00:00Z

const date = (
  value: string,
  kind: DateKind = 'published',
  confidence: Confidence = 'medium',
  method = 'engine:x',
) => ({ value, kind, method, confidence, tzAssumed: false }) satisfies FoundDate

describe('parseDateMs', () => {
  it.each([
    ['2024-01-02', Date.UTC(2024, 0, 2)],
    ['2024-01', Date.UTC(2024, 0, 1)],
    ['2024', Date.UTC(2024, 0, 1)],
    ['2024-01-02T03:04:05Z', Date.UTC(2024, 0, 2, 3, 4, 5)],
    ['2024-01-02T03:04:05.678Z', Date.UTC(2024, 0, 2, 3, 4, 5, 678)],
    ['2024-01-02T03:04:05', Date.UTC(2024, 0, 2, 3, 4, 5)],
    ['2024-01-02T03:04', Date.UTC(2024, 0, 2, 3, 4)],
    ['2024-01-02T03:04:05+02:00', Date.UTC(2024, 0, 2, 1, 4, 5)],
    ['2024-01-02T03:04:05-0130', Date.UTC(2024, 0, 2, 4, 34, 5)],
    ['2024-02-29', Date.UTC(2024, 1, 29)],
    ['0099-01-01', new Date(0).setUTCFullYear(99, 0, 1)],
  ])('%s', (value, ms) => {
    expect(parseDateMs(value)).toBe(ms)
  })

  it.each([
    '',
    '2 days ago',
    'Tue, 02 Jan 2024',
    '2023-02-29',
    '2024-13-01',
    '2024-00-10',
    '2024-01-02T25:00',
    '2024-01-02T03:04:05+25:00',
    '24-01-02',
  ])('rejects %j', (value) => {
    expect(parseDateMs(value)).toBeNull()
  })

  it('does not depend on the local time zone (no-offset values are UTC)', () => {
    expect(parseDateMs('2024-06-01T12:00:00')).toBe(parseDateMs('2024-06-01T12:00:00Z'))
  })
})

describe('isPlausibleDate (ADR-0011 point 5)', () => {
  it('rejects dates before 1995-01-01 and more than one day ahead', () => {
    expect(isPlausibleDate('1994-12-31T23:59:59Z', NOW)).toBe(false)
    expect(isPlausibleDate('1995-01-01', NOW)).toBe(true)
    expect(isPlausibleDate('2026-10-31T00:00:00Z', NOW)).toBe(true)
    expect(isPlausibleDate('2026-10-31T00:00:01Z', NOW)).toBe(false)
    expect(isPlausibleDate('0099-01-01', NOW)).toBe(false)
    expect(isPlausibleDate('garbage', NOW)).toBe(false)
  })
})

describe('effectiveDate (ADR-0011 point 4)', () => {
  const pubOld = date('2022-11-01', 'published')
  const pubNew = date('2023-02-01', 'published')
  const mod = date('2025-03-01', 'modified', 'high', 'jsonld:dateModified')

  it('defaults to the earliest high/medium published date', () => {
    expect(effectiveDate([mod, pubNew, pubOld], undefined, NOW)).toEqual(pubOld)
    expect(effectiveDate([mod, pubNew, pubOld], 'published', NOW)).toEqual(pubOld)
  })

  it('falls back to the modified date when no published date is usable', () => {
    expect(effectiveDate([mod, date('2020-01-01', 'published', 'low')], 'published', NOW)).toEqual(mod)
  })

  it('basis modified: the latest modified date, else the published date', () => {
    const older = date('2024-01-01', 'modified')
    expect(effectiveDate([older, mod, pubOld], 'modified', NOW)).toEqual(mod)
    expect(effectiveDate([pubOld], 'modified', NOW)).toEqual(pubOld)
  })

  it('basis newest: the most recent usable date of either kind', () => {
    expect(effectiveDate([pubOld, mod], 'newest', NOW)).toEqual(mod)
    expect(effectiveDate([pubOld], 'newest', NOW)).toEqual(pubOld)
  })

  it('is unknown when only low-confidence, crawl or implausible dates exist', () => {
    const dates = [
      date('2026-01-01', 'modified', 'low', 'http:last-modified'),
      date('2026-01-01', 'crawled', 'high', 'engine:brave.page_fetched'),
      date('2026-01-01', 'existed_by', 'high', 'wayback:first'),
      date('2030-01-01', 'published', 'high'),
      date('1990-01-01', 'published', 'high'),
    ]
    for (const basis of ['published', 'modified', 'newest'] as const) {
      expect(effectiveDate(dates, basis, NOW)).toBeUndefined()
    }
    expect(effectiveDate([], undefined, NOW)).toBeUndefined()
  })

  it('prefers the higher confidence at the same instant, deterministically', () => {
    const medium = date('2024-01-01', 'published', 'medium', 'engine:a')
    const high = date('2024-01-01T00:00:00Z', 'published', 'high', 'jsonld:datePublished')
    expect(effectiveDate([medium, high], 'published', NOW)).toEqual(high)
    expect(effectiveDate([high, medium], 'published', NOW)).toEqual(high)
  })

  it('does not depend on input order', () => {
    const arb = fc.array(
      fc.record({
        value: fc.constantFrom(
          '2020-01-01',
          '2021-06-01',
          '2024-01-01T10:00:00Z',
          '2026-12-01',
          '1990-01-01',
        ),
        kind: fc.constantFrom<DateKind>('published', 'modified', 'crawled'),
        method: fc.constantFrom('a', 'b'),
        confidence: fc.constantFrom<Confidence>('high', 'medium', 'low'),
        tzAssumed: fc.boolean(),
      }),
      { maxLength: 6 },
    )
    fc.assert(
      fc.property(
        arb,
        fc.constantFrom('published', 'modified', 'newest') as fc.Arbitrary<'published'>,
        (ds, basis) => {
          expect(effectiveDate([...ds].reverse(), basis, NOW)).toEqual(effectiveDate(ds, basis, NOW))
        },
      ),
    )
  })
})

describe('staleness and updates', () => {
  it('isStale is strict: exactly maxAgeDays old is not stale', () => {
    const d = date(new Date(NOW - 30 * DAY_MS).toISOString())
    expect(ageDays(d, NOW)).toBe(30)
    expect(isStale(d, 30, NOW)).toBe(false)
    expect(isStale(d, 29, NOW)).toBe(true)
    expect(isStale(date('nope'), 1, NOW)).toBe(false)
  })

  it('isUpdated needs a usable modified date at least 30 days after the published date', () => {
    expect(isUpdated([date('2022-11-01'), date('2025-03-01', 'modified')], NOW)).toBe(true)
    expect(isUpdated([date('2025-02-15'), date('2025-03-01', 'modified')], NOW)).toBe(false)
    expect(isUpdated([date('2022-11-01'), date('2025-03-01', 'modified', 'low')], NOW)).toBe(false)
    expect(isUpdated([date('2025-03-01', 'modified')], NOW)).toBe(false)
  })

  it('datePair keeps the earliest published and the latest modified', () => {
    const pair = datePair(
      [
        date('2023-01-01'),
        date('2021-01-01'),
        date('2024-01-01', 'modified'),
        date('2025-01-01', 'modified'),
      ],
      NOW,
    )
    expect(pair.published?.value).toBe('2021-01-01')
    expect(pair.modified?.value).toBe('2025-01-01')
  })

  it('judgeFreshness combines them', () => {
    expect(judgeFreshness([date('2026-10-01')], { maxAgeDays: 90 }, NOW).status).toBe('fresh')
    expect(judgeFreshness([date('2020-10-01')], { maxAgeDays: 90 }, NOW).status).toBe('stale')
    expect(judgeFreshness([date('2020-10-01')], {}, NOW).status).toBe('fresh')
    expect(judgeFreshness([date('2020-10-01', 'published', 'low')], { maxAgeDays: 90 }, NOW)).toEqual({
      status: 'unknown',
      updated: false,
    })
    // An old page updated recently is fresh on basis `modified`, stale on `published`.
    const ds = [date('2020-01-01'), date('2026-10-01', 'modified')]
    expect(judgeFreshness(ds, { maxAgeDays: 90 }, NOW)).toMatchObject({ status: 'stale', updated: true })
    expect(judgeFreshness(ds, { maxAgeDays: 90, basis: 'modified' }, NOW).status).toBe('fresh')
  })
})
