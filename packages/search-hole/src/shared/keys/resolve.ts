// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises'
import { SearchHoleError } from '../errors.ts'
import type { EngineId } from '../types.ts'
import { registerSecret } from './known-secrets.ts'
import type { KeyResolution, KeySource, SecretStore } from './types.ts'
import { envValue } from './unset.ts'
import { isUsableKey } from './validate.ts'

type Env = Readonly<Record<string, string | undefined>>

/** Conventional environment variables per engine (ADR-0007 point 1.2), in priority order. */
export const CONVENTIONAL_KEY_ENV: Readonly<Record<EngineId, readonly string[]>> = {
  searxng: [],
  brave: ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
  exa: ['EXA_API_KEY'],
  kagi: ['KAGI_API_KEY'],
  mojeek: ['MOJEEK_API_KEY'],
  marginalia: ['MARGINALIA_API_KEY'],
}

/** Engines that never take a key; resolution skips every source for them. */
const KEYLESS: ReadonlySet<EngineId> = new Set<EngineId>(['searxng'])

/** The host-injected variable our own host configs set from `userConfig`/`user_config`. */
export const hostKeyEnvName = (engine: EngineId): string => `SEARCHHOLE_${engine.toUpperCase()}_API_KEY`

export const KEY_CACHE_TTL_MS = 60_000

export interface KeyCache {
  get(engine: EngineId): KeyResolution | undefined
  /** The last value even after it expired (until `clear`), for stale-while-revalidate. */
  stale(engine: EngineId): KeyResolution | undefined
  set(engine: EngineId, value: KeyResolution): void
  /** Forgets one engine, or all. Call after `keys set` in the same process. */
  clear(engine?: EngineId): void
}

/** A per-process cache with a time-to-live and an injected clock (ADR-0007: 60 s). */
export function createKeyCache(now: () => number, ttlMs: number = KEY_CACHE_TTL_MS): KeyCache {
  // Expired entries stay (one per engine) so `stale` can serve them while a lookup runs.
  const entries = new Map<EngineId, { value: KeyResolution; expiresAt: number }>()
  const cache: KeyCache = {
    get(engine) {
      const hit = entries.get(engine)
      if (hit === undefined || now() >= hit.expiresAt) return undefined
      return hit.value
    },
    stale(engine) {
      return entries.get(engine)?.value
    },
    set(engine, value) {
      entries.set(engine, { value, expiresAt: now() + ttlMs })
    },
    clear(engine) {
      // A lookup already running must not write back the value being forgotten.
      if (engine === undefined) {
        entries.clear()
        inflight.delete(cache)
      } else {
        entries.delete(engine)
        inflight.get(cache)?.delete(engine)
      }
    },
  }
  return cache
}

export interface KeyDeps {
  env: Env
  /** Own store(s), tried in order after the environment. */
  store?: SecretStore | readonly SecretStore[] | null
  /** Reads a `*_FILE` target. Default: `fs.readFile` as UTF-8. */
  readFile?: (path: string) => Promise<string>
  /** When given, results are cached (and served from the cache) per engine. */
  cache?: KeyCache
  /**
   * With `cache`: once an entry expires, return it at once and look the key up in the
   * background. Keeps OS key-store calls (macOS `security` takes ~50 ms, longer when the
   * keychain is locked) off latency-sensitive paths such as hooks.
   */
  staleWhileRevalidate?: boolean
}

const asList = (store: KeyDeps['store']): readonly SecretStore[] =>
  store === undefined || store === null ? [] : 'get' in store ? [store] : store

async function resolveUncached(engine: EngineId, deps: KeyDeps): Promise<KeyResolution> {
  if (KEYLESS.has(engine)) return { key: null, source: 'missing' }
  const notes: string[] = []
  const readFileUtf8 = deps.readFile ?? ((path: string) => readFile(path, 'utf8'))

  // 1. Host-injected: SEARCHHOLE_<ENGINE>_API_KEY.
  const hostName = hostKeyEnvName(engine)
  const hostValue = envValue(deps.env, hostName)
  if (hostValue !== undefined) {
    if (isUsableKey(hostValue)) return { key: hostValue, source: 'host-env', via: hostName }
    notes.push(`${hostName} ignored: it contains control characters`)
  }

  // 2. Conventional names, each also as <NAME>_FILE; both set is an error.
  for (const name of CONVENTIONAL_KEY_ENV[engine]) {
    const value = envValue(deps.env, name)
    const fileName = `${name}_FILE`
    const filePath = envValue(deps.env, fileName)
    if (value !== undefined && filePath !== undefined) {
      throw new SearchHoleError('config_invalid', `Both ${name} and ${fileName} are set.`, {
        fix: `Unset one of them: ${name} holds the key itself, ${fileName} names a file that holds it.`,
        details: { engine, variables: [name, fileName] },
      })
    }
    if (value !== undefined) {
      if (isUsableKey(value)) return { key: value, source: 'env', via: name }
      notes.push(`${name} ignored: it contains control characters`)
    } else if (filePath !== undefined) {
      let text: string
      try {
        text = await readFileUtf8(filePath)
      } catch (cause) {
        throw new SearchHoleError(
          'config_invalid',
          `${fileName} points to ${filePath}, which cannot be read.`,
          {
            fix: 'Check the path and permissions, or unset the variable.',
            details: { engine, variable: fileName },
            cause,
          },
        )
      }
      const key = text.trim()
      if (key === '') notes.push(`${fileName} points to an empty file`)
      else if (isUsableKey(key)) return { key, source: 'env-file', via: fileName }
      else notes.push(`${fileName} ignored: the file holds control characters`)
    }
  }

  // 3. Own store(s).
  for (const store of asList(deps.store)) {
    try {
      const key = await store.get(engine)
      if (key !== null && isUsableKey(key.trim()))
        return { key: key.trim(), source: store.kind, via: store.label }
    } catch (e) {
      notes.push(e instanceof SearchHoleError ? e.why : `${store.label} failed`)
    }
  }
  return notes.length === 0
    ? { key: null, source: 'missing' }
    : { key: null, source: 'missing', detail: notes.join('; ') }
}

/**
 * Resolves an engine's API key per ADR-0007 point 1: `SEARCHHOLE_<ENGINE>_API_KEY`, then the
 * conventional variable and its `_FILE` variant, then our own store. Empty, whitespace-only
 * and `${...}` placeholder values count as unset at every level. Throws `config_invalid`
 * when a name and its `_FILE` variant are both set or a `_FILE` target cannot be read; a
 * failing store is reported in `detail` and resolution continues. Pass `cache` to reuse a
 * result for 60 s. The key is registered with `known-secrets`, so the logger redacts it
 * wherever it appears, and is never logged by this module.
 */
export async function resolveKey(engine: EngineId, deps: KeyDeps): Promise<KeyResolution> {
  const cache = deps.cache
  if (cache === undefined) return lookup(engine, deps)
  const cached = cache.get(engine)
  if (cached !== undefined) return cached
  let running = inflight.get(cache)?.get(engine)
  if (running === undefined) {
    const current: Promise<KeyResolution> = lookup(engine, deps)
      .then((result) => {
        if (inflight.get(cache)?.get(engine) === current) cache.set(engine, result)
        return result
      })
      .finally(() => {
        if (inflight.get(cache)?.get(engine) === current) inflight.get(cache)?.delete(engine)
      })
    running = current
    let byEngine = inflight.get(cache)
    if (byEngine === undefined) inflight.set(cache, (byEngine = new Map()))
    byEngine.set(engine, running)
  }
  const stale = deps.staleWhileRevalidate === true ? cache.stale(engine) : undefined
  if (stale === undefined) return running
  // A failed refresh keeps the stale value; the next call tries again.
  running.catch(() => undefined)
  return stale
}

/** Lookups in progress per cache, so concurrent callers share one store call. */
const inflight = new WeakMap<KeyCache, Map<EngineId, Promise<KeyResolution>>>()

async function lookup(engine: EngineId, deps: KeyDeps): Promise<KeyResolution> {
  const result = await resolveUncached(engine, deps)
  if (result.key !== null) registerSecret(result.key)
  return result
}

/** True when the key is forced from outside (environment or host config): show it locked, never write it back. */
export function isKeyLocked(source: KeySource | 'missing'): boolean {
  return source === 'host-env' || source === 'env' || source === 'env-file'
}

/** One line for `doctor` and the dashboard: presence and origin, never the value (ADR-0007 point 4). */
export function describeKeyResolution(res: KeyResolution): string {
  if (res.key === null) return res.detail === undefined ? 'not set' : `not set (${res.detail})`
  switch (res.source) {
    case 'host-env':
      return `set by the host configuration (${res.via})`
    case 'env':
      return `set in the environment (${res.via})`
    case 'env-file':
      return `set from the file named by ${res.via}`
    case 'keychain':
      return `stored in ${res.via}`
    case 'dpapi':
      return 'stored with Windows DPAPI'
    case 'file':
      return 'stored in a plaintext file (insecure)'
  }
}
