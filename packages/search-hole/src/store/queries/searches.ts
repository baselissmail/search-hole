// SPDX-License-Identifier: Apache-2.0
/** Queries for `searches`, `results`, `result_payloads`, `receipts` and `daily_stats`. */
import { z } from 'zod'
import type { Db } from '../driver.ts'
import type { RecordPlan } from '../record.ts'
import type { SearchSummary, StoredDate, StoredEngineRun, StoredResult } from '../types.ts'

const INSERT_SEARCH = `
INSERT INTO searches (receipt_id, session_id, query_redacted, profile, depth, engines_json, latency_ms,
                      kept_count, hidden_count, pushed_rule_ids_json, tool_use_id, created_at)
VALUES ($receiptId, $sessionId, $query, $profile, $depth, $engines, $latency,
        $kept, $hidden, $pushed, $toolUseId, $createdAt)`

const INSERT_RESULT = `
INSERT INTO results (search_id, engine, raw_rank, positions_json, canonical_key, url_hash, registrable_domain,
                     decision, reason, rule_id, tier, list_id, rule_text, flags_json, source_type, dates_json,
                     effective_date, effective_kind, effective_confidence, out_rank, fused, adjusted, created_at)
VALUES ($searchId, $engine, $rawRank, $positions, $canonicalKey, $urlHash, $domain,
        $decision, $reason, $ruleId, $tier, $listId, $ruleText, $flags, $sourceType, $dates,
        $effDate, $effKind, $effConfidence, $outRank, $fused, $adjusted, $createdAt)`

const INSERT_PAYLOAD = `
INSERT INTO result_payloads (result_id, engine, title, snippet, url, expires_at)
VALUES ($resultId, $engine, $title, $snippet, $url, $expiresAt)`

const UPSERT_RECEIPT = `
INSERT INTO receipts (id, session_id, created_at, updated_at, search_count)
VALUES ($id, $sessionId, $now, $now, 1)
ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at,
                               search_count = search_count + 1,
                               session_id = COALESCE(receipts.session_id, excluded.session_id)`

const UPSERT_STATS = `
INSERT INTO daily_stats (day, engine, searches, results_returned, kept, hidden, errors, latency_ms_total)
VALUES ($day, $engine, $searches, $returned, $kept, $hidden, $errors, $latency)
ON CONFLICT (day, engine) DO UPDATE SET
  searches = searches + excluded.searches,
  results_returned = results_returned + excluded.results_returned,
  kept = kept + excluded.kept,
  hidden = hidden + excluded.hidden,
  errors = errors + excluded.errors,
  latency_ms_total = latency_ms_total + excluded.latency_ms_total`

/** Inserts a planned search with its results, payloads, receipt and rollups. Call inside a write transaction. */
export function writePlan(db: Db, plan: RecordPlan): number {
  const s = plan.search
  const searchId = db.prepare(INSERT_SEARCH).run({
    receiptId: s.receiptId,
    sessionId: s.sessionId,
    query: s.queryRedacted,
    profile: s.profile,
    depth: s.depth,
    engines: s.enginesJson,
    latency: s.latencyMs,
    kept: s.keptCount,
    hidden: s.hiddenCount,
    pushed: s.pushedRuleIdsJson,
    toolUseId: s.toolUseId,
    createdAt: s.createdAt,
  }).lastInsertRowid
  const insertResult = db.prepare(INSERT_RESULT)
  const insertPayload = db.prepare(INSERT_PAYLOAD)
  for (const r of plan.results) {
    const resultId = insertResult.run({
      searchId,
      engine: r.engine,
      rawRank: r.rawRank,
      positions: r.positionsJson,
      canonicalKey: r.canonicalKey,
      urlHash: r.urlHash,
      domain: r.registrableDomain,
      decision: r.decision,
      reason: r.reason,
      ruleId: r.ruleId,
      tier: r.tier,
      listId: r.listId,
      ruleText: r.ruleText,
      flags: r.flagsJson,
      sourceType: r.sourceType,
      dates: r.datesJson,
      effDate: r.effectiveDate,
      effKind: r.effectiveKind,
      effConfidence: r.effectiveConfidence,
      outRank: r.outRank,
      fused: r.fused,
      adjusted: r.adjusted,
      createdAt: s.createdAt,
    }).lastInsertRowid
    for (const p of r.payloads) {
      insertPayload.run({
        resultId,
        engine: p.engine,
        title: p.title,
        snippet: p.snippet,
        url: p.url,
        expiresAt: p.expiresAt,
      })
    }
  }
  db.prepare(UPSERT_RECEIPT).run({ id: s.receiptId, sessionId: s.sessionId, now: s.createdAt })
  const upsertStats = db.prepare(UPSERT_STATS)
  for (const st of plan.stats) {
    upsertStats.run({
      day: plan.day,
      engine: st.engine,
      searches: st.searches,
      returned: st.resultsReturned,
      kept: st.kept,
      hidden: st.hidden,
      errors: st.errors,
      latency: st.latencyMsTotal,
    })
  }
  return searchId
}

// ── Reads ────────────────────────────────────────────────────────────────

const searchRow = z.object({
  id: z.number().int(),
  receipt_id: z.string(),
  session_id: z.string().nullable(),
  query_redacted: z.string(),
  profile: z.string(),
  depth: z.string(),
  engines_json: z.string(),
  latency_ms: z.number(),
  kept_count: z.number().int(),
  hidden_count: z.number().int(),
  pushed_rule_ids_json: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  created_at: z.number(),
})

const engineRunJson = z.array(
  z.object({
    engine: z.string(),
    status: z.string(),
    returned: z.number().default(0),
    latencyMs: z.number().optional(),
    errorClass: z.string().optional(),
    inactiveReason: z.string().optional(),
    detail: z.string().optional(),
    pushedRuleCount: z.number().optional(),
  }),
)

const dateJson = z.array(
  z.object({
    value: z.string(),
    kind: z.string(),
    method: z.string(),
    confidence: z.string(),
    tzAssumed: z.boolean().default(false),
  }),
)

const resultRow = z.object({
  id: z.number().int(),
  search_id: z.number().int(),
  engine: z.string(),
  raw_rank: z.number().int(),
  positions_json: z.string(),
  canonical_key: z.string().nullable(),
  url_hash: z.string(),
  registrable_domain: z.string(),
  decision: z.string(),
  reason: z.string().nullable(),
  rule_id: z.string().nullable(),
  tier: z.string().nullable(),
  list_id: z.string().nullable(),
  rule_text: z.string().nullable(),
  flags_json: z.string(),
  source_type: z.string(),
  dates_json: z.string(),
  effective_date: z.string().nullable(),
  effective_kind: z.string().nullable(),
  effective_confidence: z.string().nullable(),
  out_rank: z.number().int().nullable(),
  fused: z.number().nullable(),
  adjusted: z.number().nullable(),
  created_at: z.number(),
})

const payloadRow = z.object({
  result_id: z.number().int(),
  engine: z.string(),
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
  expires_at: z.number(),
})

/** Parses a JSON column; a corrupt or unexpected value reads as the fallback, never throws. */
function parseJson<T>(text: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (text === null) return fallback
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

/** Column list of `searches` as this version reads it. */
export const SEARCH_COLUMNS = `id, receipt_id, session_id, query_redacted, profile, depth, engines_json, latency_ms,
  kept_count, hidden_count, pushed_rule_ids_json, tool_use_id, created_at`

/** Parses one `searches` row (tolerant JSON columns). */
export function toSummary(raw: unknown): SearchSummary {
  const r = searchRow.parse(raw)
  const engines: StoredEngineRun[] = parseJson(r.engines_json, engineRunJson, []).map((e) => ({
    engine: e.engine,
    status: e.status,
    returned: e.returned,
    ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
    ...(e.errorClass !== undefined ? { errorClass: e.errorClass } : {}),
    ...(e.inactiveReason !== undefined ? { inactiveReason: e.inactiveReason } : {}),
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
    ...(e.pushedRuleCount !== undefined ? { pushedRuleCount: e.pushedRuleCount } : {}),
  }))
  return {
    id: r.id,
    receiptId: r.receipt_id,
    sessionId: r.session_id,
    queryRedacted: r.query_redacted,
    profile: r.profile,
    depth: r.depth,
    engines,
    latencyMs: r.latency_ms,
    keptCount: r.kept_count,
    hiddenCount: r.hidden_count,
    pushedRuleIds: parseJson(r.pushed_rule_ids_json, z.array(z.string()), []),
    toolUseId: r.tool_use_id,
    createdAt: r.created_at,
  }
}

/** One search by id. */
export function getSearch(db: Db, id: number): SearchSummary | undefined {
  const raw = db.prepare(`SELECT ${SEARCH_COLUMNS} FROM searches WHERE id = ?`).get([id])
  return raw === undefined ? undefined : toSummary(raw)
}

/** Searches with `id > afterId`, ascending, at most `limit` (the dashboard tail). */
export function listSearchesAfter(db: Db, afterId: number, limit: number): SearchSummary[] {
  const rows = db
    .prepare(`SELECT ${SEARCH_COLUMNS} FROM searches WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all([afterId, limit])
  return rows.map(toSummary)
}

/** `MAX(searches.id)`, or 0 when empty. */
export function maxSearchId(db: Db): number {
  const row = db.prepare<{ max_id: number | null }>('SELECT MAX(id) AS max_id FROM searches').get()
  return row?.max_id ?? 0
}

/** A search's results with their unexpired payloads. */
export function listResults(db: Db, searchId: number, now: number): StoredResult[] {
  const rows = db
    .prepare('SELECT * FROM results WHERE search_id = ? ORDER BY id ASC')
    .all([searchId])
    .map((r) => resultRow.parse(r))
  const payloads = new Map<number, StoredResult['payloads'][number][]>()
  const payloadRows = db
    .prepare(
      `SELECT p.result_id, p.engine, p.title, p.snippet, p.url, p.expires_at
         FROM result_payloads p JOIN results r ON r.id = p.result_id
        WHERE r.search_id = ? AND p.expires_at > ? ORDER BY p.id ASC`,
    )
    .all([searchId, now])
    .map((r) => payloadRow.parse(r))
  for (const p of payloadRows) {
    const list = payloads.get(p.result_id) ?? []
    list.push({ engine: p.engine, title: p.title, snippet: p.snippet, url: p.url, expiresAt: p.expires_at })
    payloads.set(p.result_id, list)
  }
  return rows.map((r) => ({
    id: r.id,
    searchId: r.search_id,
    engine: r.engine,
    rawRank: r.raw_rank,
    positions: parseJson(r.positions_json, z.record(z.string(), z.number()), {}),
    canonicalKey: r.canonical_key,
    urlHash: r.url_hash,
    registrableDomain: r.registrable_domain,
    decision: r.decision,
    reason: r.reason,
    ruleId: r.rule_id,
    tier: r.tier,
    listId: r.list_id,
    ruleText: r.rule_text,
    flags: parseJson(r.flags_json, z.array(z.string()), []),
    sourceType: r.source_type,
    dates: parseJson<StoredDate[]>(r.dates_json, dateJson, []),
    effectiveDate: r.effective_date,
    effectiveKind: r.effective_kind,
    effectiveConfidence: r.effective_confidence,
    outRank: r.out_rank,
    fused: r.fused,
    adjusted: r.adjusted,
    createdAt: r.created_at,
    payloads: payloads.get(r.id) ?? [],
  }))
}
