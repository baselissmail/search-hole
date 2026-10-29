// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { engineDate, parseEngineDate } from './dates.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')

describe('parseEngineDate', () => {
  it('takes a date without a timezone as UTC and marks it', () => {
    expect(parseEngineDate('2024-05-15T18:38:33', NOW)).toEqual({
      value: '2024-05-15T18:38:33.000Z',
      tzAssumed: true,
    })
    expect(parseEngineDate('2024-05-15 18:38:33', NOW)).toEqual({
      value: '2024-05-15T18:38:33.000Z',
      tzAssumed: true,
    })
    expect(parseEngineDate('2024-05-15', NOW)).toEqual({ value: '2024-05-15T00:00:00.000Z', tzAssumed: true })
  })

  it('applies explicit offsets and does not mark them', () => {
    expect(parseEngineDate('2025-10-07T00:00:00Z', NOW)).toEqual({
      value: '2025-10-07T00:00:00.000Z',
      tzAssumed: false,
    })
    expect(parseEngineDate('2025-10-07T12:00:00+02:00', NOW)).toEqual({
      value: '2025-10-07T10:00:00.000Z',
      tzAssumed: false,
    })
    expect(parseEngineDate('2025-10-07T12:00:00-0530', NOW)).toEqual({
      value: '2025-10-07T17:30:00.000Z',
      tzAssumed: false,
    })
    expect(parseEngineDate('2025-10-07T12:00:00.250Z', NOW)?.value).toBe('2025-10-07T12:00:00.250Z')
  })

  it('parses RFC 2822', () => {
    expect(parseEngineDate('Tue, 07 Oct 2025 16:21:03 GMT', NOW)).toEqual({
      value: '2025-10-07T16:21:03.000Z',
      tzAssumed: false,
    })
    expect(parseEngineDate('7 Oct 2025 16:21 +0200', NOW)?.value).toBe('2025-10-07T14:21:00.000Z')
  })

  it('rejects natural language, impossible dates, the far past and the future', () => {
    for (const bad of [
      '2 days ago',
      'yesterday',
      '',
      'not a date',
      '2025-02-30',
      '2025-13-01',
      '2025-10-07T25:00:00',
      '1994-12-31',
    ]) {
      expect(parseEngineDate(bad, NOW)).toBeNull()
    }
    expect(parseEngineDate('2026-10-31T11:00:00Z', NOW)).not.toBeNull()
    expect(parseEngineDate('2026-11-02T00:00:00Z', NOW)).toBeNull()
    expect(parseEngineDate(42, NOW)).toBeNull()
    expect(parseEngineDate(null, NOW)).toBeNull()
  })

  it('never throws and only returns plausible UTC ISO strings', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseEngineDate(s, NOW)
        if (r) {
          expect(r.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          expect(Date.parse(r.value)).toBeLessThanOrEqual(NOW + 86_400_000)
        }
      }),
    )
  })
})

describe('engineDate', () => {
  it('produces a medium-confidence published date with the method', () => {
    expect(engineDate('2024-05-15T18:38:33', 'engine:searxng.publishedDate', NOW)).toEqual({
      value: '2024-05-15T18:38:33.000Z',
      kind: 'published',
      method: 'engine:searxng.publishedDate',
      confidence: 'medium',
      tzAssumed: true,
    })
    expect(engineDate('nope', 'engine:x', NOW)).toBeUndefined()
  })
})
