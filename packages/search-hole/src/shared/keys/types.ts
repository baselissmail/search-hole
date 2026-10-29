// SPDX-License-Identifier: Apache-2.0
import type { EngineId } from '../types.ts'

/** Where a resolved key came from (ADR-0007 point 1). Persisted as `engine_health.key_source`. */
export type KeySource = 'host-env' | 'env' | 'env-file' | 'keychain' | 'dpapi' | 'file'

export type KeyResolution =
  | {
      key: string
      source: KeySource
      /** Non-secret origin for display: an env var name, or the store label. */
      via: string
    }
  | {
      key: null
      source: 'missing'
      /** Non-secret reasons sources were skipped (unreadable store, control characters, ...). */
      detail?: string
    }

/** Result of a store health check. */
export type StoreProbe = { ok: true } | { ok: false; reason: string }

/** The `kind` of a store is the `KeySource` it reports. */
export type StoreKind = Extract<KeySource, 'keychain' | 'dpapi' | 'file'>

/**
 * Search-hole's own key store (ADR-0007 point 2): an OS facility reached through its CLI,
 * or the explicit insecure file. Secrets pass through stdin, never argv.
 */
export interface SecretStore {
  readonly kind: StoreKind
  /** Human label, e.g. 'macOS Keychain'. */
  readonly label: string
  /** The stored key, or null when none. Throws `store_unavailable` when the store itself fails. */
  get(engine: EngineId): Promise<string | null>
  /** Stores a key. Throws `invalid_argument` for keys the backend cannot hold, `store_unavailable` on failure. */
  set(engine: EngineId, key: string): Promise<void>
  /** Removes a key; true when one was removed. */
  delete(engine: EngineId): Promise<boolean>
  /** Cheap check that the store can be used at all. */
  probe(): Promise<StoreProbe>
}

export interface CommandResult {
  /** Exit code; null when the process did not start or was killed. */
  code: number | null
  stdout: string
  stderr: string
  /** Set when the process could not run: 'ENOENT', 'timeout', or another errno code. */
  error?: string
}

export interface CommandOptions {
  /** Written to the child's stdin, then stdin is closed. Secrets go here. */
  stdin?: string
  /** Extra environment variables for the child (merged over the parent's). */
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
}

/**
 * Runs a command without a shell. The secret-bearing parts of a call go in `stdin`, never
 * in `args`. Injected so command construction is testable without spawning anything.
 */
export type RunCommand = (
  cmd: string,
  args: readonly string[],
  opts?: CommandOptions,
) => Promise<CommandResult>

/** The file-system operations key backends need. */
export interface KeyFs {
  exists(path: string): boolean
  readText(path: string): string
  /** Atomic write, `0600`. */
  writeText(path: string, text: string): void
  remove(path: string): boolean
  /** Creates the folder `0700`. */
  ensureDir(path: string): void
}
