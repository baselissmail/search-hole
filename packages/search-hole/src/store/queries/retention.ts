// SPDX-License-Identifier: Apache-2.0
/**
 * Retention deletes (ADR-0015 point 3). Each step is one bounded DELETE; the store runs
 * them repeatedly, each batch in its own transaction, until a batch deletes fewer rows than
 * the batch size. Children go before parents so no single statement cascades into a huge delete.
 */
import type { RetentionSettings } from '../types.ts'
import { dayOf } from './usage.ts'

const DAY_MS = 86_400_000

export interface PruneStep {
  /** Reported under this name. */
  readonly table: string
  readonly sql: string
  /** Named parameters; must match the SQL exactly. */
  readonly params: Readonly<Record<string, number | string>>
  /** Repeat until a batch deletes less than `batchSize` rows. False for small tables. */
  readonly batched: boolean
}

export const DEFAULTS = {
  dailyStatsDays: 400,
  resolvedSuggestionDays: 30,
  gatewayDays: 7,
  batchSize: 10_000,
} as const

function previousMonth(ms: number): string {
  const d = new Date(ms)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
}

/**
 * The delete steps for a prune at `now`. Rows with a timestamp at or before the cutoff are
 * deleted, so `days: 0` deletes everything that exists (the "delete all data" job).
 */
export function pruneSteps(now: number, s: RetentionSettings): PruneStep[] {
  const batch = s.batchSize ?? DEFAULTS.batchSize
  const cutoff = now - s.days * DAY_MS
  const statsDay = dayOf(now - (s.dailyStatsDays ?? DEFAULTS.dailyStatsDays) * DAY_MS)
  const suggestionCutoff = now - (s.resolvedSuggestionDays ?? DEFAULTS.resolvedSuggestionDays) * DAY_MS
  const gatewayCutoff = now - (s.gatewayDays ?? DEFAULTS.gatewayDays) * DAY_MS
  const batched = (table: string, where: string, params: Record<string, number | string>): PruneStep => ({
    table,
    sql: `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT $batch)`,
    params: { ...params, batch },
    batched: true,
  })
  return [
    batched('result_payloads', 'expires_at <= $now', { now }),
    {
      table: 'result_payloads',
      sql: `DELETE FROM result_payloads WHERE id IN (
              SELECT p.id FROM result_payloads p JOIN results r ON r.id = p.result_id
               WHERE r.created_at <= $cutoff LIMIT $batch)`,
      params: { cutoff, batch },
      batched: true,
    },
    batched('results', 'created_at <= $cutoff', { cutoff }),
    batched('searches', 'created_at <= $cutoff', { cutoff }),
    batched('fetches', 'created_at <= $cutoff', { cutoff }),
    batched('receipts', 'updated_at <= $cutoff', { cutoff }),
    batched('sessions', 'last_seen_at <= $cutoff', { cutoff }),
    {
      table: 'daily_stats',
      sql: 'DELETE FROM daily_stats WHERE day <= $day',
      params: { day: statsDay },
      batched: false,
    },
    {
      // Keep the current and the previous period (needed for caps).
      table: 'engine_usage',
      sql: `DELETE FROM engine_usage
             WHERE (period_kind = 'day' AND period_start < $prevDay)
                OR (period_kind = 'month' AND period_start < $prevMonth)`,
      params: { prevDay: dayOf(now - DAY_MS), prevMonth: previousMonth(now) },
      batched: false,
    },
    batched('suggestions', "status != 'pending' AND resolved_at IS NOT NULL AND resolved_at <= $cutoff", {
      cutoff: suggestionCutoff,
    }),
    batched('gateways', 'last_seen_at <= $cutoff', { cutoff: gatewayCutoff }),
  ]
}
