// SPDX-License-Identifier: Apache-2.0
/** Queries over `meta` (protocol state, one row) and `meta_kv` (generic key/value). */
import { z } from 'zod'
import type { Db } from '../driver.ts'

export interface MetaRow {
  readonly schemaVersion: number
  readonly minReaderVersion: string
  readonly minWriterVersion: string
  readonly lastMigratedBy: string
  readonly dataEpoch: number
  readonly migratingPid: number | null
  readonly migratingUntil: number | null
}

const metaRow = z.object({
  schema_version: z.number().int(),
  min_reader_version: z.string(),
  min_writer_version: z.string(),
  last_migrated_by: z.string(),
  data_epoch: z.number().int(),
  migrating_pid: z.number().int().nullable(),
  migrating_until: z.number().nullable(),
})

/** True when a table with this name exists. */
export function hasTable(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get([name]) !==
    undefined
  )
}

/**
 * Thrown when `meta` exists but does not have the shape this binary knows. That can only mean a
 * newer binary changed the protocol table, so callers treat it as "newer than us", not as damage.
 */
export class MetaUnreadable extends Error {}

/** Reads the meta row, or undefined for a database that has not been bootstrapped yet. */
export function readMeta(db: Db): MetaRow | undefined {
  if (!hasTable(db, 'meta')) return undefined
  let r: z.infer<typeof metaRow>
  try {
    const raw = db
      .prepare(
        `SELECT schema_version, min_reader_version, min_writer_version, last_migrated_by,
                data_epoch, migrating_pid, migrating_until
           FROM meta WHERE id = 1`,
      )
      .get()
    if (raw === undefined) return undefined
    r = metaRow.parse(raw)
  } catch (cause) {
    throw new MetaUnreadable('the meta table has an unrecognised layout', { cause })
  }
  return {
    schemaVersion: r.schema_version,
    minReaderVersion: r.min_reader_version,
    minWriterVersion: r.min_writer_version,
    lastMigratedBy: r.last_migrated_by,
    dataEpoch: r.data_epoch,
    migratingPid: r.migrating_pid,
    migratingUntil: r.migrating_until,
  }
}

/** `PRAGMA user_version`: the mirror of `min_writer_version` (see version.ts). */
export function readUserVersion(db: Db): number {
  const row = db.prepare<{ user_version: number }>('PRAGMA user_version').get()
  return row?.user_version ?? 0
}

/** The current `meta.data_epoch` (0 when absent). */
export function readDataEpoch(db: Db): number {
  const row = db.prepare<{ data_epoch: number }>('SELECT data_epoch FROM meta WHERE id = 1').get()
  return row?.data_epoch ?? 0
}

/** Increments `data_epoch` and returns the new value. Call inside a write transaction. */
export function bumpDataEpoch(db: Db): number {
  db.prepare('UPDATE meta SET data_epoch = data_epoch + 1 WHERE id = 1').run()
  return readDataEpoch(db)
}

/** Reads one `meta_kv` value. */
export function kvGet(db: Db, key: string): string | undefined {
  return db.prepare<{ value: string }>('SELECT value FROM meta_kv WHERE key = ?').get([key])?.value
}

/** Upserts one `meta_kv` value. Call inside a write transaction. */
export function kvSet(db: Db, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO meta_kv (key, value, updated_at) VALUES ($key, $value, $now)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ key, value, now })
}

/** Inserts when absent. Returns true when this call inserted the value. */
export function kvInsertIfAbsent(db: Db, key: string, value: string, now: number): boolean {
  return (
    db
      .prepare('INSERT OR IGNORE INTO meta_kv (key, value, updated_at) VALUES ($key, $value, $now)')
      .run({ key, value, now }).changes === 1
  )
}
