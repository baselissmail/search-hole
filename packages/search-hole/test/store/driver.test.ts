// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Db, isBusyError, isSqliteExperimentalWarning, openDb } from '../../src/store/driver.ts'
import { tempDir } from './helpers.ts'

const pragma = (db: Db, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]
const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8)

describe('openDb', () => {
  it('applies the ADR-0003 pragma set', async () => {
    const dir = tempDir()
    const db = await openDb({ path: join(dir, 'a.db'), busyTimeoutMs: 100 })
    expect(pragma(db, 'journal_mode')).toBe('wal')
    expect(pragma(db, 'synchronous')).toBe(1) // NORMAL
    expect(pragma(db, 'busy_timeout')).toBe(100)
    expect(pragma(db, 'foreign_keys')).toBe(1)
    expect(pragma(db, 'journal_size_limit')).toBe(33_554_432)
    expect(pragma(db, 'cache_size')).toBe(-8000)
    db.close()
  })

  it('uses the requested busy timeout (5000 for the CLI)', async () => {
    const db = await openDb({ path: join(tempDir(), 'a.db'), busyTimeoutMs: 5000 })
    expect(pragma(db, 'busy_timeout')).toBe(5000)
    db.close()
  })

  it('sets auto_vacuum=INCREMENTAL only when creating the file, before the first table', async () => {
    const dir = tempDir()
    const path = join(dir, 'a.db')
    const first = await openDb({ path, busyTimeoutMs: 100 })
    first.exec('CREATE TABLE t (x)')
    expect(pragma(first, 'auto_vacuum')).toBe(2)
    first.close()
    // Reopening an existing file must not try to change it.
    const second = await openDb({ path, busyTimeoutMs: 100 })
    expect(pragma(second, 'auto_vacuum')).toBe(2)
    second.close()
  })

  it.skipIf(process.platform === 'win32')(
    'creates the data dir 0700 and db, wal and shm files 0600',
    async () => {
      const dir = join(tempDir(), 'nested', 'data')
      const path = join(dir, 'a.db')
      const db = await openDb({ path, busyTimeoutMs: 100 })
      db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)')
      expect(mode(dir)).toBe('700')
      expect(mode(path)).toBe('600')
      expect(existsSync(`${path}-wal`)).toBe(true)
      expect(mode(`${path}-wal`)).toBe('600')
      expect(mode(`${path}-shm`)).toBe('600')
      db.close()
    },
  )

  it('works in memory', async () => {
    const db = await openDb({ path: ':memory:', busyTimeoutMs: 100 })
    db.exec('CREATE TABLE t (x INTEGER)')
    db.prepare('INSERT INTO t VALUES (?)').run([7])
    expect(db.prepare<{ x: number }>('SELECT x FROM t').all()).toEqual([{ x: 7 }])
    db.close()
  })

  it('rejects a path whose parent is a file with store_unavailable', async () => {
    const dir = tempDir()
    const db = await openDb({ path: join(dir, 'f.db'), busyTimeoutMs: 100 })
    db.close()
    await expect(openDb({ path: join(dir, 'f.db', 'x.db'), busyTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'store_unavailable',
    })
  })
})

describe('Db', () => {
  const memory = (): Promise<Db> => openDb({ path: ':memory:', busyTimeoutMs: 100 })

  it('binds positional and named parameters and reports changes', async () => {
    const db = await memory()
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)')
    const insert = db.prepare('INSERT INTO t (a, b) VALUES ($a, $b)')
    expect(insert.run({ a: 'x', b: 1 })).toEqual({ changes: 1, lastInsertRowid: 1 })
    expect(db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(['y', 2]).lastInsertRowid).toBe(2)
    expect(
      db
        .prepare<{ a: string }>('SELECT a FROM t WHERE b > ? ORDER BY id')
        .all([0])
        .map((r) => r.a),
    ).toEqual(['x', 'y'])
    expect(db.prepare('SELECT a FROM t WHERE id = ?').get([99])).toBeUndefined()
    expect(() => insert.run({ a: 'x', b: 1, extra: 3 })).toThrow() // unknown named parameter
    db.close()
  })

  it('commits when the callback returns and rolls back when it throws', async () => {
    const db = await memory()
    db.exec('CREATE TABLE t (x)')
    expect(db.tx('immediate', () => db.prepare('INSERT INTO t VALUES (1)').run().changes)).toBe(1)
    expect(() =>
      db.tx('exclusive', () => {
        db.prepare('INSERT INTO t VALUES (2)').run()
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM t').get()?.n).toBe(1)
    db.close()
  })

  it('refuses nested and asynchronous transactions, and recovers afterwards', async () => {
    const db = await memory()
    db.exec('CREATE TABLE t (x)')
    expect(() => db.tx('immediate', () => db.tx('immediate', () => 1))).toThrow(/nested/)
    expect(() => db.tx('immediate', () => Promise.resolve(1))).toThrow(/synchronous/)
    expect(db.tx('immediate', () => 'fine')).toBe('fine')
    db.close()
  })

  it('throws after close and close is idempotent', async () => {
    const db = await memory()
    db.close()
    db.close()
    expect(db.closed).toBe(true)
    expect(() => db.exec('SELECT 1')).toThrow(/closed/)
  })

  it('classifies SQLITE_BUSY from a second connection holding the write lock', async () => {
    const dir = tempDir()
    const path = join(dir, 'a.db')
    const a = await openDb({ path, busyTimeoutMs: 20 })
    const b = await openDb({ path, busyTimeoutMs: 20 })
    a.exec('CREATE TABLE t (x)')
    a.exec('BEGIN IMMEDIATE')
    let caught: unknown
    try {
      b.tx('immediate', () => 1)
    } catch (e) {
      caught = e
    }
    expect(isBusyError(caught)).toBe(true)
    expect(isBusyError(new Error('plain'))).toBe(false)
    expect(isBusyError(null)).toBe(false)
    a.exec('ROLLBACK')
    expect(b.tx('immediate', () => 'ok')).toBe('ok') // the failed attempt left no transaction behind
    a.close()
    b.close()
  })
})

describe('the Node 22 ExperimentalWarning filter', () => {
  it('matches only the SQLite experimental warning', () => {
    const msg = 'SQLite is an experimental feature and might change at any time'
    expect(isSqliteExperimentalWarning(msg, ['ExperimentalWarning'])).toBe(true)
    expect(isSqliteExperimentalWarning(msg, [{ type: 'ExperimentalWarning' }])).toBe(true)
    expect(
      isSqliteExperimentalWarning(Object.assign(new Error(msg), { name: 'ExperimentalWarning' }), []),
    ).toBe(true)
    expect(
      isSqliteExperimentalWarning('Type stripping is an experimental feature', ['ExperimentalWarning']),
    ).toBe(false)
    expect(isSqliteExperimentalWarning(msg, ['DeprecationWarning'])).toBe(false)
  })

  it('restores process.emitWarning after loading the module', async () => {
    const before = process.emitWarning
    await openDb({ path: ':memory:', busyTimeoutMs: 100 }).then((db) => db.close())
    expect(process.emitWarning).toBe(before)
  })
})
