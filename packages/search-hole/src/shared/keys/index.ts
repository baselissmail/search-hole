// SPDX-License-Identifier: Apache-2.0
/**
 * API key resolution and storage (ADR-0007). `resolveKey` reads; the stores write
 * (CLI and dashboard only: the gateway never prompts and never writes keys).
 */
import { createInsecureFileStore } from './file.ts'
import { createSecretToolStore } from './linux.ts'
import { createMacosKeychainStore } from './macos.ts'
import { nodeKeyFs, nodeRunCommand } from './spawn.ts'
import type { KeyFs, RunCommand, SecretStore } from './types.ts'
import { createDpapiStore } from './windows.ts'

export { createInsecureFileStore } from './file.ts'
export { forgetSecrets, redactKnownSecrets, registerSecret } from './known-secrets.ts'
export { createSecretToolStore } from './linux.ts'
export { createMacosKeychainStore } from './macos.ts'
export {
  CONVENTIONAL_KEY_ENV,
  createKeyCache,
  describeKeyResolution,
  hostKeyEnvName,
  isKeyLocked,
  KEY_CACHE_TTL_MS,
  type KeyCache,
  type KeyDeps,
  resolveKey,
} from './resolve.ts'
export { nodeKeyFs, nodeRunCommand } from './spawn.ts'
export type {
  CommandOptions,
  CommandResult,
  KeyFs,
  KeyResolution,
  KeySource,
  RunCommand,
  SecretStore,
  StoreKind,
  StoreProbe,
} from './types.ts'
export { envValue, isUnsetValue } from './unset.ts'
export { isUsableKey, normalizeKeyForStorage } from './validate.ts'
export { createDpapiStore, DPAPI_READ_SCRIPT, DPAPI_WRITE_SCRIPT } from './windows.ts'

export interface KeyStoreOptions {
  platform: NodeJS.Platform
  /** `<data>/secrets` (see `rootLayout(...).secrets`). */
  secretsDir: string
  run?: RunCommand
  fs?: KeyFs
  /** Keychain service / Secret Service attribute. Default 'search-hole'. */
  service?: string
}

/**
 * The OS key store for a platform: macOS Keychain, Secret Service on Linux and other
 * Unixes, DPAPI on Windows. Never null today; reserved for platforms without one.
 */
export function createOsKeyStore(opts: KeyStoreOptions): SecretStore {
  const run = opts.run ?? nodeRunCommand
  const service = opts.service === undefined ? {} : { service: opts.service }
  if (opts.platform === 'darwin') return createMacosKeychainStore({ run, ...service })
  if (opts.platform === 'win32')
    return createDpapiStore({ run, fs: opts.fs ?? nodeKeyFs, dir: opts.secretsDir })
  return createSecretToolStore({ run, ...service })
}

export interface KeyStores {
  /** Where `keys set` writes by default. */
  os: SecretStore
  /** Written only with `--insecure-file`. */
  file: SecretStore
  /** What the gateway reads: the OS store, then the insecure file if one exists. */
  readChain: readonly SecretStore[]
}

/** Builds the stores for this machine: the OS store plus the explicit insecure-file store. */
export function createKeyStores(opts: KeyStoreOptions): KeyStores {
  const os = createOsKeyStore(opts)
  const file = createInsecureFileStore({
    dir: opts.secretsDir,
    ...(opts.fs === undefined ? {} : { fs: opts.fs }),
  })
  return { os, file, readChain: [os, file] }
}
