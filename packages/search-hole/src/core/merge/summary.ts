// SPDX-License-Identifier: Apache-2.0
/** Gap warnings for deep searches (ADR-0010 §7) and the hidden summary (ADR-0012). */
import type { HiddenReason, HiddenSummary, MergedResult, Warning } from '../../shared/types.ts'
import type { HiddenResult } from './types.ts'

/** Freshness counts over results kept by the rules (before freshness hid any). */
export interface FreshnessStats {
  fresh: number
  stale: number
}

/**
 * Deep-search gap warnings, from the top N the model sees:
 * - `no_official_source`: none of them is `official` or `docs`;
 * - `single_source`: all come from one registrable domain;
 * - `all_stale`: at least one rules-kept result was stale and none had a fresh date
 *   (undated results neither confirm nor deny freshness).
 * The first two need at least one result.
 */
export function gapWarnings(top: readonly MergedResult[], stats: FreshnessStats): Warning[] {
  const out: Warning[] = []
  if (top.length > 0) {
    if (!top.some((r) => r.sourceType === 'official' || r.sourceType === 'docs')) {
      out.push({ code: 'no_official_source' })
    }
    if (new Set(top.map((r) => r.registrableDomain)).size === 1) out.push({ code: 'single_source' })
  }
  if (stats.stale > 0 && stats.fresh === 0) out.push({ code: 'all_stale' })
  return out
}

/** Counts by reason and the most-hidden registrable domains (count desc, then name). */
export function summarizeHidden(hidden: readonly HiddenResult[], topDomains = 5): HiddenSummary {
  const byReason: Partial<Record<HiddenReason, number>> = {}
  const domains = new Map<string, number>()
  for (const h of hidden) {
    byReason[h.hiddenReason] = (byReason[h.hiddenReason] ?? 0) + 1
    domains.set(h.registrableDomain, (domains.get(h.registrableDomain) ?? 0) + 1)
  }
  const top = [...domains.entries()]
    .sort(([da, ca], [db, cb]) => cb - ca || (da < db ? -1 : da > db ? 1 : 0))
    .slice(0, topDomains)
    .map(([d]) => d)
  return { count: hidden.length, byReason, topDomains: top }
}
