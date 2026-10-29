// SPDX-License-Identifier: Apache-2.0
/**
 * The migration protocol (ADR-0006 points 2-4). Mutual exclusion comes from SQLite itself:
 *
 *   1. Fast path: read `meta.schema_version` without a lock; nothing to do when current.
 *   2. Elect: in BEGIN IMMEDIATE, a conditional UPDATE claims `migrating_pid/migrating_until`
 *      only when the schema is still the one we saw and no live claim exists. Exactly one
 *      process matches a row; the others poll until the schema changes or the claim expires.
 *   3. Back up (VACUUM INTO, outside any transaction), keeping the last 3.
 *   4. Migrate: foreign_keys=OFF (a no-op inside a transaction, so first), BEGIN EXCLUSIVE,
 *      re-verify the claim, apply every pending migration, foreign_key_check (roll back on
 *      rows), write `meta`, mirror `min_writer_version` into `PRAGMA user_version`, COMMIT,
 *      foreign_keys=ON.
 *
 * SQLite DDL is transactional, so a crash leaves either the old or the new schema, never a
 * half-applied one. A crashed migrator's claim simply expires (120 s) and another takes over.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleepFor } from 'node:timers/promises'
import { SearchHoleError } from '../shared/errors.ts'
import { type Db, isBusyError } from './driver.ts'
import type { Migration } from './migrations/index.ts'
import { latestSchemaOf } from './migrations/index.ts'
import { META_SQL } from './migrations/meta-sql.ts'
import { type MetaRow, readMeta } from './queries/meta.ts'
import { encodeUserVersion, maxSemver } from './version.ts'

export interface MigrateOptions {
  /** Where `backups/` lives; null for an in-memory database (no backup is taken). */
  dataDir: string | null
  appVersion: string
  /** Epoch milliseconds. Used for claim times and backup names, never for the wait deadline. */
  now: () => number
  pid: number
  migrations: readonly Migration[]
  random?: () => number
  /** Longest total wait for another process's migration. Default 130 s (claim 120 s + margin). */
  waitMs?: number
  /** How long an election claim lives. Default 120 s (ADR-0006). */
  claimMs?: number
  /** Backups to keep. Default 3. */
  keepBackups?: number
  sleep?: (ms: number) => Promise<void>
}

export type MigrateKind = 'current' | 'waited' | 'migrated'

export interface MigrateOutcome {
  readonly kind: MigrateKind
  readonly meta: MetaRow
  /** Schema version before this process migrated (migrated), else the version seen. */
  readonly from: number
  /** Backup written by this process, if any. */
  readonly backupPath: string | null
}

const CLAIM_MS = 120_000
const WAIT_MS = 130_000
const MIGRATION_BUSY_MS = 5000

class ClaimLost extends Error {}

type Election = { kind: 'done'; meta: MetaRow } | { kind: 'elected'; from: number } | { kind: 'busy' }

function elect(db: Db, o: MigrateOptions, target: number): Election {
  return db.tx('immediate', () => {
    let meta = readMeta(db)
    if (meta === undefined) {
      db.exec(META_SQL)
      meta = readMeta(db)
      if (meta === undefined) throw new SearchHoleError('store_unavailable', 'Cannot create the meta table.')
    }
    if (meta.schemaVersion >= target) return { kind: 'done', meta }
    const now = o.now()
    const claimed = db
      .prepare(
        `UPDATE meta SET migrating_pid = $pid, migrating_until = $until
          WHERE id = 1 AND schema_version = $old
            AND (migrating_until IS NULL OR migrating_until < $now)`,
      )
      .run({ pid: o.pid, until: now + (o.claimMs ?? CLAIM_MS), old: meta.schemaVersion, now })
    return claimed.changes === 1 ? { kind: 'elected', from: meta.schemaVersion } : { kind: 'busy' }
  })
}

function releaseClaim(db: Db, pid: number): void {
  try {
    db.prepare(
      'UPDATE meta SET migrating_pid = NULL, migrating_until = NULL WHERE id = 1 AND migrating_pid = ?',
    ).run([pid])
  } catch {
    // Best effort: the claim expires on its own.
  }
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '')
}

function pruneBackups(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((n) => /^searchhole-v\d+-.+\.db$/.test(n))
    .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0))
  for (const f of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f.n))
    } catch {
      // Already gone.
    }
  }
}

/** `VACUUM INTO` a fresh backup file (cannot run inside a transaction). Returns its path. */
export function backupDatabase(
  db: Db,
  dataDir: string,
  from: number,
  now: number,
  pid: number,
  keep: number,
): string {
  const dir = join(dataDir, 'backups')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stem = join(dir, `searchhole-v${from}-${timestamp(now)}-${pid}`)
  let file = `${stem}.db`
  for (let n = 1; existsSync(file); n++) file = `${stem}-${n}.db`
  // VACUUM INTO accepts an existing empty file, so the backup is never briefly world-readable.
  closeSync(openSync(file, 'wx', 0o600))
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Platform without modes.
  }
  pruneBackups(dir, keep)
  return file
}

function applyPending(db: Db, o: MigrateOptions, from: number, target: number): void {
  const pending = o.migrations.filter((m) => m.id > from && m.id <= target).sort((a, b) => a.id - b.id)
  // foreign_keys is a no-op inside a transaction, so switch it off first (ADR-0006 point 3).
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.tx('exclusive', () => {
      const meta = readMeta(db)
      if (meta === undefined || meta.schemaVersion !== from || meta.migratingPid !== o.pid)
        throw new ClaimLost()
      let minReader = meta.minReaderVersion
      let minWriter = meta.minWriterVersion
      for (const m of pending) {
        db.exec(m.sql)
        minReader = maxSemver(minReader, m.minReaderVersion)
        minWriter = maxSemver(minWriter, m.minWriterVersion)
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new SearchHoleError(
          'store_unavailable',
          'A migration left rows that break foreign keys; it was rolled back.',
          {
            details: { violations: violations.slice(0, 5) },
          },
        )
      }
      db.prepare(
        `UPDATE meta SET schema_version = $version, min_reader_version = $reader, min_writer_version = $writer,
                         last_migrated_by = $by, migrating_pid = NULL, migrating_until = NULL
          WHERE id = 1`,
      ).run({ version: target, reader: minReader, writer: minWriter, by: o.appVersion })
      db.exec(`PRAGMA user_version = ${encodeUserVersion(minWriter)}`)
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function requireMeta(db: Db): MetaRow {
  const meta = readMeta(db)
  if (meta === undefined)
    throw new SearchHoleError('store_unavailable', 'The meta table is missing after migration.')
  return meta
}

/**
 * Brings the schema up to the newest migration, or waits for whichever process is doing so.
 * Throws `store_unavailable` when the migration fails or does not finish within `waitMs`.
 */
export async function migrate(db: Db, o: MigrateOptions): Promise<MigrateOutcome> {
  const target = latestSchemaOf(o.migrations)
  const sleep = o.sleep ?? sleepFor
  const random = o.random ?? Math.random
  const deadline = performance.now() + (o.waitMs ?? WAIT_MS)
  const previousBusy = db.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()?.timeout ?? 0
  db.exec(`PRAGMA busy_timeout = ${Math.max(previousBusy, MIGRATION_BUSY_MS)}`)
  let waited = false
  try {
    for (;;) {
      let election: Election
      try {
        election = elect(db, o, target)
      } catch (e) {
        if (!isBusyError(e)) throw e
        election = { kind: 'busy' } // another process holds the write lock (probably migrating)
      }
      if (election.kind === 'done') {
        return {
          kind: waited ? 'waited' : 'current',
          meta: election.meta,
          from: election.meta.schemaVersion,
          backupPath: null,
        }
      }
      if (election.kind === 'elected') {
        const from = election.from
        let backupPath: string | null = null
        try {
          if (from > 0 && o.dataDir !== null) {
            backupPath = backupDatabase(db, o.dataDir, from, o.now(), o.pid, o.keepBackups ?? 3)
          }
          applyPending(db, o, from, target)
          return { kind: 'migrated', meta: requireMeta(db), from, backupPath }
        } catch (e) {
          if (e instanceof ClaimLost) {
            waited = true
            continue
          }
          releaseClaim(db, o.pid)
          if (e instanceof SearchHoleError) throw e
          const reason = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
          throw new SearchHoleError(
            'store_unavailable',
            `The search-hole database upgrade failed: ${reason}`,
            {
              fix: 'Your data was backed up first (see the backups folder). Run `searchhole doctor`.',
              cause: e,
            },
          )
        }
      }
      waited = true
      if (performance.now() >= deadline) {
        throw new SearchHoleError(
          'store_unavailable',
          'Another search-hole process is still upgrading the database.',
          {
            fix: 'Wait a minute and retry.',
          },
        )
      }
      await sleep(25 + Math.floor(random() * 50))
    }
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${previousBusy}`)
    } catch {
      // Connection closed under us.
    }
  }
}
