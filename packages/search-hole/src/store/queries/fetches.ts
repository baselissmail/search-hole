// SPDX-License-Identifier: Apache-2.0
/**
 * Queries for `fetches` (metadata and dates only; page text is never stored, ADR-0015) and
 * the receipt counter they bump.
 */
import { z } from 'zod'
import type { Db } from '../driver.ts'
import type { FetchRow, FetchWrite, StoredDate } from '../types.ts'

const MAX_TITLE = 500
const MAX_URL = 2048
const MAX_TEXT = 200

const fetchRow = z.object({
  id: z.number().int(),
  receipt_id: z.string(),
  session_id: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  url_hash: z.string(),
  final_url_hash: z.string().nullable(),
  // Added by migration 0002; absent on rows read through an older select list.
  url: z.string().nullable().optional(),
  final_url: z.string().nullable().optional(),
  host: z.string().nullable(),
  registrable_domain: z.string().nullable(),
  status: z.number().int().nullable(),
  content_type: z.string().nullable(),
  bytes: z.number().int().nullable(),
  title: z.string().nullable(),
  decision: z.string().nullable(),
  reason: z.string().nullable(),
  rule_id: z.string().nullable(),
  dates_json: z.string().nullable(),
  effective_date: z.string().nullable(),
  effective_kind: z.string().nullable(),
  effective_confidence: z.string().nullable(),
  latency_ms: z.number().int().nullable(),
  created_at: z.number(),
})

const dateJson = z.array(
  z.object({
    value: z.string(),
    kind: z.string(),
    method: z.string(),
    confidence: z.string(),
    tzAssumed: z.boolean().default(false),
  }),
)

const clip = (s: string | undefined, max: number): string | null =>
  s === undefined ? null : s.length > max ? s.slice(0, max) : s

/** Inserts one fetch row and bumps (or creates) its receipt. Call inside a write transaction. */
export function insertFetch(db: Db, w: FetchWrite, now: number): number {
  const id = db
    .prepare(
      `INSERT INTO fetches (receipt_id, session_id, tool_use_id, url_hash, final_url_hash, url, final_url, host,
                            registrable_domain, status, content_type, bytes, title, decision, reason, rule_id,
                            dates_json, effective_date, effective_kind, effective_confidence, latency_ms, created_at)
       VALUES ($receiptId, $sessionId, $toolUseId, $urlHash, $finalUrlHash, $url, $finalUrl, $host, $domain, $status,
               $contentType, $bytes, $title, $decision, $reason, $ruleId, $dates, $effDate, $effKind, $effConfidence,
               $latency, $now)`,
    )
    .run({
      receiptId: w.receiptId,
      sessionId: w.sessionId ?? null,
      toolUseId: w.toolUseId ?? null,
      urlHash: w.urlHash,
      finalUrlHash: w.finalUrlHash ?? null,
      url: clip(w.url, MAX_URL),
      finalUrl: clip(w.finalUrl, MAX_URL),
      host: clip(w.host, 253),
      domain: clip(w.registrableDomain, 253),
      status: w.status ?? null,
      contentType: clip(w.contentType, MAX_TEXT),
      bytes: w.bytes ?? null,
      title: clip(w.title, MAX_TITLE),
      decision: w.decision,
      reason: clip(w.reason, MAX_TEXT),
      ruleId: clip(w.ruleId, MAX_TEXT),
      dates: w.dates === undefined ? null : JSON.stringify(w.dates),
      effDate: w.effectiveDate?.value ?? null,
      effKind: w.effectiveDate?.kind ?? null,
      effConfidence: w.effectiveDate?.confidence ?? null,
      latency: w.latencyMs === undefined ? null : Math.max(0, Math.round(w.latencyMs)),
      now,
    }).lastInsertRowid
  db.prepare(
    `INSERT INTO receipts (id, session_id, created_at, updated_at, fetch_count)
     VALUES ($id, $sessionId, $now, $now, 1)
     ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, fetch_count = fetch_count + 1,
                                    session_id = COALESCE(receipts.session_id, excluded.session_id)`,
  ).run({ id: w.receiptId, sessionId: w.sessionId ?? null, now })
  return id
}

/** Every fetch of a receipt, oldest first. */
export function listFetchesByReceipt(db: Db, receiptId: string): FetchRow[] {
  return db
    .prepare('SELECT * FROM fetches WHERE receipt_id = ? ORDER BY id ASC')
    .all([receiptId])
    .map((raw) => {
      const r = fetchRow.parse(raw)
      let dates: StoredDate[] = []
      if (r.dates_json !== null) {
        try {
          const parsed = dateJson.safeParse(JSON.parse(r.dates_json))
          if (parsed.success) dates = parsed.data
        } catch {
          dates = []
        }
      }
      return {
        id: r.id,
        receiptId: r.receipt_id,
        sessionId: r.session_id,
        toolUseId: r.tool_use_id,
        urlHash: r.url_hash,
        finalUrlHash: r.final_url_hash,
        url: r.url ?? null,
        finalUrl: r.final_url ?? null,
        host: r.host,
        registrableDomain: r.registrable_domain,
        status: r.status,
        contentType: r.content_type,
        bytes: r.bytes,
        title: r.title,
        decision: r.decision,
        reason: r.reason,
        ruleId: r.rule_id,
        dates,
        effectiveDate: r.effective_date,
        latencyMs: r.latency_ms,
        createdAt: r.created_at,
      }
    })
}
