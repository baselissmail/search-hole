// SPDX-License-Identifier: Apache-2.0
/**
 * `searchhole uninstall [--purge]` (ADR-0006 point 13). Without `--purge` it only lists what
 * would go. With it: every key in search-hole's own stores is deleted (the App's `keys.remove`
 * clears the OS keychain entry and the insecure file), then search-hole's known files and folders
 * inside its roots, then the roots themselves if empty.
 *
 * Deletion is by name, never "the whole folder": `SEARCHHOLE_HOME` may point anywhere, even at a
 * folder with other things in it. A root that is `/`, a drive root, the home directory or any of
 * its ancestors is refused outright. Secrets held by other apps (Claude Code plugin options,
 * Claude Desktop extension settings) can't be reached from here, so the plan names how to remove
 * them.
 */
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, parse, resolve, sep } from 'node:path'
import type { Roots } from '../shared/paths.ts'
import { ENGINE_ID_LIST, type EngineId } from '../shared/types.ts'

/** Everything search-hole creates inside its roots (ADR-0015 data table). */
export const KNOWN_ENTRIES: readonly string[] = [
  'settings.yaml',
  'rules.yaml',
  'searchhole.db',
  'searchhole.db-wal',
  'searchhole.db-shm',
  'searchhole.db-journal',
  'lists',
  'backups',
  'searxng',
  'secrets',
  'run',
  'ui.json',
  'ui.lock',
  'settings.lock',
  'rules.lock',
]

/** Keyed engines (SearXNG takes no key). */
const KEYED: readonly EngineId[] = ENGINE_ID_LIST.filter((e) => e !== 'searxng')

export interface UninstallPlan {
  /** Absolute paths to delete, each a known entry inside a search-hole root. */
  remove: string[]
  /** Roots removed afterwards when empty. */
  roots: string[]
  /** Roots refused as unsafe to touch. */
  refused: Array<{ root: string; why: string }>
  /** Engines whose keys in search-hole's own stores are deleted. */
  keys: EngineId[]
  /** What other apps hold, and how to remove it (we can't). */
  elsewhere: string[]
}

/** True when `a` is `b` or contains it. */
const containsOrEquals = (a: string, b: string): boolean => {
  const x = resolve(a)
  const y = resolve(b)
  return y === x || y.startsWith(x.endsWith(sep) ? x : x + sep)
}

/** Why deleting inside `root` is unsafe, or undefined when it is fine. */
export function unsafeRoot(root: string, home: string): string | undefined {
  const r = resolve(root)
  if (parse(r).root === r) return 'it is a filesystem root'
  if (containsOrEquals(r, home)) return 'it is your home folder or contains it'
  return undefined
}

export function planUninstall(o: {
  roots: Roots
  home: string
  exists?: (p: string) => boolean
}): UninstallPlan {
  const exists = o.exists ?? existsSync
  const roots = [...new Set([o.roots.config, o.roots.data, o.roots.run].map((r) => resolve(r)))]
  const plan: UninstallPlan = {
    remove: [],
    roots: [],
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
    const why = unsafeRoot(root, o.home)
    if (why !== undefined) {
      plan.refused.push({ root, why })
      continue
    }
    for (const name of KNOWN_ENTRIES) {
      const p = resolve(root, name)
      if (exists(p) && !plan.remove.includes(p)) plan.remove.push(p)
    }
    plan.roots.push(root)
  }
  // Children before parents (the run root may live inside the data root).
  plan.roots.sort((a, b) => b.length - a.length)
  return plan
}

export interface UninstallOutcome {
  removed: string[]
  failed: Array<{ path: string; error: string }>
  keysRemoved: EngineId[]
  keysFailed: Array<{ engine: EngineId; error: string }>
  rootsRemoved: string[]
}

export interface UninstallDeps {
  /** Deletes one engine's key from search-hole's own stores (App `keys.remove`). */
  removeKey(engine: EngineId): Promise<void>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Carries out a plan: keys first (they need the secrets folder), then files, then empty roots. */
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
    if (!plan.roots.some((r) => containsOrEquals(r, dirname(p)))) continue // never outside a planned root
    try {
      rmSync(p, { recursive: true, force: true })
      out.removed.push(p)
    } catch (e) {
      out.failed.push({ path: p, error: message(e) })
    }
  }
  for (const root of plan.roots) {
    try {
      if (existsSync(root) && readdirSync(root).length === 0) {
        rmdirSync(root)
        out.rootsRemoved.push(root)
      }
    } catch {
      // A root that still has other files in it stays.
    }
  }
  return out
}
