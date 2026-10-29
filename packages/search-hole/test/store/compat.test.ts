// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import type { Warning } from '../../src/shared/types.ts'
import { decideMode } from '../../src/store/compat.ts'
import { openDb } from '../../src/store/driver.ts'
import type { MetaRow } from '../../src/store/queries/meta.ts'
import { encodeUserVersion } from '../../src/store/version.ts'
import { clock, open, searchInput, tempDir, V2, V4 } from './helpers.ts'

const meta = (over: Partial<MetaRow> = {}): MetaRow => ({
  schemaVersion: 1,
  minReaderVersion: '0.0.0',
  minWriterVersion: '0.0.0',
  lastMigratedBy: '0.1.0',
  dataEpoch: 0,
  migratingPid: null,
  migratingUntil: null,
  ...over,
})

describe('decideMode (ADR-0006 point 5)', () => {
  const input = { appVersion: '0.4.0', latestSchema: 3 }

  it('is read-write when current, or when only the schema is newer (additive)', () => {
    expect(decideMode(meta({ schemaVersion: 3 }), input)).toMatchObject({ mode: 'read-write', reason: 'ok' })
    expect(decideMode(meta({ schemaVersion: 9, lastMigratedBy: '0.9.0' }), input)).toMatchObject({
      mode: 'read-write',
      needsMigration: false,
    })
  })

  it('is read-only when min_writer_version is newer than us, with the upgrade message', () => {
    const d = decideMode(
      meta({ schemaVersion: 9, minWriterVersion: '0.5.0', lastMigratedBy: '0.6.0' }),
      input,
    )
    expect(d).toMatchObject({ mode: 'read-only', reason: 'writer_too_old', needsMigration: false })
    expect(d.message).toBe(
      'search-hole v0.4.0 is older than your data (v0.6.0); update search-hole. Searches still run, but are not logged.',
    )
  })

  it('has no history when min_reader_version is newer than us, and that wins over the writer check', () => {
    const d = decideMode(meta({ minReaderVersion: '1.0.0', minWriterVersion: '1.0.0' }), input)
    expect(d).toMatchObject({ mode: 'no-history', reason: 'reader_too_old', needsMigration: false })
  })

  it('asks for a migration when the schema is behind or meta is missing', () => {
    expect(decideMode(meta({ schemaVersion: 2 }), input)).toMatchObject({
      reason: 'migration_pending',
      needsMigration: true,
    })
    expect(decideMode(undefined, input)).toMatchObject({ mode: 'no-history', needsMigration: true })
  })

  it('does not migrate a database it is too old to write', () => {
    const d = decideMode(meta({ schemaVersion: 1, minWriterVersion: '0.5.0' }), {
      appVersion: '0.4.0',
      latestSchema: 3,
    })
    expect(d).toMatchObject({ mode: 'read-only', needsMigration: false })
  })
})

describe('two versions sharing one database (ADR-0006 validate: two-version test)', () => {
  it('stays read-write across an additive migration, then goes read-only after a writer-breaking one', async () => {
    const dir = tempDir()
    const t = clock()
    const warnings: Warning[] = []
    // v0.1.0 knows only schema 1.
    const old = await open(dir, t, { appVersion: '0.1.0', onWarning: (w) => warnings.push(w) })
    expect(old.status()).toMatchObject({ mode: 'read-write', schemaVersion: 1 })

    // v0.2.0 ships an additive migration: min_writer_version is unchanged.
    const middle = await open(dir, t, { appVersion: '0.2.0', migrations: V2 })
    expect(middle.status()).toMatchObject({
      mode: 'read-write',
      migration: 'migrated',
      schemaVersion: 2,
      minWriterVersion: '0.0.0',
    })
    // The old binary keeps writing, with explicit column lists that ignore the new column.
    expect(old.recordSearch(searchInput({ receiptId: 'from-old' })).status).toBe('recorded')
    // And a freshly started old binary sees a newer schema but is still read-write.
    const oldAgain = await open(dir, t, { appVersion: '0.1.0' })
    expect(oldAgain.status()).toMatchObject({ mode: 'read-write', reason: 'ok', schemaVersion: 2 })

    // v0.4.0 contracts: min_writer_version becomes 0.3.0 and user_version follows.
    const newest = await open(dir, t, { appVersion: '0.4.0', migrations: V4 })
    expect(newest.status()).toMatchObject({ mode: 'read-write', schemaVersion: 4, minWriterVersion: '0.3.0' })
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    expect(raw.prepare<{ user_version: number }>('PRAGMA user_version').get()?.user_version).toBe(
      encodeUserVersion('0.3.0'),
    )
    raw.close()

    // The already-running v0.1.0 process notices on its next write and degrades, without throwing.
    expect(old.status().mode).toBe('read-write')
    const skipped = old.recordSearch(searchInput({ receiptId: 'after-contract' }))
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'read-only' })
    expect(skipped.status === 'skipped' && skipped.warning).toMatchObject({ code: 'logging_unavailable' })
    expect(old.status()).toMatchObject({ mode: 'read-only', reason: 'writer_too_old' })
    expect(old.status().message).toContain('v0.1.0 is older than your data (v0.4.0)')
    expect(warnings.some((w) => w.code === 'logging_unavailable')).toBe(true)
    // v0.2.0 is older than 0.3.0 as well.
    expect(middle.recordSearch(searchInput()).status).toBe('skipped')
    expect(middle.status().mode).toBe('read-only')
    // v0.4.0 is unaffected, and sees the search the old binary wrote before the contraction.
    expect(newest.recordSearch(searchInput({ receiptId: 'from-new' })).status).toBe('recorded')
    expect(newest.listSearchesAfter(0, 10).map((s) => s.receiptId)).toEqual(['from-old', 'from-new'])
  })

  it('a read-only process still reads, reserves spend-cap usage, and skips jobs, health and meta writes', async () => {
    const dir = tempDir()
    const t = clock()
    const newest = await open(dir, t, { appVersion: '0.4.0', migrations: V4 })
    newest.recordSearch(searchInput({ receiptId: 'visible' }))
    const old = await open(dir, t, { appVersion: '0.1.0' })
    expect(old.status()).toMatchObject({ mode: 'read-only', reason: 'writer_too_old' })

    expect(old.getSearch(1)?.receiptId).toBe('visible') // reads work
    expect(old.recordSearch(searchInput())).toMatchObject({ status: 'skipped', reason: 'read-only' })
    expect(old.stats().skipped).toBe(1)

    // engine_usage never takes a writer-breaking change, so reservations keep working
    // and are shared with the newer process.
    const caps = { day: 2 }
    expect(old.engineUsage.reserve('brave', 'fp', caps).ok).toBe(true)
    expect(newest.engineUsage.reserve('brave', 'fp', caps).ok).toBe(true)
    expect(old.engineUsage.reserve('brave', 'fp', caps)).toMatchObject({ ok: false, reason: 'day_cap' })

    expect(old.jobs.acquire('retention', { gatewayId: 'g', version: '0.1.0' }, 30_000)).toMatchObject({
      acquired: false,
      reason: 'read_only',
    })
    expect(
      old.engineHealth.put({
        engine: 'brave',
        keyFp: 'fp',
        subEngine: '',
        state: 'healthy',
        reasonClass: null,
        until: null,
        consecutiveFailures: 0,
        ewmaSuccess: null,
        p50Ms: null,
        p95Ms: null,
        lastSuccessAt: null,
        lastErrorRedacted: null,
        keyPresent: true,
        keySource: 'env',
      }),
    ).toBe(false)
    expect(old.meta.set('k', 'v')).toBe(false)
    expect(old.retention.prune(t(), { days: 0 })).toMatchObject({ skipped: 'read-only', totalDeleted: 0 })
    // Inserting a missing key is additive, so getOrInit still works (the install secret for key_fp).
    expect(old.meta.getOrInit('install_secret', () => 'abc')).toBe('abc')
    expect(newest.meta.get('install_secret')).toBe('abc')
  })

  it('a newer min_reader_version leaves no history: nothing is read, logged or reserved', async () => {
    const dir = tempDir()
    const t = clock()
    const first = await open(dir, t)
    first.recordSearch(searchInput())
    first.close()
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 1000 })
    raw.exec("UPDATE meta SET min_reader_version = '9.0.0', last_migrated_by = '9.0.0'")
    raw.close()

    const store = await open(dir, t)
    expect(store.status()).toMatchObject({ mode: 'no-history', reason: 'reader_too_old' })
    expect(store.getSearch(1)).toBeUndefined()
    expect(store.listSearchesAfter(0, 10)).toEqual([])
    expect(store.recordSearch(searchInput())).toMatchObject({ status: 'skipped', reason: 'no-history' })
    expect(store.engineUsage.reserve('brave', 'fp', {})).toMatchObject({
      ok: false,
      reason: 'store_unavailable',
    })
    expect(store.jobs.acquire('x', { gatewayId: 'g', version: '0.1.0' }, 1000)).toMatchObject({
      acquired: false,
    })
  })

  it('a far-future schema_version with min_writer_version <= ours is normal operation', async () => {
    const dir = tempDir()
    const t = clock()
    const first = await open(dir, t)
    first.close()
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 1000 })
    raw.exec("UPDATE meta SET schema_version = 99, last_migrated_by = '0.9.0'")
    raw.close()
    const store = await open(dir, t)
    expect(store.status()).toMatchObject({ mode: 'read-write', reason: 'ok', schemaVersion: 99 })
    expect(store.recordSearch(searchInput()).status).toBe('recorded')
  })
})

describe('the user_version check (ADR-0006 point 2)', () => {
  it('stops an already-open old store from writing the moment a newer binary contracts the schema', async () => {
    const dir = tempDir()
    const t = clock()
    const store = await open(dir, t, { appVersion: '0.2.0' })
    expect(store.recordSearch(searchInput({ receiptId: 'before' })).status).toBe('recorded')

    // A newer binary raises min_writer_version and mirrors it into user_version.
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 1000 })
    raw.exec(`PRAGMA user_version = ${encodeUserVersion('0.3.0')}`)

    expect(store.status().mode).toBe('read-write') // it has not looked yet
    expect(store.recordSearch(searchInput({ receiptId: 'after' }))).toMatchObject({
      status: 'skipped',
      reason: 'read-only',
    })
    expect(store.status()).toMatchObject({ mode: 'read-only', reason: 'writer_too_old' })
    // The write transaction rolled back: nothing from the refused search is stored.
    expect(
      raw.prepare<{ n: number }>("SELECT count(*) AS n FROM searches WHERE receipt_id = 'after'").get()?.n,
    ).toBe(0)
    expect(raw.prepare<{ n: number }>("SELECT count(*) AS n FROM receipts WHERE id = 'after'").get()?.n).toBe(
      0,
    )
    // Later calls skip without touching the database.
    expect(store.recordSearch(searchInput())).toMatchObject({ status: 'skipped', reason: 'read-only' })
    expect(store.stats()).toMatchObject({ recorded: 1, skipped: 2 })
    raw.close()
  })

  it('does not stop a store whose version is high enough', async () => {
    const dir = tempDir()
    const store = await open(dir, clock(), { appVersion: '0.3.0' })
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 1000 })
    raw.exec(`PRAGMA user_version = ${encodeUserVersion('0.3.0')}`)
    expect(store.recordSearch(searchInput()).status).toBe('recorded')
    raw.close()
  })
})
