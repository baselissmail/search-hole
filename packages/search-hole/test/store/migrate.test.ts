// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/driver.ts'
import { openStore } from '../../src/store/index.ts'
import { backupDatabase } from '../../src/store/migrate.ts'
import { MIGRATIONS } from '../../src/store/migrations/index.ts'
import { META_SQL } from '../../src/store/migrations/meta-sql.ts'
import {
  ADDITIVE,
  APP,
  autoClose,
  BROKEN,
  clock,
  FK_VIOLATION,
  open,
  REBUILD_PARENT,
  searchInput,
  tempDir,
  V2,
  V3,
} from './helpers.ts'

const TABLES = [
  'meta',
  'meta_kv',
  'rules_session',
  'rules_lastgood',
  'project_trust',
  'lists',
  'suggestions',
  'engine_health',
  'engine_usage',
  'jobs',
  'gateways',
  'installs',
  'sessions',
  'receipts',
  'daily_stats',
  'searches',
  'results',
  'result_payloads',
  'fetches',
]

const dbFile = (dir: string): string => join(dir, 'searchhole.db')
const backups = (dir: string): string[] =>
  existsSync(join(dir, 'backups')) ? readdirSync(join(dir, 'backups')).sort() : []

async function rawQuery<T extends object>(dir: string, sql: string): Promise<T[]> {
  const db = await openDb({ path: dbFile(dir), busyTimeoutMs: 1000 })
  try {
    return db.prepare<T>(sql).all()
  } finally {
    db.close()
  }
}

describe('migration 0001 on a fresh database', () => {
  it('creates every ADR-0003 table and records the bookkeeping in meta', async () => {
    const dir = tempDir()
    const store = await open(dir, clock())
    expect(store.status()).toMatchObject({
      mode: 'read-write',
      reason: 'ok',
      migration: 'migrated',
      schemaVersion: 1,
    })
    const names = (
      await rawQuery<{ name: string }>(dir, "SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((r) => r.name)
    for (const t of TABLES) expect(names, t).toContain(t)
    const [meta] = await rawQuery<Record<string, unknown>>(dir, 'SELECT * FROM meta')
    expect(meta).toMatchObject({
      schema_version: 1,
      min_reader_version: '0.0.0',
      min_writer_version: '0.0.0',
      last_migrated_by: APP,
      data_epoch: 0,
      migrating_pid: null,
      migrating_until: null,
    })
  })

  it('declares searches.id as INTEGER PRIMARY KEY AUTOINCREMENT and uses TEXT codes, not CHECK enums', async () => {
    const dir = tempDir()
    await open(dir, clock())
    const sqls = (
      await rawQuery<{ sql: string }>(dir, "SELECT sql FROM sqlite_master WHERE type = 'table'")
    ).map((r) => r.sql)
    expect(sqls.find((s) => s.includes('CREATE TABLE searches'))).toMatch(
      /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/,
    )
    for (const s of sqls) expect(s).not.toMatch(/CHECK\s*\([^)]*\bIN\s*\(/i)
    expect(sqls.some((s) => /json_valid/.test(s))).toBe(true)
  })

  it('creates the keyset indexes', async () => {
    const dir = tempDir()
    await open(dir, clock())
    const idx = (
      await rawQuery<{ name: string }>(dir, "SELECT name FROM sqlite_master WHERE type = 'index'")
    ).map((r) => r.name)
    expect(idx).toEqual(
      expect.arrayContaining([
        'searches_by_created',
        'results_by_search',
        'results_by_rule',
        'result_payloads_by_result',
      ]),
    )
  })

  it('mirrors min_writer_version into PRAGMA user_version and takes no backup of an empty database', async () => {
    const dir = tempDir()
    await open(dir, clock())
    expect(await rawQuery(dir, 'PRAGMA user_version')).toEqual([{ user_version: 0 }])
    expect(backups(dir)).toEqual([])
    expect(await rawQuery(dir, 'PRAGMA auto_vacuum')).toEqual([{ auto_vacuum: 2 }])
  })

  it('is a no-op on reopen (fast path)', async () => {
    const dir = tempDir()
    const first = await openStore({ dataDir: dir, appVersion: APP, now: clock() })
    first.close()
    const second = await open(dir, clock())
    expect(second.status().migration).toBe('current')
    expect(backups(dir)).toEqual([])
  })
})

describe('upgrading an existing database', () => {
  it('backs up with VACUUM INTO first, then applies only the pending migrations', async () => {
    const dir = tempDir()
    const t = clock()
    const v1 = await openStore({ dataDir: dir, appVersion: '0.1.0', now: t })
    expect(v1.recordSearch(searchInput()).status).toBe('recorded')
    v1.close()

    const v2 = await open(dir, t, { appVersion: '0.2.0', migrations: V2, pid: 4242 })
    expect(v2.status()).toMatchObject({ migration: 'migrated', schemaVersion: 2, lastMigratedBy: '0.2.0' })
    const files = backups(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^searchhole-v1-\d{8}T\d{9}Z-4242\.db$/)
    if (process.platform !== 'win32')
      expect((statSync(join(dir, 'backups', files[0] ?? '')).mode & 0o777).toString(8)).toBe('600')
    // The backup is a complete copy of the pre-migration database.
    const backup = await openDb({ path: join(dir, 'backups', files[0] ?? ''), busyTimeoutMs: 100 })
    expect(backup.prepare<{ n: number }>('SELECT count(*) AS n FROM searches').get()?.n).toBe(1)
    expect(
      backup
        .prepare<{ n: number }>("SELECT count(*) AS n FROM pragma_table_info('searches') WHERE name = 'note'")
        .get()?.n,
    ).toBe(0)
    backup.close()
    // The live database has the new column and the old data.
    expect(
      await rawQuery(dir, "SELECT name FROM pragma_table_info('searches') WHERE name = 'note'"),
    ).toHaveLength(1)
    expect(v2.getSearch(1)?.queryRedacted).toBe('how to parse yaml')
  })

  it('keeps only the last 3 backups', () => {
    return (async () => {
      const dir = tempDir()
      const db = await openDb({ path: dbFile(dir), busyTimeoutMs: 100 })
      db.exec('CREATE TABLE t (x)')
      const made: string[] = []
      for (let i = 0; i < 5; i++) {
        const path = backupDatabase(db, dir, 1, Date.UTC(2026, 0, 1, 0, 0, i), 100 + i, 3)
        utimesSync(path, new Date(2026, 0, 1, 0, 0, i), new Date(2026, 0, 1, 0, 0, i))
        made.push(path)
      }
      db.close()
      const left = readdirSync(join(dir, 'backups')).sort()
      expect(left).toHaveLength(3)
      expect(left).toEqual(
        made
          .slice(2)
          .map((p) => p.split('/').pop() ?? '')
          .sort(),
      )
    })()
  })

  it('rebuilding a parent table keeps its child rows (foreign_keys is off during the rebuild)', async () => {
    const dir = tempDir()
    const t = clock()
    const v1 = await openStore({ dataDir: dir, appVersion: '0.1.0', now: t })
    for (let i = 0; i < 4; i++) {
      v1.recordSearch(
        searchInput({
          receiptId: `r${i}`,
          results: searchInput().results.concat(searchInput({}).results),
        }),
      )
    }
    const count = async (table: string): Promise<number> =>
      (await rawQuery<{ n: number }>(dir, `SELECT count(*) AS n FROM ${table}`))[0]?.n ?? -1
    const before = {
      searches: await count('searches'),
      results: await count('results'),
      payloads: await count('result_payloads'),
    }
    expect(before).toEqual({ searches: 4, results: 8, payloads: 8 })
    v1.close()

    const v3 = await open(dir, t, { appVersion: '0.3.0', migrations: V3 })
    expect(v3.status()).toMatchObject({ migration: 'migrated', schemaVersion: 3 })
    expect({
      searches: await count('searches'),
      results: await count('results'),
      payloads: await count('result_payloads'),
    }).toEqual(before)
    expect(await rawQuery(dir, 'PRAGMA foreign_key_check')).toEqual([])
    expect(
      await rawQuery(dir, "SELECT name FROM pragma_table_info('searches') WHERE name = 'rebuilt'"),
    ).toHaveLength(1)
    // ids and AUTOINCREMENT survive the rebuild, so a new search continues the sequence.
    const next = v3.recordSearch(searchInput({ receiptId: 'after' }))
    expect(next).toMatchObject({ status: 'recorded', searchId: 5 })
    // Foreign keys are enforced again on the migrating connection.
    const acquired = v3.jobs.acquire('probe', { gatewayId: 'g', version: '0.3.0' }, 30_000)
    if (!acquired.acquired) throw new Error('lease not acquired')
    const fk = v3.jobs.fenced(acquired.lease, (d) =>
      d.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get(),
    )
    expect(fk).toEqual({ ok: true, value: { foreign_keys: 1 } })
  })

  it('control: the same rebuild with foreign_keys ON would have deleted the children', async () => {
    const dir = tempDir()
    const store = await openStore({ dataDir: dir, appVersion: '0.1.0', now: clock() })
    store.recordSearch(searchInput())
    store.close()
    const db = await openDb({ path: dbFile(dir), busyTimeoutMs: 1000 }) // foreign_keys = ON
    db.exec(ADDITIVE.sql)
    db.exec(REBUILD_PARENT.sql)
    expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM results').get()?.n).toBe(0)
    db.close()
  })

  it('a failing migration rolls back completely, releases its claim and reports migration_failed', async () => {
    const dir = tempDir()
    const t = clock()
    const v1 = await openStore({ dataDir: dir, appVersion: '0.1.0', now: t })
    v1.recordSearch(searchInput())
    v1.close()

    const broken = await open(dir, t, { appVersion: '0.2.0', migrations: [...MIGRATIONS, BROKEN] })
    expect(broken.status()).toMatchObject({
      mode: 'no-history',
      reason: 'migration_failed',
      migration: 'failed',
    })
    expect(broken.recordSearch(searchInput()).status).toBe('skipped')
    const [meta] = await rawQuery<Record<string, unknown>>(dir, 'SELECT * FROM meta')
    expect(meta).toMatchObject({ schema_version: 1, migrating_pid: null, migrating_until: null })
    expect(await rawQuery(dir, "SELECT name FROM sqlite_master WHERE name = 'probe_half'")).toEqual([])
    expect(backups(dir)).toHaveLength(1)

    // A fixed binary then migrates normally.
    const fixed = await open(dir, t, { appVersion: '0.2.0', migrations: V2 })
    expect(fixed.status()).toMatchObject({ mode: 'read-write', schemaVersion: 2 })
    expect(fixed.getSearch(1)).toBeDefined()
  })

  it('rolls back a migration whose foreign_key_check finds violations', async () => {
    const dir = tempDir()
    const t = clock()
    const v1 = await openStore({ dataDir: dir, appVersion: '0.1.0', now: t })
    v1.close()
    const store = await open(dir, t, { appVersion: '0.2.0', migrations: [...MIGRATIONS, FK_VIOLATION] })
    expect(store.status()).toMatchObject({ reason: 'migration_failed', schemaVersion: 1 })
    expect(store.status().message).toMatch(/foreign keys/)
    expect(await rawQuery(dir, 'SELECT count(*) AS n FROM results')).toEqual([{ n: 0 }])
  })
})

describe('election and waiting', () => {
  async function claimedBy(dir: string, until: number): Promise<void> {
    const db = await openDb({ path: dbFile(dir), busyTimeoutMs: 1000 })
    db.exec(META_SQL)
    db.prepare('UPDATE meta SET migrating_pid = 999999, migrating_until = ? WHERE id = 1').run([until])
    db.close()
  }

  it('takes over an expired claim (the previous migrator crashed)', async () => {
    const dir = tempDir()
    const t = clock()
    await claimedBy(dir, t() - 1)
    const store = await open(dir, t, { pid: 7 })
    expect(store.status()).toMatchObject({ mode: 'read-write', migration: 'migrated' })
  })

  it('waits for a live claim and then reports waited when the other process finishes', async () => {
    const dir = tempDir()
    const t = clock()
    await claimedBy(dir, t() + 120_000)
    const opening = open(dir, t, { migrationWaitMs: 10_000 })
    await new Promise((r) => setTimeout(r, 400))
    // The "other process" completes: schema applied, claim cleared.
    const other = await openDb({ path: dbFile(dir), busyTimeoutMs: 1000 })
    other.tx('exclusive', () => {
      other.exec(MIGRATIONS[0]?.sql ?? '')
      other.exec(
        "UPDATE meta SET schema_version = 1, last_migrated_by = '0.1.0', migrating_pid = NULL, migrating_until = NULL",
      )
    })
    other.close()
    const store = await opening
    expect(store.status()).toMatchObject({ mode: 'read-write', migration: 'waited', schemaVersion: 1 })
  })

  it('gives up waiting for a live claim and degrades to no-history instead of throwing', async () => {
    const dir = tempDir()
    const t = clock()
    await claimedBy(dir, t() + 120_000)
    const store = await open(dir, t, { migrationWaitMs: 150 })
    expect(store.status()).toMatchObject({ mode: 'no-history', reason: 'migration_failed' })
    expect(store.status().message).toMatch(/still upgrading/)
  })
})

describe('deferred migration', () => {
  it("migrate: 'defer' serves without logging until runMigration() finishes", async () => {
    const dir = tempDir()
    const store = await open(dir, clock(), { migrate: 'defer' })
    expect(store.status()).toMatchObject({
      mode: 'no-history',
      reason: 'migration_pending',
      migration: 'pending',
    })
    expect(store.recordSearch(searchInput())).toMatchObject({ status: 'skipped', reason: 'no-history' })
    expect(store.listSearchesAfter(0, 10)).toEqual([])
    expect(existsSync(dbFile(dir))).toBe(true)
    const status = await store.runMigration()
    expect(status).toMatchObject({ mode: 'read-write', migration: 'migrated' })
    expect(store.recordSearch(searchInput()).status).toBe('recorded')
  })

  it('opening twice in one process is harmless', async () => {
    const dir = tempDir()
    const [a, b] = await Promise.all([open(dir, clock()), open(dir, clock())])
    expect([a.status().mode, b.status().mode]).toEqual(['read-write', 'read-write'])
    expect([a.status().migration, b.status().migration].sort()).toEqual(['current', 'migrated'])
    autoClose(a)
  })
})
