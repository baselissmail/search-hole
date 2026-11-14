// SPDX-License-Identifier: Apache-2.0
/**
 * Which results of a logged search the assistant opened (ADR-0025). A result counts as opened
 * when a fetch with decision `opened`, in the same session as the search, has the result's URL
 * hash as its requested or its final URL hash (both are SHA-256 of the canonical key, like
 * `results.url_hash`). A search without a session falls back to its own receipt.
 *
 * `fetches` has no session index and this feature adds no migration, so a session's fetches
 * are reached through its receipts: `receipts_by_session`, then `fetches_by_receipt`. The
 * session filter is then applied to the rows, so a fetch another session filed under one of
 * these receipts does not count.
 */
import { z } from 'zod'
import type { Db } from '../driver.ts'

/** Search ids per call (the log pages at most 500 searches). */
const MAX_IDS = 500

const scopeRow = z.object({
  id: z.number().int(),
  session_id: z.string().nullable(),
  receipt_id: z.string(),
})

const fetchRow = z.object({
  session_id: z.string().nullable(),
  receipt_id: z.string(),
  url_hash: z.string(),
  final_url_hash: z.string().nullable(),
})

const hashRow = z.object({ search_id: z.number().int(), url_hash: z.string() })

/** Exported for the query-plan test. */
export const OPENED_FETCHES_SQL = `
SELECT f.session_id, f.receipt_id, f.url_hash, f.final_url_hash
  FROM fetches f
 WHERE f.decision = 'opened'
   AND f.receipt_id IN (
         SELECT id FROM receipts WHERE session_id IN (SELECT value FROM json_each($sessions))
         UNION
         SELECT value FROM json_each($receipts))`

const idList = (searchIds: readonly number[]): number[] =>
  [...new Set(searchIds.filter((n) => Number.isInteger(n)))].slice(0, MAX_IDS)

const addTo = (map: Map<string, Set<string>>, key: string, f: z.infer<typeof fetchRow>): void => {
  let set = map.get(key)
  if (set === undefined) {
    set = new Set()
    map.set(key, set)
  }
  set.add(f.url_hash)
  if (f.final_url_hash !== null) set.add(f.final_url_hash)
}

/**
 * Per search id: the URL hashes of the pages opened in its session (or, for a search without
 * a session, under its receipt). Searches with nothing opened are absent.
 */
export function openedHashes(db: Db, searchIds: readonly number[]): Map<number, ReadonlySet<string>> {
  const out = new Map<number, ReadonlySet<string>>()
  const ids = idList(searchIds)
  if (ids.length === 0) return out
  const scopes = db
    .prepare('SELECT id, session_id, receipt_id FROM searches WHERE id IN (SELECT value FROM json_each(?))')
    .all([JSON.stringify(ids)])
    .map((r) => scopeRow.parse(r))
  if (scopes.length === 0) return out
  const sessions = [...new Set(scopes.flatMap((s) => (s.session_id === null ? [] : [s.session_id])))]
  const receipts = [...new Set(scopes.map((s) => s.receipt_id))]
  const bySession = new Map<string, Set<string>>()
  const byReceipt = new Map<string, Set<string>>()
  const fetches = db
    .prepare(OPENED_FETCHES_SQL)
    .all({ sessions: JSON.stringify(sessions), receipts: JSON.stringify(receipts) })
  for (const raw of fetches) {
    const f = fetchRow.parse(raw)
    if (f.session_id !== null) addTo(bySession, f.session_id, f)
    addTo(byReceipt, f.receipt_id, f)
  }
  for (const s of scopes) {
    const set = s.session_id === null ? byReceipt.get(s.receipt_id) : bySession.get(s.session_id)
    if (set !== undefined) out.set(s.id, set)
  }
  return out
}

/** Per search id: how many of its kept results the assistant opened. Zero counts are absent. */
export function openedCounts(db: Db, searchIds: readonly number[]): Map<number, number> {
  const out = new Map<number, number>()
  const opened = openedHashes(db, searchIds)
  if (opened.size === 0) return out
  const rows = db
    .prepare(
      `SELECT search_id, url_hash FROM results
        WHERE search_id IN (SELECT value FROM json_each(?)) AND decision <> 'hidden'`,
    )
    .all([JSON.stringify([...opened.keys()])])
  for (const raw of rows) {
    const r = hashRow.parse(raw)
    if (opened.get(r.search_id)?.has(r.url_hash) === true)
      out.set(r.search_id, (out.get(r.search_id) ?? 0) + 1)
  }
  return out
}
