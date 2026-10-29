// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'
import type { EngineId } from '../types.ts'
import type { KeyFs, RunCommand, SecretStore, StoreProbe } from './types.ts'
import { normalizeKeyForStorage, unavailable } from './validate.ts'

const LABEL = 'Windows DPAPI'
const TIMEOUT_MS = 15_000

/** Env var naming the file PowerShell writes the protected key to. */
export const DPAPI_OUT_ENV = 'SEARCHHOLE_DPAPI_OUT'
/** Env var naming the file PowerShell reads the protected key from. */
export const DPAPI_IN_ENV = 'SEARCHHOLE_DPAPI_IN'

/**
 * ADR-0007 point 2, verbatim. The key arrives on stdin as data, never in the script text,
 * so it never lands in argv or in the ScriptBlock event log.
 */
export const DPAPI_WRITE_SCRIPT = `$k=[Console]::In.ReadLine(); ConvertTo-SecureString -String $k -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:${DPAPI_OUT_ENV}`

/** Reads the protected file back and writes the plain key to stdout. */
export const DPAPI_READ_SCRIPT = `$s=(Get-Content -LiteralPath $env:${DPAPI_IN_ENV} -Raw).Trim() | ConvertTo-SecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }`

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'] as const

export interface DpapiOptions {
  run: RunCommand
  fs: KeyFs
  /** Folder for the protected files: `<data>/secrets`. */
  dir: string
  /** Default 'powershell' (Windows PowerShell 5.1, present on every supported Windows). */
  powershell?: string
}

/**
 * Windows DPAPI (user scope) through PowerShell, with the protected key in
 * `<data>/secrets/<engine>.dpapi` (ADR-0007 point 2). PowerShell is spawned only when a
 * file exists (reads) or a key is being written, because its startup costs 300 to 800 ms.
 */
export function createDpapiStore(opts: DpapiOptions): SecretStore {
  const { run, fs, dir } = opts
  const powershell = opts.powershell ?? 'powershell'
  const fileFor = (engine: EngineId): string => join(dir, `${engine}.dpapi`)

  return {
    kind: 'dpapi',
    label: LABEL,

    async get(engine) {
      const file = fileFor(engine)
      if (!fs.exists(file)) return null
      const r = await run(powershell, [...POWERSHELL_ARGS, DPAPI_READ_SCRIPT], {
        env: { [DPAPI_IN_ENV]: file },
        timeoutMs: TIMEOUT_MS,
      })
      if (r.error !== undefined) throw unavailable(LABEL, `could not run PowerShell (${r.error})`)
      if (r.code !== 0) {
        throw unavailable(
          LABEL,
          `could not decrypt ${engine}.dpapi (saved by another Windows user?)`,
          'Set the key again with searchhole keys set.',
        )
      }
      const key = r.stdout.replace(/\r?\n$/, '')
      return key === '' ? null : key
    },

    async set(engine, rawKey) {
      const key = normalizeKeyForStorage(rawKey)
      const file = fileFor(engine)
      fs.ensureDir(dir)
      const r = await run(powershell, [...POWERSHELL_ARGS, DPAPI_WRITE_SCRIPT], {
        stdin: `${key}\n`,
        env: { [DPAPI_OUT_ENV]: file },
        timeoutMs: TIMEOUT_MS,
      })
      if (r.error !== undefined) throw unavailable(LABEL, `could not run PowerShell (${r.error})`)
      if (r.code !== 0) throw unavailable(LABEL, `PowerShell exited with ${r.code}`)
      if (!fs.exists(file) || fs.readText(file).trim() === '')
        throw unavailable(LABEL, 'the protected key file was not written')
    },

    async delete(engine) {
      return fs.remove(fileFor(engine))
    },

    async probe(): Promise<StoreProbe> {
      const r = await run(powershell, [...POWERSHELL_ARGS, 'exit 0'], { timeoutMs: TIMEOUT_MS })
      if (r.error !== undefined) return { ok: false, reason: `could not run PowerShell (${r.error})` }
      return r.code === 0 ? { ok: true } : { ok: false, reason: `PowerShell exited with ${r.code}` }
    },
  }
}
