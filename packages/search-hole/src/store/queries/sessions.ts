// SPDX-License-Identifier: Apache-2.0
/** Queries for `sessions` (ADR-0005), `receipts` and `gateways` (ADR-0004). Mutable tables. */
import { z } from 'zod'
import type { Db } from '../driver.ts'
import type { GatewayRow, GatewayWrite, ReceiptRow, SessionRow, SessionWrite } from '../types.ts'

const sessionRow = z.object({
  id: z.string(),
  host_profile: z.string(),
  host_key: z.string().nullable(),
  key_source: z.string(),
  client_name: z.string().nullable(),
  client_version: z.string().nullable(),
  protocol_era: z.string().nullable(),
  project_dir: z.string().nullable(),
  gateway_id: z.string().nullable(),
  open_receipt_id: z.string().nullable(),
  turn_open: z.number().int(),
  started_at: z.number(),
  last_seen_at: z.number(),
})

const SESSION_COLUMNS = `id, host_profile, host_key, key_source, client_name, client_version, protocol_era,
  project_dir, gateway_id, open_receipt_id, turn_open, started_at, last_seen_at`

/**
 * Inserts or refreshes a session. Every listed field overwrites the stored one except
 * `started_at`, and `client_*`, `project_dir` and `protocol_era`, which only fill gaps.
 */
export function upsertSession(db: Db, w: SessionWrite, now: number): void {
  db.prepare(
    `INSERT INTO sessions (${SESSION_COLUMNS})
     VALUES ($id, $host, $hostKey, $keySource, $clientName, $clientVersion, $era, $projectDir, $gatewayId,
             $openReceipt, $turnOpen, $now, $now)
     ON CONFLICT (id) DO UPDATE SET
       host_profile = excluded.host_profile,
       host_key = excluded.host_key,
       key_source = excluded.key_source,
       client_name = COALESCE(excluded.client_name, sessions.client_name),
       client_version = COALESCE(excluded.client_version, sessions.client_version),
       protocol_era = COALESCE(excluded.protocol_era, sessions.protocol_era),
       project_dir = COALESCE(excluded.project_dir, sessions.project_dir),
       gateway_id = COALESCE(excluded.gateway_id, sessions.gateway_id),
       open_receipt_id = excluded.open_receipt_id,
       turn_open = excluded.turn_open,
       last_seen_at = excluded.last_seen_at`,
  ).run({
    id: w.id,
    host: w.hostProfile,
    hostKey: w.hostKey ?? null,
    keySource: w.keySource,
    clientName: w.clientName ?? null,
    clientVersion: w.clientVersion ?? null,
    era: w.protocolEra ?? null,
    projectDir: w.projectDir ?? null,
    gatewayId: w.gatewayId ?? null,
    openReceipt: w.openReceiptId ?? null,
    turnOpen: w.turnOpen ? 1 : 0,
    now,
  })
}

/** One session by id. */
export function getSession(db: Db, id: string): SessionRow | undefined {
  const raw = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get([id])
  if (raw === undefined) return undefined
  const r = sessionRow.parse(raw)
  return {
    id: r.id,
    hostProfile: r.host_profile,
    hostKey: r.host_key,
    keySource: r.key_source,
    clientName: r.client_name,
    clientVersion: r.client_version,
    protocolEra: r.protocol_era,
    projectDir: r.project_dir,
    gatewayId: r.gateway_id,
    openReceiptId: r.open_receipt_id,
    turnOpen: r.turn_open !== 0,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
  }
}

/**
 * Opens a turn for a session, unless another gateway opened this session's turn within
 * `windowMs`: then two copies of search-hole serve one host session (ADR-0006 point 11), and
 * this receipt is recorded as `duplicate_of` that turn while the session row stays the
 * other gateway's. Run inside one write transaction, so two racing gateways can't both win.
 */
export function claimTurn(
  db: Db,
  w: SessionWrite & { gatewayId: string; openReceiptId: string },
  windowMs: number,
  now: number,
): { kind: 'claimed' } | { kind: 'duplicate'; of: string } {
  const raw = db
    .prepare(
      `SELECT s.gateway_id, s.open_receipt_id, s.turn_open, r.created_at
         FROM sessions s LEFT JOIN receipts r ON r.id = s.open_receipt_id
        WHERE s.id = ?`,
    )
    .get([w.id])
  const row =
    raw === undefined
      ? undefined
      : z
          .object({
            gateway_id: z.string().nullable(),
            open_receipt_id: z.string().nullable(),
            turn_open: z.number().int(),
            created_at: z.number().nullable(),
          })
          .parse(raw)
  ensureReceipt(db, w.openReceiptId, w.id, now)
  if (
    row !== undefined &&
    row.gateway_id !== null &&
    row.gateway_id !== w.gatewayId &&
    row.turn_open !== 0 &&
    row.open_receipt_id !== null &&
    row.open_receipt_id !== w.openReceiptId &&
    row.created_at !== null &&
    now - row.created_at <= windowMs
  ) {
    db.prepare('UPDATE receipts SET duplicate_of = $of WHERE id = $id').run({
      of: row.open_receipt_id,
      id: w.openReceiptId,
    })
    return { kind: 'duplicate', of: row.open_receipt_id }
  }
  upsertSession(db, { ...w, turnOpen: true }, now)
  return { kind: 'claimed' }
}

// ── Receipts ─────────────────────────────────────────────────────────────

const receiptRow = z.object({
  id: z.string(),
  session_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  closed_at: z.number().nullable(),
  search_count: z.number().int(),
  fetch_count: z.number().int(),
  duplicate_of: z.string().nullable(),
})

const RECEIPT_COLUMNS =
  'id, session_id, created_at, updated_at, closed_at, search_count, fetch_count, duplicate_of'

function toReceipt(raw: unknown): ReceiptRow {
  const r = receiptRow.parse(raw)
  return {
    id: r.id,
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
    searchCount: r.search_count,
    fetchCount: r.fetch_count,
    duplicateOf: r.duplicate_of,
  }
}

/** Creates an empty receipt if it does not exist yet. */
export function ensureReceipt(db: Db, id: string, sessionId: string | null, now: number): void {
  db.prepare(
    `INSERT INTO receipts (id, session_id, created_at, updated_at) VALUES ($id, $sessionId, $now, $now)
     ON CONFLICT (id) DO NOTHING`,
  ).run({ id, sessionId, now })
}

/** One receipt by id. */
export function getReceipt(db: Db, id: string): ReceiptRow | undefined {
  const raw = db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE id = ?`).get([id])
  return raw === undefined ? undefined : toReceipt(raw)
}

/** Sets or clears `closed_at`. Returns true when a row changed. */
export function setReceiptClosed(db: Db, id: string, closedAt: number | null, now: number): boolean {
  return (
    db
      .prepare('UPDATE receipts SET closed_at = $closedAt, updated_at = $now WHERE id = $id')
      .run({ id, closedAt, now }).changes > 0
  )
}

/** Receipts marked `duplicate_of` created since `since` (doctor: duplicate copies). */
export function countDuplicateReceipts(db: Db, since: number): number {
  const raw = db
    .prepare('SELECT COUNT(*) AS n FROM receipts WHERE duplicate_of IS NOT NULL AND created_at >= ?')
    .get([since])
  return z.object({ n: z.number().int() }).parse(raw).n
}

/** The most recently created receipt of a session. */
export function latestReceiptForSession(db: Db, sessionId: string): ReceiptRow | undefined {
  const raw = db
    .prepare(
      `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get([sessionId])
  return raw === undefined ? undefined : toReceipt(raw)
}

// ── Gateways ─────────────────────────────────────────────────────────────

const gatewayRow = z.object({
  id: z.string(),
  pid: z.number().int(),
  host_profile: z.string(),
  client_name: z.string().nullable(),
  client_version: z.string().nullable(),
  app_version: z.string(),
  schema_version_known: z.number().int().nullable(),
  started_at: z.number(),
  last_seen_at: z.number(),
})

/** Inserts or refreshes one gateway heartbeat row. */
export function upsertGateway(db: Db, w: GatewayWrite, now: number): void {
  db.prepare(
    `INSERT INTO gateways (id, pid, host_profile, client_name, client_version, app_version, schema_version_known,
                           started_at, last_seen_at)
     VALUES ($id, $pid, $host, $clientName, $clientVersion, $appVersion, $schema, $startedAt, $now)
     ON CONFLICT (id) DO UPDATE SET
       client_name = COALESCE(excluded.client_name, gateways.client_name),
       client_version = COALESCE(excluded.client_version, gateways.client_version),
       app_version = excluded.app_version,
       schema_version_known = excluded.schema_version_known,
       last_seen_at = excluded.last_seen_at`,
  ).run({
    id: w.id,
    pid: w.pid,
    host: w.hostProfile,
    clientName: w.clientName ?? null,
    clientVersion: w.clientVersion ?? null,
    appVersion: w.appVersion,
    schema: w.schemaVersionKnown ?? null,
    startedAt: w.startedAt,
    now,
  })
}

/** Gateways seen at or after `since` (epoch ms), most recent first. */
export function listGateways(db: Db, since: number): GatewayRow[] {
  return db
    .prepare(
      `SELECT id, pid, host_profile, client_name, client_version, app_version, schema_version_known, started_at,
              last_seen_at FROM gateways WHERE last_seen_at >= ? ORDER BY last_seen_at DESC`,
    )
    .all([since])
    .map((raw) => {
      const r = gatewayRow.parse(raw)
      return {
        id: r.id,
        pid: r.pid,
        hostProfile: r.host_profile,
        clientName: r.client_name,
        clientVersion: r.client_version,
        appVersion: r.app_version,
        schemaVersionKnown: r.schema_version_known,
        startedAt: r.started_at,
        lastSeenAt: r.last_seen_at,
      }
    })
}
