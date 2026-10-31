// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/driver.ts'
import { openStore } from '../../src/store/index.ts'
import { LATEST_SCHEMA_VERSION as L } from '../../src/store/migrations/index.ts'
import { clock, searchInput, tempDir } from './helpers.ts'
import { runWorkers } from './workers.ts'

// These tests start real Node processes that hit one database file together.
const LONG = 90_000

async function query<T extends object>(dir: string, sql: string): Promise<T[]> {
  const db = await openDb({ path: join(dir, 'searchhole.db'), busyTimeoutMs: 5000 })
  try {
    return db.prepare<T>(sql).all()
  } finally {
    db.close()
  }
}

describe('migration race (ADR-0006 validate: 20 processes at once)', () => {
  it(
    'on a fresh database exactly one process migrates and all end up read-write',
    async () => {
      const dir = tempDir()
      const outputs = await runWorkers(20, 'open', dir, { busyTimeoutMs: 5000, migrationWaitMs: 60_000 })
      expect(outputs).toHaveLength(20)
      expect(outputs.filter((o) => o.status.migration === 'migrated')).toHaveLength(1)
      for (const o of outputs) {
        expect(o.status, `pid ${o.pid}`).toMatchObject({ mode: 'read-write', reason: 'ok', schemaVersion: L })
        expect(['migrated', 'waited', 'current']).toContain(o.status.migration)
      }
      expect(await query(dir, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
      expect(await query(dir, 'SELECT schema_version, migrating_pid, migrating_until FROM meta')).toEqual([
        { schema_version: L, migrating_pid: null, migrating_until: null },
      ])
      expect(existsSync(join(dir, 'backups'))).toBe(false) // nothing to back up
      // Whoever created the file set auto_vacuum before the first table existed.
      expect(await query(dir, 'PRAGMA auto_vacuum')).toEqual([{ auto_vacuum: 2 }])
      expect(
        await query(
          dir,
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'searches'",
        ),
      ).toEqual([{ n: 1 }])
    },
    LONG,
  )

  it(
    'on an old database exactly one process backs up and migrates, and nobody sees a half-applied schema',
    async () => {
      const dir = tempDir()
      // Seed schema 1 with data, as an old install would have.
      const seed = await openStore({ dataDir: dir, appVersion: '0.1.0', now: clock() })
      for (let i = 0; i < 800; i++) seed.recordSearch(searchInput({ receiptId: `seed-${i}` }))
      seed.close()

      const outputs = await runWorkers(20, 'open', dir, {
        appVersion: '0.2.0',
        migrations: 'V2',
        busyTimeoutMs: 5000,
        migrationWaitMs: 60_000,
      })
      expect(outputs.filter((o) => o.status.migration === 'migrated')).toHaveLength(1)
      for (const o of outputs)
        expect(o.status, `pid ${o.pid}`).toMatchObject({ mode: 'read-write', schemaVersion: L + 1 })

      const backups = readdirSync(join(dir, 'backups'))
      expect(backups).toHaveLength(1)
      expect(backups[0]).toMatch(new RegExp(`^searchhole-v${L}-`))
      expect(
        await query(dir, "SELECT name FROM pragma_table_info('searches') WHERE name = 'note'"),
      ).toHaveLength(1)
      expect(await query(dir, 'SELECT count(*) AS n FROM searches')).toEqual([{ n: 800 }])
      expect(await query(dir, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
    },
    LONG,
  )
})

describe('concurrent writers (ADR-0003 validate)', () => {
  it(
    '8 processes recording searches while a tail reads: no lost rows, no duplicates, ascending ids',
    async () => {
      const dir = tempDir()
      const parent = await openStore({ dataDir: dir, appVersion: '0.1.0', now: () => Date.now() })
      const PER_WORKER = 100
      const WORKERS = 8
      const expected = PER_WORKER * WORKERS

      const workers = runWorkers(WORKERS, 'record', dir, { count: PER_WORKER })
      // The dashboard tail polls the rowid cursor while the writers run.
      const seen: number[] = []
      let cursor = 0
      let finished = false
      void workers.finally(() => {
        finished = true
      })
      const deadline = Date.now() + 60_000
      while ((!finished || seen.length < expected) && Date.now() < deadline) {
        const rows = parent.listSearchesAfter(cursor, 200)
        for (const r of rows) seen.push(r.id)
        if (rows.length > 0) cursor = rows[rows.length - 1]?.id ?? cursor
        else await new Promise((r) => setTimeout(r, 10))
      }
      const outputs = await workers

      expect(outputs.reduce((n, o) => n + (o.stats?.recorded ?? 0), 0)).toBe(expected)
      expect(outputs.reduce((n, o) => n + (o.stats?.dropped ?? 0), 0)).toBe(0)
      expect(await query(dir, 'SELECT count(*) AS n FROM searches')).toEqual([{ n: expected }])
      expect(await query(dir, 'SELECT count(*) AS n FROM results')).toEqual([{ n: expected * 3 }])
      expect(await query(dir, 'SELECT count(*) AS n FROM result_payloads')).toEqual([{ n: expected * 3 }])
      expect(await query(dir, 'SELECT count(DISTINCT id) AS n, max(id) AS top FROM searches')).toEqual([
        { n: expected, top: expected },
      ])
      expect(await query(dir, 'SELECT search_count AS n FROM receipts ORDER BY id LIMIT 1')).toEqual([
        { n: PER_WORKER },
      ])
      expect(await query(dir, "SELECT searches AS n FROM daily_stats WHERE engine = '*'")).toEqual([
        { n: expected },
      ])
      // The tail saw every row exactly once, in order.
      expect(seen).toEqual(Array.from({ length: expected }, (_, i) => i + 1))
      // The ADR budget is p95 < 20 ms on a quiet disk; assert a generous bound so CI noise cannot flake.
      const p95s = outputs.map((o) => o.p95 ?? 0)
      expect(Math.max(...p95s)).toBeLessThan(500)
      parent.close()
    },
    LONG,
  )
})

describe('spend-cap race (ADR-0009 validate)', () => {
  it(
    '8 processes, 200 attempts, a cap of 100: exactly 100 calls are granted',
    async () => {
      const dir = tempDir()
      const parent = await openStore({ dataDir: dir, appVersion: '0.1.0', now: () => Date.now() })
      const outputs = await runWorkers(8, 'reserve', dir, { count: 25, cap: 100, busyTimeoutMs: 5000 })
      const granted = outputs.reduce((n, o) => n + (o.granted ?? 0), 0)
      const denied = outputs.reduce((n, o) => n + (o.denied ?? 0), 0)
      expect(granted).toBe(100)
      expect(denied).toBe(100)
      expect(parent.engineUsage.counts('brave', 'fp1')).toEqual({ day: 100, month: 100 })
      parent.close()
    },
    LONG,
  )
})
