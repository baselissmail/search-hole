// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto'
import { SearchHoleError } from '../errors.ts'
import type { EngineId } from '../types.ts'
import type { RunCommand, SecretStore, StoreProbe } from './types.ts'
import { normalizeKeyForStorage, unavailable } from './validate.ts'

const LABEL = 'Secret Service (secret-tool)'
const TIMEOUT_MS = 8_000
const PROBE_ACCOUNT = '__probe__'

export interface SecretToolOptions {
  run: RunCommand
  /** Attribute value for `service`. Default 'search-hole'. */
  service?: string
  /** Generates the throwaway probe secret. Injected for tests. */
  randomToken?: () => string
}

/**
 * The freedesktop Secret Service through `secret-tool` (ADR-0007 point 2). The secret is
 * written to stdin, never argv. `secret-tool` only works with a running Secret Service
 * (not on headless or SSH hosts), so `set` first proves a write-and-read-back round trip
 * and refuses, with the env-var alternatives, when that fails.
 */
export function createSecretToolStore(opts: SecretToolOptions): SecretStore {
  const { run } = opts
  const service = opts.service ?? 'search-hole'
  const token = opts.randomToken ?? ((): string => randomBytes(12).toString('hex'))
  let probed: StoreProbe | undefined

  const attrs = (engine: string): string[] => ['service', service, 'account', engine]

  const lookup = async (account: string): Promise<{ value: string | null; error?: string }> => {
    const r = await run('secret-tool', ['lookup', ...attrs(account)], { timeoutMs: TIMEOUT_MS })
    if (r.error !== undefined) return { value: null, error: r.error }
    return { value: r.code === 0 && r.stdout !== '' ? r.stdout.replace(/\r?\n$/, '') : null }
  }

  const store = async (account: string, secret: string): Promise<string | undefined> => {
    const r = await run('secret-tool', ['store', `--label=search-hole ${account}`, ...attrs(account)], {
      stdin: secret,
      timeoutMs: TIMEOUT_MS,
    })
    if (r.error !== undefined) return r.error
    return r.code === 0 ? undefined : `exit ${r.code}`
  }

  const describe = (error: string): string =>
    error === 'ENOENT'
      ? 'secret-tool is not installed (package libsecret-tools)'
      : error === 'timeout'
        ? 'timed out waiting for a Secret Service (headless or SSH session?)'
        : `could not use secret-tool (${error})`

  const probe = async (): Promise<StoreProbe> => {
    if (probed !== undefined) return probed
    const secret = `probe-${token()}`
    const failed = await store(PROBE_ACCOUNT, secret)
    if (failed !== undefined) return { ok: false, reason: describe(failed) }
    const back = await lookup(PROBE_ACCOUNT)
    await run('secret-tool', ['clear', ...attrs(PROBE_ACCOUNT)], { timeoutMs: TIMEOUT_MS })
    if (back.value !== secret)
      return {
        ok: false,
        reason:
          back.error === undefined
            ? 'the Secret Service did not return what was stored'
            : describe(back.error),
      }
    probed = { ok: true }
    return probed
  }

  return {
    kind: 'keychain',
    label: LABEL,

    async get(engine: EngineId) {
      const r = await lookup(engine)
      // A missing binary or an unreachable service reads as "no key here"; `probe` explains why.
      return r.value
    },

    async set(engine, rawKey) {
      const key = normalizeKeyForStorage(rawKey)
      const ready = await probe()
      if (!ready.ok) {
        throw new SearchHoleError('store_unavailable', `No usable OS key store: ${ready.reason}.`, {
          fix: 'Set the key as an environment variable (for example TAVILY_API_KEY), or point TAVILY_API_KEY_FILE at a file that holds it.',
        })
      }
      const failed = await store(engine, key)
      if (failed !== undefined) throw unavailable(LABEL, describe(failed))
      if ((await lookup(engine)).value !== key) throw unavailable(LABEL, 'the key was not stored')
    },

    async delete(engine) {
      const existed = (await lookup(engine)).value !== null
      const r = await run('secret-tool', ['clear', ...attrs(engine)], { timeoutMs: TIMEOUT_MS })
      if (r.error !== undefined) throw unavailable(LABEL, describe(r.error))
      return existed
    },

    probe,
  }
}
