// SPDX-License-Identifier: Apache-2.0
/**
 * List files on disk (ADR-0006 point 8, ADR-0022). Layout under `<data>/lists/`:
 *
 * ```text
 * generation                      rewritten after every change; one stat per request detects it
 * <id>/                           a vendored or subscribed list
 *   source.txt                    the last good copy, as downloaded
 *   source.json                   { contentSha256, bytes, fetchedAt, url, etag, lastModified }
 *   compiled-<compiler>.json      the compiled artifact (see lists/artifact.ts), one per compiler version
 * local/<id>/                     an imported file
 *   source.txt  manifest.json  compiled-<compiler>.json
 * ```
 *
 * Every write is atomic (temp file, fsync, rename). `source.json` is written last, so a reader
 * never sees a new pointer before the text it points at. Artifacts of an older compiler are
 * pruned when a new copy lands (they describe old content); a newer compiler's artifacts are
 * never deleted (ADR-0006 point 8). The shipped starter lists are found next to the bundle
 * (`dist/lists/<id>.txt`) or, in a source checkout, in `lists/vendor/`.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { stripVendorHeader, type VendoredList } from '../lists/catalog.ts'
import { LIST_ID, type LocalListManifest, RESERVED_LIST_IDS } from '../lists/registry.ts'
import { atomicWriteFile, ensureDir } from '../shared/paths.ts'

/** What `source.json` records about the copy in `source.txt`. */
export interface SourceMeta {
  contentSha256: string
  bytes: number
  /** ISO 8601. */
  fetchedAt: string
  url?: string
  etag?: string | null
  lastModified?: string | null
}

const sourceMetaSchema = z.object({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  fetchedAt: z.string(),
  url: z.string().optional(),
  etag: z.string().nullable().optional(),
  lastModified: z.string().nullable().optional(),
})

const manifestSchema = z.object({
  id: z.string().regex(LIST_ID),
  kind: z.enum(['block', 'allow', 'official', 'content-farm', 'clone']),
  format: z.enum(['auto', 'ublacklist', 'abp', 'adguard', 'hosts', 'domains', 'goggles', 'searchhole']),
  file: z.string().max(255),
  importedAt: z.string(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
})

const COMPILED = /^compiled-(\d{1,6})\.json$/

/** The folders that may hold the shipped starter lists, best first. */
export function vendoredDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(here, 'lists'), // the bundle: dist/searchhole.mjs → dist/lists/
    join(here, '..', 'lists'),
    join(here, '..', '..', '..', '..', 'lists', 'vendor'), // a source checkout: src/app → lists/vendor
  ]
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** The on-disk side of the lists: content, pointers, artifacts and local manifests. */
export class ListFiles {
  readonly root: string
  private readonly vendorDirs: readonly string[]
  private readonly shipped = new Map<string, string | null>()

  constructor(root: string, vendorDirs: readonly string[] = vendoredDirs()) {
    this.root = root
    this.vendorDirs = vendorDirs
  }

  /**
   * The folder of a list. Ids are validated (`LIST_ID`), so they never leave `root`, and a
   * subscribed list can never be `local/` (every imported list) or the `generation` stamp.
   */
  dir(id: string, local: boolean): string {
    const safe = id.toLowerCase()
    if (!LIST_ID.test(safe) || (!local && RESERVED_LIST_IDS.has(safe))) throw new Error(`invalid list id: ${id}`)
    return local ? join(this.root, 'local', safe) : join(this.root, safe)
  }

  /** Changes whenever a list changes on disk (one `stat`). */
  generation(): string {
    try {
      const s = statSync(join(this.root, 'generation'))
      return `${s.ino}:${s.mtimeMs}:${s.size}`
    } catch {
      return 'none'
    }
  }

  /** Tells every process to reload its lists. */
  bumpGeneration(): void {
    ensureDir(this.root)
    atomicWriteFile(join(this.root, 'generation'), `${Date.now()}:${process.pid}:${Math.random()}\n`, {
      mode: 0o644,
    })
  }

  readSourceMeta(dir: string): SourceMeta | null {
    const parsed = sourceMetaSchema.safeParse(readJson(join(dir, 'source.json')))
    if (!parsed.success) return null
    const m = parsed.data
    const out: SourceMeta = { contentSha256: m.contentSha256, bytes: m.bytes, fetchedAt: m.fetchedAt }
    if (m.url !== undefined) out.url = m.url
    if (m.etag !== undefined) out.etag = m.etag
    if (m.lastModified !== undefined) out.lastModified = m.lastModified
    return out
  }

  readSource(dir: string): string | null {
    try {
      return readFileSync(join(dir, 'source.txt'), 'utf8')
    } catch {
      return null
    }
  }

  readCompiled(dir: string, compilerVersion: string): string | null {
    try {
      return readFileSync(join(dir, `compiled-${compilerVersion}.json`), 'utf8')
    } catch {
      return null
    }
  }

  /** Stamp of one compiled artifact (for tests and diagnostics). */
  compiledPath(dir: string, compilerVersion: string): string {
    return join(dir, `compiled-${compilerVersion}.json`)
  }

  writeCompiled(dir: string, compilerVersion: string, text: string): void {
    ensureDir(dir)
    atomicWriteFile(join(dir, `compiled-${compilerVersion}.json`), text, { mode: 0o644 })
  }

  /** Writes a new copy: text, artifact, then the pointer; prunes older compilers' artifacts. */
  writeSource(
    dir: string,
    text: string,
    meta: SourceMeta,
    compiled: { version: string; text: string },
  ): void {
    ensureDir(dir)
    atomicWriteFile(join(dir, 'source.txt'), text, { mode: 0o644 })
    atomicWriteFile(join(dir, `compiled-${compiled.version}.json`), compiled.text, { mode: 0o644 })
    atomicWriteFile(join(dir, 'source.json'), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o644 })
    this.pruneCompiled(dir, compiled.version)
  }

  /** Removes artifacts built by an older compiler than `keep` (never a newer one). */
  pruneCompiled(dir: string, keep: string): void {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const m = COMPILED.exec(name)
      if (m?.[1] === undefined || Number(m[1]) >= Number(keep)) continue
      try {
        unlinkSync(join(dir, name))
      } catch {
        // Another process may have removed it already.
      }
    }
  }

  remove(dir: string): void {
    rmSync(dir, { recursive: true, force: true })
  }

  writeManifest(dir: string, m: LocalListManifest): void {
    ensureDir(dir)
    atomicWriteFile(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o644 })
  }

  /** Every readable local-import manifest. A broken one is skipped (and its list is absent). */
  localManifests(): LocalListManifest[] {
    const base = join(this.root, 'local')
    let names: string[]
    try {
      names = readdirSync(base)
    } catch {
      return []
    }
    const out: LocalListManifest[] = []
    for (const name of names.sort()) {
      const parsed = manifestSchema.safeParse(readJson(join(base, name, 'manifest.json')))
      if (parsed.success && parsed.data.id === name) out.push(parsed.data)
    }
    return out
  }

  /** The upstream text of a shipped starter list (vendor header removed), or null when not found. */
  shippedText(v: VendoredList): string | null {
    const cached = this.shipped.get(v.id)
    if (cached !== undefined) return cached
    let found: string | null = null
    for (const dir of this.vendorDirs) {
      const file = join(dir, `${v.id}.txt`)
      if (!existsSync(file)) continue
      try {
        const split = stripVendorHeader(readFileSync(file, 'utf8'))
        if (split !== null) {
          found = split.body
          break
        }
      } catch {
        // Try the next location.
      }
    }
    this.shipped.set(v.id, found)
    return found
  }
}
