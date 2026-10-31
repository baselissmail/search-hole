// SPDX-License-Identifier: Apache-2.0
/**
 * Queries for `lists` (ADR-0008 "Lists", ADR-0022): one row per vendored, subscribed or local
 * list with its refresh state. List content and compiled artifacts are files under
 * `<data>/lists/` (ADR-0006 point 8); this table holds what a refresh needs next time
 * (validators, the last rule count for the shrink guard, failures, the next due time) and
 * what `lists`, `doctor` and the dashboard show. Also the per-list contribution counts read
 * from `results`. Call the writers inside BEGIN IMMEDIATE.
 */
import { z } from 'zod'
import type { Db } from '../driver.ts'
import type { ListContribution, ListMetaWrite, ListOutcomeWrite, ListRow } from '../types.ts'

const COLUMNS = `id, name, source, url, format, kind, mode, license, update_interval_hours, etag, last_modified,
  content_sha256, compiler_version, rule_count, previous_rule_count, skipped_count, fetched_at, checked_at,
  verified_at, next_check_at, failures, last_error, last_error_detail, created_at, updated_at`

const n = z.number().nullable()
const s = z.string().nullable()
const listRow = z.object({
  id: z.string(),
  name: s,
  source: s,
  url: s,
  format: z.string(),
  kind: z.string(),
  mode: z.string(),
  license: s,
  update_interval_hours: n,
  etag: s,
  last_modified: s,
  content_sha256: s,
  compiler_version: s,
  rule_count: n,
  previous_rule_count: n,
  skipped_count: n,
  fetched_at: n,
  checked_at: n,
  verified_at: n,
  next_check_at: n,
  failures: z.number(),
  last_error: s,
  last_error_detail: s,
  created_at: z.number(),
  updated_at: z.number(),
})

function toRow(raw: unknown): ListRow {
  const r = listRow.parse(raw)
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    url: r.url,
    format: r.format,
    kind: r.kind,
    mode: r.mode,
    license: r.license,
    updateIntervalHours: r.update_interval_hours,
    etag: r.etag,
    lastModified: r.last_modified,
    contentSha256: r.content_sha256,
    compilerVersion: r.compiler_version,
    ruleCount: r.rule_count,
    previousRuleCount: r.previous_rule_count,
    skippedCount: r.skipped_count,
    fetchedAt: r.fetched_at,
    checkedAt: r.checked_at,
    verifiedAt: r.verified_at,
    nextCheckAt: r.next_check_at,
    failures: r.failures,
    lastError: r.last_error,
    lastErrorDetail: r.last_error_detail,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const clip = (v: string | null | undefined, max: number): string | null =>
  v === null || v === undefined ? null : v.length > max ? v.slice(0, max) : v

/** One list row, or undefined. */
export function getListRow(db: Db, id: string): ListRow | undefined {
  const raw = db.prepare(`SELECT ${COLUMNS} FROM lists WHERE id = ?`).get([id])
  return raw === undefined ? undefined : toRow(raw)
}

/** Every list row, by id. */
export function listListRows(db: Db): ListRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM lists ORDER BY id`).all().map(toRow)
}

/**
 * Inserts or updates a list's configuration. A changed URL drops the HTTP validators, so the
 * next refresh is unconditional; the content state stays until a new copy replaces it.
 */
export function upsertListMeta(db: Db, w: ListMetaWrite, now: number): void {
  db.prepare(
    `INSERT INTO lists (id, name, source, url, format, kind, mode, license, update_interval_hours, created_at, updated_at)
     VALUES ($id, $name, $source, $url, $format, $kind, $mode, $license, $interval, $now, $now)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       source = excluded.source,
       etag = CASE WHEN lists.url IS excluded.url THEN lists.etag ELSE NULL END,
       last_modified = CASE WHEN lists.url IS excluded.url THEN lists.last_modified ELSE NULL END,
       url = excluded.url,
       format = excluded.format,
       kind = excluded.kind,
       mode = excluded.mode,
       license = COALESCE(excluded.license, lists.license),
       update_interval_hours = excluded.update_interval_hours,
       updated_at = excluded.updated_at`,
  ).run({
    id: w.id,
    name: clip(w.name, 200),
    source: w.source,
    url: clip(w.url, 2048),
    format: w.format,
    kind: w.kind,
    mode: w.mode,
    license: clip(w.license, 100),
    interval: w.updateIntervalHours,
    now,
  })
}

/**
 * Records one refresh (or import) outcome. `fetched` replaces the content state and moves the
 * old rule count to `previous_rule_count` (SQLite evaluates the right-hand sides against the old
 * row); `verified` (HTTP 304 or identical bytes) only renews the validators and times; `failed`
 * keeps the last good content and counts the failure. Returns false when the row does not exist.
 */
export function writeListOutcome(db: Db, id: string, w: ListOutcomeWrite, now: number): boolean {
  if (w.kind === 'fetched') {
    return (
      db
        .prepare(
          `UPDATE lists SET
             etag = $etag, last_modified = $lastModified, content_sha256 = $sha, compiler_version = $compiler,
             previous_rule_count = rule_count, rule_count = $rules, skipped_count = $skipped,
             license = COALESCE($license, license),
             fetched_at = $now, checked_at = $now, verified_at = $now, next_check_at = $next,
             failures = 0, last_error = NULL, last_error_detail = NULL, updated_at = $now
           WHERE id = $id`,
        )
        .run({
          id,
          etag: clip(w.etag, 500),
          lastModified: clip(w.lastModified, 100),
          sha: w.contentSha256,
          compiler: w.compilerVersion,
          rules: w.ruleCount,
          skipped: w.skippedCount,
          license: clip(w.license, 100),
          next: w.nextCheckAt,
          now,
        }).changes === 1
    )
  }
  if (w.kind === 'verified') {
    return (
      db
        .prepare(
          `UPDATE lists SET
             etag = COALESCE($etag, etag), last_modified = COALESCE($lastModified, last_modified),
             content_sha256 = COALESCE($sha, content_sha256), rule_count = COALESCE($rules, rule_count),
             checked_at = $now, verified_at = $now, next_check_at = $next,
             failures = 0, last_error = NULL, last_error_detail = NULL, updated_at = $now
           WHERE id = $id`,
        )
        .run({
          id,
          etag: clip(w.etag, 500),
          lastModified: clip(w.lastModified, 100),
          sha: w.contentSha256 ?? null,
          rules: w.ruleCount ?? null,
          next: w.nextCheckAt,
          now,
        }).changes === 1
    )
  }
  return (
    db
      .prepare(
        `UPDATE lists SET
           checked_at = $now, next_check_at = $next, failures = failures + 1,
           last_error = $error, last_error_detail = $detail, updated_at = $now
         WHERE id = $id`,
      )
      .run({ id, error: clip(w.error, 64), detail: clip(w.detail, 500), next: w.nextCheckAt, now })
      .changes === 1
  )
}

/** Deletes a list row. Returns true when one existed. */
export function deleteListRow(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM lists WHERE id = ?').run([id]).changes === 1
}

const countRow = z.object({ id: z.string(), n: z.number() })

/**
 * Per list since `since` (epoch ms): results it hid (enforced, the deciding visibility rule)
 * and kept results an audit-mode list would have hidden. Reads `results` by `created_at`.
 */
export function listContribution(db: Db, since: number): Map<string, ListContribution> {
  const out = new Map<string, ListContribution>()
  const entry = (id: string): ListContribution => {
    let e = out.get(id)
    if (e === undefined) {
      e = { hidden: 0, wouldHide: 0 }
      out.set(id, e)
    }
    return e
  }
  const hidden = db
    .prepare(
      `SELECT list_id AS id, COUNT(*) AS n FROM results
        WHERE created_at >= ? AND decision = 'hidden' AND reason = 'list' AND list_id IS NOT NULL
        GROUP BY list_id`,
    )
    .all([since])
  for (const raw of hidden) {
    const r = countRow.parse(raw)
    entry(r.id).hidden = r.n
  }
  const audit = db
    .prepare(
      `SELECT audit_list_id AS id, COUNT(*) AS n FROM results
        WHERE created_at >= ? AND audit_list_id IS NOT NULL
        GROUP BY audit_list_id`,
    )
    .all([since])
  for (const raw of audit) {
    const r = countRow.parse(raw)
    entry(r.id).wouldHide = r.n
  }
  return out
}
