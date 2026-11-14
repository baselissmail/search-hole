// SPDX-License-Identifier: Apache-2.0
/**
 * The list registry (ADR-0008 "Lists", ADR-0017 point 7, ADR-0022): which lists exist, where
 * each comes from, and its effective mode, plus the refresh arithmetic (interval, `Expires`,
 * back-off) and the shrink guard. Pure: the app layer supplies what it read from rules.yaml
 * and from the local-import manifests.
 *
 * Four sources, one id space:
 * - `bundled`: the first-party lists compiled into search-hole (`bundled/`). Never fetched.
 * - `vendored`: the ADR-0017 starter set, shipped as copies (`lists/vendor/`) and refreshed from
 *   the catalog URL in the background. Works offline with the shipped copy.
 * - `subscribed`: `subscriptions:` in the global rules.yaml (HTTPS only).
 * - `local`: files the user imported (`searchhole lists import`). Never refreshed.
 *
 * Modes: a subscription carries its own `mode`; every other list takes `lists.<id>.mode` from
 * rules.yaml, else its default (bundled: the registry's, vendored: the catalog's recommendation,
 * local: `enforce`).
 */
import { parseDuration } from '../core/rules/time.ts'
import type { ListKind, ListMode } from '../shared/types.ts'
import { FIRST_PARTY_LISTS, type FirstPartyList } from './bundled/first-party.ts'
import { CATALOG, type CatalogList, VENDORED_LISTS, type VendoredList } from './catalog.ts'
import { expiresToMs } from './import/index.ts'
import type { ListFormat, ListSetting, Subscription } from './yaml.ts'

export type ListSource = 'bundled' | 'vendored' | 'subscribed' | 'local'

/** Stable failure codes of a refresh or import (stored in `lists.last_error`). */
export type ListErrorCode =
  /** The new copy has under half the rules of the one in force (SYNTHESIS §6). */
  | 'shrink_guard'
  /** The bytes do not match the subscription's pinned `sha256`. */
  | 'sha256_mismatch'
  /** Over the 64 MiB cap. */
  | 'too_large'
  /** The server answered with a status other than 200 or 304. */
  | 'http_status'
  | 'network'
  | 'timeout'
  /** The URL or a redirect is not HTTPS. */
  | 'not_https'
  /** The host resolves to a private, loopback or otherwise non-public address. */
  | 'blocked_address'
  | 'too_many_redirects'
  /** The body is not text (binary, or not decodable as UTF-8). */
  | 'not_text'
  /** No line of the list could be imported. */
  | 'empty'
  /** The stored copy or the shipped copy could not be read. */
  | 'unreadable'

/** A local import's manifest (`<data>/lists/local/<id>/manifest.json`). */
export interface LocalListManifest {
  id: string
  kind: ListKind
  format: ListFormat
  /** The imported file's name (no directory). */
  file: string
  /** ISO 8601. */
  importedAt: string
  contentSha256: string
  bytes: number
}

/** One list as configured, before its rules are loaded. */
export interface ListEntry {
  id: string
  name: string
  source: ListSource
  kind: ListKind
  /** The format to import with (`auto` detects). */
  format: ListFormat
  mode: ListMode
  /** The mode without the user's choice. */
  defaultMode: ListMode
  url?: string
  homepage?: string
  license?: string
  description?: string
  /** The refresh interval as written (`7d`), for fetched lists. */
  update?: string
  /** Refresh interval in ms before `Expires` is applied; null for lists that are never fetched. */
  updateMs: number | null
  /** Pinned SHA-256 of the list bytes (subscriptions only). */
  sha256?: string
  catalog?: CatalogList
  /** The shipped copy, for vendored lists. */
  vendored?: VendoredList
  firstParty?: FirstPartyList
  local?: LocalListManifest
}

export interface RegistryInput {
  subscriptions: readonly Subscription[]
  /** `lists:` in the global rules.yaml. */
  settings: Readonly<Record<string, ListSetting>>
  locals: readonly LocalListManifest[]
}

export interface Registry {
  entries: ListEntry[]
  /** Configuration that was ignored, one sentence each (shown by `doctor`). */
  problems: string[]
}

/** List ids: what subscription names allow, lower case (they name folders under `<data>/lists/`). */
export const LIST_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Names search-hole uses itself under `<data>/lists/`: the imports folder and the change stamp. */
export const RESERVED_LIST_IDS: ReadonlySet<string> = new Set(['local', 'generation'])
export const DEFAULT_UPDATE = '7d'
const HOUR = 3_600_000
/** A shorter `update` is raised to this. */
export const MIN_UPDATE_MS = HOUR
/** A list's `Expires` can shorten the interval, never below this (uBlock Origin uses 4 hours). */
export const EXPIRES_FLOOR_MS = 6 * HOUR
/** First retry after a failed refresh; it doubles per failure, up to the interval. */
export const RETRY_BASE_MS = HOUR
/** An update is refused when the new rule count is below this share of the one in force. */
export const SHRINK_RATIO = 0.5

/** An `update:` duration (`12h`, `7d`, `2w`) in ms, or null. */
export const updateToMs = (text: string): number | null => parseDuration(text)

const catalogById: ReadonlyMap<string, CatalogList> = new Map(CATALOG.map((c) => [c.id, c]))
const vendoredById: ReadonlyMap<string, VendoredList> = new Map(VENDORED_LISTS.map((v) => [v.id, v]))
const firstPartyIds: ReadonlySet<string> = new Set(FIRST_PARTY_LISTS.map((l) => l.id))

/** The catalog entry with this id. */
export function catalogEntry(id: string): CatalogList | undefined {
  return catalogById.get(id)
}

/** The catalog entry whose subscription URL is `url`. */
export function catalogByUrl(url: string): CatalogList | undefined {
  return CATALOG.find((c) => c.url === url)
}

/** True for ids that belong to a built-in (bundled or vendored) list. */
export function isBuiltinId(id: string): boolean {
  return firstPartyIds.has(id) || vendoredById.has(id)
}

const enabledDefault = (mode: CatalogList['recommendedMode']): ListMode =>
  mode === 'off' ? 'disabled' : mode

function vendoredEntry(v: VendoredList, c: CatalogList, settings: RegistryInput['settings']): ListEntry {
  const defaultMode = enabledDefault(c.recommendedMode)
  return {
    id: v.id,
    name: c.name,
    source: 'vendored',
    kind: c.kind,
    format: c.format,
    mode: settings[v.id]?.mode ?? defaultMode,
    defaultMode,
    url: c.url,
    homepage: c.homepage,
    license: c.license,
    description: c.notes,
    update: DEFAULT_UPDATE,
    updateMs: updateToMs(DEFAULT_UPDATE),
    catalog: c,
    vendored: v,
  }
}

/** Resolves every configured list. Never throws: conflicts become `problems`. */
export function resolveRegistry(input: RegistryInput): Registry {
  const problems: string[] = []
  const entries: ListEntry[] = []
  const taken = new Map<string, ListSource>()
  const claim = (id: string, source: ListSource): boolean => {
    const key = id.toLowerCase()
    const prev = taken.get(key)
    if (prev !== undefined) return false
    taken.set(key, source)
    return true
  }

  for (const l of FIRST_PARTY_LISTS) {
    claim(l.id, 'bundled')
    entries.push({
      id: l.id,
      name: l.title,
      source: 'bundled',
      kind: l.kind,
      format: 'searchhole',
      mode: input.settings[l.id]?.mode ?? l.mode,
      defaultMode: l.mode,
      license: 'CC0-1.0',
      description: l.description,
      updateMs: null,
      firstParty: l,
    })
  }

  const subscribed = new Map<string, Subscription>()
  for (const s of input.subscriptions) {
    if (firstPartyIds.has(s.name.toLowerCase())) {
      problems.push(`subscription '${s.name}' has the name of a built-in list and is ignored; rename it`)
      continue
    }
    if (!LIST_ID.test(s.name)) {
      problems.push(`subscription '${s.name}' needs a lower-case name to be stored; it is ignored`)
      continue
    }
    if (RESERVED_LIST_IDS.has(s.name)) {
      problems.push(`subscription '${s.name}' has a name search-hole uses itself and is ignored; rename it`)
      continue
    }
    subscribed.set(s.name, s)
  }

  for (const v of VENDORED_LISTS) {
    const c = catalogById.get(v.id)
    if (c === undefined) continue
    const sub = subscribed.get(v.id)
    claim(v.id, 'vendored')
    if (sub === undefined) {
      entries.push(vendoredEntry(v, c, input.settings))
      continue
    }
    // A subscription with a starter list's name replaces it; with the catalog URL it keeps the
    // shipped copy as its offline fallback.
    subscribed.delete(v.id)
    const sameSource = sub.url === c.url
    entries.push({
      ...subscriptionEntry(sub, c),
      ...(sameSource
        ? { source: 'vendored' as const, vendored: v, defaultMode: enabledDefault(c.recommendedMode) }
        : {}),
    })
    if (input.settings[v.id] !== undefined) {
      problems.push(`lists.${v.id} is ignored: its subscription sets the mode`)
    }
  }

  for (const s of subscribed.values()) {
    if (!claim(s.name, 'subscribed')) {
      problems.push(`subscription '${s.name}' clashes with another list of the same name; it is ignored`)
      continue
    }
    entries.push(subscriptionEntry(s, catalogByUrl(s.url)))
    if (input.settings[s.name] !== undefined) {
      problems.push(`lists.${s.name} is ignored: its subscription sets the mode`)
    }
  }

  for (const m of input.locals) {
    if (!LIST_ID.test(m.id)) continue
    if (!claim(m.id, 'local')) {
      problems.push(`the imported list '${m.id}' clashes with another list of the same name; it is ignored`)
      continue
    }
    entries.push({
      id: m.id,
      name: m.id,
      source: 'local',
      kind: m.kind,
      format: m.format,
      mode: input.settings[m.id]?.mode ?? 'enforce',
      defaultMode: 'enforce',
      description: `Imported from ${m.file}`,
      updateMs: null,
      local: m,
    })
  }

  for (const id of Object.keys(input.settings)) {
    if (!taken.has(id.toLowerCase())) problems.push(`lists.${id} names no list; it is ignored`)
  }
  return { entries, problems }
}

function subscriptionEntry(s: Subscription, c: CatalogList | undefined): ListEntry {
  const e: ListEntry = {
    id: s.name,
    name: c?.name ?? s.name,
    source: 'subscribed',
    kind: s.kind,
    format: s.format,
    mode: s.mode,
    defaultMode: 'enforce',
    url: s.url,
    update: s.update,
    updateMs: updateToMs(s.update),
  }
  if (c !== undefined) {
    e.catalog = c
    e.homepage = c.homepage
    e.license = c.license
    e.description = c.notes
  }
  if (s.sha256 !== undefined) e.sha256 = s.sha256
  return e
}

/**
 * The refresh interval: the entry's `update` (at least an hour), shortened by the list's own
 * `Expires` header, never below six hours.
 */
export function refreshIntervalMs(updateMs: number, expires?: string): number {
  const base = Math.max(MIN_UPDATE_MS, updateMs)
  const exp = expires === undefined ? null : expiresToMs(expires)
  return exp === null ? base : Math.min(base, Math.max(EXPIRES_FLOOR_MS, exp))
}

/** Delay before retrying after `failures` consecutive failures (1 h, 2 h, 4 h, … up to the interval). */
export function retryDelayMs(failures: number, intervalMs: number): number {
  const n = Math.max(1, Math.min(failures, 20))
  return Math.min(intervalMs, RETRY_BASE_MS * 2 ** (n - 1))
}

/** True when an update from `previous` to `next` rules must be refused (shrink guard). */
export function shrinkRefused(previous: number | null | undefined, next: number): boolean {
  return previous !== null && previous !== undefined && previous > 0 && next < previous * SHRINK_RATIO
}

/** A list id from a URL's file name (`…/my-list.txt` → `my-list`), or null. */
export function idFromUrl(url: string): string | null {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  let file =
    path
      .split('/')
      .filter((p) => p !== '')
      .pop() ?? ''
  try {
    file = decodeURIComponent(file)
  } catch {
    // Keep the encoded name.
  }
  const base = file
    .replace(/\.(txt|list|goggle|yaml|yml|hosts|conf)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  return LIST_ID.test(base) && !RESERVED_LIST_IDS.has(base) ? base : null
}
