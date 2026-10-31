// SPDX-License-Identifier: Apache-2.0
/**
 * The SQLite store (ADR-0003, ADR-0006): one connection per process, typed queries, and the
 * write discipline that keeps many gateways sharing one file:
 *
 * - every write is one BEGIN IMMEDIATE transaction that re-reads `PRAGMA user_version` first
 *   and switches the store to read-only if a newer binary has contracted the schema;
 * - a busy log write goes to an in-memory retry queue and never blocks or fails a search;
 * - read-only (`min_writer_version` newer than us) still allows `engine_usage` reservations;
 * - `no-history` (`min_reader_version` newer, or the schema is not ready) logs nothing.
 *
 * All timestamps are epoch milliseconds from the injected clock.
 */
import { join } from 'node:path'
import { SearchHoleError } from '../shared/errors.ts'
import type { Warning } from '../shared/types.ts'
import { decideMode, type ModeDecision, writerTooOld } from './compat.ts'
import { type Db, isBusyError, openDb } from './driver.ts'
import { migrate } from './migrate.ts'
import { latestSchemaOf, MIGRATIONS } from './migrations/index.ts'
import { insertFetch, listFetchesByReceipt } from './queries/fetches.ts'
import { getHealth, listHealth, putHealth } from './queries/health.ts'
import {
  acquireLease,
  getJob,
  leaseHolds,
  listJobs,
  patchJob,
  releaseLease,
  renewLease,
} from './queries/jobs.ts'
import { getSearchLog, hiddenReasonCounts, listRecentSearches, listSearchesByReceipt } from './queries/log.ts'
import {
  bumpDataEpoch,
  kvGet,
  kvInsertIfAbsent,
  kvSet,
  type MetaRow,
  MetaUnreadable,
  readDataEpoch,
  readMeta,
  readUserVersion,
} from './queries/meta.ts'
import { DEFAULTS, pruneSteps } from './queries/retention.ts'
import {
  clearSessionRules,
  deleteSessionRule,
  deleteTrust,
  findPendingSuggestion,
  getSuggestion,
  getTrust,
  insertSessionRule,
  insertSuggestion,
  latestLastGood,
  listSessionRules,
  listSuggestions,
  putLastGood,
  putTrust,
  resolveSuggestion,
} from './queries/rules.ts'
import { getSearch, listResults, listSearchesAfter, maxSearchId, writePlan } from './queries/searches.ts'
import {
  claimTurn,
  countDuplicateReceipts,
  ensureReceipt,
  getReceipt,
  getSession,
  latestReceiptForSession,
  listGateways,
  setReceiptClosed,
  upsertGateway,
  upsertSession,
} from './queries/sessions.ts'
import { readCounts, refundUsage, reserveUsage } from './queries/usage.ts'
import { planBuiltinRecord, planRecord, type RecordPlan } from './record.ts'
import { RETRY_MAX_AGE_MS, RetryQueue } from './retry-queue.ts'
import type {
  AcquireResult,
  FencedResult,
  FlushReport,
  JobPatch,
  Lease,
  LeaseFailure,
  LeaseWrite,
  MigrationState,
  OpenStoreOptions,
  PruneReport,
  RecordBuiltinInput,
  RecordSearchInput,
  RecordSearchResult,
  ReserveResult,
  SkipReason,
  Store,
  StoreStatus,
} from './types.ts'
import { encodeUserVersion } from './version.ts'

export type { Migration } from './migrations/index.ts'
export { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.ts'
export { BUILTIN_ENGINE } from './queries/log.ts'
export { urlHash } from './record.ts'
export type * from './types.ts'
export { SHARED_KEY_FP } from './types.ts'

const DB_FILE = 'searchhole.db'
const MAX_SEARCHES_PER_TAIL = 500
const CHECKPOINT_MODES: ReadonlySet<string> = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'])

type WriteOutcome<R> =
  | { kind: 'ok'; value: R }
  | { kind: 'busy' }
  | { kind: 'skipped'; reason: Exclude<SkipReason, 'error'> }
  | { kind: 'error'; error: unknown }

/** Thrown inside a write transaction to roll it back when a newer binary has contracted the schema. */
class WriterTooOld extends Error {}
/** Thrown inside a fenced transaction when the lease epoch no longer matches. */
class LeaseLost extends Error {}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)

/**
 * Opens (and, unless `migrate: 'defer'`, migrates) the store. Throws `store_unavailable` only
 * when the database cannot be opened at all; a newer schema never throws, it yields `read-only`
 * or `no-history` mode (see `Store.status()`).
 */
export async function openStore(opts: OpenStoreOptions): Promise<Store> {
  const appVersion = opts.appVersion
  let ours: number
  try {
    ours = encodeUserVersion(appVersion)
  } catch (cause) {
    throw new SearchHoleError(
      'invalid_argument',
      `appVersion must be a semver string, got "${appVersion}".`,
      { cause },
    )
  }
  const migrations = opts.migrations ?? MIGRATIONS
  const latest = latestSchemaOf(migrations)
  const memory = opts.dataDir === ':memory:'
  const dbPath = memory ? ':memory:' : join(opts.dataDir, DB_FILE)
  const now = opts.now
  const random = opts.random ?? Math.random
  const pid = opts.pid ?? process.pid
  const warn = opts.onWarning ?? (() => undefined)

  const db = await openDb({ path: dbPath, busyTimeoutMs: opts.busyTimeoutMs ?? 100 })

  let closed = false
  let state: { meta: MetaRow | undefined; decision: ModeDecision; migration: MigrationState }
  try {
    const meta = readMeta(db)
    const decision = decideMode(meta, { appVersion, latestSchema: latest })
    state = {
      meta,
      decision,
      migration: decision.needsMigration ? 'pending' : decision.reason === 'ok' ? 'current' : 'blocked',
    }
  } catch (cause) {
    if (cause instanceof MetaUnreadable) {
      // A newer binary changed the protocol table itself: never throw on a newer schema.
      state = {
        meta: undefined,
        migration: 'blocked',
        decision: {
          mode: 'no-history',
          reason: 'reader_too_old',
          needsMigration: false,
          message: `search-hole v${appVersion} cannot read this database's metadata (written by a newer version); update search-hole. Searches still run with your rules files only.`,
        },
      }
    } else {
      db.close()
      throw new SearchHoleError('store_unavailable', `${dbPath} is not a search-hole database.`, {
        fix: 'Move the file aside and restart, or run `searchhole doctor`.',
        cause,
      })
    }
  }

  const stats = { recorded: 0, queued: 0, skipped: 0 }
  const queue = new RetryQueue<RecordPlan>()
  let timer: ReturnType<typeof setTimeout> | undefined

  // ── mode handling ──────────────────────────────────────────────────────

  const switchToReadOnly = (): void => {
    let dataVersion = state.meta?.lastMigratedBy ?? 'a newer version'
    let meta = state.meta
    try {
      meta = readMeta(db) ?? meta
      dataVersion = meta?.lastMigratedBy ?? dataVersion
    } catch {
      // Keep the last known meta.
    }
    state = { meta, decision: writerTooOld(appVersion, dataVersion), migration: state.migration }
    warn({ code: 'logging_unavailable', detail: state.decision.message })
  }

  const status = (): StoreStatus => ({
    mode: state.decision.mode,
    reason: state.decision.reason,
    message: state.decision.message,
    migration: state.migration,
    appVersion,
    latestSchemaVersion: latest,
    ...(state.meta !== undefined
      ? {
          schemaVersion: state.meta.schemaVersion,
          minReaderVersion: state.meta.minReaderVersion,
          minWriterVersion: state.meta.minWriterVersion,
          lastMigratedBy: state.meta.lastMigratedBy,
        }
      : {}),
    dbPath,
  })

  const runMigration = async (): Promise<StoreStatus> => {
    if (closed || !state.decision.needsMigration) return status()
    try {
      const outcome = await migrate(db, {
        dataDir: memory ? null : opts.dataDir,
        appVersion,
        now,
        pid,
        migrations,
        random,
        ...(opts.migrationWaitMs !== undefined ? { waitMs: opts.migrationWaitMs } : {}),
      })
      state = {
        meta: outcome.meta,
        decision: decideMode(outcome.meta, { appVersion, latestSchema: latest }),
        migration: outcome.kind,
      }
    } catch (e) {
      state = {
        meta: state.meta,
        migration: 'failed',
        decision: {
          mode: 'no-history',
          reason: 'migration_failed',
          needsMigration: true,
          message: `${errorText(e).replace(/\.$/, '')}. Searches run without logging; run \`searchhole doctor\`.`,
        },
      }
    }
    return status()
  }

  // ── transactions ───────────────────────────────────────────────────────

  /**
   * One BEGIN IMMEDIATE write transaction. Unless `readOnlyOk`, it first re-reads
   * `PRAGMA user_version` and rolls back into read-only mode when it exceeds ours.
   * `readOnlyOk` writes (engine_usage, meta_kv inserts) skip that check: those tables never
   * take writer-breaking changes (ADR-0009 point 6).
   */
  const write = <R>(fn: (d: Db) => R, o: { readOnlyOk?: boolean } = {}): WriteOutcome<R> => {
    if (closed) return { kind: 'skipped', reason: 'closed' }
    const mode = state.decision.mode
    if (mode === 'no-history') return { kind: 'skipped', reason: 'no-history' }
    if (mode === 'read-only' && o.readOnlyOk !== true) return { kind: 'skipped', reason: 'read-only' }
    try {
      const value = db.tx('immediate', () => {
        if (o.readOnlyOk !== true && readUserVersion(db) > ours) throw new WriterTooOld()
        return fn(db)
      })
      return { kind: 'ok', value }
    } catch (e) {
      if (e instanceof WriterTooOld) {
        switchToReadOnly()
        return { kind: 'skipped', reason: 'read-only' }
      }
      if (isBusyError(e)) return { kind: 'busy' }
      return { kind: 'error', error: e }
    }
  }

  const read = <R>(fn: (d: Db) => R, fallback: R): R => {
    if (closed || state.decision.mode === 'no-history') return fallback
    try {
      return fn(db)
    } catch (e) {
      if (isBusyError(e)) return fallback
      throw e
    }
  }

  /** Unwraps a write whose failures are programming errors, not conditions. */
  const mustWrite = <R>(r: WriteOutcome<R>): { ok: true; value: R } | { ok: false } => {
    if (r.kind === 'ok') return { ok: true, value: r.value }
    if (r.kind === 'error') throw r.error
    return { ok: false }
  }

  // ── search log ─────────────────────────────────────────────────────────

  const skippedWarning = (reason: SkipReason, error?: unknown): Warning => ({
    code: 'logging_unavailable',
    detail:
      reason === 'error'
        ? `could not log the search: ${errorText(error)}`
        : reason === 'closed'
          ? 'the search log is closed'
          : state.decision.message,
  })

  const schedule = (): void => {
    if (timer !== undefined || closed || queue.length === 0) return
    const base = opts.retryIntervalMs ?? 500
    const delay = Math.max(1, Math.round(base * (0.5 + random())))
    timer = setTimeout(() => {
      timer = undefined
      flushRetries()
    }, delay)
    timer.unref()
  }

  const noteDrops = (n: number, why: string): void => {
    if (n > 0) warn({ code: 'logging_unavailable', detail: `dropped ${n} search log write(s): ${why}` })
  }

  function flushRetries(): FlushReport {
    let skippedDrops = 0
    const result = queue.flush(now(), (plan) => {
      const r = write((d) => writePlan(d, plan))
      if (r.kind === 'ok') {
        stats.recorded++
        return 'done'
      }
      if (r.kind === 'busy') return 'retry'
      stats.skipped++
      skippedDrops++
      return 'drop'
    })
    noteDrops(skippedDrops, state.decision.message)
    noteDrops(result.dropped - skippedDrops, `database busy for more than ${RETRY_MAX_AGE_MS / 1000} s`)
    schedule()
    return result
  }

  const recordPlanned = (make: () => RecordPlan): RecordSearchResult => {
    let plan: RecordPlan
    try {
      plan = make()
    } catch (error) {
      stats.skipped++
      return { status: 'skipped', reason: 'error', warning: skippedWarning('error', error) }
    }
    const r = write((d) => writePlan(d, plan))
    switch (r.kind) {
      case 'ok':
        stats.recorded++
        return { status: 'recorded', searchId: r.value }
      case 'busy': {
        stats.queued++
        noteDrops(queue.push(plan, now()), 'retry queue is full')
        schedule()
        return { status: 'queued' }
      }
      case 'skipped':
        stats.skipped++
        return { status: 'skipped', reason: r.reason, warning: skippedWarning(r.reason) }
      case 'error':
        stats.skipped++
        return { status: 'skipped', reason: 'error', warning: skippedWarning('error', r.error) }
    }
  }

  const recordSearch = (input: RecordSearchInput): RecordSearchResult =>
    recordPlanned(() => planRecord(input, input.createdAt ?? now()))

  const recordBuiltinSearch = (input: RecordBuiltinInput): RecordSearchResult =>
    recordPlanned(() => planBuiltinRecord(input, input.createdAt ?? now()))

  /** A best-effort write of mutable state: false when skipped or busy; programming errors throw. */
  const softWrite = <R>(fn: (d: Db) => R): { ok: true; value: R } | { ok: false } => {
    const r = write(fn)
    if (r.kind === 'ok') return { ok: true, value: r.value }
    if (r.kind === 'error') throw r.error
    return { ok: false }
  }
  const clampLimit = (n: number, max: number): number =>
    Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : 1

  // ── lease helpers ──────────────────────────────────────────────────────

  const leaseFailure = (r: WriteOutcome<unknown>): LeaseFailure => {
    if (r.kind === 'skipped') return r.reason === 'read-only' ? 'read_only' : 'store_unavailable'
    return 'store_unavailable'
  }

  const patchLease = (lease: Lease, patch: JobPatch, release: boolean): LeaseWrite => {
    const r = write((d) =>
      release ? releaseLease(d, lease, patch, now()) : patchJob(d, lease, patch, now()),
    )
    if (r.kind === 'error') throw r.error
    if (r.kind !== 'ok') return { ok: false, reason: leaseFailure(r) }
    return r.value ? { ok: true, lease } : { ok: false, reason: 'lease_lost' }
  }

  // ── the store ──────────────────────────────────────────────────────────

  const store: Store = {
    dbPath,
    status,
    stats: () => ({
      recorded: stats.recorded,
      queued: stats.queued,
      dropped: queue.dropped,
      skipped: stats.skipped,
      pending: queue.length,
    }),
    recordSearch,
    recordBuiltinSearch,
    flushRetries,
    getSearch: (id) => read((d) => getSearch(d, id), undefined),
    listSearchesAfter: (afterId, limit) => {
      const n = Number.isFinite(limit) ? Math.min(MAX_SEARCHES_PER_TAIL, Math.max(1, Math.floor(limit))) : 1
      return read((d) => listSearchesAfter(d, afterId, n), [])
    },
    listResults: (searchId) => read((d) => listResults(d, searchId, now()), []),
    tailState: () =>
      read((d) => ({ maxId: maxSearchId(d), epoch: readDataEpoch(d) }), { maxId: 0, epoch: 0 }),

    engineHealth: {
      get: (engine, keyFp, subEngine = '') => read((d) => getHealth(d, engine, keyFp, subEngine), undefined),
      list: (engine) => read((d) => listHealth(d, engine), []),
      put: (row) => mustWrite(write((d) => putHealth(d, row, now()))).ok,
    },

    engineUsage: {
      reserve: (engine, keyFp, caps, at = now()): ReserveResult => {
        const r = write((d) => reserveUsage(d, engine, keyFp, caps, at), { readOnlyOk: true })
        if (r.kind === 'ok') return r.value
        const detail =
          r.kind === 'busy'
            ? 'database busy'
            : r.kind === 'skipped'
              ? `store is ${r.reason}`
              : errorText(r.error)
        return { ok: false, reason: 'store_unavailable', detail }
      },
      refund: (reservation) =>
        write((d) => refundUsage(d, reservation, now()), { readOnlyOk: true }).kind === 'ok',
      counts: (engine, keyFp, at = now()) =>
        read((d) => readCounts(d, engine, keyFp, at), { day: 0, month: 0 }),
    },

    jobs: {
      acquire: (name, owner, leaseMs): AcquireResult => {
        const r = write((d) => acquireLease(d, name, owner, leaseMs, now()))
        if (r.kind === 'error') throw r.error
        if (r.kind !== 'ok') {
          return {
            acquired: false,
            reason: leaseFailure(r) === 'read_only' ? 'read_only' : 'store_unavailable',
          }
        }
        return r.value
      },
      renew: (lease, leaseMs): LeaseWrite => {
        const r = write((d) => renewLease(d, lease, leaseMs, now()))
        if (r.kind === 'error') throw r.error
        return r.kind === 'ok' ? r.value : { ok: false, reason: leaseFailure(r) }
      },
      update: (lease, patch) => patchLease(lease, patch, false),
      release: (lease, final = {}) => patchLease(lease, final, true),
      fenced: <R>(lease: Lease, fn: (d: Db) => R): FencedResult<R> => {
        const r = write((d) => {
          if (!leaseHolds(d, lease)) throw new LeaseLost()
          return fn(d)
        })
        if (r.kind === 'ok') return { ok: true, value: r.value }
        if (r.kind === 'error') {
          if (r.error instanceof LeaseLost) return { ok: false, reason: 'lease_lost' }
          throw r.error
        }
        return { ok: false, reason: leaseFailure(r) }
      },
      get: (name) => read((d) => getJob(d, name), undefined),
      list: () => read((d) => listJobs(d), []),
    },

    meta: {
      get: (key) => read((d) => kvGet(d, key), undefined),
      set: (key, value) => mustWrite(write((d) => kvSet(d, key, value, now()))).ok,
      getOrInit: (key, make) => {
        const existing = read((d) => kvGet(d, key), undefined)
        if (existing !== undefined) return existing
        const r = mustWrite(
          write(
            (d) => {
              kvInsertIfAbsent(d, key, make(), now())
              return kvGet(d, key)
            },
            { readOnlyOk: true },
          ),
        )
        return r.ok ? r.value : undefined
      },
      snapshot: () =>
        read((d) => {
          const m = readMeta(d)
          return m === undefined
            ? undefined
            : {
                schemaVersion: m.schemaVersion,
                minReaderVersion: m.minReaderVersion,
                minWriterVersion: m.minWriterVersion,
                lastMigratedBy: m.lastMigratedBy,
                dataEpoch: m.dataEpoch,
              }
        }, undefined),
    },

    retention: {
      prune: (at, settings): PruneReport => {
        const deleted: Record<string, number> = {}
        let total = 0
        let batches = 0
        const size = settings.batchSize ?? DEFAULTS.batchSize
        const finish = (extra: Pick<PruneReport, 'skipped' | 'interrupted'>): PruneReport => {
          let epoch: number | undefined
          if (total > 0) {
            const bumped = write((d) => bumpDataEpoch(d))
            if (bumped.kind === 'ok') epoch = bumped.value
          }
          return {
            ...extra,
            deleted,
            totalDeleted: total,
            batches,
            ...(epoch !== undefined ? { epoch } : {}),
          }
        }
        for (const step of pruneSteps(at, settings)) {
          for (;;) {
            const r = write((d) => d.prepare(step.sql).run(step.params).changes)
            if (r.kind === 'skipped') return finish({ skipped: r.reason })
            if (r.kind === 'busy') return finish({ interrupted: 'busy' })
            if (r.kind === 'error') throw r.error
            batches++
            deleted[step.table] = (deleted[step.table] ?? 0) + r.value
            total += r.value
            if (!step.batched || r.value < size) break
          }
        }
        return finish({})
      },
    },

    maintenance: {
      checkpoint: (mode = 'PASSIVE') => {
        if (!CHECKPOINT_MODES.has(mode)) throw new TypeError(`unknown checkpoint mode: ${String(mode)}`)
        maintain(`PRAGMA wal_checkpoint(${mode})`)
      },
      incrementalVacuum: (pages) => {
        if (!Number.isFinite(pages)) throw new TypeError('pages must be a finite number')
        maintain(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`)
      },
      optimize: () => maintain('PRAGMA optimize'),
    },

    searchLog: {
      recent: ({ limit, hiddenOnly }) =>
        read((d) => listRecentSearches(d, clampLimit(limit, MAX_SEARCHES_PER_TAIL), hiddenOnly === true), []),
      get: (id) => read((d) => getSearchLog(d, id), undefined),
      byReceipt: (receiptId) => read((d) => listSearchesByReceipt(d, receiptId), []),
      hiddenReasons: (ids) => read((d) => hiddenReasonCounts(d, ids), new Map()),
    },

    sessions: {
      upsert: (w) => softWrite((d) => upsertSession(d, w, now())).ok,
      get: (id) => read((d) => getSession(d, id), undefined),
      claimTurn: (w, windowMs) => {
        const r = softWrite((d) => claimTurn(d, w, windowMs, now()))
        return r.ok ? r.value : undefined
      },
    },

    receipts: {
      ensure: (id, sessionId) => softWrite((d) => ensureReceipt(d, id, sessionId ?? null, now())).ok,
      duplicatesSince: (since) => read((d) => countDuplicateReceipts(d, since), 0),
      get: (id) => read((d) => getReceipt(d, id), undefined),
      close: (id) => {
        const r = softWrite((d) => setReceiptClosed(d, id, now(), now()))
        return r.ok && r.value
      },
      reopen: (id) => {
        const r = softWrite((d) => setReceiptClosed(d, id, null, now()))
        return r.ok && r.value
      },
      latestForSession: (sessionId) => read((d) => latestReceiptForSession(d, sessionId), undefined),
    },

    fetches: {
      record: (w) => softWrite((d) => insertFetch(d, w, now())).ok,
      byReceipt: (receiptId) => read((d) => listFetchesByReceipt(d, receiptId), []),
    },

    suggestions: {
      add: (w) => {
        const r = softWrite((d) => insertSuggestion(d, w, now()))
        return r.ok ? r.value : undefined
      },
      get: (id) => read((d) => getSuggestion(d, id), undefined),
      list: (limit = 200) => read((d) => listSuggestions(d, clampLimit(limit, 1000)), []),
      findPending: (key) => read((d) => findPendingSuggestion(d, key), undefined),
      resolve: (id, status) => {
        const r = softWrite((d) => resolveSuggestion(d, id, status, now()))
        return r.ok && r.value
      },
    },

    sessionRules: {
      add: (w) => softWrite((d) => insertSessionRule(d, w, now())).ok,
      list: (sessionId) => read((d) => listSessionRules(d, sessionId, now()), []),
      remove: (id) => {
        const r = softWrite((d) => deleteSessionRule(d, id))
        return r.ok && r.value
      },
      clear: (sessionId) => {
        const r = softWrite((d) => clearSessionRules(d, sessionId))
        return r.ok ? r.value : 0
      },
    },

    projectTrust: {
      get: (path) => read((d) => getTrust(d, path), undefined),
      set: (path, sha) => softWrite((d) => putTrust(d, path, sha, now())).ok,
      remove: (path) => {
        const r = softWrite((d) => deleteTrust(d, path))
        return r.ok && r.value
      },
    },

    rulesLastGood: {
      put: (w) => softWrite((d) => putLastGood(d, w, now())).ok,
      latest: (sourcePath) => read((d) => latestLastGood(d, sourcePath), undefined),
    },

    gateways: {
      heartbeat: (w) => softWrite((d) => upsertGateway(d, w, now())).ok,
      list: (since) => read((d) => listGateways(d, since), []),
    },

    dataEpoch: () => read((d) => readDataEpoch(d), 0),
    bumpDataEpoch: () => {
      const r = mustWrite(write((d) => bumpDataEpoch(d)))
      return r.ok ? r.value : undefined
    },

    runMigration,
    close: () => {
      if (closed) return
      try {
        flushRetries()
      } catch {
        // Closing must not throw.
      }
      noteDrops(queue.clear(), 'the store was closed')
      if (timer !== undefined) clearTimeout(timer)
      closed = true
      db.close()
    },
  }

  /** Maintenance runs only in read-write mode; BUSY is ignored (the lease holder retries later). */
  function maintain(sql: string): void {
    if (closed || state.decision.mode !== 'read-write') return
    try {
      db.exec(sql)
    } catch (e) {
      if (!isBusyError(e)) throw e
    }
  }

  if (state.decision.needsMigration && (opts.migrate ?? 'inline') === 'inline') await runMigration()
  return store
}
