// SPDX-License-Identifier: Apache-2.0
/**
 * Queries for rule state kept in SQLite (ADR-0008): session-scope rules, project trust
 * (content hashes the user approved) and the last good compiled user rules per file hash.
 */
import { z } from 'zod'
import type { Db } from '../driver.ts'
import type {
  LastGoodRow,
  LastGoodWrite,
  SessionRuleRow,
  SessionRuleWrite,
  SuggestionRow,
  SuggestionWrite,
  TrustRow,
} from '../types.ts'

// ── rules_session ────────────────────────────────────────────────────────

const sessionRuleRow = z.object({
  id: z.string(),
  session_id: z.string(),
  rule_json: z.string(),
  created_at: z.number(),
  until: z.number().nullable(),
})

function toSessionRule(raw: unknown): SessionRuleRow {
  const r = sessionRuleRow.parse(raw)
  let rule: unknown = null
  try {
    rule = JSON.parse(r.rule_json)
  } catch {
    rule = null
  }
  return { id: r.id, sessionId: r.session_id, rule, createdAt: r.created_at, until: r.until }
}

/** Inserts (or replaces) one session rule. Call inside a write transaction. */
export function insertSessionRule(db: Db, w: SessionRuleWrite, now: number): void {
  db.prepare(
    `INSERT INTO rules_session (id, session_id, rule_json, created_at, until)
     VALUES ($id, $sessionId, $rule, $now, $until)
     ON CONFLICT (id) DO UPDATE SET rule_json = excluded.rule_json, until = excluded.until`,
  ).run({ id: w.id, sessionId: w.sessionId, rule: JSON.stringify(w.rule), now, until: w.until ?? null })
}

/** Session rules not expired at `now`, in `(created_at, id)` order; all sessions when `sessionId` is omitted. */
export function listSessionRules(db: Db, sessionId: string | undefined, now: number): SessionRuleRow[] {
  const rows =
    sessionId === undefined
      ? db
          .prepare(
            'SELECT * FROM rules_session WHERE until IS NULL OR until > ? ORDER BY session_id, created_at, id',
          )
          .all([now])
      : db
          .prepare(
            'SELECT * FROM rules_session WHERE session_id = ? AND (until IS NULL OR until > ?) ORDER BY created_at, id',
          )
          .all([sessionId, now])
  return rows.map(toSessionRule)
}

/** Deletes one session rule by its row id. */
export function deleteSessionRule(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM rules_session WHERE id = ?').run([id]).changes > 0
}

/** Deletes every rule of a session (SessionStart with source=clear, ADR-0005). */
export function clearSessionRules(db: Db, sessionId: string): number {
  return db.prepare('DELETE FROM rules_session WHERE session_id = ?').run([sessionId]).changes
}

// ── project_trust ────────────────────────────────────────────────────────

const trustRow = z.object({ path: z.string(), content_sha256: z.string(), trusted_at: z.number() })

/** The trusted hash for a project rules file. */
export function getTrust(db: Db, path: string): TrustRow | undefined {
  const raw = db
    .prepare('SELECT path, content_sha256, trusted_at FROM project_trust WHERE path = ?')
    .get([path])
  if (raw === undefined) return undefined
  const r = trustRow.parse(raw)
  return { path: r.path, sha256: r.content_sha256, trustedAt: r.trusted_at }
}

/** Records the trusted hash for a project rules file. */
export function putTrust(db: Db, path: string, sha256: string, now: number): void {
  db.prepare(
    `INSERT INTO project_trust (path, content_sha256, trusted_at) VALUES ($path, $sha, $now)
     ON CONFLICT (path) DO UPDATE SET content_sha256 = excluded.content_sha256, trusted_at = excluded.trusted_at`,
  ).run({ path, sha: sha256, now })
}

/** Forgets the trust for a project rules file. */
export function deleteTrust(db: Db, path: string): boolean {
  return db.prepare('DELETE FROM project_trust WHERE path = ?').run([path]).changes > 0
}

// ── rules_lastgood ───────────────────────────────────────────────────────

const lastGoodRow = z.object({
  source_path: z.string(),
  content_sha256: z.string(),
  compiler_version: z.string(),
  compiled_json: z.string(),
  saved_at: z.number(),
})

/** Saves the last good loaded rules for one file content hash. */
export function putLastGood(db: Db, w: LastGoodWrite, now: number): void {
  db.prepare(
    `INSERT INTO rules_lastgood (source_path, content_sha256, compiler_version, compiled_json, saved_at)
     VALUES ($path, $sha, $compiler, $json, $now)
     ON CONFLICT (source_path, content_sha256) DO UPDATE SET compiler_version = excluded.compiler_version,
       compiled_json = excluded.compiled_json, saved_at = excluded.saved_at`,
  ).run({
    path: w.sourcePath,
    sha: w.sha256,
    compiler: w.compilerVersion,
    json: JSON.stringify(w.compiled),
    now,
  })
}

/** The most recently saved good rules for a file path (any content hash). */
export function latestLastGood(db: Db, sourcePath: string): LastGoodRow | undefined {
  const raw = db
    .prepare('SELECT * FROM rules_lastgood WHERE source_path = ? ORDER BY saved_at DESC LIMIT 1')
    .get([sourcePath])
  if (raw === undefined) return undefined
  const r = lastGoodRow.parse(raw)
  let compiled: unknown = null
  try {
    compiled = JSON.parse(r.compiled_json)
  } catch {
    compiled = null
  }
  return {
    sourcePath: r.source_path,
    sha256: r.content_sha256,
    compilerVersion: r.compiler_version,
    compiled,
    savedAt: r.saved_at,
  }
}

// ── suggestions ──────────────────────────────────────────────────────────

const suggestionRow = z.object({
  id: z.number().int(),
  session_id: z.string().nullable(),
  receipt_id: z.string().nullable(),
  status: z.string(),
  rule_json: z.string(),
  reason: z.string().nullable(),
  created_at: z.number(),
  resolved_at: z.number().nullable(),
})

function toSuggestion(raw: unknown): SuggestionRow {
  const r = suggestionRow.parse(raw)
  let rule: unknown = null
  try {
    rule = JSON.parse(r.rule_json)
  } catch {
    rule = null
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    receiptId: r.receipt_id,
    status: r.status,
    rule,
    reason: r.reason,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }
}

/** Queues a suggestion; returns its id. */
export function insertSuggestion(db: Db, w: SuggestionWrite, now: number): number {
  return db
    .prepare(
      `INSERT INTO suggestions (session_id, receipt_id, status, rule_json, reason, created_at)
       VALUES ($sessionId, $receiptId, 'pending', $rule, $reason, $now)`,
    )
    .run({
      sessionId: w.sessionId ?? null,
      receiptId: w.receiptId ?? null,
      rule: JSON.stringify(w.rule),
      reason: w.reason ?? null,
      now,
    }).lastInsertRowid
}

/** One suggestion by id. */
export function getSuggestion(db: Db, id: number): SuggestionRow | undefined {
  const raw = db.prepare('SELECT * FROM suggestions WHERE id = ?').get([id])
  return raw === undefined ? undefined : toSuggestion(raw)
}

/** Suggestions, pending first, then newest first. */
export function listSuggestions(db: Db, limit: number): SuggestionRow[] {
  return db
    .prepare(
      `SELECT * FROM suggestions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
       LIMIT ?`,
    )
    .all([limit])
    .map(toSuggestion)
}

/** The pending suggestion with this dedupe key (stored as `rule_json.dedupeKey`), if any. */
export function findPendingSuggestion(db: Db, dedupeKey: string): SuggestionRow | undefined {
  const raw = db
    .prepare(
      `SELECT * FROM suggestions WHERE status = 'pending' AND json_extract(rule_json, '$.dedupeKey') = ?
        ORDER BY id ASC LIMIT 1`,
    )
    .get([dedupeKey])
  return raw === undefined ? undefined : toSuggestion(raw)
}

/** Resolves a pending suggestion. Returns false when it was not pending. */
export function resolveSuggestion(db: Db, id: number, status: string, now: number): boolean {
  return (
    db
      .prepare(
        "UPDATE suggestions SET status = $status, resolved_at = $now WHERE id = $id AND status = 'pending'",
      )
      .run({ id, status, now }).changes > 0
  )
}
