// SPDX-License-Identifier: Apache-2.0
/**
 * Data and config roots (ADR-0015 point 1) plus the small file-system primitives every
 * writer shares: private directories, atomic writes and a file lock.
 *
 * `resolveRoots` is pure (everything it reads is injected) so it can be tested for every
 * OS, including stripped environments. The fs helpers below it are thin wrappers.
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, posix, win32 } from 'node:path'
import { SearchHoleError } from './errors.ts'
import { envValue } from './keys/unset.ts'

export type Env = Readonly<Record<string, string | undefined>>

/** How the roots were chosen. */
export type RootSource = 'env' | 'dot-dir' | 'platform' | 'fallback'

export interface RootsInput {
  env: Env
  platform: NodeJS.Platform
  homedir: string
  exists: (path: string) => boolean
}

export interface Roots {
  /** `rules.yaml`, `settings.yaml`. */
  config: string
  /** DB, lists, backups, searxng/, secrets/. */
  data: string
  /** `ui.json`, locks. */
  run: string
  source: RootSource
}

type PathApi = typeof posix

export const pathFor = (platform: NodeJS.Platform): PathApi => (platform === 'win32' ? win32 : posix)

const invalid = (why: string, fix: string): SearchHoleError =>
  new SearchHoleError('config_invalid', why, { fix })

/** The single-directory layout used by SEARCHHOLE_HOME, `~/.searchhole/` and the fallback. */
function singleRoot(root: string, p: PathApi, source: RootSource): Roots {
  return { config: root, data: root, run: p.join(root, 'run'), source }
}

/** Expands a leading `~` and requires an absolute path. */
function absoluteHome(value: string, input: RootsInput, p: PathApi): string {
  let v = value
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) v = p.join(input.homedir, v.slice(1))
  if (!p.isAbsolute(v)) {
    throw invalid(
      `SEARCHHOLE_HOME must be an absolute path (got a relative one).`,
      'Set SEARCHHOLE_HOME to a full path, or unset it.',
    )
  }
  return p.normalize(v)
}

/** An XDG or Windows folder variable is usable only when it is set and absolute. */
function absoluteEnv(env: Env, name: string, p: PathApi): string | undefined {
  const v = envValue(env, name)
  return v !== undefined && p.isAbsolute(v) ? v : undefined
}

function requireHome(input: RootsInput): string {
  if (input.homedir.trim() === '') {
    throw invalid(
      'Cannot determine the home directory to place search-hole data.',
      'Set SEARCHHOLE_HOME to a writable folder.',
    )
  }
  return input.homedir
}

/** Platform default roots when neither SEARCHHOLE_HOME nor `~/.searchhole/` is in play. */
function platformDefault(input: RootsInput): Roots {
  const { env, platform } = input
  const p = pathFor(platform)
  const dot = (): string => p.join(requireHome(input), '.searchhole')
  if (platform === 'darwin') return singleRoot(dot(), p, 'platform')
  if (platform === 'win32') {
    const appData = absoluteEnv(env, 'APPDATA', p)
    const localAppData = absoluteEnv(env, 'LOCALAPPDATA', p)
    // Some GUI launchers strip these; fall back to one folder under the home directory.
    if (appData === undefined || localAppData === undefined) return singleRoot(dot(), p, 'fallback')
    const data = p.join(localAppData, 'searchhole')
    return { config: p.join(appData, 'searchhole'), data, run: p.join(data, 'run'), source: 'platform' }
  }
  const home = requireHome(input)
  const config = p.join(absoluteEnv(env, 'XDG_CONFIG_HOME', p) ?? p.join(home, '.config'), 'searchhole')
  const data = p.join(absoluteEnv(env, 'XDG_DATA_HOME', p) ?? p.join(home, '.local', 'share'), 'searchhole')
  const runtime = absoluteEnv(env, 'XDG_RUNTIME_DIR', p)
  return {
    config,
    data,
    run: runtime === undefined ? p.join(data, 'run') : p.join(runtime, 'searchhole'),
    source: 'platform',
  }
}

/**
 * Resolves the config, data and run roots: `SEARCHHOLE_HOME`, else an existing
 * `~/.searchhole/`, else the platform default (ADR-0015 point 1). An unset or
 * placeholder-valued `SEARCHHOLE_HOME` counts as unset. Throws `config_invalid` for a
 * relative `SEARCHHOLE_HOME` or when no home directory can be found.
 */
export function resolveRoots(input: RootsInput): Roots {
  const p = pathFor(input.platform)
  const explicit = envValue(input.env, 'SEARCHHOLE_HOME')
  if (explicit !== undefined) return singleRoot(absoluteHome(explicit, input, p), p, 'env')
  const dot = p.join(requireHome(input), '.searchhole')
  if (input.exists(dot)) return singleRoot(dot, p, 'dot-dir')
  return platformDefault(input)
}

/** The real process inputs for `resolveRoots`. */
export function systemRootsInput(): RootsInput {
  return { env: process.env, platform: process.platform, homedir: homedir(), exists: existsSync }
}

/** Names of the files and folders under the roots (ADR-0015 data table). */
export interface RootLayout {
  settings: string
  rules: string
  db: string
  lists: string
  backups: string
  searxng: string
  secrets: string
  uiJson: string
  uiLock: string
  settingsLock: string
  rulesLock: string
}

/** Joins the standard names onto resolved roots using the platform's path rules. */
export function rootLayout(roots: Roots, platform: NodeJS.Platform = process.platform): RootLayout {
  const p = pathFor(platform)
  return {
    settings: p.join(roots.config, 'settings.yaml'),
    rules: p.join(roots.config, 'rules.yaml'),
    db: p.join(roots.data, 'searchhole.db'),
    lists: p.join(roots.data, 'lists'),
    backups: p.join(roots.data, 'backups'),
    searxng: p.join(roots.data, 'searxng'),
    secrets: p.join(roots.data, 'secrets'),
    uiJson: p.join(roots.run, 'ui.json'),
    uiLock: p.join(roots.run, 'ui.lock'),
    settingsLock: p.join(roots.run, 'settings.lock'),
    rulesLock: p.join(roots.run, 'rules.lock'),
  }
}

/**
 * Every root that currently holds search-hole data (settings, rules or the DB). `doctor`
 * warns when more than one is returned: the "launched from the dock sees different
 * XDG variables" split-brain case.
 */
export function findPopulatedRoots(input: RootsInput): Roots[] {
  const p = pathFor(input.platform)
  const candidates: Roots[] = []
  const explicit = envValue(input.env, 'SEARCHHOLE_HOME')
  if (explicit !== undefined) candidates.push(singleRoot(absoluteHome(explicit, input, p), p, 'env'))
  candidates.push(singleRoot(p.join(requireHome(input), '.searchhole'), p, 'dot-dir'))
  candidates.push(platformDefault(input))
  const seen = new Set<string>()
  const out: Roots[] = []
  for (const root of candidates) {
    const key = `${root.config}\u0000${root.data}`
    if (seen.has(key)) continue
    seen.add(key)
    const layout = rootLayout(root, input.platform)
    if ([layout.settings, layout.rules, layout.db].some((f) => input.exists(f))) out.push(root)
  }
  return out
}

// ── File-system primitives ───────────────────────────────────────────────

const errno = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e ? String(e.code) : undefined

/**
 * Creates a directory (and missing parents) and makes a newly created directory `0700`.
 * An existing directory is left as it is. Throws `config_invalid` if the path is a file.
 */
export function ensureDir(dir: string): void {
  const parent = dirname(dir)
  if (parent !== dir) mkdirSync(parent, { recursive: true })
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch (e) {
    if (errno(e) !== 'EEXIST') throw e
    if (!statSync(dir).isDirectory())
      throw invalid(
        `${dir} exists but is not a directory.`,
        'Move it aside, or set SEARCHHOLE_HOME elsewhere.',
      )
    return
  }
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync is best effort (some filesystems refuse it).
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Writes a file atomically: temp file in the same folder, fsync, rename over the target,
 * fsync the folder. Files are `0600` unless `mode` says otherwise. Readers see either the
 * old or the new content, never a partial write.
 */
export function atomicWriteFile(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', opts.mode ?? 0o600)
  try {
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Windows refuses to rename over a file another process has open; retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file)
        break
      } catch (e) {
        const code = errno(e)
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e
        sleepSync(20 * (attempt + 1))
      }
    }
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // already gone
    }
    throw e
  }
  fsyncDir(dirname(file))
}

export interface LockOptions {
  /** A lock older than this is considered abandoned. Default 30 s. */
  staleMs?: number
  /** How long to wait for the lock. Default 5 s. */
  timeoutMs?: number
  /** Poll interval while waiting. Default 25 ms. */
  retryMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pid?: number
  /** Whether a process id is alive. Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean
}

interface LockBody {
  pid: number
  startedAt: number
  token: string
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return errno(e) === 'EPERM'
  }
}

function readLock(lockPath: string): LockBody | null {
  try {
    const body: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (
      typeof body === 'object' &&
      body !== null &&
      'pid' in body &&
      'startedAt' in body &&
      'token' in body
    ) {
      const { pid, startedAt, token } = body
      if (typeof pid === 'number' && typeof startedAt === 'number' && typeof token === 'string') {
        return { pid, startedAt, token }
      }
    }
  } catch {
    // unreadable or half-written: handled by the caller
  }
  return null
}

/**
 * Runs `fn` while holding an exclusive lock file (`O_EXCL` create). A lock whose owner is
 * dead, or that is older than `staleMs`, is taken over. Used for YAML writes, where SQLite
 * is not involved (ADR-0006). Throws `internal` if the lock cannot be taken in `timeoutMs`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: LockOptions = {},
): Promise<T> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const staleMs = opts.staleMs ?? 30_000
  const retryMs = opts.retryMs ?? 25
  const pid = opts.pid ?? process.pid
  const isAlive = opts.isAlive ?? defaultIsAlive
  const deadline = now() + (opts.timeoutMs ?? 5_000)
  const token = randomBytes(8).toString('hex')
  ensureDir(dirname(lockPath))

  const isStale = (): boolean => {
    const body = readLock(lockPath)
    if (body === null) {
      // Empty or unparseable: a writer may be mid-create, so judge by file age.
      try {
        return now() - statSync(lockPath).mtimeMs > staleMs
      } catch {
        return false
      }
    }
    return now() - body.startedAt > staleMs || !isAlive(body.pid)
  }

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid, startedAt: now(), token } satisfies LockBody))
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e
      if (isStale()) {
        // Move it aside first: rename is atomic, so only one waiter removes a given lock.
        const aside = `${lockPath}.stale.${token}`
        try {
          renameSync(lockPath, aside)
          unlinkSync(aside)
        } catch {
          // someone else took it over
        }
        continue
      }
      if (now() >= deadline) {
        throw new SearchHoleError('internal', `Timed out waiting for the lock ${lockPath}.`, {
          fix: 'Another search-hole process is writing; try again, or delete the lock file if no search-hole process is running.',
        })
      }
      await sleep(retryMs)
    }
  }

  try {
    return await fn()
  } finally {
    // Release only our own lock; a takeover after staleness may have replaced it.
    if (readLock(lockPath)?.token === token) {
      try {
        unlinkSync(lockPath)
      } catch {
        // already gone
      }
    }
  }
}
