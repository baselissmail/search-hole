// SPDX-License-Identifier: Apache-2.0
/**
 * Relative times ("in 6 days", "yesterday") with the exact time for tooltips. Only the Lists
 * view uses them, so they load with it rather than in the initial bundle.
 */
import { formatDate, formatDateTime } from './format.ts'

function parse(at: string): Date | null {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>()

function relativeFormat(locale: string | undefined): Intl.RelativeTimeFormat {
  const key = locale ?? ''
  let f = relativeFormats.get(key)
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    relativeFormats.set(key, f)
  }
  return f
}

/** Calendar days from `now`'s local day to `date`'s (negative in the past). */
function dayDiff(date: Date, now: Date): number {
  const a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / DAY)
}

/**
 * `at` relative to `now`: "5 minutes ago", "yesterday", "in 6 days". A date without a time
 * (`2026-10-31`) is a calendar day: "today", "yesterday". Within a minute: "just now" or
 * "in a moment".
 */
export function formatRelative(at: string, now: Date = new Date(), locale?: string): string {
  const rtf = relativeFormat(locale)
  const day = DATE_ONLY.exec(at)
  if (day) {
    const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    const days = dayDiff(date, now)
    if (Math.abs(days) < 30) return rtf.format(days, 'day')
    return relativeLarge(rtf, days)
  }
  const date = parse(at)
  if (!date) return at
  const diff = date.getTime() - now.getTime()
  const sign = diff < 0 ? -1 : 1
  const abs = Math.abs(diff)
  if (abs < MINUTE) return sign < 0 ? 'just now' : 'in a moment'
  const minutes = Math.round(abs / MINUTE)
  if (minutes < 60) return rtf.format(sign * minutes, 'minute')
  const hours = Math.round(abs / HOUR)
  if (hours < 24) return rtf.format(sign * hours, 'hour')
  const days = Math.round(abs / DAY)
  if (days < 30) return rtf.format(sign * days, 'day')
  return relativeLarge(rtf, sign * days)
}

function relativeLarge(rtf: Intl.RelativeTimeFormat, days: number): string {
  const months = Math.round(Math.abs(days) / 30.44)
  if (months < 12) return rtf.format(Math.sign(days) * Math.max(1, months), 'month')
  return rtf.format(Math.sign(days) * Math.round(Math.abs(days) / 365.25), 'year')
}

/** The exact time for a tooltip: the date alone for a date without a time. */
export function formatExact(at: string): string {
  return DATE_ONLY.test(at) ? formatDate(`${at}T12:00:00`) : formatDateTime(at)
}

/** True when `at` is at or before `now`. */
export function isPast(at: string, now: Date = new Date()): boolean {
  const day = DATE_ONLY.exec(at)
  if (day) return dayDiff(new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])), now) <= 0
  const date = parse(at)
  return date !== null && date.getTime() <= now.getTime()
}

/**
 * A moment that has happened (a download, a check), relative to `now`. `now` may lag a little
 * behind the data (it ticks once a minute), so a time just after it is "just now", never "in a
 * moment".
 */
export function formatAgo(at: string, now: Date = new Date(), locale?: string): string {
  return DATE_ONLY.test(at) || isPast(at, now) ? formatRelative(at, now, locale) : 'just now'
}
