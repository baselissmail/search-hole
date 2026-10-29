// SPDX-License-Identifier: Apache-2.0
/**
 * Queries for `engine_usage` (ADR-0009 point 6): spend-cap counters per
 * (engine, key_fp, period). Periods are UTC calendar days and months.
 */

import type { EngineId } from '../../shared/types.ts'
import type { Db } from '../driver.ts'
import type { UsageCaps, UsageCounts, UsageReservation } from '../types.ts'

/** UTC `YYYY-MM-DD` of an epoch-ms instant. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** UTC `YYYY-MM` of an epoch-ms instant. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7)
}

function readCount(db: Db, engine: string, keyFp: string, kind: 'day' | 'month', start: string): number {
  const row = db
    .prepare<{ count: number }>(
      'SELECT count FROM engine_usage WHERE engine = ? AND key_fp = ? AND period_kind = ? AND period_start = ?',
    )
    .get([engine, keyFp, kind, start])
  return row?.count ?? 0
}

/** Current day and month counters for (engine, key_fp). */
export function readCounts(db: Db, engine: EngineId, keyFp: string, now: number): UsageCounts {
  return {
    day: readCount(db, engine, keyFp, 'day', dayOf(now)),
    month: readCount(db, engine, keyFp, 'month', monthOf(now)),
  }
}

export type ReserveRow =
  | { ok: true; reservation: UsageReservation; counts: UsageCounts }
  | { ok: false; reason: 'day_cap' | 'month_cap'; counts: UsageCounts }

const BUMP = `
INSERT INTO engine_usage (engine, key_fp, period_kind, period_start, count, updated_at)
VALUES ($engine, $keyFp, $kind, $start, 1, $now)
ON CONFLICT (engine, key_fp, period_kind, period_start) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`

/** Checks both caps and increments both counters. Call inside BEGIN IMMEDIATE so it is atomic. */
export function reserveUsage(
  db: Db,
  engine: EngineId,
  keyFp: string,
  caps: UsageCaps,
  now: number,
): ReserveRow {
  const dayStart = dayOf(now)
  const monthStart = monthOf(now)
  const before = {
    day: readCount(db, engine, keyFp, 'day', dayStart),
    month: readCount(db, engine, keyFp, 'month', monthStart),
  }
  if (caps.day !== undefined && caps.day !== null && before.day >= caps.day) {
    return { ok: false, reason: 'day_cap', counts: before }
  }
  if (caps.month !== undefined && caps.month !== null && before.month >= caps.month) {
    return { ok: false, reason: 'month_cap', counts: before }
  }
  const bump = db.prepare(BUMP)
  bump.run({ engine, keyFp, kind: 'day', start: dayStart, now })
  bump.run({ engine, keyFp, kind: 'month', start: monthStart, now })
  return {
    ok: true,
    reservation: { engine, keyFp, dayStart, monthStart },
    counts: { day: before.day + 1, month: before.month + 1 },
  }
}

/** Decrements the buckets a reservation charged, never below zero. */
export function refundUsage(db: Db, r: UsageReservation, now: number): void {
  const dec = db.prepare(
    `UPDATE engine_usage SET count = MAX(count - 1, 0), updated_at = $now
      WHERE engine = $engine AND key_fp = $keyFp AND period_kind = $kind AND period_start = $start`,
  )
  dec.run({ engine: r.engine, keyFp: r.keyFp, kind: 'day', start: r.dayStart, now })
  dec.run({ engine: r.engine, keyFp: r.keyFp, kind: 'month', start: r.monthStart, now })
}
