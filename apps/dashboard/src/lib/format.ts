// SPDX-License-Identifier: Apache-2.0
/** Number and time formatting in the user's locale. Formatters are built once. */

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 })
const timeOfDay = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

export function formatCount(n: number): string {
  return integer.format(n)
}

/** `part` of `whole` as a whole percentage; `–` when there is nothing to divide. */
export function formatShare(part: number, whole: number): string {
  return whole > 0 ? percent.format(part / whole) : '–'
}

export function formatLatency(ms: number): string {
  return ms >= 10_000 ? `${integer.format(Math.round(ms / 1000))} s` : `${integer.format(ms)} ms`
}

function parse(at: string): Date | null {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Time of day for today's rows, day and time for older ones. */
export function formatLogTime(at: string, now: Date = new Date()): string {
  const date = parse(at)
  if (!date) return at
  return date.toDateString() === now.toDateString() ? timeOfDay.format(date) : dayAndTime.format(date)
}

export function formatDateTime(at: string): string {
  const date = parse(at)
  return date ? full.format(date) : at
}

export function formatDate(at: string): string {
  const date = parse(at)
  return date ? dateOnly.format(date) : at
}
