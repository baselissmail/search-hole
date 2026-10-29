// SPDX-License-Identifier: Apache-2.0
/**
 * URL path dates (ADR-0011 row 6): `/2023/04/12/`, `/2023-04-12-slug`, and
 * month-only `/2023/04/`. Day precision is medium confidence, month-only low.
 * Pure.
 */
import type { FoundDate } from '../../shared/types.ts'
import { isPlausibleDate } from './parse.ts'

const DAY_SLASH_RE = /(?:^|\/)((?:19|20)\d{2})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?=$|[/_.-])/
const DAY_DASH_RE = /(?:^|[/_-])((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?=$|[/_.-])/
const MONTH_RE = /(?:^|\/)((?:19|20)\d{2})\/(0[1-9]|1[0-2])(?=$|\/)/

function dayMs(y: number, mo: number, d: number): number | null {
  const ms = Date.UTC(y, mo - 1, d)
  const check = new Date(ms)
  return check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? ms : null
}

function safePath(url: string): string | null {
  try {
    const path = new URL(url).pathname
    try {
      return decodeURIComponent(path)
    } catch {
      return path
    }
  } catch {
    return null
  }
}

/**
 * Returns at most one date found in the URL path, as a `published` date with
 * `method: 'url-path'`. `now` bounds the future-date check.
 */
export function extractUrlDate(url: string, now: number): FoundDate | null {
  const path = safePath(url)
  if (path === null) return null
  const day = DAY_SLASH_RE.exec(path) ?? DAY_DASH_RE.exec(path)
  if (day) {
    const ms = dayMs(Number(day[1]), Number(day[2]), Number(day[3]))
    if (ms !== null && isPlausibleDate(ms, now)) {
      return {
        value: new Date(ms).toISOString(),
        kind: 'published',
        method: 'url-path',
        confidence: 'medium',
        tzAssumed: true,
      }
    }
    return null
  }
  const month = MONTH_RE.exec(path)
  if (month) {
    const ms = dayMs(Number(month[1]), Number(month[2]), 1)
    if (ms !== null && isPlausibleDate(ms, now)) {
      return {
        value: new Date(ms).toISOString(),
        kind: 'published',
        method: 'url-path',
        confidence: 'low',
        tzAssumed: true,
      }
    }
  }
  return null
}
