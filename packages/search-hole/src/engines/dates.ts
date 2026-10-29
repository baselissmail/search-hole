// SPDX-License-Identifier: Apache-2.0
/**
 * Engine-supplied dates (ADR-0011 chain row 1). Parsing is delegated to core/dates so the
 * whole product shares one strict parser: ISO 8601 and RFC 2822 plus a short list of
 * explicit formats, never natural language ("2 days ago"). A date without a timezone is
 * taken as UTC and marked `tzAssumed`; dates before 1995-01-01 or more than a day in the
 * future are rejected. The clock is passed in, never read.
 */

import { parseStrictDate } from '../core/dates/parse.ts'
import type { DateKind, FoundDate } from '../shared/types.ts'

/**
 * Parses an engine date string into normalised UTC ISO form.
 * Returns null for anything that is not a plausible, strictly formatted date.
 */
export function parseEngineDate(raw: unknown, now: number): { value: string; tzAssumed: boolean } | null {
  if (typeof raw !== 'string') return null
  const parsed = parseStrictDate(raw, { now })
  return parsed ? { value: parsed.value, tzAssumed: parsed.tzAssumed } : null
}

/**
 * Wraps a raw engine date as a FoundDate. Engine dates are medium confidence until the
 * P1 corpus measures them (ADR-0011 row 1).
 */
export function engineDate(
  raw: unknown,
  method: string,
  now: number,
  kind: DateKind = 'published',
): FoundDate | undefined {
  const parsed = parseEngineDate(raw, now)
  if (!parsed) return undefined
  return { value: parsed.value, kind, method, confidence: 'medium', tzAssumed: parsed.tzAssumed }
}
