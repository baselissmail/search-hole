// SPDX-License-Identifier: Apache-2.0
import type { EngineId } from '../types.ts'
import type { RunCommand, SecretStore, StoreProbe } from './types.ts'
import { normalizeKeyForStorage, scrub, unavailable } from './validate.ts'

const LABEL = 'macOS Keychain'
const TIMEOUT_MS = 8_000
const NOT_FOUND = 44

export interface MacosKeychainOptions {
  run: RunCommand
  /** Keychain service name. Default 'search-hole'. */
  service?: string
}

/** A service name goes into a `security -i` line unquoted, so it must be a plain token. */
function plainToken(name: string): string {
  if (normalizeKeyForStorage(name, { strictQuoting: true }) !== name) {
    throw unavailable(LABEL, 'the service name contains characters that cannot be passed to security -i')
  }
  return name
}

/**
 * The macOS Keychain through the `security` CLI (ADR-0007 point 2). Writes go through
 * `security -i` with the command on stdin so the key is never in argv (visible in `ps`);
 * keys with whitespace, `"` or `\` are rejected because `security -i` parses the line.
 * Reads and deletes carry no secret in argv and run directly. Items are generic passwords
 * with service `search-hole` and account `<engine>`.
 */
export function createMacosKeychainStore(opts: MacosKeychainOptions): SecretStore {
  const { run } = opts
  const service = plainToken(opts.service ?? 'search-hole')

  const get = async (engine: EngineId): Promise<string | null> => {
    const r = await run('security', ['find-generic-password', '-s', service, '-a', engine, '-w'], {
      timeoutMs: TIMEOUT_MS,
    })
    if (r.error !== undefined) throw unavailable(LABEL, `could not run security (${r.error})`)
    if (r.code === NOT_FOUND) return null
    if (r.code !== 0)
      throw unavailable(
        LABEL,
        `security exited with ${r.code}`,
        'Unlock the login keychain, or use an environment variable.',
      )
    const key = r.stdout.replace(/\r?\n$/, '')
    return key === '' ? null : key
  }

  return {
    kind: 'keychain',
    label: LABEL,
    get,

    async set(engine, rawKey) {
      const key = normalizeKeyForStorage(rawKey, { strictQuoting: true })
      const stdin = `add-generic-password -U -s ${service} -a ${engine} -w ${key}\n`
      const r = await run('security', ['-i'], { stdin, timeoutMs: TIMEOUT_MS })
      if (r.error !== undefined) throw unavailable(LABEL, `could not run security (${r.error})`)
      if (r.code !== 0) {
        throw unavailable(
          LABEL,
          `security exited with ${r.code}: ${scrub(r.stderr, key).trim().slice(0, 200)}`,
        )
      }
      // `security -i` reports only the last command's status; read back to be sure.
      if ((await get(engine)) !== key)
        throw unavailable(LABEL, 'the key was not stored (keychain locked or access denied?)')
    },

    async delete(engine) {
      const r = await run('security', ['delete-generic-password', '-s', service, '-a', engine], {
        timeoutMs: TIMEOUT_MS,
      })
      if (r.error !== undefined) throw unavailable(LABEL, `could not run security (${r.error})`)
      if (r.code === 0) return true
      if (r.code === NOT_FOUND) return false
      throw unavailable(LABEL, `security exited with ${r.code}`)
    },

    async probe(): Promise<StoreProbe> {
      const r = await run('security', ['list-keychains'], { timeoutMs: TIMEOUT_MS })
      if (r.error !== undefined) return { ok: false, reason: `could not run security (${r.error})` }
      return r.code === 0 ? { ok: true } : { ok: false, reason: `security exited with ${r.code}` }
    },
  }
}
