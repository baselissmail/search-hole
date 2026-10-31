// SPDX-License-Identifier: Apache-2.0
/**
 * Lazy access to the SQLite store (ADR-0006 point 6, ADR-0013): nothing is opened at
 * construction. Read paths never create a database that does not exist yet and never run a
 * migration; write paths create the file and run a pending migration first. When the store
 * cannot be opened, callers get null and search keeps working without history.
 */
import { existsSync } from 'node:fs'
import { isSearchHoleError } from '../shared/errors.ts'
import type { Logger } from '../shared/log.ts'
import type { Warning } from '../shared/types.ts'
import { openStore, type Store } from '../store/index.ts'

/** How long a failed open is remembered before trying again. */
const RETRY_OPEN_MS = 30_000
/** Longest a request waits for another process's migration before serving without history. */
const MIGRATION_WAIT_MS = 3_000

export interface StoreGateOptions {
  dataDir: string
  dbPath: string
  appVersion: string
  now: () => number
  busyTimeoutMs: number
  logger: Logger
  /**
   * Reads may run a pending migration (CLI only: a terminal command is an explicit user
   * request). Hosts keep reads side-effect free; their first write migrates (ADR-0006 point 6).
   */
  readonly migrateOnRead?: boolean
}

/** Opens the store on first need and remembers why it is unavailable. */
export class StoreGate {
  private store: Store | null = null
  private opening: Promise<Store | null> | null = null
  private migrating: Promise<void> | null = null
  private failedAt: number | null = null
  private failure: string | null = null

  private readonly o: StoreGateOptions

  constructor(o: StoreGateOptions) {
    this.o = o
  }

  /** Why the store is unavailable, if it is. */
  get unavailableReason(): string | null {
    return this.store === null ? this.failure : null
  }

  /** The open store, without opening it. */
  peek(): Store | null {
    return this.store
  }

  /** For reads: the store if it exists or is already open; never creates the file, never migrates. */
  async read(): Promise<Store | null> {
    if (!this.store && !existsSync(this.o.dbPath)) return null
    // Without this, an older (compatible) database reads as empty until the first write.
    if (this.o.migrateOnRead === true) return this.write()
    return this.store ?? this.open()
  }

  /** For writes: opens (creating the file) and runs a pending migration first. */
  async write(): Promise<Store | null> {
    const store = this.store ?? (await this.open())
    if (!store) return null
    if (store.status().migration === 'pending') {
      this.migrating ??= store
        .runMigration()
        .then((s) => {
          if (s.mode !== 'read-write') this.o.logger.warn({ mode: s.mode, reason: s.reason }, s.message)
        })
        .catch((e: unknown) => {
          this.o.logger.warn({ err: e }, 'store migration failed')
        })
        .finally(() => {
          this.migrating = null
        })
      await this.migrating
    }
    return store
  }

  /** A `logging_unavailable` warning when the store cannot log, else null. */
  loggingWarning(): Warning | null {
    const s = this.store
    if (!s) return { code: 'logging_unavailable', detail: this.failure ?? 'the search log is not open' }
    const status = s.status()
    return status.mode === 'read-write' ? null : { code: 'logging_unavailable', detail: status.message }
  }

  async close(): Promise<void> {
    const pending = this.opening
    if (pending) await pending.catch(() => null)
    if (this.migrating) await this.migrating
    this.store?.close()
    this.store = null
  }

  private open(): Promise<Store | null> {
    if (this.failedAt !== null && this.o.now() - this.failedAt < RETRY_OPEN_MS) return Promise.resolve(null)
    this.opening ??= openStore({
      dataDir: this.o.dataDir,
      appVersion: this.o.appVersion,
      now: this.o.now,
      busyTimeoutMs: this.o.busyTimeoutMs,
      migrate: 'defer',
      migrationWaitMs: MIGRATION_WAIT_MS,
      onWarning: (w) => {
        if (w.code === 'logging_unavailable') this.o.logger.warn({ code: w.code }, w.detail)
      },
    })
      .then((s) => {
        this.store = s
        this.failure = null
        this.failedAt = null
        return s
      })
      .catch((e: unknown) => {
        this.failure = isSearchHoleError(e) ? e.why : 'the search-hole database could not be opened'
        this.failedAt = this.o.now()
        this.o.logger.warn({ err: e }, 'store unavailable; searches run without history')
        return null
      })
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }
}
