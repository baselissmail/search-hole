// SPDX-License-Identifier: Apache-2.0
/** Page and value date parsing (ADR-0011). Pure. */
export {
  BODY_SCAN_LIMIT,
  extractPageDates,
  LAST_MODIFIED_IGNORE_WINDOW_MS,
  type PageDateContext,
} from './extract.ts'
export { type JsonLdCandidate, jsonLdDateCandidates } from './jsonld.ts'
export {
  FUTURE_TOLERANCE_MS,
  isPlausibleDate,
  MIN_DATE_MS,
  type ParseDateOptions,
  type ParsedDate,
  parseStrictDate,
} from './parse.ts'
export { extractUrlDate } from './urlDates.ts'
