// SPDX-License-Identifier: Apache-2.0
/** Queries for `engine_health` (ADR-0009 point 4), keyed by (engine, key_fp, sub_engine). */
import { z } from 'zod'
import type { EngineId, HealthState } from '../../shared/types.ts'
import type { Db } from '../driver.ts'
import type { EngineHealthRow, EngineHealthWrite } from '../types.ts'

const MAX_ERROR = 200

const healthRow = z.object({
  engine: z.string(),
  key_fp: z.string(),
  sub_engine: z.string(),
  state: z.string(),
  reason_class: z.string().nullable(),
  until: z.number().nullable(),
  consecutive_failures: z.number().int(),
  ewma_success: z.number().nullable(),
  p50_ms: z.number().nullable(),
  p95_ms: z.number().nullable(),
  last_success_at: z.number().nullable(),
  last_error_redacted: z.string().nullable(),
  key_present: z.number().int(),
  key_source: z.string().nullable(),
  updated_at: z.number(),
})

const COLUMNS = `engine, key_fp, sub_engine, state, reason_class, until, consecutive_failures, ewma_success,
  p50_ms, p95_ms, last_success_at, last_error_redacted, key_present, key_source, updated_at`

function toState(value: string): HealthState {
  return value === 'healthy' || value === 'unhealthy' ? value : 'unknown'
}

function toRow(raw: unknown): EngineHealthRow {
  const r = healthRow.parse(raw)
  return {
    engine: r.engine as EngineId,
    keyFp: r.key_fp,
    subEngine: r.sub_engine,
    state: toState(r.state),
    reasonClass: r.reason_class,
    until: r.until,
    consecutiveFailures: r.consecutive_failures,
    ewmaSuccess: r.ewma_success,
    p50Ms: r.p50_ms,
    p95Ms: r.p95_ms,
    lastSuccessAt: r.last_success_at,
    lastErrorRedacted: r.last_error_redacted,
    keyPresent: r.key_present !== 0,
    keySource: r.key_source,
    updatedAt: r.updated_at,
  }
}

/** One health row, or undefined. */
export function getHealth(
  db: Db,
  engine: EngineId,
  keyFp: string,
  subEngine: string,
): EngineHealthRow | undefined {
  const raw = db
    .prepare(`SELECT ${COLUMNS} FROM engine_health WHERE engine = ? AND key_fp = ? AND sub_engine = ?`)
    .get([engine, keyFp, subEngine])
  return raw === undefined ? undefined : toRow(raw)
}

/** Every health row for one engine, or for all engines. */
export function listHealth(db: Db, engine: EngineId | undefined): EngineHealthRow[] {
  const rows =
    engine === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM engine_health ORDER BY engine, key_fp, sub_engine`).all()
      : db
          .prepare(`SELECT ${COLUMNS} FROM engine_health WHERE engine = ? ORDER BY key_fp, sub_engine`)
          .all([engine])
  return rows.map(toRow)
}

/** Upserts one health row. Call inside a write transaction. */
export function putHealth(db: Db, row: EngineHealthWrite, now: number): void {
  db.prepare(
    `INSERT INTO engine_health (${COLUMNS})
     VALUES ($engine, $keyFp, $subEngine, $state, $reason, $until, $failures, $ewma, $p50, $p95,
             $lastSuccess, $lastError, $keyPresent, $keySource, $now)
     ON CONFLICT (engine, key_fp, sub_engine) DO UPDATE SET
       state = excluded.state, reason_class = excluded.reason_class, until = excluded.until,
       consecutive_failures = excluded.consecutive_failures, ewma_success = excluded.ewma_success,
       p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms, last_success_at = excluded.last_success_at,
       last_error_redacted = excluded.last_error_redacted, key_present = excluded.key_present,
       key_source = excluded.key_source, updated_at = excluded.updated_at`,
  ).run({
    engine: row.engine,
    keyFp: row.keyFp,
    subEngine: row.subEngine,
    state: row.state,
    reason: row.reasonClass,
    until: row.until,
    failures: row.consecutiveFailures,
    ewma: row.ewmaSuccess,
    p50: row.p50Ms,
    p95: row.p95Ms,
    lastSuccess: row.lastSuccessAt,
    lastError: row.lastErrorRedacted === null ? null : row.lastErrorRedacted.slice(0, MAX_ERROR),
    keyPresent: row.keyPresent ? 1 : 0,
    keySource: row.keySource,
    now,
  })
}
