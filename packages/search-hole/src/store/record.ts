// SPDX-License-Identifier: Apache-2.0
/**
 * Turns a search outcome into rows (pure, deterministic). This is where each engine's
 * retention policy is enforced (ADR-0009 point 9): a `decisions-only` engine contributes a
 * URL hash, domain, rank and decision, never title, snippet or URL. The writer in
 * queries/searches.ts only inserts what this plan contains.
 */
import { createHash } from 'node:crypto'
import { canonicalKey, hostOf, registrableDomain } from '../core/url.ts'
import type { EngineId, EngineRetention, MergedResult, RuleRef } from '../shared/types.ts'
import { BUILTIN_ENGINE } from './queries/log.ts'
import type { RecordBuiltinInput, RecordedResult, RecordSearchInput } from './types.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const DEFAULT_RETENTION_DAYS = 90

// Defensive caps: adapters bound these already, the store never trusts that.
const MAX_QUERY = 2000
const MAX_TITLE = 500
const MAX_SNIPPET = 2000
const MAX_URL = 2048
const MAX_RULE_TEXT = 1000
const MAX_DOMAIN = 253

export interface PayloadRow {
  readonly engine: string
  readonly title: string
  readonly snippet: string
  readonly url: string
  readonly expiresAt: number
}

export interface ResultRow {
  readonly engine: string
  readonly rawRank: number
  readonly positionsJson: string
  readonly canonicalKey: string | null
  readonly urlHash: string
  readonly registrableDomain: string
  readonly decision: string
  readonly reason: string | null
  readonly ruleId: string | null
  readonly tier: string | null
  readonly listId: string | null
  readonly ruleText: string | null
  /** The audit-mode list that would have hidden this kept result (ADR-0022 contribution). */
  readonly auditListId: string | null
  readonly flagsJson: string
  readonly sourceType: string
  readonly datesJson: string
  readonly effectiveDate: string | null
  readonly effectiveKind: string | null
  readonly effectiveConfidence: string | null
  readonly outRank: number | null
  readonly fused: number
  readonly adjusted: number
  readonly payloads: readonly PayloadRow[]
}

export interface SearchRow {
  readonly receiptId: string
  readonly sessionId: string | null
  readonly queryRedacted: string
  readonly profile: string
  readonly depth: string
  readonly enginesJson: string
  readonly latencyMs: number
  readonly keptCount: number
  readonly hiddenCount: number
  readonly pushedRuleIdsJson: string | null
  readonly toolUseId: string | null
  readonly createdAt: number
}

export interface StatsRow {
  readonly engine: string
  readonly searches: number
  readonly resultsReturned: number
  readonly kept: number
  readonly hidden: number
  readonly errors: number
  readonly latencyMsTotal: number
}

export interface RecordPlan {
  readonly search: SearchRow
  readonly results: readonly ResultRow[]
  /** UTC `YYYY-MM-DD` of `createdAt`. */
  readonly day: string
  readonly stats: readonly StatsRow[]
}

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

/** Hex SHA-256 of a normalized URL (the canonical key), the only URL trace of decisions-only engines. */
export function urlHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex')
}

function primaryEngine(m: MergedResult): { engine: string; rank: number } {
  let best: { engine: string; rank: number } | undefined
  for (const [engine, rank] of Object.entries(m.positions)) {
    if (typeof rank !== 'number') continue
    const better =
      best === undefined ||
      rank < best.rank ||
      (rank === best.rank &&
        m.engines.indexOf(engine as EngineId) < m.engines.indexOf(best.engine as EngineId))
    if (better) best = { engine, rank }
  }
  return best ?? { engine: m.engines[0] ?? 'unknown', rank: 0 }
}

function deciding(m: MergedResult): RuleRef | undefined {
  const d = m.decision
  return d.visibilityRule ?? d.pin?.rule ?? d.weight.rule
}

function payloadExpiry(policy: EngineRetention, createdAt: number, capDays: number): number | undefined {
  const cap = capDays * DAY_MS
  const ttl = policy.payloadTtlHours === null ? cap : Math.min(policy.payloadTtlHours * HOUR_MS, cap)
  return ttl > 0 ? createdAt + ttl : undefined
}

function buildResult(
  r: RecordedResult,
  retention: RecordSearchInput['retention'],
  createdAt: number,
  capDays: number,
): ResultRow {
  const m = r.merged
  const { engine, rank } = primaryEngine(m)
  const groupEngines = new Set<string>([...m.engines, ...r.hits.map((h) => h.engine)])
  // The URL itself is stored only when no engine in the group restricts it.
  const urlStorable =
    groupEngines.size > 0 &&
    [...groupEngines].every((e) => {
      const policy = retention[e as EngineId]
      return policy !== undefined && policy.log !== 'decisions-only'
    })
  const payloads: PayloadRow[] = []
  const seen = new Set<string>()
  for (const hit of r.hits) {
    if (seen.has(hit.engine)) continue
    seen.add(hit.engine)
    const policy = retention[hit.engine]
    if (policy === undefined || policy.log === 'decisions-only') continue
    const expiresAt = payloadExpiry(policy, createdAt, capDays)
    if (expiresAt === undefined) continue
    payloads.push({
      engine: hit.engine,
      title: clip(hit.title, MAX_TITLE),
      snippet: clip(hit.snippet, MAX_SNIPPET),
      url: clip(hit.url, MAX_URL),
      expiresAt,
    })
  }
  const rule = deciding(m)
  const hidden = r.visibility === 'hidden'
  const audit = m.decision.audit
  const eff = m.effectiveDate
  return {
    engine,
    rawRank: rank,
    positionsJson: JSON.stringify(m.positions),
    canonicalKey: urlStorable ? clip(m.canonicalKey, MAX_URL) : null,
    urlHash: urlHash(m.canonicalKey || m.url),
    registrableDomain: clip(m.registrableDomain, MAX_DOMAIN),
    decision: r.visibility,
    reason: hidden && r.reason !== undefined ? r.reason : null,
    ruleId: rule?.ruleId ?? null,
    tier: rule?.tier ?? null,
    listId: rule?.listId ?? null,
    ruleText: rule === undefined ? null : clip(rule.text, MAX_RULE_TEXT),
    auditListId: !hidden && audit?.wouldBe === 'hidden' ? (audit.rule.listId ?? null) : null,
    flagsJson: JSON.stringify(m.flags),
    sourceType: m.sourceType,
    datesJson: JSON.stringify(m.dates),
    effectiveDate: eff?.value ?? null,
    effectiveKind: eff?.kind ?? null,
    effectiveConfidence: eff?.confidence ?? null,
    outRank: hidden ? null : (r.outRank ?? null),
    fused: Number.isFinite(m.fused) ? m.fused : 0,
    adjusted: Number.isFinite(m.adjusted) ? m.adjusted : 0,
    payloads,
  }
}

function buildStats(input: RecordSearchInput): StatsRow[] {
  const rows: StatsRow[] = []
  let errors = 0
  for (const run of input.engines) {
    if (run.status === 'skipped') continue
    const failed = run.status === 'error' ? 1 : 0
    errors += failed
    rows.push({
      engine: run.engine,
      searches: 1,
      resultsReturned: run.returned,
      kept: 0,
      hidden: 0,
      errors: failed,
      latencyMsTotal: run.latencyMs ?? 0,
    })
  }
  rows.push({
    engine: '*',
    searches: 1,
    resultsReturned: input.keptCount + input.hiddenCount,
    kept: input.keptCount,
    hidden: input.hiddenCount,
    errors,
    latencyMsTotal: input.latencyMs,
  })
  return rows
}

/** Builds the rows for one search. Pure: the same input and `createdAt` give the same plan. */
export function planRecord(input: RecordSearchInput, createdAt: number): RecordPlan {
  const capDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS
  return {
    search: {
      receiptId: input.receiptId,
      sessionId: input.sessionId ?? null,
      queryRedacted: clip(input.queryRedacted, MAX_QUERY),
      profile: input.profile,
      depth: input.depth,
      enginesJson: JSON.stringify(input.engines),
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      keptCount: input.keptCount,
      hiddenCount: input.hiddenCount,
      pushedRuleIdsJson: input.pushedRuleIds === undefined ? null : JSON.stringify(input.pushedRuleIds),
      toolUseId: input.toolUseId ?? null,
      createdAt,
    },
    results: input.results.map((r) => buildResult(r, input.retention, createdAt, capDays)),
    day: new Date(createdAt).toISOString().slice(0, 10),
    stats: buildStats(input),
  }
}

/**
 * Builds the rows for one built-in WebSearch (ADR-0018). Stored like a decisions-only
 * engine: URL hash, registrable domain, ranks, decision and rule; never title or URL. The
 * single engine run `builtin` marks the search's mode.
 */
export function planBuiltinRecord(input: RecordBuiltinInput, createdAt: number): RecordPlan {
  let kept = 0
  let hidden = 0
  // Built-in results are the user's own Claude Code session data, already on this machine: keep
  // title and URL for the local log under normal retention (ADR-0018 amendment, 2026-10-31).
  const capDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS
  const expiresAt = capDays > 0 ? createdAt + capDays * 24 * HOUR_MS : undefined
  const results: ResultRow[] = input.results.map((r) => {
    const isHidden = r.visibility === 'hidden'
    if (isHidden) hidden++
    else kept++
    const key = canonicalKey(r.url)
    const host = hostOf(r.url) ?? ''
    const rule = r.rule
    const rank = Number.isFinite(r.rank) && r.rank >= 1 ? Math.floor(r.rank) : 0
    return {
      engine: BUILTIN_ENGINE,
      rawRank: rank,
      positionsJson: JSON.stringify({ [BUILTIN_ENGINE]: rank }),
      canonicalKey: key === null || key === undefined ? null : clip(key, MAX_URL),
      urlHash: urlHash(key ?? r.url),
      registrableDomain: clip(host === '' ? '' : registrableDomain(host), MAX_DOMAIN),
      decision: r.visibility,
      reason: isHidden && r.reason !== undefined ? r.reason : null,
      ruleId: rule?.ruleId ?? null,
      tier: rule?.tier ?? null,
      listId: rule?.listId ?? null,
      ruleText: rule === undefined ? null : clip(rule.text, MAX_RULE_TEXT),
      auditListId: isHidden ? null : (r.auditRule?.listId ?? null),
      flagsJson: JSON.stringify(r.flags),
      sourceType: r.sourceType,
      datesJson: '[]',
      effectiveDate: null,
      effectiveKind: null,
      effectiveConfidence: null,
      outRank: isHidden ? null : (r.outRank ?? null),
      fused: 0,
      adjusted: 0,
      payloads:
        expiresAt === undefined
          ? []
          : [
              {
                engine: BUILTIN_ENGINE,
                title: clip(r.title ?? '', MAX_TITLE),
                snippet: '',
                url: clip(r.url, MAX_URL),
                expiresAt,
              },
            ],
    }
  })
  const latencyMs = Math.max(0, Math.round(input.latencyMs))
  return {
    search: {
      receiptId: input.receiptId,
      sessionId: input.sessionId ?? null,
      queryRedacted: clip(input.queryRedacted, MAX_QUERY),
      profile: input.profile,
      depth: 'standard',
      enginesJson: JSON.stringify([
        { engine: BUILTIN_ENGINE, status: 'ok', returned: input.results.length, latencyMs },
      ]),
      latencyMs,
      keptCount: kept,
      hiddenCount: hidden,
      pushedRuleIdsJson: null,
      toolUseId: input.toolUseId ?? null,
      createdAt,
    },
    results,
    day: new Date(createdAt).toISOString().slice(0, 10),
    stats: [
      {
        engine: BUILTIN_ENGINE,
        searches: 1,
        resultsReturned: input.results.length,
        kept: 0,
        hidden: 0,
        errors: 0,
        latencyMsTotal: latencyMs,
      },
      {
        engine: '*',
        searches: 1,
        resultsReturned: input.results.length,
        kept,
        hidden,
        errors: 0,
        latencyMsTotal: latencyMs,
      },
    ],
  }
}
