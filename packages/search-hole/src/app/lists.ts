// SPDX-License-Identifier: Apache-2.0
/**
 * Lists end to end (ADR-0008 "Lists", ADR-0017 point 7, ADR-0022): the configured set, its
 * compiled rules for the rules engine, refreshes with their safety guards, the lease-owned
 * background job, and the admin operations behind `searchhole lists` and the dashboard.
 *
 * - Loading is synchronous and cached per process. A request costs one `stat` (the
 *   `generation` file) plus the rules.yaml hash the rules service already computes; lists
 *   load from their compiled artifacts, and a missing, corrupt or older artifact is rebuilt
 *   from the stored text (never a crash).
 * - Refreshing runs only under the `lists:refresh` lease, so one process at a time fetches;
 *   gateways start it in the background after a real request, never on the search path.
 *   A failed refresh keeps the copy in force.
 * - Guards: HTTPS and public hosts only (lists/fetch), the 64 MiB cap, an optional `sha256`
 *   pin, and the shrink guard (a copy with under half the rules is refused unless forced).
 * - User choices are written to the global rules.yaml with the locked, comment-preserving
 *   writer: `subscriptions:` for URL lists, `lists.<id>.mode` for every other list.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { type Document, isMap, isSeq, type YAMLMap, type YAMLSeq } from 'yaml'
import type { CancelEntry, ListInput } from '../core/rules/engine.ts'
import { parseDuration } from '../core/rules/time.ts'
import { createListFetcher, type ListFetcher, type ListFetchOutcome } from '../fetch/list.ts'
import {
  artifactOf,
  type BuildKey,
  contentSha256,
  decodeArtifact,
  encodeArtifact,
  LIST_COMPILER_VERSION,
  type ListArtifactMeta,
} from '../lists/artifact.ts'
import { bundledLists } from '../lists/bundled/index.ts'
import { CATALOG, VENDORED_LISTS } from '../lists/catalog.ts'
import { importList } from '../lists/import/index.ts'
import {
  catalogByUrl,
  catalogEntry,
  DEFAULT_UPDATE,
  idFromUrl,
  isBuiltinId,
  LIST_ID,
  type ListEntry,
  type ListErrorCode,
  type LocalListManifest,
  RESERVED_LIST_IDS,
  type Registry,
  refreshIntervalMs,
  resolveRegistry,
  retryDelayMs,
  shrinkRefused,
  updateToMs,
} from '../lists/registry.ts'
import type { ListFormat, LoadedRules } from '../lists/yaml.ts'
import { SearchHoleError } from '../shared/errors.ts'
import type { ListKind, ListMode, Rule } from '../shared/types.ts'
import type { Lease, ListContribution, ListRow, Store } from '../store/index.ts'
import type { AppContext } from './context.ts'
import { editRulesFile } from './fsutil.ts'
import { ListFiles, vendoredDirs } from './listfiles.ts'
import type { FileState } from './rules.ts'
import type {
  AddListInput,
  DoctorCheck,
  ImportListInput,
  ListCatalogEntry,
  ListError,
  ListStatus,
  ListUpdateResult,
} from './types.ts'

/** The lease of the refresh job (ADR-0006 point 7). */
export const LIST_REFRESH_JOB = 'lists:refresh'
const LEASE_MS = 30_000
const HEARTBEAT_MS = 10_000
/** A gateway looks for due lists at most this often. */
const KICK_EVERY_MS = 15 * 60_000
/** Delay between the request that triggered a background refresh and its start. */
export const DEFAULT_KICK_DELAY_MS = 2_000
/** How long a terminal command waits for another process's refresh to finish. */
const CLI_LEASE_WAIT_MS = 20_000
const DAY_MS = 86_400_000
const CONTRIBUTION_MS = 7 * DAY_MS
/** A list is stale when it has not been verified for this many intervals (and at least 21 days). */
const STALE_INTERVALS = 3
const MIN_STALE_MS = 21 * DAY_MS
const MODES: readonly ListMode[] = ['enforce', 'audit', 'disabled']
const KINDS: readonly ListKind[] = ['block', 'allow', 'official', 'content-farm', 'clone']
const FORMATS: readonly ListFormat[] = [
  'auto',
  'ublacklist',
  'abp',
  'adguard',
  'hosts',
  'domains',
  'goggles',
  'searchhole',
]
const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** One list as loaded in this process. */
interface LoadedList {
  /** Content, kind and format it was built from (`bundled` for first-party lists). */
  build: string
  rules: readonly Rule[]
  cancel: readonly CancelEntry[]
  meta?: ListArtifactMeta
  copy: ListStatus['copy']
  /** When the copy in force was fetched, shipped or imported (ISO 8601). */
  fetchedAt: string | null
  contentSha256?: string
  problem?: { code: ListErrorCode; message: string }
}

/** The enabled lists, ready for the rules engine. */
export interface LoadedListSet {
  /** Changes whenever a list's mode or content changes (part of the compiled-rules cache key). */
  key: string
  inputs: ListInput[]
  /** Kind of each enabled list, for source typing. */
  kinds: ReadonlyMap<string, ListKind>
  registry: Registry
  loaded: ReadonlyMap<string, LoadedList>
  /** List rules in `inputs`. */
  totalRules: number
}

export interface ListsServiceOptions {
  /** Delay before a background refresh starts (tests: 0). */
  kickDelayMs?: number
}

const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString()

const bad = (why: string, fix?: string): SearchHoleError =>
  new SearchHoleError('invalid_argument', why, fix === undefined ? {} : { fix })

const reservedName = (id: string): SearchHoleError =>
  bad(`"${id}" is a name search-hole uses itself.`, 'Give the list another name with --name <id>.')

const refreshable = (e: ListEntry): boolean =>
  e.url !== undefined && e.source !== 'local' && e.source !== 'bundled'

/** True for an error the fetcher reported, mapped to the stored code. */
function fetchErrorCode(code: Extract<ListFetchOutcome, { kind: 'error' }>['code']): ListErrorCode {
  return code === 'cancelled' ? 'network' : code
}

export class ListsService {
  private readonly ctx: AppContext
  private readonly files: ListFiles
  private readonly kickDelayMs: number
  private current: { key: string; set: LoadedListSet } | null = null
  private readonly perList = new Map<string, LoadedList>()
  private bundled: Map<string, ListInput> | null = null
  private fetcherInstance: ListFetcher | null = null
  private background: Promise<void> | null = null
  private backgroundAbort: AbortController | null = null
  private lastKick: number | null = null
  private closed = false

  constructor(ctx: AppContext, o: ListsServiceOptions = {}) {
    this.ctx = ctx
    this.files = new ListFiles(ctx.layout.lists, ctx.seams.listVendorDirs ?? vendoredDirs())
    this.kickDelayMs = o.kickDelayMs ?? DEFAULT_KICK_DELAY_MS
  }

  // ── Loading ────────────────────────────────────────────────────────────

  /** The enabled lists for this request (cached; one `stat` when nothing changed). */
  set(global: FileState): LoadedListSet {
    const gkey = global.sha256 === undefined ? '-' : `${global.sha256}${global.lastGood === true ? '*' : ''}`
    const key = `${gkey}|${this.files.generation()}`
    if (this.current?.key === key) return this.current.set
    const registry = this.registry(global.loaded)
    const inputs: ListInput[] = []
    const kinds = new Map<string, ListKind>()
    const loaded = new Map<string, LoadedList>()
    const parts: string[] = []
    let totalRules = 0
    for (const e of registry.entries) {
      if (e.mode === 'disabled') {
        this.perList.delete(e.id)
        continue
      }
      const l = this.loadEntry(e, true)
      loaded.set(e.id, l)
      kinds.set(e.id, e.kind)
      parts.push(`${e.id}=${e.mode}@${l.build}`)
      if (l.rules.length === 0 && l.cancel.length === 0) continue
      inputs.push({ id: e.id, kind: e.kind, mode: e.mode, rules: l.rules, cancel: l.cancel })
      totalRules += l.rules.length
    }
    for (const id of this.perList.keys()) if (!loaded.has(id)) this.perList.delete(id)
    const set: LoadedListSet = { key: parts.join(','), inputs, kinds, registry, loaded, totalRules }
    this.current = { key, set }
    return set
  }

  /** Forgets the cached set (after this process changed rules.yaml or the list files). */
  invalidate(): void {
    this.current = null
  }

  private registry(loaded: LoadedRules | null): Registry {
    let locals: LocalListManifest[] = []
    try {
      locals = this.files.localManifests()
    } catch (e) {
      this.ctx.logger.warn({ err: e }, 'could not read the imported lists')
    }
    return resolveRegistry({
      subscriptions: loaded?.subscriptions ?? [],
      settings: loaded?.lists ?? {},
      locals,
    })
  }

  private bundledInput(id: string): ListInput | undefined {
    this.bundled ??= new Map(bundledLists().map((l) => [l.id, l]))
    return this.bundled.get(id)
  }

  /** Cache writes happen only once search-hole has a data folder (never from a first hook). */
  private canWriteCache(): boolean {
    return existsSync(this.ctx.roots.data)
  }

  private loadEntry(e: ListEntry, remember: boolean): LoadedList {
    const keep = (l: LoadedList): LoadedList => {
      if (remember) this.perList.set(e.id, l)
      return l
    }
    if (e.source === 'bundled') {
      const b = this.bundledInput(e.id)
      return {
        build: 'bundled',
        rules: b?.rules ?? [],
        cancel: b?.cancel ?? [],
        copy: 'built-in',
        fetchedAt: null,
      }
    }
    const local = e.source === 'local'
    const dir = this.files.dir(e.id, local)
    let copy: LoadedList['copy']
    let sha: string
    let fetchedAt: string
    if (local && e.local !== undefined) {
      copy = 'imported'
      sha = e.local.contentSha256
      fetchedAt = e.local.importedAt
    } else {
      const meta = local ? null : this.files.readSourceMeta(dir)
      if (meta !== null) {
        copy = 'downloaded'
        sha = meta.contentSha256
        fetchedAt = meta.fetchedAt
      } else if (e.vendored !== undefined) {
        copy = 'shipped'
        sha = e.vendored.sha256
        fetchedAt = e.vendored.fetchedAt
      } else {
        return keep({ build: 'none', rules: [], cancel: [], copy: 'none', fetchedAt: null })
      }
    }
    const build = `${copy}:${sha}:${e.kind}:${e.format}`
    const cached = this.perList.get(e.id)
    if (cached?.build === build) return cached

    const key: BuildKey = { contentSha256: sha, kind: e.kind, requestedFormat: e.format }
    const artifactText = this.files.readCompiled(dir, LIST_COMPILER_VERSION)
    if (artifactText !== null) {
      const decoded = decodeArtifact(artifactText, { listId: e.id, build: key })
      if (decoded.ok) {
        const a = decoded.artifact
        return keep({ build, rules: a.rules, cancel: a.cancel, meta: a, copy, fetchedAt, contentSha256: sha })
      }
      if (decoded.reason === 'corrupt' || decoded.reason === 'checksum') {
        this.ctx.logger.warn({ list: e.id, reason: decoded.reason }, 'list artifact unusable; rebuilding it')
      }
    }

    // Rebuild from the stored text (or the shipped copy).
    let problem: LoadedList['problem']
    let text =
      copy === 'shipped' && e.vendored !== undefined
        ? this.files.shippedText(e.vendored)
        : this.files.readSource(dir)
    if (text !== null && contentSha256(text) !== sha) {
      problem = { code: 'unreadable', message: 'the stored copy does not match its checksum' }
      text = null
    }
    if (text === null && copy === 'downloaded' && e.vendored !== undefined) {
      // A damaged download of a starter list: fall back to the shipped copy.
      const shipped = this.files.shippedText(e.vendored)
      if (shipped !== null) {
        text = shipped
        copy = 'shipped'
        sha = e.vendored.sha256
        fetchedAt = e.vendored.fetchedAt
      }
    }
    if (text === null) {
      return keep({
        build: `missing:${build}`,
        rules: [],
        cancel: [],
        copy: 'none',
        fetchedAt: null,
        problem: problem ?? {
          code: 'unreadable',
          message:
            copy === 'shipped'
              ? 'the copy shipped with search-hole was not found'
              : 'the stored copy could not be read',
        },
      })
    }
    const imported = importList(text, { format: e.format, listId: e.id, kind: e.kind })
    const o = {
      contentSha256: sha,
      requestedFormat: e.format,
      builtAt: new Date(this.ctx.now()).toISOString(),
    }
    if (this.canWriteCache()) {
      try {
        this.files.writeCompiled(dir, LIST_COMPILER_VERSION, encodeArtifact(imported, o))
      } catch (err) {
        this.ctx.logger.debug({ err, list: e.id }, 'could not cache the compiled list')
      }
    }
    const a = artifactOf(imported, o)
    const finalBuild = `${copy}:${sha}:${e.kind}:${e.format}`
    const l: LoadedList = {
      build: finalBuild,
      rules: a.rules,
      cancel: a.cancel,
      meta: a,
      copy,
      fetchedAt,
      contentSha256: sha,
    }
    if (problem !== undefined) l.problem = problem
    return keep(l)
  }

  // ── Status ─────────────────────────────────────────────────────────────

  private rows(store: Store | null): Map<string, ListRow> {
    if (!store || store.status().migration === 'pending') return new Map()
    try {
      return new Map(store.lists.list().map((r) => [r.id, r]))
    } catch {
      return new Map()
    }
  }

  private contribution(store: Store | null): Map<string, ListContribution> {
    if (!store || store.status().migration === 'pending') return new Map()
    try {
      return store.lists.contribution(this.ctx.now() - CONTRIBUTION_MS)
    } catch {
      return new Map()
    }
  }

  private intervalOf(e: ListEntry, l: LoadedList | undefined): number {
    return refreshIntervalMs(e.updateMs ?? updateToMs(DEFAULT_UPDATE) ?? 7 * DAY_MS, l?.meta?.header.expires)
  }

  /** When an enabled list with a URL is next due (epoch ms). */
  private nextDue(e: ListEntry, l: LoadedList | undefined, row: ListRow | undefined): number {
    if (row?.nextCheckAt !== null && row?.nextCheckAt !== undefined) return row.nextCheckAt
    const at = l?.fetchedAt === null || l?.fetchedAt === undefined ? Number.NaN : Date.parse(l.fetchedAt)
    return Number.isFinite(at) ? at + this.intervalOf(e, l) : this.ctx.now()
  }

  private statusOf(
    e: ListEntry,
    l: LoadedList,
    row: ListRow | undefined,
    c: ListContribution | undefined,
  ): ListStatus {
    let lastError: ListError | null = null
    if (row?.lastError) {
      lastError = {
        code: row.lastError as ListErrorCode,
        message: row.lastErrorDetail ?? row.lastError,
        at: iso(row.checkedAt) ?? new Date(this.ctx.now()).toISOString(),
      }
    } else if (l.problem !== undefined) {
      lastError = { ...l.problem, at: new Date(this.ctx.now()).toISOString() }
    }
    const status: ListStatus = {
      id: e.id,
      name: e.name,
      source: e.source,
      format: e.format,
      kind: e.kind,
      mode: e.mode,
      defaultMode: e.defaultMode,
      ruleCount: l.rules.length,
      skipped: l.meta?.stats.skipped ?? 0,
      skipReasons: l.meta?.skipReasons ?? {},
      copy: l.copy,
      lastUpdate: l.fetchedAt,
      lastCheck: iso(row?.checkedAt),
      nextUpdate: refreshable(e) && e.mode !== 'disabled' ? iso(this.nextDue(e, l, row)) : null,
      lastError,
      warnings: l.meta?.warnings ?? [],
      contribution: { hidden7d: c?.hidden ?? 0, wouldHide7d: c?.wouldHide ?? 0 },
    }
    if (e.url !== undefined) status.url = e.url
    if (e.homepage !== undefined) status.homepage = e.homepage
    const license = e.license ?? l.meta?.header.license ?? row?.license ?? undefined
    if (license !== undefined) status.license = license
    if (e.description !== undefined) status.description = e.description
    if (l.meta !== undefined && l.meta.format !== e.format) status.detectedFormat = l.meta.format
    if (refreshable(e)) status.update = e.update ?? DEFAULT_UPDATE
    if (e.sha256 !== undefined) status.sha256 = e.sha256
    return status
  }

  /** Every configured list with its state. */
  statuses(global: FileState, store: Store | null): ListStatus[] {
    const set = this.set(global)
    const rows = this.rows(store)
    const contrib = this.contribution(store)
    return set.registry.entries.map((e) =>
      this.statusOf(e, set.loaded.get(e.id) ?? this.loadEntry(e, false), rows.get(e.id), contrib.get(e.id)),
    )
  }

  private statusById(id: string, global: FileState, store: Store | null): ListStatus {
    const s = this.statuses(global, store).find((x) => x.id === id)
    if (s === undefined)
      throw new SearchHoleError('internal', `The list ${id} was saved but could not be read back.`)
    return s
  }

  /** The catalog with what is enabled here. */
  catalog(global: FileState): ListCatalogEntry[] {
    const entries = new Map(this.set(global).registry.entries.map((e) => [e.id, e]))
    const vendored = new Set(VENDORED_LISTS.map((v) => v.id))
    return CATALOG.map((c) => {
      const e = entries.get(c.id) ?? [...entries.values()].find((x) => x.url === c.url)
      const out: ListCatalogEntry = {
        id: c.id,
        name: c.name,
        url: c.url,
        homepage: c.homepage,
        format: c.format,
        kind: c.kind,
        license: c.license,
        licenseUrl: c.licenseUrl,
        bundleable: c.bundleable,
        recommendedMode: c.recommendedMode,
        notes: c.notes,
        starter: vendored.has(c.id),
        enabled: e !== undefined && e.mode !== 'disabled',
      }
      if (c.approxRules !== undefined) out.approxRules = c.approxRules
      if (e !== undefined) out.mode = e.mode
      return out
    })
  }

  // ── Admin: rules.yaml ──────────────────────────────────────────────────

  private findEntry(id: string, global: FileState): ListEntry {
    const e = this.set(global).registry.entries.find((x) => x.id === id)
    if (e === undefined) throw bad(`There is no list "${id}".`, 'See your lists with `searchhole lists`.')
    return e
  }

  private async editGlobal(edit: (doc: Document, current: LoadedRules | null) => void): Promise<void> {
    await editRulesFile(this.ctx.layout.rules, this.ctx.layout.rulesLock, 'global', edit)
    this.invalidate()
  }

  /** Adds a subscription (or enables a starter list) and, unless asked not to, downloads it. */
  async add(
    input: AddListInput,
    global: () => FileState,
    store: () => Promise<Store | null>,
  ): Promise<ListStatus> {
    const source = input.source.trim()
    if (source === '')
      throw bad('Name a catalog list or give an https:// URL.', 'See `searchhole lists catalog`.')
    if (input.mode !== undefined && !MODES.includes(input.mode))
      throw bad(`Unknown mode "${String(input.mode)}".`, 'Use enforce, audit or disabled.')
    if (input.kind !== undefined && !KINDS.includes(input.kind))
      throw bad(`Unknown kind "${String(input.kind)}".`, `Use one of: ${KINDS.join(', ')}.`)
    if (input.format !== undefined && !FORMATS.includes(input.format))
      throw bad(`Unknown format "${String(input.format)}".`, `Use one of: ${FORMATS.join(', ')}.`)
    if (input.update !== undefined && parseDuration(input.update) === null)
      throw bad('update must be a duration such as 12h, 1d or 7d.')
    if (input.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(input.sha256))
      throw bad('sha256 must be 64 hex characters.')

    const entries = this.set(global()).registry.entries
    const cat = catalogEntry(source)
    // A starter or first-party list: it is already here, so "add" means "turn it on".
    if (cat !== undefined && entries.some((e) => e.id === cat.id) && input.name === undefined) {
      const e = entries.find((x) => x.id === cat.id) as ListEntry
      const mode =
        input.mode ??
        (e.mode !== 'disabled' ? e.mode : e.defaultMode !== 'disabled' ? e.defaultMode : 'enforce')
      if (mode !== e.mode) await this.setMode(e.id, mode, global, store)
      if (input.fetch !== false && refreshable(e) && mode !== 'disabled')
        await this.update([e.id], {}, global, store)
      return this.statusById(e.id, global(), await store())
    }

    let url: string
    let id: string | null
    let kind: ListKind
    let format: ListFormat
    if (cat !== undefined) {
      url = cat.url
      id = input.name ?? cat.id
      kind = input.kind ?? cat.kind
      format = input.format ?? cat.format
    } else {
      let parsed: URL
      try {
        parsed = new URL(source)
      } catch {
        throw bad(
          'That is neither a catalog list nor a URL.',
          'See `searchhole lists catalog`, or give an https:// URL.',
        )
      }
      if (parsed.protocol !== 'https:')
        throw bad('Lists are fetched over HTTPS only.', 'Use the https:// address of the list.')
      if (parsed.username !== '' || parsed.password !== '')
        throw bad('A list URL must not contain a user name or password.')
      url = parsed.href
      const known = catalogByUrl(url)
      id = input.name ?? known?.id ?? idFromUrl(url)
      kind = input.kind ?? known?.kind ?? 'block'
      format = input.format ?? known?.format ?? 'auto'
    }
    if (id === null) throw bad('Could not name this list from its URL.', 'Give it a name with --name <id>.')
    if (!LIST_ID.test(id)) throw bad('A list name is 1–64 lower-case letters, digits, ".", "_" or "-".')
    if (RESERVED_LIST_IDS.has(id)) throw reservedName(id)
    if (isBuiltinId(id) || entries.some((e) => e.id === id)) {
      throw bad(
        `A list named "${id}" already exists.`,
        'Pick another --name, or change its mode with `searchhole lists enforce|audit|disable`.',
      )
    }
    // A new subscription is someone else's list: it starts in audit, so the user sees what it
    // would hide before it hides anything (the same default as the dashboard).
    const mode = input.mode ?? 'audit'
    await this.editGlobal((doc) => {
      const body: Record<string, unknown> = { name: id, url, format, kind, mode }
      if (input.update !== undefined) body.update = input.update
      if (input.sha256 !== undefined) body.sha256 = input.sha256.toLowerCase()
      subscriptionsSeq(doc).add(doc.createNode(body))
    })
    if (input.fetch !== false && mode !== 'disabled') await this.update([id], {}, global, store)
    return this.statusById(id, global(), await store())
  }

  /** Unsubscribes or deletes an import; built-in lists can only be disabled. */
  async remove(id: string, global: () => FileState, store: () => Promise<Store | null>): Promise<ListStatus> {
    const g = global()
    const e = this.findEntry(id, g)
    const st = await store()
    const before = this.statusById(id, g, st)
    const subscribed = (g.loaded?.subscriptions ?? []).some((s) => s.name === id)
    if (e.source === 'bundled' || (e.source === 'vendored' && !subscribed)) {
      throw bad(
        `${id} comes with search-hole and cannot be removed.`,
        `Turn it off with \`searchhole lists disable ${id}\`.`,
      )
    }
    const hasSetting = g.loaded?.lists[id] !== undefined
    if (subscribed || hasSetting) {
      await this.editGlobal((doc) => {
        const seq = doc.get('subscriptions', true)
        if (isSeq(seq)) {
          const i = seq.items.findIndex((item) => isMap(item) && String((item as YAMLMap).get('name')) === id)
          if (i >= 0) seq.delete(i)
          if (seq.items.length === 0) doc.delete('subscriptions')
        }
        deleteListSetting(doc, id)
      })
    }
    if (e.source === 'subscribed' || e.source === 'local') {
      try {
        this.files.remove(this.files.dir(id, e.source === 'local'))
        this.files.bumpGeneration()
      } catch (err) {
        this.ctx.logger.warn({ err, list: id }, 'could not delete the list files')
      }
      try {
        st?.lists.remove(id)
      } catch {
        // The row is only state; a stale one is harmless.
      }
    }
    this.perList.delete(id)
    this.invalidate()
    return before
  }

  /** Sets a list's mode (enforce, audit or disabled). */
  async setMode(
    id: string,
    mode: ListMode,
    global: () => FileState,
    store: () => Promise<Store | null>,
  ): Promise<ListStatus> {
    if (!MODES.includes(mode)) throw bad(`Unknown mode "${String(mode)}".`, 'Use enforce, audit or disabled.')
    const g = global()
    this.findEntry(id, g)
    const subscribed = (g.loaded?.subscriptions ?? []).some((s) => s.name === id)
    await this.editGlobal((doc) => {
      if (subscribed) {
        const seq = doc.get('subscriptions', true)
        if (!isSeq(seq)) return
        const item = seq.items.find((x) => isMap(x) && String((x as YAMLMap).get('name')) === id)
        if (isMap(item)) item.set('mode', mode)
        return
      }
      setListSetting(doc, id, mode)
    })
    return this.statusById(id, global(), await store())
  }

  // ── Import ─────────────────────────────────────────────────────────────

  /** Imports a local file as a list. Re-importing a name replaces its contents. */
  async importFile(
    path: string,
    input: ImportListInput,
    global: () => FileState,
    store: () => Promise<Store | null>,
  ): Promise<ListStatus> {
    const id = input.name.trim()
    if (!LIST_ID.test(id)) throw bad('A list name is 1–64 lower-case letters, digits, ".", "_" or "-".')
    if (RESERVED_LIST_IDS.has(id)) throw reservedName(id)
    if (!KINDS.includes(input.kind))
      throw bad(`Unknown kind "${String(input.kind)}".`, `Use one of: ${KINDS.join(', ')}.`)
    const format = input.format ?? 'auto'
    if (!FORMATS.includes(format))
      throw bad(`Unknown format "${String(format)}".`, `Use one of: ${FORMATS.join(', ')}.`)
    if (input.mode !== undefined && !MODES.includes(input.mode))
      throw bad(`Unknown mode "${String(input.mode)}".`)
    const g = global()
    const clash = this.set(g).registry.entries.find((e) => e.id === id)
    if (isBuiltinId(id) || (clash !== undefined && clash.source !== 'local')) {
      throw bad(`A list named "${id}" already exists.`, 'Pick another --name.')
    }
    const file = resolve(this.ctx.cwd, path)
    // One open file for the checks and the read, and the cap is checked on what was read.
    let bytes: Buffer
    try {
      const fd = openSync(file, 'r')
      try {
        const s = fstatSync(fd)
        if (!s.isFile()) throw bad(`${path} is not a file.`)
        if (s.size > MAX_IMPORT_BYTES) throw bad(`${path} is larger than 64 MiB, the per-list cap.`)
        bytes = readFileSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (e) {
      if (e instanceof SearchHoleError) throw e
      throw bad(`Cannot read ${path}.`, 'Check the path and its permissions.')
    }
    if (bytes.length > MAX_IMPORT_BYTES) throw bad(`${path} is larger than 64 MiB, the per-list cap.`)
    if (bytes.subarray(0, 8192).includes(0)) throw bad(`${path} is a binary file, not a text list.`)
    const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes)
    const imported = importList(text, { format, listId: id, kind: input.kind })
    if (imported.rules.length === 0 && imported.cancel.length === 0) {
      const top = Object.entries(imported.skipReasons)
        .slice(0, 3)
        .map(([r, n]) => `${n} ${r}`)
        .join(', ')
      throw bad(
        `No line of ${basename(file)} could be imported as a ${imported.format} list${top === '' ? '' : ` (skipped: ${top})`}.`,
        'Check the file, or name its format with --format.',
      )
    }
    const sha = contentSha256(text)
    const now = this.ctx.now()
    const importedAt = new Date(now).toISOString()
    const dir = this.files.dir(id, true)
    const o = { contentSha256: sha, requestedFormat: format, builtAt: importedAt }
    this.files.writeSource(
      dir,
      text,
      { contentSha256: sha, bytes: bytes.length, fetchedAt: importedAt },
      { version: LIST_COMPILER_VERSION, text: encodeArtifact(imported, o) },
    )
    this.files.writeManifest(dir, {
      id,
      kind: input.kind,
      format,
      file: basename(file).slice(0, 255),
      importedAt,
      contentSha256: sha,
      bytes: bytes.length,
    })
    this.files.bumpGeneration()
    this.invalidate()
    const st = await store()
    if (st && st.status().mode === 'read-write') {
      try {
        st.lists.upsertMeta({
          id,
          name: id,
          source: 'local',
          url: null,
          format,
          kind: input.kind,
          mode: input.mode ?? 'enforce',
          license: imported.header.license ?? null,
          updateIntervalHours: null,
        })
        st.lists.recordOutcome(id, {
          kind: 'fetched',
          etag: null,
          lastModified: null,
          contentSha256: sha,
          compilerVersion: LIST_COMPILER_VERSION,
          ruleCount: imported.rules.length,
          skippedCount: imported.stats.skipped,
          license: imported.header.license ?? null,
          nextCheckAt: null,
        })
      } catch (err) {
        this.ctx.logger.warn({ err, list: id }, 'could not record the imported list')
      }
    }
    if (input.mode !== undefined && (input.mode !== 'enforce' || g.loaded?.lists[id] !== undefined)) {
      await this.editGlobal((doc) => setListSetting(doc, id, input.mode as ListMode))
    }
    return this.statusById(id, global(), st)
  }

  // ── Refresh ────────────────────────────────────────────────────────────

  private fetcher(): ListFetcher {
    if (this.ctx.seams.listFetcher !== undefined) return this.ctx.seams.listFetcher
    this.fetcherInstance ??= createListFetcher()
    return this.fetcherInstance
  }

  /** Takes the refresh lease, waiting up to `waitMs` for another holder; heartbeats until `stop`. */
  private async acquire(
    store: Store,
    waitMs: number,
  ): Promise<{ lease: () => Lease; stop: () => void; lost: () => boolean } | null> {
    const owner = { gatewayId: this.ctx.gatewayId, version: this.ctx.version }
    const deadline = Date.now() + waitMs
    for (;;) {
      const r = store.jobs.acquire(LIST_REFRESH_JOB, owner, LEASE_MS)
      if (r.acquired) {
        let lease = r.lease
        let lost = false
        const timer = setInterval(() => {
          const renewed = store.jobs.renew(lease, LEASE_MS)
          if (renewed.ok) lease = renewed.lease
          else lost = true
        }, HEARTBEAT_MS)
        timer.unref()
        return {
          lease: () => lease,
          lost: () => lost,
          stop: () => {
            clearInterval(timer)
            try {
              store.jobs.release(lease, { status: 'idle' })
            } catch {
              // The lease expires on its own.
            }
          },
        }
      }
      if (r.reason !== 'held' || Date.now() >= deadline) return null
      await new Promise((res) => setTimeout(res, 250))
    }
  }

  private metaWrite(e: ListEntry): Parameters<Store['lists']['upsertMeta']>[0] {
    return {
      id: e.id,
      name: e.name,
      source: e.source,
      url: e.url ?? null,
      format: e.format,
      kind: e.kind,
      mode: e.mode,
      license: e.license ?? null,
      updateIntervalHours: e.updateMs === null ? null : Math.round(e.updateMs / 3_600_000),
    }
  }

  /** Fetches one list and, when it passes every guard, puts the new copy in force. */
  private async refreshOne(
    e: ListEntry,
    o: { force: boolean; store: Store; lease: Lease; signal?: AbortSignal },
  ): Promise<ListUpdateResult> {
    const { store, lease } = o
    const current = this.loadEntry(e, false)
    const previous = current.copy === 'none' ? null : current.rules.length
    const dir = this.files.dir(e.id, false)
    const meta = this.files.readSourceMeta(dir)
    store.lists.upsertMeta(this.metaWrite(e))
    const row = store.lists.get(e.id)
    const now = this.ctx.now()
    const interval = this.intervalOf(e, current)
    const fail = (code: ListErrorCode, message: string): ListUpdateResult => {
      store.lists.recordOutcome(
        e.id,
        {
          kind: 'failed',
          error: code,
          detail: message,
          nextCheckAt: now + retryDelayMs((row?.failures ?? 0) + 1, interval),
        },
        lease,
      )
      return {
        id: e.id,
        result: 'failed',
        ruleCount: current.rules.length,
        previousRuleCount: previous,
        message,
        error: { code, message },
      }
    }
    const validators =
      meta !== null && row?.contentSha256 === meta.contentSha256
        ? { etag: row.etag, lastModified: row.lastModified }
        : {}
    const res = await this.fetcher().fetch({
      url: e.url as string,
      ...validators,
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    })
    if (res.kind === 'error') return fail(fetchErrorCode(res.code), res.message)
    if (res.kind === 'not_modified') {
      if (meta === null)
        return fail('http_status', 'The server answered 304 Not Modified to an unconditional request.')
      store.lists.recordOutcome(
        e.id,
        { kind: 'verified', etag: res.etag, lastModified: res.lastModified, nextCheckAt: now + interval },
        lease,
      )
      return {
        id: e.id,
        result: 'unchanged',
        ruleCount: current.rules.length,
        previousRuleCount: previous,
        message: 'not modified',
      }
    }
    if (e.sha256 !== undefined && res.bytesSha256 !== e.sha256) {
      return fail(
        'sha256_mismatch',
        `The download (sha256 ${res.bytesSha256.slice(0, 12)}…) does not match the pinned sha256 ${e.sha256.slice(0, 12)}…; the copy in force was kept.`,
      )
    }
    const sha = contentSha256(res.text)
    if (current.contentSha256 === sha && current.copy !== 'none') {
      if (current.copy === 'shipped') {
        // The shipped copy is current: store it as downloaded so validators work next time.
        this.writeCopy(e, dir, res, sha, current, now)
      }
      store.lists.recordOutcome(
        e.id,
        {
          kind: 'verified',
          etag: res.etag,
          lastModified: res.lastModified,
          contentSha256: sha,
          ruleCount: current.rules.length,
          nextCheckAt: now + interval,
        },
        lease,
      )
      return {
        id: e.id,
        result: 'unchanged',
        ruleCount: current.rules.length,
        previousRuleCount: previous,
        message: 'same content',
      }
    }
    const imported = importList(res.text, { format: e.format, listId: e.id, kind: e.kind })
    const count = imported.rules.length
    if (count === 0 && imported.cancel.length === 0 && !o.force) {
      return fail('empty', 'No line of the download could be imported; the copy in force was kept.')
    }
    if (!o.force && shrinkRefused(previous, count)) {
      return fail(
        'shrink_guard',
        `The new copy has ${count.toLocaleString('en-US')} rules, under half of the ${(previous ?? 0).toLocaleString('en-US')} in force, so it was refused (a guard against broken or hijacked lists). If the change is expected, run \`searchhole lists update ${e.id} --force\`.`,
      )
    }
    const renewed = store.jobs.renew(lease, LEASE_MS)
    if (!renewed.ok) {
      return {
        id: e.id,
        result: 'skipped',
        ruleCount: current.rules.length,
        previousRuleCount: previous,
        message: 'another process took over the refresh',
      }
    }
    const builtAt = new Date(now).toISOString()
    this.files.writeSource(
      dir,
      res.text,
      {
        contentSha256: sha,
        bytes: res.bytes,
        fetchedAt: builtAt,
        url: res.finalUrl,
        etag: res.etag,
        lastModified: res.lastModified,
      },
      {
        version: LIST_COMPILER_VERSION,
        text: encodeArtifact(imported, { contentSha256: sha, requestedFormat: e.format, builtAt }),
      },
    )
    this.files.bumpGeneration()
    this.invalidate()
    store.lists.recordOutcome(
      e.id,
      {
        kind: 'fetched',
        etag: res.etag,
        lastModified: res.lastModified,
        contentSha256: sha,
        compilerVersion: LIST_COMPILER_VERSION,
        ruleCount: count,
        skippedCount: imported.stats.skipped,
        license: imported.header.license ?? null,
        nextCheckAt: now + refreshIntervalMs(e.updateMs ?? 7 * DAY_MS, imported.header.expires),
      },
      lease,
    )
    const from = previous === null ? '' : `${previous.toLocaleString('en-US')} → `
    return {
      id: e.id,
      result: 'updated',
      ruleCount: count,
      previousRuleCount: previous,
      message: `${from}${count.toLocaleString('en-US')} rules${imported.stats.skipped > 0 ? ` (${imported.stats.skipped.toLocaleString('en-US')} lines skipped)` : ''}`,
    }
  }

  /** Stores a download whose content is already in force (the shipped copy). */
  private writeCopy(
    e: ListEntry,
    dir: string,
    res: Extract<ListFetchOutcome, { kind: 'ok' }>,
    sha: string,
    current: LoadedList,
    now: number,
  ): void {
    const builtAt = new Date(now).toISOString()
    const imported = importList(res.text, { format: e.format, listId: e.id, kind: e.kind })
    try {
      this.files.writeSource(
        dir,
        res.text,
        {
          contentSha256: sha,
          bytes: res.bytes,
          fetchedAt: current.fetchedAt ?? builtAt,
          url: res.finalUrl,
          etag: res.etag,
          lastModified: res.lastModified,
        },
        {
          version: LIST_COMPILER_VERSION,
          text: encodeArtifact(imported, { contentSha256: sha, requestedFormat: e.format, builtAt }),
        },
      )
      this.files.bumpGeneration()
      this.invalidate()
    } catch (err) {
      this.ctx.logger.warn({ err, list: e.id }, 'could not store the list copy')
    }
  }

  /** Refreshes lists on demand (CLI, dashboard). */
  async update(
    ids: readonly string[] | undefined,
    opts: { force?: boolean },
    global: () => FileState,
    storeFn: () => Promise<Store | null>,
  ): Promise<ListUpdateResult[]> {
    const entries = this.set(global()).registry.entries
    const named = ids !== undefined && ids.length > 0
    const targets: ListEntry[] = named
      ? [...new Set(ids)].map((id) => {
          const e = entries.find((x) => x.id === id)
          if (e === undefined)
            throw bad(`There is no list "${id}".`, 'See your lists with `searchhole lists`.')
          return e
        })
      : entries.filter((e) => refreshable(e) && e.mode !== 'disabled')
    const results: ListUpdateResult[] = []
    const work: ListEntry[] = []
    for (const e of targets) {
      if (refreshable(e)) work.push(e)
      else {
        const l = this.loadEntry(e, false)
        results.push({
          id: e.id,
          result: 'skipped',
          ruleCount: l.rules.length,
          previousRuleCount: null,
          message:
            e.source === 'local'
              ? 'imported: run `searchhole lists import` again to change it'
              : 'built in: it updates with search-hole',
        })
      }
    }
    if (work.length === 0) return results
    const store = await storeFn()
    if (!store) {
      throw new SearchHoleError(
        'store_unavailable',
        'Refreshing lists needs the search-hole database, which is unavailable.',
        {
          fix: 'Run `searchhole doctor`.',
        },
      )
    }
    if (store.status().mode !== 'read-write') {
      throw new SearchHoleError('store_unavailable', `Lists cannot be refreshed: ${store.status().message}`, {
        fix: 'Update search-hole, then try again.',
      })
    }
    const held = await this.acquire(store, this.ctx.host === 'cli' ? CLI_LEASE_WAIT_MS : 0)
    if (held === null) {
      for (const e of work) {
        results.push({
          id: e.id,
          result: 'skipped',
          ruleCount: this.loadEntry(e, false).rules.length,
          previousRuleCount: null,
          message: 'another search-hole process is refreshing lists; try again in a minute',
        })
      }
      return results
    }
    try {
      for (const e of work) {
        if (held.lost()) {
          results.push({
            id: e.id,
            result: 'skipped',
            ruleCount: 0,
            previousRuleCount: null,
            message: 'another process took over the refresh',
          })
          continue
        }
        try {
          results.push(await this.refreshOne(e, { force: opts.force === true, store, lease: held.lease() }))
        } catch (err) {
          this.ctx.logger.warn({ err, list: e.id }, 'list refresh failed')
          const message = err instanceof Error ? err.message.slice(0, 200) : 'refresh failed'
          results.push({
            id: e.id,
            result: 'failed',
            ruleCount: 0,
            previousRuleCount: null,
            message,
            error: { code: 'network', message },
          })
        }
      }
    } finally {
      held.stop()
    }
    // Keep the caller's order.
    const order = new Map(targets.map((e, i) => [e.id, i]))
    return results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }

  /**
   * After a real request in a gateway: refresh due lists in the background, under the lease,
   * at most once per 15 minutes per process. Never awaited by the request.
   */
  kick(global: () => FileState, store: Store | null): void {
    if (this.ctx.host === 'cli' || this.closed || this.background !== null) return
    // settings.yaml lists.autoUpdate: false keeps everything offline (`lists update` still works).
    if (!this.ctx.settings.settings.lists.autoUpdate) return
    const now = this.ctx.now()
    if (this.lastKick !== null && now - this.lastKick < KICK_EVERY_MS) return
    this.lastKick = now
    const state = store?.status()
    if (store === null || state === undefined || state.mode !== 'read-write' || state.migration === 'pending')
      return
    const abort = new AbortController()
    this.backgroundAbort = abort
    this.background = new Promise<void>((res) => {
      // A closing gateway (stdin EOF) must not wait for the delay.
      const t = setTimeout(res, this.kickDelayMs)
      t.unref()
      abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          res()
        },
        { once: true },
      )
    })
      .then(() => this.runDue(global(), store, abort.signal))
      .catch((err: unknown) => {
        this.ctx.logger.warn({ err }, 'background list refresh failed')
      })
      .finally(() => {
        this.background = null
        this.backgroundAbort = null
      })
  }

  /** Resolves once a background refresh (if any) has finished. */
  async idle(): Promise<void> {
    await this.background
  }

  private async runDue(global: FileState, store: Store, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) return
    const set = this.set(global)
    const rows = this.rows(store)
    const now = this.ctx.now()
    const due = set.registry.entries.filter(
      (e) =>
        refreshable(e) &&
        e.mode !== 'disabled' &&
        this.nextDue(e, set.loaded.get(e.id), rows.get(e.id)) <= now,
    )
    if (due.length === 0) return
    const held = await this.acquire(store, 0)
    if (held === null) return
    try {
      for (const e of due) {
        if (signal.aborted || held.lost() || this.closed) break
        // Another process may have refreshed it while we waited for the lease.
        const fresh = this.rows(store).get(e.id)
        if (
          fresh?.nextCheckAt !== null &&
          fresh?.nextCheckAt !== undefined &&
          fresh.nextCheckAt > this.ctx.now()
        )
          continue
        try {
          const r = await this.refreshOne(e, { force: false, store, lease: held.lease(), signal })
          this.ctx.logger.info({ list: e.id, result: r.result }, `list refresh: ${r.message}`)
        } catch (err) {
          this.ctx.logger.warn({ err, list: e.id }, 'list refresh failed')
        }
      }
    } finally {
      held.stop()
    }
  }

  // ── Doctor ─────────────────────────────────────────────────────────────

  /** Doctor lines: failures, stale or never-fetched lists, shrink-guard and pin refusals, ignored config. */
  doctorChecks(global: FileState, store: Store | null): DoctorCheck[] {
    let statuses: ListStatus[]
    try {
      statuses = this.statuses(global, store)
    } catch (err) {
      return [
        {
          id: 'lists',
          status: 'warn',
          title: 'Lists could not be read',
          detail: err instanceof Error ? err.message : String(err),
        },
      ]
    }
    const checks: DoctorCheck[] = []
    const now = this.ctx.now()
    const rows = this.rows(store)
    for (const s of statuses) {
      if (s.mode === 'disabled') continue
      const id = `lists:${s.id}`
      const err = s.lastError
      if (err?.code === 'shrink_guard') {
        checks.push({
          id,
          status: 'warn',
          title: `List ${s.id}: an update was refused by the shrink guard`,
          detail: err.message,
          fix: `If the smaller list is expected, run \`searchhole lists update ${s.id} --force\`.`,
        })
      } else if (err?.code === 'sha256_mismatch') {
        checks.push({
          id,
          status: 'warn',
          title: `List ${s.id}: the download does not match the pinned sha256`,
          detail: err.message,
          fix: `Check the list, then update or remove its sha256 in rules.yaml (subscriptions → ${s.id}).`,
        })
      } else if (err !== null) {
        checks.push({
          id,
          status: 'warn',
          title: `List ${s.id}: ${s.copy === 'none' ? 'not loaded' : 'the last refresh failed'} (${err.code})`,
          detail: `${err.message}${s.copy === 'none' ? '' : ' The copy in force is still used.'}`,
          fix:
            s.url === undefined
              ? 'Run `searchhole doctor` again after fixing the file.'
              : `Retry with \`searchhole lists update ${s.id}\`.`,
        })
      } else if (s.copy === 'none' && s.url !== undefined) {
        checks.push({
          id,
          status: 'warn',
          title: `List ${s.id} has not been downloaded yet`,
          fix: `Download it with \`searchhole lists update ${s.id}\`.`,
        })
      }
      if (s.url !== undefined && s.copy !== 'none' && err?.code !== 'shrink_guard') {
        const row = rows.get(s.id)
        const verified = row?.verifiedAt ?? (s.lastUpdate === null ? null : Date.parse(s.lastUpdate))
        const interval = updateToMs(s.update ?? DEFAULT_UPDATE) ?? 7 * DAY_MS
        const staleAfter = Math.max(MIN_STALE_MS, STALE_INTERVALS * interval)
        if (verified !== null && Number.isFinite(verified) && now - verified > staleAfter) {
          checks.push({
            id: `${id}:stale`,
            status: s.copy === 'shipped' ? 'info' : 'warn',
            title: `List ${s.id} is stale: last ${s.copy === 'shipped' ? 'shipped copy from' : 'verified'} ${new Date(verified).toISOString().slice(0, 10)}`,
            fix: `Refresh it with \`searchhole lists update ${s.id}\` (needs network access to ${hostOf(s.url)}).`,
          })
        }
      }
    }
    const problems = this.set(global).registry.problems
    if (problems.length > 0) {
      checks.push({
        id: 'lists:config',
        status: 'warn',
        title: 'rules.yaml: some list settings are ignored',
        detail: problems.join('; '),
        fix: 'Fix the names in rules.yaml (subscriptions and lists).',
      })
    }
    const enforced = statuses.filter((s) => s.mode === 'enforce')
    const audit = statuses.filter((s) => s.mode === 'audit')
    const rules = statuses.filter((s) => s.mode !== 'disabled').reduce((n, s) => n + s.ruleCount, 0)
    checks.unshift({
      id: 'lists',
      status: checks.some((c) => c.status === 'warn') ? 'warn' : 'ok',
      title: `Lists: ${enforced.length} enforced, ${audit.length} audit, ${statuses.length - enforced.length - audit.length} off · ${rules.toLocaleString('en-US')} rules`,
      ...(checks.length > 0
        ? { detail: `${checks.length} list problem${checks.length === 1 ? '' : 's'} below` }
        : {}),
    })
    return checks
  }

  async close(): Promise<void> {
    this.closed = true
    this.backgroundAbort?.abort()
    const pending = this.background
    if (pending !== null) {
      await Promise.race([pending, new Promise<void>((res) => setTimeout(res, 2_000).unref())])
    }
    await this.fetcherInstance?.close().catch(() => undefined)
    this.fetcherInstance = null
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The `subscriptions:` sequence of a rules document, created when missing. */
function subscriptionsSeq(doc: Document): YAMLSeq {
  const existing = doc.get('subscriptions', true)
  if (isSeq(existing)) return existing
  if (existing !== undefined && existing !== null) {
    throw new SearchHoleError('rules_invalid', '`subscriptions` in rules.yaml is not a list.', {
      fix: 'Fix the file by hand; search-hole will not rewrite it.',
    })
  }
  const seq = doc.createNode([]) as YAMLSeq
  doc.set('subscriptions', seq)
  return seq
}

/** Sets `lists.<id>.mode`, creating `lists:` and the entry (flow style) when missing. */
function setListSetting(doc: Document, id: string, mode: ListMode): void {
  let lists = doc.get('lists', true)
  if (lists === undefined || lists === null) {
    lists = doc.createNode({}) as YAMLMap
    doc.set('lists', lists)
  }
  if (!isMap(lists)) {
    throw new SearchHoleError('rules_invalid', '`lists` in rules.yaml is not a mapping.', {
      fix: 'Fix the file by hand; search-hole will not rewrite it.',
    })
  }
  const entry = lists.get(id, true)
  if (isMap(entry)) {
    entry.set('mode', mode)
    return
  }
  const node = doc.createNode({ mode }) as YAMLMap
  node.flow = true
  lists.set(id, node)
}

/** Removes `lists.<id>` (and `lists:` when it becomes empty). */
function deleteListSetting(doc: Document, id: string): void {
  const lists = doc.get('lists', true)
  if (!isMap(lists)) return
  lists.delete(id)
  if (lists.items.length === 0) doc.delete('lists')
}
