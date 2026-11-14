// SPDX-License-Identifier: Apache-2.0
/**
 * `searchhole uninstall [--purge]` (ADR-0006 point 13). Without `--purge` it only lists what
 * would go. With it: every key in search-hole's own stores is deleted (the App's `keys.remove`
 * clears the OS keychain entry and the insecure file), then search-hole's own files inside its
 * roots, then its folders and the roots themselves if empty.
 *
 * Nothing is deleted because of where it is: `SEARCHHOLE_HOME` may point anywhere, even at a
 * folder with other things in it. A file goes only when search-hole writes a file of that
 * name; inside its folders (`lists`, `backups`, `secrets`, `searxng`) only what it puts there
 * goes, and whatever else is in them stays and is listed. A root that is `/`, a drive root,
 * the home directory or any of its ancestors is refused outright. Secrets held by other apps
 * (Claude Code plugin options, Claude Desktop extension settings) can't be reached from here,
 * so the plan names how to remove them.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import type { Roots } from '../shared/paths.ts'
import { ENGINE_ID_LIST, type EngineId } from '../shared/types.ts'

/** Files search-hole creates directly in a root (ADR-0015 data table). */
export const KNOWN_FILES: readonly string[] = [
  'settings.yaml',
  'rules.yaml',
  'searchhole.db',
  'searchhole.db-wal',
  'searchhole.db-shm',
  'searchhole.db-journal',
  'ui.json',
  'ui.lock',
  'settings.lock',
  'rules.lock',
  'project-rules.lock',
]

/** Folders search-hole creates in its data root. Only what it puts in them is deleted. */
export const KNOWN_FOLDERS: readonly string[] = ['lists', 'backups', 'secrets', 'searxng']

/** A leftover of an interrupted atomic write: `<file>.<pid>.<8 hex>.tmp`. */
const TMP_SUFFIX = /\.\d+\.[0-9a-f]{8}\.tmp$/
/** What a list's folder holds (app/listfiles.ts). */
const LIST_FILE = /^(?:source\.txt|source\.json|manifest\.json|compiled-\d{1,6}\.json)$/
/** A pre-migration database copy (store/migrate.ts). */
const BACKUP_FILE = /^searchhole-v\d+-\d{8}T\d{9}Z-\d+(?:-\d+)?\.db(?:-wal|-shm|-journal)?$/
/** A key file of the insecure store or the Windows DPAPI store (shared/keys). */
const KEY_FILE = new RegExp(`^(?:${ENGINE_ID_LIST.join('|')})\\.(?:key|dpapi)$`)
/** First words of the `searxng/settings.yml` that `searchhole searxng up` writes. */
const SEARXNG_MARK = '# Managed by search-hole'

/** Keyed engines (SearXNG takes no key). */
const KEYED: readonly EngineId[] = ENGINE_ID_LIST.filter((e) => e !== 'searxng')

export interface UninstallPlan {
  /** Absolute paths to delete: search-hole's own files, and folders that hold nothing else. */
  remove: string[]
  /** search-hole's folders, removed afterwards when empty. */
  folders: string[]
  /** Roots removed afterwards when empty. */
  roots: string[]
  /** Things inside search-hole's folders that it did not put there. They stay. */
  left: string[]
  /** Roots refused as unsafe to touch. */
  refused: Array<{ root: string; why: string }>
  /** Engines whose keys in search-hole's own stores are deleted. */
  keys: EngineId[]
  /** What other apps hold, and how to remove it (we can't). */
  elsewhere: string[]
}

interface Entry {
  name: string
  dir: boolean
}

const entries = (dir: string): Entry[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }))
  } catch {
    return []
  }
}

const own = (name: string, pattern: RegExp): boolean => pattern.test(name.replace(TMP_SUFFIX, ''))

/** True when a folder holds nothing but one list's files. */
const isListFolder = (dir: string): boolean => entries(dir).every((e) => !e.dir && own(e.name, LIST_FILE))

/** True when `searxng/` is the one `searchhole searxng up` made (the container writes into it too). */
const isOurSearxng = (dir: string): boolean => {
  try {
    return readFileSync(join(dir, 'settings.yml'), 'utf8').startsWith(SEARXNG_MARK)
  } catch {
    return false
  }
}

/** Sorts what is inside one of search-hole's folders into "ours, delete" and "not ours, leave". */
function sortFolder(folder: string, plan: Pick<UninstallPlan, 'remove' | 'folders' | 'left'>): void {
  const take = (path: string, ours: boolean): void => void (ours ? plan.remove : plan.left).push(path)
  switch (basename(folder)) {
    case 'lists':
      for (const e of entries(folder)) {
        const path = join(folder, e.name)
        if (!e.dir) take(path, own(e.name, /^generation$/))
        else if (e.name === 'local') {
          // Imported lists, one folder each.
          for (const c of entries(path)) take(join(path, c.name), c.dir && isListFolder(join(path, c.name)))
          plan.folders.push(path)
        } else take(path, isListFolder(path))
      }
      break
    case 'backups':
      for (const e of entries(folder)) take(join(folder, e.name), !e.dir && own(e.name, BACKUP_FILE))
      break
    case 'secrets':
      for (const e of entries(folder)) take(join(folder, e.name), !e.dir && own(e.name, KEY_FILE))
      break
    case 'searxng':
      if (isOurSearxng(folder)) for (const e of entries(folder)) plan.remove.push(join(folder, e.name))
      else plan.left.push(...entries(folder).map((e) => join(folder, e.name)))
      break
  }
  plan.folders.push(folder)
}

/** A path with its symlinks resolved, as far as it exists. */
function real(path: string): string {
  const rest: string[] = []
  let at = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(at), ...rest)
    } catch {
      const up = dirname(at)
      if (up === at) return resolve(path)
      rest.unshift(basename(at))
      at = up
    }
  }
}

/** True when `a` is `b` or contains it. */
const containsOrEquals = (a: string, b: string, foldCase = false): boolean => {
  const x = foldCase ? resolve(a).toLowerCase() : resolve(a)
  const y = foldCase ? resolve(b).toLowerCase() : resolve(b)
  return y === x || y.startsWith(x.endsWith(sep) ? x : x + sep)
}

/**
 * Why deleting inside `root` is unsafe, or undefined when it is fine. Paths are compared as
 * written and with symlinks resolved, ignoring case where the file system does (macOS, Windows).
 */
export function unsafeRoot(
  root: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const foldCase = platform === 'darwin' || platform === 'win32'
  for (const r of new Set([resolve(root), real(root)])) {
    if (parse(r).root === r) return 'it is a filesystem root'
    for (const h of new Set([resolve(home), real(home)])) {
      if (containsOrEquals(r, h, foldCase)) return 'it is your home folder or contains it'
    }
  }
  return undefined
}

export function planUninstall(o: { roots: Roots; home: string; platform?: NodeJS.Platform }): UninstallPlan {
  const roots = [...new Set([o.roots.config, o.roots.data, o.roots.run].map((r) => resolve(r)))]
  const plan: UninstallPlan = {
    remove: [],
    folders: [],
    roots: [],
    left: [],
    refused: [],
    keys: [...KEYED],
    elsewhere: [
      'Claude Code plugin (and the keys you gave it): claude plugin uninstall search-hole@search-hole-local, then claude plugin marketplace remove search-hole-local',
      'Claude Desktop extension (and its keychain keys): Settings → Extensions → search-hole → Uninstall',
      'MCP configs written by `searchhole setup` (VS Code, Cursor, Windsurf, Zed, Goose, Codex): remove the "search-hole" entry; setup left a .bak copy next to each file it changed',
      'A private SearXNG container, if you started one: run `searchhole searxng down` first',
      'Project .searchhole.yaml files in your repositories are yours and stay',
    ],
  }
  for (const root of roots) {
    const why = unsafeRoot(root, o.home, o.platform)
    if (why !== undefined) {
      plan.refused.push({ root, why })
      continue
    }
    for (const name of KNOWN_FILES) {
      const p = resolve(root, name)
      if (existsSync(p) && !plan.remove.includes(p)) plan.remove.push(p)
    }
    for (const name of KNOWN_FOLDERS) {
      const p = resolve(root, name)
      // A root of its own (the run folder inside the data folder) is handled as a root.
      if (existsSync(p) && !roots.includes(p) && !plan.folders.includes(p)) sortFolder(p, plan)
    }
    plan.roots.push(root)
  }
  // Children before parents (`lists/local` before `lists`; the run root may live inside the data root).
  plan.folders.sort((a, b) => b.length - a.length)
  plan.roots.sort((a, b) => b.length - a.length)
  return plan
}

export interface UninstallOutcome {
  removed: string[]
  failed: Array<{ path: string; error: string }>
  keysRemoved: EngineId[]
  keysFailed: Array<{ engine: EngineId; error: string }>
  /** Roots and folders that were empty afterwards and are gone. */
  rootsRemoved: string[]
}

export interface UninstallDeps {
  /** Deletes one engine's key from search-hole's own stores (App `keys.remove`). */
  removeKey(engine: EngineId): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Carries out a plan: keys first (they need the secrets folder), then files, then empty folders and roots. */
export async function runUninstall(plan: UninstallPlan, deps: UninstallDeps): Promise<UninstallOutcome> {
  const out: UninstallOutcome = { removed: [], failed: [], keysRemoved: [], keysFailed: [], rootsRemoved: [] }
  for (const engine of plan.keys) {
    try {
      await deps.removeKey(engine)
      out.keysRemoved.push(engine)
    } catch (e) {
      out.keysFailed.push({ engine, error: message(e) })
    }
  }
  for (const p of plan.remove) {
    if (!plan.roots.some((r) => p !== r && containsOrEquals(r, dirname(p)))) continue // never outside a planned root
    try {
      rmSync(p, { recursive: true, force: true })
      out.removed.push(p)
    } catch (e) {
      out.failed.push({ path: p, error: message(e) })
    }
  }
  for (const dir of [...plan.folders, ...plan.roots]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmdirSync(dir)
        out.rootsRemoved.push(dir)
      }
    } catch {
      // A folder that still has other files in it stays.
    }
  }
  return out
}
