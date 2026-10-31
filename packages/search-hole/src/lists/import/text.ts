// SPDX-License-Identifier: Apache-2.0
/**
 * Text helpers for the importers: line iteration under the byte cap, UTF-8
 * sizes, header comments and `Expires` values.
 */
import type { ListHeader } from './types.ts'

/** UTF-8 length of `s` (a lone surrogate counts as the 3-byte replacement character). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Iterates the lines of a list: `fn(line, 1-based number)`. */
export type EachLine = (fn: (line: string, n: number) => void) => void

/**
 * Calls `fn(line, number)` for each line (`\n`, `\r\n` or `\r` endings, a
 * leading BOM dropped) until the lines read would exceed `maxBytes`.
 */
export function forEachLine(
  text: string,
  maxBytes: number,
  fn: (line: string, n: number) => void,
): { lines: number; truncated: boolean } {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const counting = s.length * 3 > maxBytes
  let bytes = 0
  let n = 0
  let at = 0
  while (at < s.length) {
    let end = at
    while (end < s.length) {
      const c = s.charCodeAt(end)
      if (c === 10 || c === 13) break
      end++
    }
    const line = s.slice(at, end)
    if (counting) {
      bytes += utf8Length(line) + 1
      if (bytes > maxBytes) return { lines: n, truncated: true }
    }
    n++
    fn(line, n)
    at = end + (s.charCodeAt(end) === 13 && s.charCodeAt(end + 1) === 10 ? 2 : 1)
  }
  return { lines: n, truncated: false }
}

const HEADER_FIELDS: Readonly<Record<string, keyof ListHeader>> = {
  title: 'title',
  name: 'title',
  description: 'description',
  license: 'license',
  licence: 'license',
  homepage: 'homepage',
  expires: 'expires',
  version: 'version',
  lastmodified: 'lastModified',
  updated: 'lastModified',
  author: 'author',
  transferredto: 'transferredTo',
}

/**
 * Reads one `Key: value` header comment (the text after `!` or `#`) into
 * `header`; the first value wins. Values starting with `%` are unfilled
 * template placeholders and are ignored. Returns true when a field was read.
 */
export function readHeaderComment(comment: string, header: ListHeader): boolean {
  const m = /^\s*([A-Za-z][A-Za-z _-]{0,30}?)\s*:\s*(.*?)\s*$/.exec(comment)
  return m ? setHeaderField(m[1] ?? '', m[2] ?? '', header) : false
}

/** Sets a header field by its (case- and separator-insensitive) name; the first value wins. */
export function setHeaderField(name: string, value: string, header: ListHeader): boolean {
  const field = HEADER_FIELDS[name.toLowerCase().replace(/[\s_-]/g, '')]
  const v = value.trim()
  if (!field || v === '' || v.startsWith('%')) return false
  if (header[field] === undefined) header[field] = v.slice(0, 500)
  return true
}

const UNIT_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

/**
 * Parses a list `Expires` value (`4 days (update frequency)`, `12h`, `1w`; a
 * bare number is days) into milliseconds, or null. Floors (uBlock uses 4 hours)
 * are the caller's choice.
 */
export function expiresToMs(value: string): number | null {
  const m = /^\s*(\d{1,6})\s*([a-z]*)/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? '').toLowerCase()
  const ms = unit === '' ? UNIT_MS.d : UNIT_MS[unit]
  return n > 0 && ms !== undefined ? n * ms : null
}
