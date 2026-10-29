// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'
import type { EngineId } from '../types.ts'
import { nodeKeyFs } from './spawn.ts'
import type { KeyFs, SecretStore } from './types.ts'
import { normalizeKeyForStorage } from './validate.ts'

export interface InsecureFileOptions {
  /** `<data>/secrets`. */
  dir: string
  fs?: KeyFs
}

/**
 * The explicit opt-in plaintext store (ADR-0007 point 2): `<data>/secrets/<engine>.key`,
 * file `0600`, folder `0700`. It is written only by `searchhole keys set --insecure-file`;
 * reading it is automatic once the file exists. `doctor` warns about it permanently.
 */
export function createInsecureFileStore(opts: InsecureFileOptions): SecretStore {
  const fs = opts.fs ?? nodeKeyFs
  const fileFor = (engine: EngineId): string => join(opts.dir, `${engine}.key`)

  return {
    kind: 'file',
    label: 'plaintext file (insecure)',

    async get(engine) {
      const file = fileFor(engine)
      if (!fs.exists(file)) return null
      const key = fs.readText(file).trim()
      return key === '' ? null : key
    },

    async set(engine, rawKey) {
      const key = normalizeKeyForStorage(rawKey)
      fs.ensureDir(opts.dir)
      fs.writeText(fileFor(engine), `${key}\n`)
    },

    async delete(engine) {
      return fs.remove(fileFor(engine))
    },

    async probe() {
      return { ok: true }
    },
  }
}
