// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSearchHoleError } from './errors.ts'
import {
  atomicWriteFile,
  ensureDir,
  findPopulatedRoots,
  type RootsInput,
  resolveRoots,
  rootLayout,
  withFileLock,
} from './paths.ts'

/** An unsubstituted host placeholder such as `${user_config.name}`, built without a literal `${`. */
const ph = (name: string): string => ['$', '{', name, '}'].join('')

const input = (over: Partial<RootsInput> & { platform: NodeJS.Platform }): RootsInput => ({
  env: {},
  homedir: over.platform === 'win32' ? 'C:\\Users\\Ana' : '/home/ana',
  exists: () => false,
  ...over,
})

describe('resolveRoots', () => {
  it('SEARCHHOLE_HOME wins and puts everything under it', () => {
    const roots = resolveRoots(
      input({
        platform: 'linux',
        env: { SEARCHHOLE_HOME: '/srv/sh', XDG_CONFIG_HOME: '/x' },
        exists: () => true,
      }),
    )
    expect(roots).toEqual({ config: '/srv/sh', data: '/srv/sh', run: '/srv/sh/run', source: 'env' })
  })

  it('expands ~ in SEARCHHOLE_HOME and rejects relative paths', () => {
    expect(resolveRoots(input({ platform: 'linux', env: { SEARCHHOLE_HOME: '~/sh' } })).config).toBe(
      '/home/ana/sh',
    )
    let err: unknown
    try {
      resolveRoots(input({ platform: 'linux', env: { SEARCHHOLE_HOME: 'relative/dir' } }))
    } catch (e) {
      err = e
    }
    expect(isSearchHoleError(err) && err.code).toBe('config_invalid')
  })

  it.each(['', '   ', ph('user_config.home')])('treats SEARCHHOLE_HOME=%j as unset', (value) => {
    const roots = resolveRoots(input({ platform: 'darwin', env: { SEARCHHOLE_HOME: value } }))
    expect(roots.source).toBe('platform')
  })

  it('uses an existing ~/.searchhole on every OS before the platform default', () => {
    const existing = new Set(['/home/ana/.searchhole'])
    const roots = resolveRoots(input({ platform: 'linux', exists: (p) => existing.has(p) }))
    expect(roots).toEqual({
      config: '/home/ana/.searchhole',
      data: '/home/ana/.searchhole',
      run: '/home/ana/.searchhole/run',
      source: 'dot-dir',
    })
    const win = resolveRoots(
      input({
        platform: 'win32',
        env: { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' },
        exists: (p) => p === 'C:\\Users\\Ana\\.searchhole',
      }),
    )
    expect(win.source).toBe('dot-dir')
    expect(win.config).toBe('C:\\Users\\Ana\\.searchhole')
  })

  it('macOS default is ~/.searchhole with run/', () => {
    expect(resolveRoots(input({ platform: 'darwin', homedir: '/Users/ana' }))).toEqual({
      config: '/Users/ana/.searchhole',
      data: '/Users/ana/.searchhole',
      run: '/Users/ana/.searchhole/run',
      source: 'platform',
    })
  })

  describe('Linux', () => {
    it('uses XDG defaults when the variables are unset', () => {
      expect(resolveRoots(input({ platform: 'linux' }))).toEqual({
        config: '/home/ana/.config/searchhole',
        data: '/home/ana/.local/share/searchhole',
        run: '/home/ana/.local/share/searchhole/run',
        source: 'platform',
      })
    })

    it('honours XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_RUNTIME_DIR', () => {
      const roots = resolveRoots(
        input({
          platform: 'linux',
          env: { XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_RUNTIME_DIR: '/run/user/1000' },
        }),
      )
      expect(roots).toEqual({
        config: '/c/searchhole',
        data: '/d/searchhole',
        run: '/run/user/1000/searchhole',
        source: 'platform',
      })
    })

    it('ignores relative or empty XDG values (a stripped launcher environment)', () => {
      const roots = resolveRoots(
        input({
          platform: 'linux',
          env: { XDG_CONFIG_HOME: 'rel', XDG_DATA_HOME: '', XDG_RUNTIME_DIR: 'tmp' },
        }),
      )
      expect(roots.config).toBe('/home/ana/.config/searchhole')
      expect(roots.data).toBe('/home/ana/.local/share/searchhole')
      expect(roots.run).toBe('/home/ana/.local/share/searchhole/run')
    })
  })

  describe('Windows', () => {
    it('uses %APPDATA% for config and %LOCALAPPDATA% for data and run', () => {
      expect(
        resolveRoots(
          input({
            platform: 'win32',
            env: {
              APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming',
              LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local',
            },
          }),
        ),
      ).toEqual({
        config: 'C:\\Users\\Ana\\AppData\\Roaming\\searchhole',
        data: 'C:\\Users\\Ana\\AppData\\Local\\searchhole',
        run: 'C:\\Users\\Ana\\AppData\\Local\\searchhole\\run',
        source: 'platform',
      })
    })

    it('falls back to <home>\\.searchhole when either variable is missing', () => {
      for (const env of [
        {},
        { APPDATA: 'C:\\A' },
        { LOCALAPPDATA: 'C:\\L' },
        { APPDATA: '', LOCALAPPDATA: '' },
      ]) {
        expect(resolveRoots(input({ platform: 'win32', env }))).toEqual({
          config: 'C:\\Users\\Ana\\.searchhole',
          data: 'C:\\Users\\Ana\\.searchhole',
          run: 'C:\\Users\\Ana\\.searchhole\\run',
          source: 'fallback',
        })
      }
    })

    it('accepts SEARCHHOLE_HOME with Windows separators', () => {
      expect(resolveRoots(input({ platform: 'win32', env: { SEARCHHOLE_HOME: 'D:\\data\\sh' } })).run).toBe(
        'D:\\data\\sh\\run',
      )
    })
  })

  it('throws config_invalid when no home directory can be found', () => {
    let err: unknown
    try {
      resolveRoots(input({ platform: 'linux', homedir: '' }))
    } catch (e) {
      err = e
    }
    expect(isSearchHoleError(err) && err.fix).toContain('SEARCHHOLE_HOME')
  })
})

describe('rootLayout', () => {
  it('names the standard files under the roots', () => {
    const layout = rootLayout({ config: '/c', data: '/d', run: '/r', source: 'platform' }, 'linux')
    expect(layout).toMatchObject({
      settings: '/c/settings.yaml',
      rules: '/c/rules.yaml',
      db: '/d/searchhole.db',
      secrets: '/d/secrets',
      uiJson: '/r/ui.json',
      settingsLock: '/r/settings.lock',
    })
  })
})

describe('findPopulatedRoots (split-brain detection)', () => {
  it('returns every root that holds data, without duplicates', () => {
    const present = new Set([
      '/home/ana/.searchhole/settings.yaml',
      '/home/ana/.local/share/searchhole/searchhole.db',
    ])
    const found = findPopulatedRoots(input({ platform: 'linux', exists: (p) => present.has(p) }))
    expect(found.map((r) => r.source)).toEqual(['dot-dir', 'platform'])
  })

  it('returns one root when only one holds data, and includes SEARCHHOLE_HOME', () => {
    const present = new Set(['/srv/sh/rules.yaml'])
    const found = findPopulatedRoots(
      input({ platform: 'darwin', env: { SEARCHHOLE_HOME: '/srv/sh' }, exists: (p) => present.has(p) }),
    )
    expect(found.map((r) => r.config)).toEqual(['/srv/sh'])
  })

  it('does not list the same folder twice on macOS', () => {
    const found = findPopulatedRoots(
      input({
        platform: 'darwin',
        homedir: '/Users/ana',
        exists: (p) => p === '/Users/ana/.searchhole/settings.yaml',
      }),
    )
    expect(found).toHaveLength(1)
  })
})

describe('file-system primitives', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'searchhole-paths-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('ensureDir creates nested directories, 0700 for the leaf, and is idempotent', () => {
    const leaf = join(dir, 'a', 'b', 'leaf')
    ensureDir(leaf)
    ensureDir(leaf)
    expect(statSync(leaf).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(leaf).mode & 0o777).toBe(0o700)
  })

  it('ensureDir leaves an existing directory alone and rejects a file in the way', () => {
    const existing = join(dir, 'shared')
    mkdirSync(existing, { mode: 0o755 })
    ensureDir(existing)
    if (process.platform !== 'win32') expect(statSync(existing).mode & 0o777).toBe(0o755)
    const file = join(dir, 'file')
    writeFileSync(file, 'x')
    expect(() => ensureDir(file)).toThrow(/not a directory/)
  })

  it('atomicWriteFile writes 0600, replaces content, and leaves no temp files', () => {
    const file = join(dir, 'settings.yaml')
    atomicWriteFile(file, 'one')
    atomicWriteFile(file, 'two')
    expect(readFileSync(file, 'utf8')).toBe('two')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['settings.yaml'])
  })

  it('atomicWriteFile cleans up its temp file when the target cannot be replaced', () => {
    const target = join(dir, 'target')
    mkdirSync(target)
    expect(() => atomicWriteFile(target, 'x')).toThrow()
    expect(readdirSync(dir)).toEqual(['target'])
  })

  describe('withFileLock', () => {
    it('serialises concurrent holders', async () => {
      const lock = join(dir, 'run', 'x.lock')
      let active = 0
      let maxActive = 0
      const order: number[] = []
      const task = (n: number) =>
        withFileLock(lock, async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await new Promise((r) => setTimeout(r, 15))
          order.push(n)
          active--
        })
      await Promise.all([task(1), task(2), task(3), task(4)])
      expect(maxActive).toBe(1)
      expect([...order].sort()).toEqual([1, 2, 3, 4])
      expect(existsSync(lock)).toBe(false)
    })

    it('releases the lock when fn throws and returns fn results', async () => {
      const lock = join(dir, 'l.lock')
      await expect(
        withFileLock(lock, () => {
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect(existsSync(lock)).toBe(false)
      await expect(withFileLock(lock, () => 42)).resolves.toBe(42)
    })

    it('takes over a lock whose owner process is dead', async () => {
      const lock = join(dir, 'dead.lock')
      writeFileSync(lock, JSON.stringify({ pid: 999_999, startedAt: Date.now(), token: 'old' }))
      await expect(withFileLock(lock, () => 'ok', { isAlive: () => false })).resolves.toBe('ok')
    })

    it('takes over a lock older than staleMs even if the pid looks alive', async () => {
      const lock = join(dir, 'old.lock')
      const clock = 1_000_000
      writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: clock - 60_000, token: 'old' }))
      await expect(
        withFileLock(lock, () => 'ok', { isAlive: () => true, now: () => clock, staleMs: 30_000 }),
      ).resolves.toBe('ok')
    })

    it('times out on a fresh lock held by a live process (injected clock)', async () => {
      const lock = join(dir, 'busy.lock')
      let clock = 5_000
      writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: clock, token: 'held' }))
      const sleep = (ms: number): Promise<void> => {
        clock += ms
        return Promise.resolve()
      }
      let err: unknown
      try {
        await withFileLock(lock, () => 'never', {
          isAlive: () => true,
          now: () => clock,
          sleep,
          timeoutMs: 200,
          retryMs: 50,
          staleMs: 10_000,
        })
      } catch (e) {
        err = e
      }
      expect(isSearchHoleError(err)).toBe(true)
      expect(readFileSync(lock, 'utf8')).toContain('held')
    })

    it('does not remove a lock it no longer owns', async () => {
      const lock = join(dir, 'taken.lock')
      await withFileLock(lock, () => {
        writeFileSync(
          lock,
          JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'someone-else' }),
        )
      })
      expect(readFileSync(lock, 'utf8')).toContain('someone-else')
    })
  })
})
