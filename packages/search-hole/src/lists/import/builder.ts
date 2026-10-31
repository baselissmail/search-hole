// SPDX-License-Identifier: Apache-2.0
/**
 * The shared half of every importer: maps an entry's intent through the list
 * kind, validates the match with the rules engine's own parser (so every rule
 * produced compiles), de-duplicates, enforces the per-list caps, and counts.
 */
import type { CancelEntry } from '../../core/rules/engine.ts'
import { classifyMatch, parseMatch } from '../../core/rules/match.ts'
import type { ListKind, Rule, RuleAction } from '../../shared/types.ts'
import {
  type ImportFormat,
  type ImportResult,
  type ImportStats,
  type ListCaps,
  type ListHeader,
  SKIPPED_SAMPLE,
  type SkippedEntry,
} from './types.ts'

/** What a list line asks for, before the list kind gives it meaning. */
export type Intent =
  /** A plain entry (`||d^`, `*://*.d/*`, a hosts or domains line): the kind decides. */
  | { type: 'positive' }
  /** An exception (`@@`, uBlacklist `@`). */
  | { type: 'exception' }
  /** uBlacklist `@N`, Goggles `boost=N` (and a bare instruction). */
  | { type: 'raise'; weight: number }
  /** Goggles `downrank=N`. */
  | { type: 'lower'; weight: number }
  /** Goggles `discard`. */
  | { type: 'discard' }
  /** A rule that states its action (search-hole YAML lists); only `official` overrides it. */
  | { type: 'explicit'; action: RuleAction; weight: number }

export const POSITIVE: Intent = { type: 'positive' }
export const EXCEPTION: Intent = { type: 'exception' }

/**
 * ADR-0008 "List role defines meaning": `official` lists only annotate (action
 * `normal`); `allow` lists turn entries into exceptions; `block`, `content-farm`
 * and `clone` lists block, unless the line itself says otherwise.
 */
export function actionFor(kind: ListKind, intent: Intent): { action: RuleAction; weight: number } | string {
  if (kind === 'official') {
    if (intent.type === 'exception') return 'exception in an official (annotation-only) list'
    return { action: 'normal', weight: 1 }
  }
  switch (intent.type) {
    case 'positive':
      return { action: kind === 'allow' ? 'allow' : 'block', weight: 1 }
    case 'exception':
      return { action: 'allow', weight: 1 }
    case 'raise':
      return { action: 'raise', weight: intent.weight }
    case 'lower':
      return { action: 'lower', weight: intent.weight }
    case 'discard':
      return kind === 'allow' ? 'discard in an allow list' : { action: 'block', weight: 1 }
    case 'explicit':
      return { action: intent.action, weight: intent.weight }
  }
}

/** Turns an engine parse error into a stable, countable skip reason. */
function invalidReason(error: string): string {
  if (/lookahead|lookbehind|backreference/.test(error))
    return 'non-linear regex (lookaround or backreference)'
  if (error.startsWith('regex is longer')) return 'regex longer than 1,000 characters'
  if (error.startsWith('invalid regex') || error === 'empty regex') return 'invalid regex'
  if (error.includes('would match every URL')) return 'matches every URL'
  if (error.startsWith('URL pattern')) return 'URL pattern over the limits (2 *, 2 ^, 500 characters)'
  if (error.includes('host name') || error.includes('valid host')) return 'invalid host name'
  if (error.includes('invalid path')) return 'invalid path'
  return 'invalid rule'
}

/** Goggles precedence inside one goggle: discard is final, then the largest boost, then the weakest downrank. */
function gogglesStrength(action: RuleAction, weight: number): number {
  if (action === 'block') return 1000
  if (action === 'raise') return 100 + weight
  if (action === 'lower') return 50 - weight
  return 0
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface BuilderOptions {
  listId: string
  kind: ListKind
  format: ImportFormat
  caps: ListCaps
  /** Goggles: instructions with the same match resolve into one rule instead of counting as duplicates. */
  mergeByMatch?: boolean
}

export class ListBuilder {
  readonly header: ListHeader = {}
  allowlistMode = false
  truncated = false
  readonly stats: ImportStats = {
    bytes: 0,
    lines: 0,
    ignored: 0,
    entries: 0,
    accepted: 0,
    duplicates: 0,
    skipped: 0,
    rules: 0,
    cancel: 0,
    regex: 0,
    patterns: 0,
    companions: 0,
  }
  private readonly rules: Rule[] = []
  private readonly cancel: CancelEntry[] = []
  private readonly warnings: string[] = []
  private readonly sample: SkippedEntry[] = []
  private readonly reasons = new Map<string, number>()
  private readonly seen = new Map<string, number>()
  private readonly seenCancel = new Set<string>()
  private readonly warned = new Set<string>()

  private readonly o: BuilderOptions

  constructor(o: BuilderOptions) {
    this.o = o
  }

  get kind(): ListKind {
    return this.o.kind
  }

  get listId(): string {
    return this.o.listId
  }

  get format(): ImportFormat {
    return this.o.format
  }

  /** A blank line, comment, header, directive or reserved name. */
  ignore(): void {
    this.stats.ignored++
  }

  /** `n` lines that hold no entry (formats not read line by line). */
  ignoreLines(n: number): void {
    this.stats.ignored += n
  }

  warn(message: string): void {
    if (!this.warned.has(message)) {
      this.warned.add(message)
      this.warnings.push(message)
    }
  }

  skip(line: number, text: string, reason: string, detail?: string): void {
    this.stats.entries++
    this.stats.skipped++
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
    if (this.sample.length < SKIPPED_SAMPLE) {
      const s: SkippedEntry = { line, reason, text: cut(text, 200) }
      if (detail !== undefined) s.detail = cut(detail, 300)
      this.sample.push(s)
    }
  }

  /**
   * Adds one entry. `match` must be a search-hole match expression; `text` is
   * the source line (kept on the rule when it differs). `sub` numbers the
   * second and later entries of one line (hosts files).
   */
  add(line: number, text: string, match: string, intent: Intent, listImportant = false, sub = 0): void {
    const mapped = actionFor(this.o.kind, intent)
    if (typeof mapped === 'string') {
      this.skip(line, text, mapped)
      return
    }
    const parsed = parseMatch(match)
    if (!parsed.ok) {
      this.skip(line, text, invalidReason(parsed.error), parsed.error)
      return
    }
    const m = parsed.match
    const { action, weight } = mapped
    const key = this.o.mergeByMatch
      ? `${m.kind}\u0000${m.canonical}\u0000${listImportant}`
      : `${m.kind}\u0000${m.canonical}\u0000${action}\u0000${weight}\u0000${listImportant}`
    const id = `l_${this.o.listId}_${line}${sub > 0 ? `_${sub + 1}` : ''}`
    const known = this.seen.get(key)
    if (known !== undefined) {
      const prev = this.rules[known]
      if (
        this.o.mergeByMatch &&
        prev &&
        gogglesStrength(action, weight) > gogglesStrength(prev.action, prev.weight)
      ) {
        prev.id = id
        prev.action = action
        prev.weight = weight
        if (text !== prev.match) prev.text = cut(text, 1000)
        else delete prev.text
      }
      this.stats.entries++
      this.stats.duplicates++
      return
    }
    if (this.rules.length + this.cancel.length >= this.o.caps.rules) {
      this.warn(
        `list has more than ${this.o.caps.rules.toLocaleString('en-US')} rules; the rest were skipped`,
      )
      this.skip(line, text, 'over the per-list rule cap')
      return
    }
    if (m.kind === 'regex' && this.stats.regex >= this.o.caps.regex) {
      this.warn(
        `list has more than ${this.o.caps.regex.toLocaleString('en-US')} regex rules; the rest were skipped`,
      )
      this.skip(line, text, 'over the per-list regex cap')
      return
    }
    const hostLike = m.kind === 'domain' || m.kind === 'exact_host' || m.kind === 'host_path'
    const stored = hostLike && classifyMatch(m.canonical) === m.kind ? m.canonical : match.trim()
    const rule: Rule = {
      id,
      scope: 'list',
      match: stored,
      matchKind: m.kind,
      action,
      weight,
      important: false,
      listId: this.o.listId,
      order: this.rules.length,
    }
    if (listImportant) rule.listImportant = true
    if (text !== stored) rule.text = cut(text, 1000)
    this.seen.set(key, this.rules.length)
    this.rules.push(rule)
    this.stats.entries++
    this.stats.accepted++
    this.stats.rules++
    if (m.kind === 'regex') this.stats.regex++
    if (m.kind === 'url_pattern') this.stats.patterns++
  }

  /**
   * Goggles allowlist mode (a generic `$discard`): results that an instruction
   * matches must stay visible when the profile hides everything else
   * (`default: block`), so every weight rule gets an `allow` companion with the
   * same match. Discards become list-important, so a discard stays final
   * against the goggle's own companions. Only for lists that hide (not
   * `official` or `allow`). Returns the number of companions added.
   */
  addAllowlistCompanions(): number {
    if (this.o.kind === 'official' || this.o.kind === 'allow') return 0
    let added = 0
    for (const r of this.rules.slice()) {
      if (r.action === 'block') {
        r.listImportant = true
        continue
      }
      if (this.rules.length + this.cancel.length >= this.o.caps.rules) break
      if (r.matchKind === 'regex' && this.stats.regex >= this.o.caps.regex) continue
      const c: Rule = { ...r, id: `${r.id}_keep`, action: 'allow', weight: 1, order: this.rules.length }
      this.rules.push(c)
      this.stats.rules++
      this.stats.companions++
      if (c.matchKind === 'regex') this.stats.regex++
      if (c.matchKind === 'url_pattern') this.stats.patterns++
      added++
    }
    return added
  }

  /** Adds a `$badfilter` entry: it cancels the rule this line would otherwise be, in every list. */
  addCancel(line: number, text: string, match: string, intent: Intent, listImportant: boolean): void {
    const mapped = actionFor(this.o.kind, intent)
    if (typeof mapped === 'string') {
      this.skip(line, text, mapped)
      return
    }
    const parsed = parseMatch(match)
    if (!parsed.ok) {
      this.skip(line, text, invalidReason(parsed.error), parsed.error)
      return
    }
    const m = parsed.match
    const key = `${m.kind}\u0000${m.canonical}\u0000${mapped.action}\u0000${listImportant}`
    if (this.seenCancel.has(key)) {
      this.stats.entries++
      this.stats.duplicates++
      return
    }
    if (this.rules.length + this.cancel.length >= this.o.caps.rules) {
      this.warn(
        `list has more than ${this.o.caps.rules.toLocaleString('en-US')} rules; the rest were skipped`,
      )
      this.skip(line, text, 'over the per-list rule cap')
      return
    }
    this.seenCancel.add(key)
    const hostLike = m.kind === 'domain' || m.kind === 'exact_host' || m.kind === 'host_path'
    const stored = hostLike && classifyMatch(m.canonical) === m.kind ? m.canonical : match.trim()
    const c: CancelEntry = { match: stored, action: mapped.action }
    if (listImportant) c.listImportant = true
    this.cancel.push(c)
    this.stats.entries++
    this.stats.accepted++
    this.stats.cancel++
  }

  finish(): ImportResult {
    const result: ImportResult = {
      listId: this.o.listId,
      kind: this.o.kind,
      format: this.o.format,
      rules: this.rules,
      cancel: this.cancel,
      skipped: this.sample,
      skipReasons: Object.fromEntries(
        [...this.reasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
      ),
      stats: this.stats,
      warnings: this.warnings,
      header: this.header,
    }
    if (this.allowlistMode) result.allowlistMode = true
    if (this.truncated) result.truncated = true
    return result
  }
}
