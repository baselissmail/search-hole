// SPDX-License-Identifier: Apache-2.0
/**
 * Read queries for the search log as the CLI and receipts show it. A search's mode is
 * derived from its engine runs: built-in WebSearch rows are recorded with the single
 * pseudo-engine `builtin` (see `planBuiltinRecord`), so no column was needed for it.
 */
import type { Db } from '../driver.ts'
import type { SearchLogRow, SearchOverview } from '../types.ts'
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

/**
 * Newest searches first, with the session's client name. `beforeId` pages back in time and
 * `afterId` keeps only newer rows (both exclusive keyset cursors on `searches.id`).
 */
export function listRecentSearches(
  db: Db,
  limit: number,
  hiddenOnly: boolean,
  cursor: { beforeId?: number; afterId?: number } = {},
): SearchLogRow[] {
  const where: string[] = []
  const args: number[] = []
  if (hiddenOnly) where.push('s.hidden_count > 0')
  if (cursor.beforeId !== undefined) {
    where.push('s.id < ?')
    args.push(cursor.beforeId)
  }
  if (cursor.afterId !== undefined) {
    where.push('s.id > ?')
    args.push(cursor.afterId)
  }
  return db
    .prepare(
      `SELECT ${PREFIXED}, ss.client_name AS client_name FROM searches s
         LEFT JOIN sessions ss ON ss.id = s.session_id ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.id DESC LIMIT ?`,
    )
    .all([...args, limit])
    .map(toLogRow)
}

/** Searches with `id > afterId`, oldest first: the dashboard's live tail (ADR-0004 point 5). */
export function listSearchLogAfter(db: Db, afterId: number, limit: number): SearchLogRow[] {
  return db
    .prepare(
      `SELECT ${PREFIXED}, ss.client_name AS client_name FROM searches s
         LEFT JOIN sessions ss ON ss.id = s.session_id
        WHERE s.id > ? ORDER BY s.id ASC LIMIT ?`,
    )
    .all([afterId, limit])
    .map(toLogRow)
}

/** Totals since `since` for the dashboard header. */
export function searchOverview(db: Db, since: number): SearchOverview {
  const totals = db
    .prepare<{ n: number; kept: number; hidden: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(kept_count), 0) AS kept, COALESCE(SUM(hidden_count), 0) AS hidden
         FROM searches WHERE created_at >= ?`,
    )
    .get([since]) ?? { n: 0, kept: 0, hidden: 0 }
  const engines = db
    .prepare<{ engine: string; n: number }>(
      `SELECT je.value ->> 'engine' AS engine, COUNT(*) AS n
         FROM searches s, json_each(s.engines_json) je
        WHERE s.created_at >= ? AND je.value ->> 'status' IN ('ok', 'empty')
        GROUP BY engine ORDER BY n DESC, engine`,
    )
    .all([since])
  const topHidden = db
    .prepare<{ domain: string; n: number }>(
      `SELECT registrable_domain AS domain, COUNT(*) AS n FROM results
        WHERE decision = 'hidden' AND created_at >= ?
        GROUP BY registrable_domain ORDER BY n DESC, domain LIMIT 5`,
    )
    .all([since])
  const sourceTypes = db
    .prepare<{ type: string; n: number }>(
      `SELECT source_type AS type, COUNT(*) AS n FROM results
        WHERE decision <> 'hidden' AND created_at >= ? GROUP BY source_type`,
    )
    .all([since])
  const builtin = engines.find((e) => e.engine === BUILTIN_ENGINE)?.n ?? 0
  return {
    searches: totals.n,
    builtin,
    kept: totals.kept,
    hidden: totals.hidden,
    engines: engines
      .filter((e) => e.engine !== BUILTIN_ENGINE)
      .map((e) => ({ engine: e.engine, searches: e.n })),
    topHidden: topHidden.map((r) => ({ domain: r.domain, count: r.n })),
    sourceTypes: Object.fromEntries(sourceTypes.map((r) => [r.type, r.n])),
  }
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
