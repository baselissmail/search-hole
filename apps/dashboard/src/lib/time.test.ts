// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { formatAgo, formatRelative, isPast } from './time.ts'

const now = new Date(2026, 10, 1, 12, 0, 0) // 1 Nov 2026, 12:00 local
const later = (ms: number) => new Date(now.getTime() + ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatRelative', () => {
  it('words times around now', () => {
    expect(formatRelative(later(-20_000), now, 'en')).toBe('just now')
    expect(formatRelative(later(20_000), now, 'en')).toBe('in a moment')
    expect(formatRelative(later(-5 * MIN), now, 'en')).toBe('5 minutes ago')
    expect(formatRelative(later(3 * HOUR), now, 'en')).toBe('in 3 hours')
    expect(formatRelative(later(-26 * HOUR), now, 'en')).toBe('yesterday')
    expect(formatRelative(later(6 * DAY), now, 'en')).toBe('in 6 days')
    expect(formatRelative(later(-45 * DAY), now, 'en')).toBe('last month')
    expect(formatRelative(later(-800 * DAY), now, 'en')).toBe('2 years ago')
  })

  it('reads a date without a time as a calendar day', () => {
    expect(formatRelative('2026-11-01', now, 'en')).toBe('today')
    expect(formatRelative('2026-10-31', now, 'en')).toBe('yesterday')
    expect(formatRelative('2026-10-29', now, 'en')).toBe('3 days ago')
    expect(formatRelative('2026-11-08', now, 'en')).toBe('in 7 days')
  })

  it('returns anything unreadable as it came', () => {
    expect(formatRelative('not a time', now, 'en')).toBe('not a time')
  })
})

describe('isPast', () => {
  it('compares instants and calendar days', () => {
    expect(isPast(later(-1), now)).toBe(true)
    expect(isPast(later(HOUR), now)).toBe(false)
    expect(isPast('2026-11-01', now)).toBe(true)
    expect(isPast('2026-11-02', now)).toBe(false)
    expect(isPast('garbage', now)).toBe(false)
  })
})

describe('formatAgo', () => {
  it('never puts a past event in the future', () => {
    expect(formatAgo(later(-3 * HOUR), now, 'en')).toBe('3 hours ago')
    expect(formatAgo(later(40_000), now, 'en')).toBe('just now')
    expect(formatAgo(later(5 * MIN), now, 'en')).toBe('just now')
    expect(formatAgo('2026-10-31', now, 'en')).toBe('yesterday')
  })
})
