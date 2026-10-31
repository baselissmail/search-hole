// SPDX-License-Identifier: Apache-2.0
/**
 * Words and pure helpers for lists (ADR-0008 "Lists", ADR-0022): modes, sources, kinds, what a
 * list did this week, what an error means and what to do about it, and the inputs that undo a
 * change. No React, no I/O: the screens and the actions build on these.
 */
import type {
  AddListInput,
  ListCatalogEntry,
  ListFormat,
  ListKind,
  ListMode,
  ListSource,
  ListStatus,
  ListUpdateResult,
} from './contract.ts'
import { formatCount } from './format.ts'

export const LIST_MODES: readonly ListMode[] = ['enforce', 'audit', 'disabled']

export const MODE_WORDS: Record<ListMode, string> = {
  enforce: 'Enforce',
  audit: 'Audit',
  disabled: 'Off',
}

export const MODE_HINTS: Record<ListMode, string> = {
  enforce: 'Applies the list: it hides what it matches.',
  audit: 'Records what it would hide, and hides nothing.',
  disabled: 'Not applied and not refreshed.',
}

export function modeWord(mode: string): string {
  return MODE_WORDS[mode as ListMode] ?? mode
}

export const SOURCE_WORDS: Record<ListSource, string> = {
  bundled: 'Built-in',
  vendored: 'Starter',
  subscribed: 'Subscribed',
  local: 'Imported',
}

export const SOURCE_HINTS: Record<ListSource, string> = {
  bundled: 'Written by search-hole and built in. It updates with search-hole.',
  vendored:
    'A starter list: a copy ships with search-hole so it works offline, then it is refreshed from its address.',
  subscribed: 'Your subscription, downloaded from its address.',
  local: 'Imported from a file on this computer. Never refreshed: import the file again to change it.',
}

export function sourceWord(source: string): string {
  return SOURCE_WORDS[source as ListSource] ?? source
}

export const LIST_KINDS: readonly ListKind[] = ['block', 'allow', 'official', 'content-farm', 'clone']

export const KIND_WORDS: Record<ListKind, string> = {
  block: 'Block',
  allow: 'Allow',
  official: 'Official sources',
  'content-farm': 'Content farms',
  clone: 'Clone sites',
}

export const KIND_HINTS: Record<ListKind, string> = {
  block: 'Hides the sites it lists.',
  allow: 'Exceptions: keeps the sites it lists, even when another list blocks them.',
  official: 'Marks official sources so they rank first. Never hides anything.',
  'content-farm': 'Marks content farms and hides them.',
  clone: 'Marks sites that copy other sites, and hides them.',
}

export function kindWord(kind: string): string {
  return KIND_WORDS[kind as ListKind] ?? kind
}

export const LIST_FORMATS: readonly ListFormat[] = [
  'auto',
  'ublacklist',
  'abp',
  'adguard',
  'hosts',
  'domains',
  'goggles',
  'searchhole',
]

export const FORMAT_WORDS: Record<ListFormat, string> = {
  auto: 'Detect automatically',
  ublacklist: 'uBlacklist',
  abp: 'Adblock Plus',
  adguard: 'AdGuard',
  hosts: 'hosts file',
  domains: 'Plain domains',
  goggles: 'Brave Goggles',
  searchhole: 'search-hole',
}

export function formatWord(format: string): string {
  return FORMAT_WORDS[format as ListFormat] ?? format
}

/** Refresh intervals the add form offers (`update:` durations the server accepts). */
export const UPDATE_INTERVALS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '12h', label: 'Every 12 hours' },
  { value: '1d', label: 'Every day' },
  { value: '7d', label: 'Every week' },
  { value: '2w', label: 'Every 2 weeks' },
  { value: '30d', label: 'Every 30 days' },
]

export const DEFAULT_UPDATE = '7d'

const UNIT_WORDS: Record<string, string> = { m: 'minute', h: 'hour', d: 'day', w: 'week' }

/** `7d` → `every 7 days`, `1d` → `every day`; anything else as written. */
export function intervalText(update: string): string {
  const m = /^(\d{1,6})([mhdw])$/.exec(update.trim())
  const unit = m ? UNIT_WORDS[m[2] ?? ''] : undefined
  if (!m || unit === undefined) return update
  const n = Number(m[1])
  return n === 1 ? `every ${unit}` : `every ${formatCount(n)} ${unit}s`
}

const results = (n: number) => `${formatCount(n)} ${n === 1 ? 'result' : 'results'}`

/**
 * What a list did in the last 7 days, in words: "Hid 312 results this week", "Would hide 41
 * results this week" (audit), or why it hides nothing.
 */
export function contributionText(list: Pick<ListStatus, 'mode' | 'kind' | 'contribution'>): string {
  const { hidden7d: hid, wouldHide7d: would } = list.contribution
  if (hid > 0 && would > 0) return `Hid ${results(hid)} this week; would hide ${formatCount(would)} more`
  if (hid > 0) return `Hid ${results(hid)} this week`
  if (would > 0) return `Would hide ${results(would)} this week`
  if (list.mode === 'disabled') return 'Off: not applied'
  if (list.kind === 'official') return 'Marks official sources; hides nothing'
  if (list.kind === 'allow') return 'Keeps sites; hides nothing'
  return list.mode === 'audit' ? 'Would hide nothing this week' : 'Hid nothing this week'
}

export interface ContributionSummary {
  /** Results hidden by lists in the last 7 days. */
  hidden: number
  /** Results audit lists would have hidden. */
  wouldHide: number
  /** The lists that hid the most, most first (at most `top`). */
  top: Array<{ id: string; name: string; count: number }>
}

export function contributionSummary(lists: readonly ListStatus[], top = 3): ContributionSummary {
  let hidden = 0
  let wouldHide = 0
  for (const l of lists) {
    hidden += l.contribution.hidden7d
    wouldHide += l.contribution.wouldHide7d
  }
  const most = lists
    .filter((l) => l.contribution.hidden7d > 0)
    .map((l) => ({ id: l.id, name: l.name, count: l.contribution.hidden7d }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, top)
  return { hidden, wouldHide, top: most }
}

/** The headline of the Lists section. */
export function summaryText(s: ContributionSummary): string {
  if (s.hidden === 0 && s.wouldHide === 0) return 'No list hid anything this week.'
  const hid = s.hidden > 0 ? `Lists hid ${results(s.hidden)} this week` : 'Lists hid nothing this week'
  const would = s.wouldHide > 0 ? `; audit lists would have hidden ${formatCount(s.wouldHide)} more` : ''
  return `${hid}${would}.`
}

/** Subscribed and imported lists can be removed; built-in and starter lists only turned off. */
export function canRemove(list: Pick<ListStatus, 'source'>): boolean {
  return list.source === 'subscribed' || list.source === 'local'
}

/** Lists with an address can be refreshed on demand. */
export function canUpdate(list: Pick<ListStatus, 'source' | 'url'>): boolean {
  return (list.source === 'vendored' || list.source === 'subscribed') && Boolean(list.url)
}

/**
 * The subscription that recreates a removed list (the Undo of a remove), or null when nothing
 * can recreate it (an import's file is deleted with it; built-in lists are never removed).
 */
export function resubscribeInput(list: ListStatus): AddListInput | null {
  if (list.source !== 'subscribed' || !list.url) return null
  const input: AddListInput = {
    source: list.url,
    name: list.id,
    format: list.format,
    kind: list.kind,
    mode: list.mode,
  }
  if (list.update) input.update = list.update
  if (list.sha256) input.sha256 = list.sha256
  return input
}

/** The mode a catalog list is added in: its recommendation, else Audit (trial before enforcing). */
export function catalogAddMode(entry: Pick<ListCatalogEntry, 'recommendedMode'>): ListMode {
  return entry.recommendedMode === 'off' ? 'audit' : entry.recommendedMode
}

/** How to undo adding a catalog list: restore its mode when it was already here, else remove it. */
export function catalogUndo(entry: Pick<ListCatalogEntry, 'mode'>): { remove: true } | { mode: ListMode } {
  return entry.mode === undefined ? { remove: true } : { mode: entry.mode }
}

export interface UpdateTally {
  updated: number
  unchanged: number
  failed: number
  skipped: number
}

export function tallyUpdates(results: readonly ListUpdateResult[]): UpdateTally {
  const t: UpdateTally = { updated: 0, unchanged: 0, failed: 0, skipped: 0 }
  for (const r of results) if (r.result in t) t[r.result] += 1
  return t
}

/** `2 updated · 5 unchanged · 1 failed` (zero counts left out). */
export function tallyText(t: UpdateTally): string {
  const parts = (['updated', 'unchanged', 'failed', 'skipped'] as const)
    .filter((k) => t[k] > 0)
    .map((k) => `${formatCount(t[k])} ${k}`)
  return parts.length > 0 ? parts.join(' · ') : 'No list to update'
}

export interface Outcome {
  tone: 'success' | 'info' | 'error'
  title: string
  description: string
}

/** The toast for one list's refresh. */
export function updateOutcome(r: ListUpdateResult, name: string): Outcome {
  const rules = `${formatCount(r.ruleCount)} ${r.ruleCount === 1 ? 'rule' : 'rules'}`
  switch (r.result) {
    case 'updated':
      return {
        tone: 'success',
        title: `Updated ${name}`,
        description:
          r.previousRuleCount === null
            ? `${rules} in force.`
            : `${formatCount(r.previousRuleCount)} → ${rules}.`,
      }
    case 'unchanged':
      return { tone: 'success', title: `${name} is up to date`, description: `No change; ${rules} in force.` }
    case 'failed':
      return {
        tone: 'error',
        title: `Couldn't update ${name}`,
        description: `${withStop(r.error?.message ?? r.message)} The copy in force is kept.`,
      }
    default:
      return { tone: 'info', title: `${name} was not updated`, description: sentence(r.message) }
  }
}

/** `text` ending in a full stop (error messages keep their own first letter: `getaddrinfo …`). */
export function withStop(text: string): string {
  const t = text.trim()
  return t === '' || /[.!?]$/.test(t) ? t : `${t}.`
}

function sentence(text: string): string {
  const t = withStop(text)
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export interface ErrorAdvice {
  /** The state, in one or two words (shown with an icon and colour). */
  word: string
  tone: 'warn' | 'danger'
  /** What happened and what to do, in plain words. */
  advice: string
  /** The one-click fix: accept the refused copy, or try again. */
  action?: 'force' | 'retry'
}

const ERRORS: Record<string, ErrorAdvice> = {
  shrink_guard: {
    word: 'Held back',
    tone: 'warn',
    advice:
      'The new copy has under half the rules of the one in force, so search-hole kept the old one: a guard against broken or hijacked lists. If the list really shrank, accept the new copy.',
    action: 'force',
  },
  sha256_mismatch: {
    word: 'Checksum mismatch',
    tone: 'warn',
    advice:
      'The download does not match the SHA-256 you pinned. If you trust the change, remove the list and subscribe again without the pin.',
  },
  too_large: {
    word: 'Too large',
    tone: 'danger',
    advice: 'The list is over the 64 MiB cap. Subscribe to a smaller variant of it.',
  },
  http_status: {
    word: 'Server error',
    tone: 'danger',
    advice: 'The server did not send the list. Check that the address still works, or try again later.',
    action: 'retry',
  },
  network: {
    word: 'Network error',
    tone: 'danger',
    advice: 'The list could not be downloaded. Check your connection, then try again.',
    action: 'retry',
  },
  timeout: {
    word: 'Timed out',
    tone: 'danger',
    advice: 'The download took longer than 60 seconds. Try again later.',
    action: 'retry',
  },
  not_https: {
    word: 'Not HTTPS',
    tone: 'danger',
    advice: 'Lists are fetched over HTTPS only, redirects included. Use the https:// address of the list.',
  },
  blocked_address: {
    word: 'Blocked address',
    tone: 'danger',
    advice:
      'The address points to a private or local network, which search-hole never fetches from. Use a public address.',
  },
  too_many_redirects: {
    word: 'Too many redirects',
    tone: 'danger',
    advice: 'The address redirected more than 5 times. Subscribe to its final address instead.',
  },
  not_text: {
    word: 'Not a text list',
    tone: 'danger',
    advice: 'The download is binary or not UTF-8 text. Check that the address points to the raw list file.',
  },
  empty: {
    word: 'No usable rules',
    tone: 'danger',
    advice: 'No line of the download could be imported. Check the address, or set the format.',
  },
  unreadable: {
    word: 'Unreadable copy',
    tone: 'danger',
    advice: 'The stored copy could not be read. Update the list to download a fresh copy.',
    action: 'retry',
  },
}

export function listErrorAdvice(code: string): ErrorAdvice {
  return (
    ERRORS[code] ?? {
      word: 'Update failed',
      tone: 'danger',
      advice: 'The last refresh failed. Try again, or run `searchhole doctor`.',
      action: 'retry',
    }
  )
}

/** List ids: what the server stores (they name folders). */
export const LIST_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface FieldProblem {
  message: string
  fix?: string
}

/** Checks the add form's address before it is sent; null when it can go. */
export function checkListUrl(raw: string): FieldProblem | null {
  const text = raw.trim()
  if (text === '')
    return { message: "Enter the list's address.", fix: 'For example https://example.org/list.txt' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { message: 'That is not a full address.', fix: 'Start it with https://' }
  }
  if (url.protocol !== 'https:') {
    return { message: 'Lists are fetched over HTTPS only.', fix: 'Use the https:// address of the list.' }
  }
  if (url.username !== '' || url.password !== '') {
    return { message: 'The address must not contain a user name or password.' }
  }
  return null
}

/** Checks the optional list name; null when it is empty or valid. */
export function checkListName(raw: string): FieldProblem | null {
  const text = raw.trim()
  if (text === '' || LIST_ID.test(text)) return null
  return {
    message: 'Use 1–64 lower-case letters, digits, ".", "_" or "-".',
    fix: 'It starts with a letter or a digit, as in my-list.',
  }
}

/** The host a list downloads from, for "Downloads from raw.githubusercontent.com". */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/** `NONE` and `NOASSERTION` in words. */
export function licenseText(license: string | undefined): string {
  if (!license) return 'Unknown licence'
  if (license === 'NONE') return 'No licence'
  if (license === 'NOASSERTION') return 'Licence unclear'
  return license
}
