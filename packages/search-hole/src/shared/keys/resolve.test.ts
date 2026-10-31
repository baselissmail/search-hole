// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isSearchHoleError, SearchHoleError } from '../errors.ts'
import type { EngineId } from '../types.ts'
import {
  CONVENTIONAL_KEY_ENV,
  createKeyCache,
  describeKeyResolution,
  hostKeyEnvName,
  isKeyLocked,
  type KeyDeps,
  resolveKey,
} from './resolve.ts'
import type { SecretStore, StoreKind } from './types.ts'

/** An unsubstituted host placeholder such as `${user_config.name}`, built without a literal `${`. */
const ph = (name: string): string => ['$', '{', name, '}'].join('')

const KEY = 'tvly-test-key-0123456789abcdef'

/** A store backed by a map, counting reads. */
function fakeStore(kind: StoreKind, entries: Partial<Record<EngineId, string>> = {}, fail?: () => never) {
  const state = { reads: 0, entries: { ...entries } }
  const store: SecretStore = {
    kind,
    label: `fake ${kind}`,
    async get(engine) {
      state.reads++
      if (fail) fail()
      return state.entries[engine] ?? null
    },
    async set(engine, key) {
      state.entries[engine] = key
    },
    async delete(engine) {
      return delete state.entries[engine]
    },
    async probe() {
      return { ok: true }
    },
  }
  return { store, state }
}

const deps = (over: Partial<KeyDeps> = {}): KeyDeps => ({ env: {}, ...over })

async function thrown(p: Promise<unknown>): Promise<SearchHoleError> {
  try {
    await p
  } catch (e) {
    if (isSearchHoleError(e)) return e
    throw e
  }
  throw new Error('expected a SearchHoleError')
}

describe('resolveKey order (ADR-0007 point 1)', () => {
  it('prefers the host-injected variable over everything else', async () => {
    const { store } = fakeStore('keychain', { tavily: 'from-store' })
    const res = await resolveKey(
      'tavily',
      deps({ env: { SEARCHHOLE_TAVILY_API_KEY: 'from-host', TAVILY_API_KEY: 'from-env' }, store }),
    )
    expect(res).toEqual({ key: 'from-host', source: 'host-env', via: 'SEARCHHOLE_TAVILY_API_KEY' })
  })

  it('then the conventional variable, then its _FILE, then the store', async () => {
    const { store } = fakeStore('keychain', { tavily: 'from-store' })
    const readFile = async (path: string) => (path === '/run/secrets/tavily' ? 'from-file\n' : '')
    expect(await resolveKey('tavily', deps({ env: { TAVILY_API_KEY: 'from-env' }, store }))).toEqual({
      key: 'from-env',
      source: 'env',
      via: 'TAVILY_API_KEY',
    })
    expect(
      await resolveKey(
        'tavily',
        deps({ env: { TAVILY_API_KEY_FILE: '/run/secrets/tavily' }, store, readFile }),
      ),
    ).toEqual({
      key: 'from-file',
      source: 'env-file',
      via: 'TAVILY_API_KEY_FILE',
    })
    expect(await resolveKey('tavily', deps({ store }))).toEqual({
      key: 'from-store',
      source: 'keychain',
      via: 'fake keychain',
    })
  })

  it.each(Object.entries(CONVENTIONAL_KEY_ENV).filter(([, names]) => names.length > 0))(
    '%s reads its conventional names in order',
    async (engine, names) => {
      for (const name of names) {
        const res = await resolveKey(engine as EngineId, deps({ env: { [name]: `k-${name}` } }))
        expect(res).toMatchObject({ key: `k-${name}`, source: 'env', via: name })
      }
      if (names.length > 1) {
        const both = Object.fromEntries(names.map((n) => [n, `k-${n}`]))
        expect(await resolveKey(engine as EngineId, deps({ env: both }))).toMatchObject({ via: names[0] })
      }
    },
  )

  it('knows Brave under both of its names and builds host names from the engine id', async () => {
    expect(CONVENTIONAL_KEY_ENV.brave).toEqual(['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY'])
    expect(hostKeyEnvName('brave')).toBe('SEARCHHOLE_BRAVE_API_KEY')
    expect(await resolveKey('brave', deps({ env: { BRAVE_API_KEY: 'b' } }))).toMatchObject({
      key: 'b',
      via: 'BRAVE_API_KEY',
    })
  })

  it('returns missing when nothing is configured', async () => {
    expect(await resolveKey('exa', deps())).toEqual({ key: null, source: 'missing' })
  })

  it('does not look anywhere for keyless engines', async () => {
    const { store, state } = fakeStore('keychain', { searxng: 'x' })
    const res = await resolveKey('searxng', deps({ env: { SEARCHHOLE_SEARXNG_API_KEY: 'x' }, store }))
    expect(res).toEqual({ key: null, source: 'missing' })
    expect(state.reads).toBe(0)
  })
})

describe('unset values (MCPB placeholders, blanks)', () => {
  const unset = ['', '   ', '\t\n', ph('user_config.brave_api_key'), ` ${ph('user_config.x')} `, ph('TAVILY')]

  it.each(unset)('treats %j as unset at every level and falls through', async (value) => {
    const { store } = fakeStore('keychain', { tavily: 'from-store' })
    const res = await resolveKey(
      'tavily',
      deps({
        env: { SEARCHHOLE_TAVILY_API_KEY: value, TAVILY_API_KEY: value, TAVILY_API_KEY_FILE: value },
        store,
      }),
    )
    expect(res).toMatchObject({ key: 'from-store', source: 'keychain' })
  })

  it('treats a placeholder store value as unset too', async () => {
    const { store } = fakeStore('file', { tavily: '   ' })
    expect(await resolveKey('tavily', deps({ store }))).toEqual({ key: null, source: 'missing' })
  })

  it('lets a lower level win when the higher one is a placeholder', async () => {
    const res = await resolveKey(
      'tavily',
      deps({ env: { SEARCHHOLE_TAVILY_API_KEY: ph('user_config.tavily_api_key'), TAVILY_API_KEY: 'real' } }),
    )
    expect(res).toMatchObject({ key: 'real', source: 'env' })
  })

  it('trims surrounding whitespace from keys (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_-]{8,40}$/),
        fc.constantFrom('', ' ', '\n', '\t '),
        async (key, pad) => {
          const res = await resolveKey('exa', deps({ env: { EXA_API_KEY: `${pad}${key}${pad}` } }))
          expect(res).toMatchObject({ key, source: 'env' })
        },
      ),
      { seed: 11, numRuns: 50 },
    )
  })

  it('skips values with control characters and says why', async () => {
    const res = await resolveKey('exa', deps({ env: { EXA_API_KEY: 'abc\r\nX-Evil: 1' } }))
    expect(res).toEqual({
      key: null,
      source: 'missing',
      detail: 'EXA_API_KEY ignored: it contains control characters',
    })
  })
})

describe('_FILE variants', () => {
  it('errors when a name and its _FILE are both set, naming both and never a value', async () => {
    const err = await thrown(
      resolveKey('tavily', deps({ env: { TAVILY_API_KEY: KEY, TAVILY_API_KEY_FILE: '/x' } })),
    )
    expect(err.code).toBe('config_invalid')
    expect(err.why).toContain('TAVILY_API_KEY')
    expect(err.why).toContain('TAVILY_API_KEY_FILE')
    expect(JSON.stringify(err.details)).not.toContain(KEY)
    expect(err.why + err.fix).not.toContain(KEY)
  })

  it('does not count a placeholder as "set" for the conflict check', async () => {
    const res = await resolveKey(
      'tavily',
      deps({
        env: { TAVILY_API_KEY: ph('user_config.k'), TAVILY_API_KEY_FILE: '/f' },
        readFile: async () => 'k-from-file',
      }),
    )
    expect(res).toMatchObject({ key: 'k-from-file', source: 'env-file' })
  })

  it('errors when the file cannot be read, without leaking anything', async () => {
    const err = await thrown(
      resolveKey(
        'brave',
        deps({
          env: { BRAVE_API_KEY_FILE: '/nope/key' },
          readFile: async () => {
            throw new Error('ENOENT: no such file')
          },
        }),
      ),
    )
    expect(err.code).toBe('config_invalid')
    expect(err.why).toContain('BRAVE_API_KEY_FILE')
  })

  it('skips an empty file and continues to the next source', async () => {
    const { store } = fakeStore('keychain', { exa: 'stored' })
    const res = await resolveKey(
      'exa',
      deps({ env: { EXA_API_KEY_FILE: '/empty' }, readFile: async () => '\n', store }),
    )
    expect(res).toMatchObject({ key: 'stored', source: 'keychain' })
  })

  it('reads the second Brave name as a file when the first is absent', async () => {
    const res = await resolveKey(
      'brave',
      deps({ env: { BRAVE_API_KEY_FILE: '/b' }, readFile: async () => 'bk' }),
    )
    expect(res).toMatchObject({ key: 'bk', via: 'BRAVE_API_KEY_FILE' })
  })
})

describe('stores', () => {
  it('tries stores in order and reports the one that answered', async () => {
    const os = fakeStore('keychain')
    const file = fakeStore('file', { kagi: 'from-file' })
    const res = await resolveKey('kagi', deps({ store: [os.store, file.store] }))
    expect(res).toMatchObject({ key: 'from-file', source: 'file', via: 'fake file' })
    expect(os.state.reads).toBe(1)
  })

  it('records a failing store in detail and keeps going', async () => {
    const broken = fakeStore('keychain', {}, () => {
      throw new SearchHoleError('store_unavailable', 'macOS Keychain: locked')
    })
    const file = fakeStore('file', { exa: 'ok' })
    expect(await resolveKey('exa', deps({ store: [broken.store, file.store] }))).toMatchObject({
      key: 'ok',
      source: 'file',
    })
    expect(await resolveKey('exa', deps({ store: broken.store }))).toEqual({
      key: null,
      source: 'missing',
      detail: 'macOS Keychain: locked',
    })
  })

  it('does not ask the store when the environment already answered', async () => {
    const { store, state } = fakeStore('keychain', { exa: 'x' })
    await resolveKey('exa', deps({ env: { EXA_API_KEY: 'e' }, store }))
    expect(state.reads).toBe(0)
  })
})

describe('cache (60 s, injected clock)', () => {
  it('serves from the cache until the TTL passes, then asks again', async () => {
    let now = 1_000
    const { store, state } = fakeStore('keychain', { exa: 'one' })
    const cache = createKeyCache(() => now)
    const d = deps({ store, cache })
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'one' })
    state.entries.exa = 'two'
    now += 59_999
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'one' })
    expect(state.reads).toBe(1)
    now += 1
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'two' })
    expect(state.reads).toBe(2)
  })

  it('caches "missing" too, so a pasted key shows up within a minute or on clear()', async () => {
    let now = 0
    const { store, state } = fakeStore('keychain')
    const cache = createKeyCache(() => now)
    const d = deps({ store, cache })
    expect(await resolveKey('exa', d)).toMatchObject({ source: 'missing' })
    await store.set('exa', 'pasted')
    expect(await resolveKey('exa', d)).toMatchObject({ source: 'missing' })
    cache.clear('exa')
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'pasted' })
    expect(state.reads).toBe(2)
    cache.clear()
    now += 61_000
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'pasted' })
  })

  it('stale-while-revalidate: an expired key is served at once and refreshed in the background', async () => {
    let now = 0
    const { store, state } = fakeStore('keychain', { exa: 'one' })
    const cache = createKeyCache(() => now)
    const d = deps({ store, cache, staleWhileRevalidate: true })
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'one' })
    state.entries.exa = 'two'
    now += 61_000
    // Concurrent callers share one store read and get the stale value without waiting.
    const [a, b] = await Promise.all([resolveKey('exa', d), resolveKey('exa', d)])
    expect([a.key, b.key]).toEqual(['one', 'one'])
    await new Promise((r) => setImmediate(r))
    expect(state.reads).toBe(2)
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'two' })
    expect(state.reads).toBe(2)
  })

  it('clear() during a background refresh: the old value is not written back', async () => {
    let now = 0
    const { store, state } = fakeStore('keychain', { exa: 'old' })
    const cache = createKeyCache(() => now)
    const d = deps({ store, cache, staleWhileRevalidate: true })
    await resolveKey('exa', d)
    now += 61_000
    const pending = resolveKey('exa', d)
    cache.clear('exa')
    state.entries.exa = 'new'
    expect((await pending).key).toBe('old')
    await new Promise((r) => setImmediate(r))
    expect(await resolveKey('exa', d)).toMatchObject({ key: 'new' })
  })

  it('keeps engines apart and does not cache thrown errors', async () => {
    const cache = createKeyCache(() => 0)
    const env = { TAVILY_API_KEY: 'a', TAVILY_API_KEY_FILE: '/f' }
    await thrown(resolveKey('tavily', { env, cache }))
    const fixed = await resolveKey('tavily', { env: { TAVILY_API_KEY: 'a' }, cache })
    expect(fixed).toMatchObject({ key: 'a' })
    expect(await resolveKey('exa', { env: { EXA_API_KEY: 'b' }, cache })).toMatchObject({ key: 'b' })
  })
})

describe('describeKeyResolution / isKeyLocked', () => {
  it('describes presence and origin without ever showing the value', async () => {
    const host = await resolveKey('brave', deps({ env: { SEARCHHOLE_BRAVE_API_KEY: KEY } }))
    expect(describeKeyResolution(host)).toBe('set by the host configuration (SEARCHHOLE_BRAVE_API_KEY)')
    const env = await resolveKey('brave', deps({ env: { BRAVE_API_KEY: KEY } }))
    expect(describeKeyResolution(env)).toBe('set in the environment (BRAVE_API_KEY)')
    const file = await resolveKey(
      'brave',
      deps({ env: { BRAVE_API_KEY_FILE: '/f' }, readFile: async () => KEY }),
    )
    expect(describeKeyResolution(file)).toBe('set from the file named by BRAVE_API_KEY_FILE')
    const stored = await resolveKey('brave', deps({ store: fakeStore('keychain', { brave: KEY }).store }))
    expect(describeKeyResolution(stored)).toBe('stored in fake keychain')
    for (const r of [host, env, file, stored]) expect(describeKeyResolution(r)).not.toContain(KEY)
    expect(describeKeyResolution({ key: null, source: 'missing' })).toBe('not set')
    expect(describeKeyResolution({ key: null, source: 'missing', detail: 'locked' })).toBe('not set (locked)')
  })

  it('locks only keys forced from the environment', () => {
    expect(['host-env', 'env', 'env-file'].map((s) => isKeyLocked(s as 'env'))).toEqual([true, true, true])
    expect(['keychain', 'dpapi', 'file', 'missing'].map((s) => isKeyLocked(s as 'file'))).toEqual([
      false,
      false,
      false,
      false,
    ])
  })
})
