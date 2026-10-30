// SPDX-License-Identifier: Apache-2.0
/**
 * Read queries for the search log as the CLI and receipts show it. A search's mode is
 * derived from its engine runs: built-in WebSearch rows are recorded with the single
 * pseudo-engine `builtin` (see `planBuiltinRecord`), so no column was needed for it.
 */
import type { Db } from '../driver.ts'
import type { SearchLogRow } from '../types.ts'
import { SEARCH_COLUMNS, toSummary } from './searches.ts'

/** The pseudo-engine id of Claude Code's built-in WebSearch rows. */
export const BUILTIN_ENGINE = 'builtin'

const PREFIXED = SEARCH_COLUMNS.split(',')
  .map((c) => `s.${c.trim()}`)
  .join(', ')

function toLogRow(raw: unknown): SearchLogRow {
  const summary = toSummary(raw)
  const client =
    typeof raw === 'object' && raw !== null && 'client_name' in raw
      ? (raw as { client_name: unknown }).client_name
      : null
  return {
    ...summary,
    mode: summary.engines.some((e) => e.engine === BUILTIN_ENGINE) ? 'builtin' : 'engines',
    clientName: typeof client === 'string' ? client : null,
  }
}

/** Newest searches first, with the session's client name. */
export function listRecentSearches(db: Db, limit: number, hiddenOnly: boolean): SearchLogRow[] {
  const where = hiddenOnly ? 'WHERE s.hidden_count > 0' : ''
  return db
    .prepare(
      `SELECT ${PREFIXED}, ss.client_name AS client_name FROM searches s
         LEFT JOIN sessions ss ON ss.id = s.session_id ${where}
        ORDER BY s.id DESC LIMIT ?`,
    )
    .all([limit])
    .map(toLogRow)
}

/** One search with its client name. */
export function getSearchLog(db: Db, id: number): SearchLogRow | undefined {
  const raw = db
    .prepare(
      `SELECT ${PREFIXED}, ss.client_name AS client_name FROM searches s
         LEFT JOIN sessions ss ON ss.id = s.session_id WHERE s.id = ?`,
    )
    .get([id])
  return raw === undefined ? undefined : toLogRow(raw)
}

/** Every search of a receipt, oldest first. */
export function listSearchesByReceipt(db: Db, receiptId: string): SearchLogRow[] {
  return db
    .prepare(
      `SELECT ${PREFIXED}, ss.client_name AS client_name FROM searches s
         LEFT JOIN sessions ss ON ss.id = s.session_id WHERE s.receipt_id = ? ORDER BY s.id ASC`,
    )
    .all([receiptId])
    .map(toLogRow)
}

/** Hidden-result counts by reason for each search id. */
export function hiddenReasonCounts(
  db: Db,
  searchIds: readonly number[],
): Map<number, Record<string, number>> {
  const out = new Map<number, Record<string, number>>()
  if (searchIds.length === 0) return out
  const ids = searchIds.filter((n) => Number.isInteger(n)).slice(0, 500)
  if (ids.length === 0) return out
  const rows = db
    .prepare<{ search_id: number; reason: string | null; n: number }>(
      `SELECT search_id, reason, COUNT(*) AS n FROM results
        WHERE decision = 'hidden' AND search_id IN (${ids.map(() => '?').join(',')})
        GROUP BY search_id, reason`,
    )
    .all(ids)
  for (const r of rows) {
    const rec = out.get(r.search_id) ?? {}
    const key = r.reason ?? 'rule'
    rec[key] = (rec[key] ?? 0) + r.n
    out.set(r.search_id, rec)
  }
  return out
}
