// SPDX-License-Identifier: Apache-2.0
/**
 * The compatibility decision (ADR-0006 point 5): what a binary may do with a database
 * written by another version. It never throws and never downgrades.
 */
import type { MetaRow } from './queries/meta.ts'
import { compareSemver } from './version.ts'

/**
 * - `read-write`: normal operation.
 * - `read-only`: `min_writer_version` is newer than us. Searches run with full rules; logging is
 *   skipped and counted; `engine_usage` reservations still work.
 * - `no-history`: no usable history (`min_reader_version` is newer than us, or the schema is not
 *   ready). Searches run with YAML rules only and nothing is logged.
 */
export type StoreMode = 'read-write' | 'read-only' | 'no-history'

export type ModeReason = 'ok' | 'writer_too_old' | 'reader_too_old' | 'migration_pending' | 'migration_failed'

export interface ModeDecision {
  readonly mode: StoreMode
  readonly reason: ModeReason
  /** One line for receipts and `doctor`. */
  readonly message: string
  /** True when this binary has migrations the database has not applied yet. */
  readonly needsMigration: boolean
}

export interface DecideInput {
  readonly appVersion: string
  /** Highest schema version this binary can produce. */
  readonly latestSchema: number
}

/** Decides the mode from `meta`. `undefined` meta is a database that has not been bootstrapped. */
export function decideMode(meta: MetaRow | undefined, input: DecideInput): ModeDecision {
  if (meta === undefined) return pending()
  if (compareSemver(meta.minReaderVersion, input.appVersion) > 0) {
    return {
      mode: 'no-history',
      reason: 'reader_too_old',
      needsMigration: false,
      message: `search-hole v${input.appVersion} is older than your data (v${meta.lastMigratedBy}) and cannot read its history; update search-hole. Searches still run with your rules files only.`,
    }
  }
  if (compareSemver(meta.minWriterVersion, input.appVersion) > 0) {
    return writerTooOld(input.appVersion, meta.lastMigratedBy)
  }
  if (meta.schemaVersion < input.latestSchema) return pending()
  return { mode: 'read-write', reason: 'ok', needsMigration: false, message: 'ok' }
}

/** Read-only mode: a newer binary raised `min_writer_version` above this one. */
export function writerTooOld(appVersion: string, dataVersion: string): ModeDecision {
  return {
    mode: 'read-only',
    reason: 'writer_too_old',
    needsMigration: false,
    message: `search-hole v${appVersion} is older than your data (v${dataVersion}); update search-hole. Searches still run, but are not logged.`,
  }
}

function pending(): ModeDecision {
  return {
    mode: 'no-history',
    reason: 'migration_pending',
    needsMigration: true,
    message: 'The search-hole database is being upgraded; searches run without logging until it finishes.',
  }
}
