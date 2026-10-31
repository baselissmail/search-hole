// SPDX-License-Identifier: Apache-2.0
/**
 * Types shared by the list importers (ADR-0008 "Lists", "Import mapping").
 */
import type { CancelEntry } from '../../core/rules/engine.ts'
import type { ListKind, Rule } from '../../shared/types.ts'
import type { ListFormat } from '../yaml.ts'

/** A concrete list format (what `auto` resolves to). */
export type ImportFormat = Exclude<ListFormat, 'auto'>

/** Per-list caps (ADR-0008 "Strict vs permissive compile"). */
export interface ListCaps {
  /** Rules kept per list; later entries are skipped. */
  rules: number
  /** UTF-8 bytes read per list; later lines are not read. */
  bytes: number
  /** Regex rules kept per list; later regex entries are skipped. */
  regex: number
}

export const LIST_CAPS: Readonly<ListCaps> = Object.freeze({
  rules: 2_000_000,
  bytes: 64 * 1024 * 1024,
  regex: 20_000,
})

export interface ImportOptions {
  format: ListFormat
  /** The list id the rules belong to (`Rule.listId`, `ListInput.id`). */
  listId: string
  /** The list role: it decides what a plain entry means (ADR-0008 "List role defines meaning"). */
  kind: ListKind
  /** Lower caps, for tests. Never raised above {@link LIST_CAPS}. */
  caps?: Partial<ListCaps>
}

/** Metadata read from the list's header comments, uBlacklist front matter or Goggles `! key:` lines. */
export interface ListHeader {
  title?: string
  description?: string
  license?: string
  homepage?: string
  /** Raw value, e.g. `4 days (update frequency)`; see `expiresToMs`. */
  expires?: string
  version?: string
  lastModified?: string
  author?: string
  /** Goggles `transferred_to`: the list moved to this URL. */
  transferredTo?: string
}

/** One line (or hosts-file name) that was not imported. */
export interface SkippedEntry {
  /** 1-based line number. */
  line: number
  /** Stable, countable reason (`cosmetic filter`, `unsupported modifier $dnstype`, …). */
  reason: string
  /** The line, cut to 200 characters. */
  text: string
  /** Specifics, e.g. the regex error. */
  detail?: string
}

/**
 * Counters. Invariants (fuzz-tested):
 * - `entries === accepted + duplicates + skipped`
 * - `accepted + companions === rules + cancel`
 * - `lines - ignored <= entries` (equal unless a hosts line names several hosts)
 * - `rules`, `cancel`, `regex` and `patterns` count `result.rules` / `result.cancel`
 * - `skipped` is the sum of `skipReasons`
 */
export interface ImportStats {
  /** UTF-8 size of the whole input. */
  bytes: number
  /** Lines read (all of them unless the byte cap truncated the list). */
  lines: number
  /** Blank lines, comments, headers, directives and reserved hosts-file names (`localhost`). */
  ignored: number
  /** Rule candidates: one per remaining line, one per name on a hosts line. */
  entries: number
  /** Entries that became a rule or a cancel entry. */
  accepted: number
  /** Entries identical to an earlier one; for Goggles, instructions merged into an earlier one with the same match. */
  duplicates: number
  /** Entries not imported; see `skipReasons` and the `skipped` sample. */
  skipped: number
  rules: number
  cancel: number
  /** Rules with `matchKind: 'regex'` (capped at {@link ListCaps.regex}). */
  regex: number
  /** Rules with `matchKind: 'url_pattern'`. */
  patterns: number
  /** `allow` rules added next to the instructions of an allowlist-mode goggle (see `allowlistMode`). */
  companions: number
}

export interface ImportResult {
  listId: string
  kind: ListKind
  /** The format that was parsed (detected when the input asked for `auto`). */
  format: ImportFormat
  /** Rules with `scope: 'list'`, ready for a `ListInput`; `order` is the index. */
  rules: Rule[]
  /** `$badfilter` cancel set (ABP/AdGuard). */
  cancel: CancelEntry[]
  /** The first skipped entries (a sample of at most {@link SKIPPED_SAMPLE}). */
  skipped: SkippedEntry[]
  /** Every skip, counted by reason. */
  skipReasons: Record<string, number>
  stats: ImportStats
  /** List-level notes: approximations, caps, truncation, ignored directives. */
  warnings: string[]
  header: ListHeader
  /**
   * A generic Goggles `$discard`: the goggle keeps only what it matches. Apply it
   * with a profile that sets `default: block`; each instruction then also has an
   * `allow` companion (so matched results stay visible) and discards are
   * list-important (so they stay final).
   */
  allowlistMode?: boolean
  /** The byte cap stopped reading; `stats.lines` counts only the lines read. */
  truncated?: boolean
}

/** Size of the `skipped` sample. */
export const SKIPPED_SAMPLE = 100
