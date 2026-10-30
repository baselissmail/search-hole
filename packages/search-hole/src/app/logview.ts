// SPDX-License-Identifier: Apache-2.0
/** The search log as the CLI shows it (`searchhole log`, `log <id>`). Read-only. */
import {
  type Depth,
  ENGINE_ID_LIST,
  type EngineId,
  type HiddenReason,
  type SourceType,
  type Tier,
} from '../shared/types.ts'
import { BUILTIN_ENGINE, type SearchLogRow, type Store } from '../store/index.ts'
import type { LogDetail, LogEntry } from './types.ts'

const ENGINES: ReadonlySet<string> = new Set<string>(ENGINE_ID_LIST)
const DEPTHS: readonly Depth[] = ['quick', 'standard', 'deep']
const REASONS: readonly HiddenReason[] = ['rule', 'list', 'stale', 'date_required', 'allowlist_mode']
const TIERS: readonly Tier[] = ['T0s', 'T0g', 'T1', 'T2', 'T3', 'T4']
const SOURCE_TYPES: readonly SourceType[] = [
  'official',
  'docs',
  'forum',
  'news',
  'blog',
  'repo',
  'reference',
  'content_farm',
  'unknown',
]

const pick = <T extends string>(values: readonly T[], v: string | null | undefined): T | undefined =>
  values.find((x) => x === v)

function entryOf(row: SearchLogRow): LogEntry {
  const entry: LogEntry = {
    searchId: row.id,
    receiptId: row.receiptId,
    at: new Date(row.createdAt).toISOString(),
    query: row.queryRedacted,
    profile: row.profile,
    depth: pick(DEPTHS, row.depth) ?? 'standard',
    mode: row.mode,
    engines: row.engines
      .filter((e) => e.status !== 'skipped' && ENGINES.has(e.engine))
      .map((e) => e.engine as EngineId),
    kept: row.keptCount,
    hidden: row.hiddenCount,
    latencyMs: row.latencyMs,
  }
  if (row.clientName !== null) entry.client = row.clientName
  return entry
}

/** Newest searches first. */
export function recentLog(
  store: Store | null,
  opts: { limit?: number; hiddenOnly?: boolean } = {},
): LogEntry[] {
  if (!store) return []
  return store.searchLog
    .recent({ limit: opts.limit ?? 20, hiddenOnly: opts.hiddenOnly === true })
    .map(entryOf)
}

/** One search with its results (kept in output order, then hidden by raw rank). */
export function logDetail(store: Store | null, searchId: number): LogDetail | undefined {
  if (!store) return undefined
  const row = store.searchLog.get(searchId)
  if (!row) return undefined
  const results: LogDetail['results'] = []
  for (const r of store.listResults(searchId)) {
    const engine: EngineId | 'builtin' | undefined =
      r.engine === BUILTIN_ENGINE ? 'builtin' : ENGINES.has(r.engine) ? (r.engine as EngineId) : undefined
    if (engine === undefined) continue
    const payload = r.payloads[0]
    const hidden = r.decision === 'hidden'
    const item: LogDetail['results'][number] = {
      rank: hidden ? r.rawRank : (r.outRank ?? r.rawRank),
      engine,
      domain: r.registrableDomain,
      decision: hidden ? 'hidden' : r.flags.includes('pinned') ? 'pinned' : 'kept',
    }
    const url = payload?.url ?? (r.canonicalKey === null ? undefined : `https:${r.canonicalKey}`)
    if (url !== undefined) item.url = url
    if (payload?.title) item.title = payload.title
    const reason = pick(REASONS, r.reason)
    if (hidden && reason !== undefined) item.reason = reason
    const tier = pick(TIERS, r.tier)
    if (r.ruleId !== null && tier !== undefined && r.ruleText !== null) {
      item.rule = { ruleId: r.ruleId, tier, text: r.ruleText }
    }
    const st = pick(SOURCE_TYPES, r.sourceType)
    if (st !== undefined) item.sourceType = st
    results.push(item)
  }
  results.sort((a, b) => {
    const ah = a.decision === 'hidden' ? 1 : 0
    const bh = b.decision === 'hidden' ? 1 : 0
    return ah - bh || a.rank - b.rank
  })
  return { ...entryOf(row), results }
}
