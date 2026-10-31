// SPDX-License-Identifier: Apache-2.0
/**
 * Compiled list artifacts (ADR-0006 point 8, ADR-0022): an imported list serialised so a
 * process loads it without re-importing the text on every start.
 *
 * File format: one header line of JSON, a newline, then the body JSON.
 * - The header names the artifact (`magic`), the compiler version, the list id, the SHA-256 of
 *   the list text it was built from, and the SHA-256 and byte length of the body. A reader
 *   checks the header first (cheap), then the body checksum, then the body shape.
 * - Rules are stored as compact tuples; the rule id keeps only what follows `l_<listId>_`.
 *
 * Anything unexpected (truncated file, checksum, another compiler version, another source) is
 * reported as a reason, never thrown: the caller rebuilds from the list text.
 *
 * Pure: hashing is `node:crypto`, the only I/O-free builtin a pure layer may use.
 */
import { createHash } from 'node:crypto'
import type { CancelEntry, ListInput } from '../core/rules/engine.ts'
import type { ListKind, ListMode, MatchKind, Rule, RuleAction } from '../shared/types.ts'
import type { ImportFormat, ImportResult, ImportStats, ListHeader, SkippedEntry } from './import/index.ts'
import type { ListFormat } from './yaml.ts'

/**
 * Bump when the importers' output or this encoding changes: older artifacts are then rebuilt
 * from the stored list text (never deleted while a newer version could still read them).
 */
export const LIST_COMPILER_VERSION = '1'
export const ARTIFACT_MAGIC = 'searchhole-list-artifact'
/** Skipped-line samples kept in an artifact (the import keeps up to 100). */
const SKIPPED_IN_ARTIFACT = 20

const KINDS: readonly MatchKind[] = ['domain', 'exact_host', 'host_path', 'url_pattern', 'regex']
const ACTIONS: readonly RuleAction[] = ['block', 'allow', 'pin', 'raise', 'lower', 'normal']
const LIST_KINDS: ReadonlySet<string> = new Set<ListKind>([
  'block',
  'allow',
  'official',
  'content-farm',
  'clone',
])

/** What an artifact says about the import it holds. */
export interface ListArtifactMeta {
  listId: string
  kind: ListKind
  /** The format that was parsed (detected when `requestedFormat` is `auto`). */
  format: ImportFormat
  /** The format the list was imported with (`auto` or a concrete one). */
  requestedFormat: ListFormat
  /** SHA-256 (hex) of the list text the rules were built from. */
  contentSha256: string
  compilerVersion: string
  /** ISO 8601. */
  builtAt: string
  stats: ImportStats
  skipReasons: Record<string, number>
  skippedSample: SkippedEntry[]
  warnings: string[]
  header: ListHeader
  allowlistMode?: true
  truncated?: true
}

export interface ListArtifact extends ListArtifactMeta {
  rules: Rule[]
  cancel: CancelEntry[]
}

interface ArtifactHeader {
  magic: string
  compilerVersion: string
  listId: string
  kind: ListKind
  requestedFormat: ListFormat
  contentSha256: string
  bodySha256: string
  bodyBytes: number
}

/** How an artifact was built: a different value for any of these means "rebuild". */
export interface BuildKey {
  contentSha256: string
  kind: ListKind
  requestedFormat: ListFormat
}

type RuleTuple = [string, string, number, number, number, number]
type CancelTuple = [string, number, number]

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** Hex SHA-256 of a list's text (UTF-8), the content key of its artifacts. */
export function contentSha256(text: string): string {
  return sha256(text)
}

/** Serialises an import. `builtAt` is an ISO date. */
export function encodeArtifact(
  imported: ImportResult,
  o: { contentSha256: string; requestedFormat: ListFormat; builtAt: string },
): string {
  const prefix = `l_${imported.listId}_`
  const rules: RuleTuple[] = imported.rules.map((r) => [
    r.id.startsWith(prefix) ? r.id.slice(prefix.length) : `!${r.id}`,
    r.match,
    KINDS.indexOf(r.matchKind),
    ACTIONS.indexOf(r.action),
    r.weight,
    r.listImportant === true ? 1 : 0,
  ])
  const cancel: CancelTuple[] = imported.cancel.map((c) => [
    c.match,
    ACTIONS.indexOf(c.action),
    c.listImportant === true ? 1 : 0,
  ])
  const meta: ListArtifactMeta = {
    listId: imported.listId,
    kind: imported.kind,
    format: imported.format,
    requestedFormat: o.requestedFormat,
    contentSha256: o.contentSha256,
    compilerVersion: LIST_COMPILER_VERSION,
    builtAt: o.builtAt,
    stats: imported.stats,
    skipReasons: imported.skipReasons,
    skippedSample: imported.skipped.slice(0, SKIPPED_IN_ARTIFACT),
    warnings: imported.warnings,
    header: imported.header,
    ...(imported.allowlistMode === true ? { allowlistMode: true as const } : {}),
    ...(imported.truncated === true ? { truncated: true as const } : {}),
  }
  const body = JSON.stringify({ meta, rules, cancel })
  const header: ArtifactHeader = {
    magic: ARTIFACT_MAGIC,
    compilerVersion: LIST_COMPILER_VERSION,
    listId: imported.listId,
    kind: imported.kind,
    requestedFormat: o.requestedFormat,
    contentSha256: o.contentSha256,
    bodySha256: sha256(body),
    bodyBytes: Buffer.byteLength(body, 'utf8'),
  }
  return `${JSON.stringify(header)}\n${body}`
}

export type DecodeFailure =
  | 'corrupt'
  | 'checksum'
  | 'compiler_version'
  | 'other_list'
  | 'other_content'
  | 'other_options'

export type DecodeResult = { ok: true; artifact: ListArtifact } | { ok: false; reason: DecodeFailure }

export interface DecodeExpect {
  listId: string
  /** The content, kind and format the artifact must have been built with; omit to accept any. */
  build?: BuildKey
  /** Default: this build's {@link LIST_COMPILER_VERSION}. */
  compilerVersion?: string
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads only the header line (no body hashing): which list, content and compiler built it. */
export function peekArtifact(
  text: string,
): { compilerVersion: string; listId: string; contentSha256: string } | null {
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  try {
    const h = JSON.parse(text.slice(0, nl)) as unknown
    if (!isObj(h) || h.magic !== ARTIFACT_MAGIC) return null
    if (typeof h.compilerVersion !== 'string' || typeof h.listId !== 'string') return null
    if (typeof h.contentSha256 !== 'string') return null
    return { compilerVersion: h.compilerVersion, listId: h.listId, contentSha256: h.contentSha256 }
  } catch {
    return null
  }
}

/** Parses and verifies an artifact. Never throws. */
export function decodeArtifact(text: string, expect: DecodeExpect): DecodeResult {
  const nl = text.indexOf('\n')
  if (nl < 0) return { ok: false, reason: 'corrupt' }
  let header: unknown
  try {
    header = JSON.parse(text.slice(0, nl))
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  if (!isObj(header) || header.magic !== ARTIFACT_MAGIC) return { ok: false, reason: 'corrupt' }
  if (header.compilerVersion !== (expect.compilerVersion ?? LIST_COMPILER_VERSION))
    return { ok: false, reason: 'compiler_version' }
  if (header.listId !== expect.listId) return { ok: false, reason: 'other_list' }
  const want = expect.build
  if (want !== undefined) {
    if (header.contentSha256 !== want.contentSha256) return { ok: false, reason: 'other_content' }
    if (header.kind !== want.kind || header.requestedFormat !== want.requestedFormat)
      return { ok: false, reason: 'other_options' }
  }
  const body = text.slice(nl + 1)
  if (typeof header.bodySha256 !== 'string' || sha256(body) !== header.bodySha256)
    return { ok: false, reason: 'checksum' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'corrupt' }
  }
  const artifact = toArtifact(parsed, expect.listId, String(header.contentSha256))
  return artifact === null ? { ok: false, reason: 'corrupt' } : { ok: true, artifact }
}

function toArtifact(parsed: unknown, listId: string, content: string): ListArtifact | null {
  if (!isObj(parsed) || !isObj(parsed.meta) || !Array.isArray(parsed.rules) || !Array.isArray(parsed.cancel))
    return null
  const meta = parsed.meta
  if (meta.listId !== listId || meta.contentSha256 !== content) return null
  if (typeof meta.kind !== 'string' || !LIST_KINDS.has(meta.kind)) return null
  if (typeof meta.format !== 'string' || !isObj(meta.stats) || !isObj(meta.header)) return null
  const prefix = `l_${listId}_`
  const rules: Rule[] = []
  for (let i = 0; i < parsed.rules.length; i++) {
    const t = parsed.rules[i] as unknown
    if (!Array.isArray(t) || t.length !== 6) return null
    const [id, match, kind, action, weight, flags] = t as unknown[]
    const matchKind = KINDS[kind as number]
    const act = ACTIONS[action as number]
    if (typeof id !== 'string' || typeof match !== 'string' || matchKind === undefined || act === undefined)
      return null
    if (typeof weight !== 'number' || (flags !== 0 && flags !== 1)) return null
    const rule: Rule = {
      id: id.startsWith('!') ? id.slice(1) : `${prefix}${id}`,
      scope: 'list',
      match,
      matchKind,
      action: act,
      weight,
      important: false,
      listId,
      order: i,
    }
    if (flags === 1) rule.listImportant = true
    rules.push(rule)
  }
  const cancel: CancelEntry[] = []
  for (const t of parsed.cancel as unknown[]) {
    if (!Array.isArray(t) || t.length !== 3) return null
    const [match, action, imp] = t as unknown[]
    const act = ACTIONS[action as number]
    if (typeof match !== 'string' || act === undefined) return null
    const c: CancelEntry = { match, action: act }
    if (imp === 1) c.listImportant = true
    cancel.push(c)
  }
  const out: ListArtifact = {
    listId,
    kind: meta.kind as ListKind,
    format: meta.format as ImportFormat,
    requestedFormat: (typeof meta.requestedFormat === 'string' ? meta.requestedFormat : 'auto') as ListFormat,
    contentSha256: content,
    compilerVersion: String(meta.compilerVersion),
    builtAt: typeof meta.builtAt === 'string' ? meta.builtAt : '',
    stats: meta.stats as unknown as ImportStats,
    skipReasons: isObj(meta.skipReasons) ? (meta.skipReasons as Record<string, number>) : {},
    skippedSample: Array.isArray(meta.skippedSample) ? (meta.skippedSample as SkippedEntry[]) : [],
    warnings: Array.isArray(meta.warnings)
      ? meta.warnings.filter((w): w is string => typeof w === 'string')
      : [],
    header: meta.header as ListHeader,
    rules,
    cancel,
  }
  if (meta.allowlistMode === true) out.allowlistMode = true
  if (meta.truncated === true) out.truncated = true
  return out
}

/** The artifact of a fresh import, without a round trip through JSON. */
export function artifactOf(
  imported: ImportResult,
  o: { contentSha256: string; requestedFormat: ListFormat; builtAt: string },
): ListArtifact {
  const out: ListArtifact = {
    listId: imported.listId,
    kind: imported.kind,
    format: imported.format,
    requestedFormat: o.requestedFormat,
    contentSha256: o.contentSha256,
    compilerVersion: LIST_COMPILER_VERSION,
    builtAt: o.builtAt,
    stats: imported.stats,
    skipReasons: imported.skipReasons,
    skippedSample: imported.skipped.slice(0, SKIPPED_IN_ARTIFACT),
    warnings: imported.warnings,
    header: imported.header,
    rules: imported.rules,
    cancel: imported.cancel,
  }
  if (imported.allowlistMode === true) out.allowlistMode = true
  if (imported.truncated === true) out.truncated = true
  return out
}

/** The engine's view of an artifact in the given mode. */
export function artifactToListInput(a: ListArtifact, mode: ListMode): ListInput {
  return { id: a.listId, kind: a.kind, mode, rules: a.rules, cancel: a.cancel }
}
