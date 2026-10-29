// SPDX-License-Identifier: Apache-2.0
/**
 * The SQLite driver port (ADR-0003 point 1): a small interface over `node:sqlite`.
 * Everything else in `store/` talks to `Db`, never to the native module, so tests can
 * use `:memory:` and a better-sqlite3 or `bun:sqlite` adapter can be swapped in later.
 *
 * The native module is resolved as `Database ?? DatabaseSync` (Node 26.11 renamed the
 * class and kept the old name as an alias). On Node 22 importing `node:sqlite` prints an
 * ExperimentalWarning; only that one warning is suppressed.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { SearchHoleError } from '../shared/errors.ts'

export type SqlValue = string | number | bigint | null | Uint8Array
export type Row = Readonly<Record<string, SqlValue>>
export type NamedParams = Readonly<Record<string, SqlValue>>
/** Positional (`?`) or named (`$name`, bare keys) parameters. */
export type Params = readonly SqlValue[] | NamedParams

export interface RunResult {
  readonly changes: number
  readonly lastInsertRowid: number
}

export interface Stmt<T extends object = Row> {
  all(params?: Params): T[]
  get(params?: Params): T | undefined
  run(params?: Params): RunResult
}

export type TxMode = 'immediate' | 'exclusive'

export interface Db {
  readonly path: string
  readonly closed: boolean
  exec(sql: string): void
  /** Statements are cached per SQL text for the life of the connection. */
  prepare<T extends object = Row>(sql: string): Stmt<T>
  /**
   * Runs `fn` inside BEGIN IMMEDIATE / BEGIN EXCLUSIVE. Commits when `fn` returns and rolls
   * back when it throws. `fn` must be synchronous and transactions cannot nest.
   */
  tx<R>(mode: TxMode, fn: () => R): R
  close(): void
}

interface NativeStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}
interface NativeDatabase {
  exec(sql: string): void
  prepare(sql: string): NativeStatement
  close(): void
}
type NativeCtor = new (path: string) => NativeDatabase

// SQLite primary result codes (the low byte of errcode, which may be an extended code).
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/** True for SQLITE_BUSY / SQLITE_LOCKED, which are retryable. */
export function isBusyError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('errcode' in e)) return false
  const code = (e as { errcode: unknown }).errcode
  return typeof code === 'number' && ((code & 0xff) === SQLITE_BUSY || (code & 0xff) === SQLITE_LOCKED)
}

/** True for Node 22's one-time "SQLite is an experimental feature" warning. Exported for tests. */
export function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[]): boolean {
  const first = rest[0]
  const type =
    typeof first === 'string'
      ? first
      : typeof first === 'object' && first !== null && 'type' in first
        ? String((first as { type: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : ''
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : ''
  return type === 'ExperimentalWarning' && /sqlite/i.test(message)
}

let nativeCtor: Promise<NativeCtor> | undefined

async function importNative(): Promise<NativeCtor> {
  const original = process.emitWarning
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) return
    Reflect.apply(original, process, [warning, ...rest])
  }
  process.emitWarning = filtered as unknown as typeof process.emitWarning
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      Database?: NativeCtor
      DatabaseSync?: NativeCtor
    }
    const ctor = mod.Database ?? mod.DatabaseSync
    if (!ctor) throw new Error('node:sqlite exports neither Database nor DatabaseSync')
    return ctor
  } catch (cause) {
    throw new SearchHoleError('store_unavailable', 'This Node.js has no built-in SQLite (node:sqlite).', {
      fix: 'Use Node.js 22.13 or newer.',
      cause,
    })
  } finally {
    process.emitWarning = original
  }
}

/** Resolves the native SQLite class once per process. */
export function loadSqlite(): Promise<NativeCtor> {
  nativeCtor ??= importNative()
  return nativeCtor
}

export interface OpenDbOptions {
  /** File path or `:memory:`. The parent directory is created `0700`, the file `0600`. */
  path: string
  /** Applied after setup. ADR-0003: 100 on the search path, 5000 for migrations and the CLI. */
  busyTimeoutMs: number
}

/** busy_timeout used only while configuring a connection (WAL switch can race other openers). */
const SETUP_BUSY_MS = 5000
const SETUP_ATTEMPTS = 20
const STATEMENT_CACHE_LIMIT = 256

function ensureDir(dir: string): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Only tighten directories we created; never touch a pre-existing user directory.
  if (created !== undefined) chmodSync(dir, 0o700)
}

/** Creates the DB file `0600` before SQLite does (SQLite gives -wal/-shm the same mode). True when new. */
function prepareFile(path: string): boolean {
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  return statSync(path).size === 0
}

function chmodSidecars(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      chmodSync(path + suffix, 0o600)
    } catch {
      // The sidecar may not exist yet, or the platform ignores modes.
    }
  }
}

function configure(native: NativeDatabase, memory: boolean, isNew: boolean, requestedBusyMs: number): void {
  const busyTimeoutMs = Number.isFinite(requestedBusyMs) ? Math.max(0, Math.floor(requestedBusyMs)) : 100
  native.exec(`PRAGMA busy_timeout = ${Math.max(SETUP_BUSY_MS, busyTimeoutMs)}`)
  // auto_vacuum only takes effect before the first table exists (ADR-0003 point 3).
  if (isNew) native.exec('PRAGMA auto_vacuum = INCREMENTAL')
  if (!memory) native.exec('PRAGMA journal_mode = WAL')
  native.exec('PRAGMA synchronous = NORMAL')
  native.exec('PRAGMA foreign_keys = ON')
  native.exec('PRAGMA journal_size_limit = 33554432')
  native.exec('PRAGMA cache_size = -8000')
  native.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
  )
}

function bind(params: Params | undefined): unknown[] {
  if (params === undefined) return []
  return Array.isArray(params) ? [...params] : [params]
}

/** Opens a connection with the ADR-0003 pragma set. Rejects with `store_unavailable` on failure. */
export async function openDb(opts: OpenDbOptions): Promise<Db> {
  const Ctor = await loadSqlite()
  const memory = opts.path === ':memory:'
  let isNew = true
  try {
    if (!memory) {
      ensureDir(dirname(opts.path))
      isNew = prepareFile(opts.path)
    }
  } catch (cause) {
    throw new SearchHoleError(
      'store_unavailable',
      `Cannot create the search-hole data folder at ${dirname(opts.path)}.`,
      {
        fix: 'Check the folder permissions, or set SEARCHHOLE_HOME to a writable location.',
        cause,
      },
    )
  }
  let native: NativeDatabase | undefined
  for (let attempt = 1; ; attempt++) {
    try {
      native ??= new Ctor(opts.path)
      configure(native, memory, isNew, opts.busyTimeoutMs)
      break
    } catch (cause) {
      if (isBusyError(cause) && attempt < SETUP_ATTEMPTS) {
        await sleep(10 + attempt * 15)
        continue
      }
      try {
        native?.close()
      } catch {
        // Already unusable.
      }
      throw new SearchHoleError(
        'store_unavailable',
        `Cannot open the search-hole database at ${opts.path}.`,
        {
          fix: 'Run `searchhole doctor`. If the file is damaged, move it aside and restart.',
          cause,
        },
      )
    }
  }
  if (!memory) chmodSidecars(opts.path)
  return wrap(native, opts.path)
}

function wrap(native: NativeDatabase, path: string): Db {
  const cache = new Map<string, NativeStatement>()
  let inTx = false
  let closed = false

  const guard = (): void => {
    if (closed) throw new Error('database is closed')
  }
  const stmt = (sql: string): NativeStatement => {
    guard()
    let st = cache.get(sql)
    if (!st) {
      if (cache.size >= STATEMENT_CACHE_LIMIT) cache.clear()
      st = native.prepare(sql)
      cache.set(sql, st)
    }
    return st
  }

  return {
    path,
    get closed() {
      return closed
    },
    exec(sql) {
      guard()
      native.exec(sql)
    },
    prepare<T extends object>(sql: string): Stmt<T> {
      stmt(sql) // fail fast on bad SQL
      return {
        all: (params) => stmt(sql).all(...bind(params)) as T[],
        get: (params) => (stmt(sql).get(...bind(params)) ?? undefined) as T | undefined,
        run: (params) => {
          const r = stmt(sql).run(...bind(params))
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
        },
      }
    },
    tx(mode, fn) {
      guard()
      if (inTx) throw new Error('nested transactions are not supported')
      native.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN EXCLUSIVE')
      inTx = true
      try {
        const result = fn()
        if (isThenable(result)) throw new TypeError('db.tx callbacks must be synchronous')
        native.exec('COMMIT')
        inTx = false
        return result
      } catch (e) {
        inTx = false
        try {
          native.exec('ROLLBACK')
        } catch {
          // The transaction may already have been rolled back by SQLite.
        }
        throw e
      }
    },
    close() {
      if (closed) return
      closed = true
      cache.clear()
      native.close()
    },
  }
}
