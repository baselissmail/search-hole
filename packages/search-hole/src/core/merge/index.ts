// SPDX-License-Identifier: Apache-2.0
/**
 * Dedupe and fusion (ADR-0010), in this order:
 * 1. visibility per original URL (ADR-0008); hidden URLs never join a group;
 * 2. group kept URLs by canonical key; `positions[e]` = min raw rank;
 * 3. RRF (k = 20) over raw ranks, × rule weight × prefer factor;
 * 4. freshness (stale → hidden unless pinned; no usable date → `date_unknown`, or hidden
 *    with `requireDate`);
 * 5. pins first, then adjusted score, then the deterministic tie-break;
 * 6. deep coverage guarantee and gap warnings; `limit` last.
 *
 * Pure and deterministic: the same input gives the same output, and permuting `raw` never
 * changes it.
 */
import type { EngineId, MergedResult, RawResult, RuleDecision, Warning } from '../../shared/types.ts'
import { judgeFreshness } from '../freshness.ts'
import { canonicalize, normalizeOriginal } from '../url.ts'
import { buildDraft, compareRaw, type Draft, engineIndex, type GroupCtx, type Member } from './group.ts'
import { compareDrafts, placeWithCoverage, withFlags } from './order.ts'
import { sanitizeFactor } from './score.ts'
import { type FreshnessStats, gapWarnings } from './summary.ts'
import type { HiddenResult, MergeInput, MergeOutput } from './types.ts'

export { buildDraft, engineIndex, FLAG_ORDER, mergeDates } from './group.ts'
export { compareDrafts, placeWithCoverage } from './order.ts'
export { fuse, RRF_K, rrfTerm, scoreKey, WEIGHT_STEP, weightMultiplier } from './score.ts'
export { type FreshnessStats, gapWarnings, summarizeHidden } from './summary.ts'
export type { HiddenResult, MergeInput, MergeOutput } from './types.ts'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function hide(d: Draft, hiddenReason: HiddenResult['hiddenReason']): HiddenDraft {
  return { ...d, result: { ...d.result, hiddenReason } }
}

interface HiddenDraft extends Draft {
  result: HiddenResult
}

function compareHidden(a: HiddenDraft, b: HiddenDraft): number {
  return (
    a.bestRank - b.bestRank ||
    a.bestEngineIdx - b.bestEngineIdx ||
    cmp(a.result.canonicalKey, b.result.canonicalKey) ||
    cmp(a.result.url, b.result.url) ||
    cmp(JSON.stringify(a.result), JSON.stringify(b.result))
  )
}

/** Merges every engine's raw results into ordered kept results, hidden results and warnings. */
export function merge(input: MergeInput): MergeOutput {
  const engines = engineIndex(
    input.engineOrder,
    input.raw.map((r) => r.engine),
  )
  const ctx: GroupCtx = {
    engines,
    weightOf: (e) => sanitizeFactor(input.engineWeights?.[e]),
    basis: input.freshness.basis,
    now: input.now,
    sourceType: input.sourceType,
  }
  const limit = Number.isNaN(input.limit) ? 0 : Math.max(0, Math.floor(input.limit))

  // 1. Visibility per original URL, before any grouping.
  const decisions = new Map<string, RuleDecision>()
  const decide = (url: string): RuleDecision => {
    let d = decisions.get(url)
    if (!d) {
      d = input.decide(url)
      decisions.set(url, d)
    }
    return d
  }
  const invalid: RawResult[] = []
  const hidden: HiddenDraft[] = []
  const groups = new Map<string, Member[]>()
  const responded = new Set<EngineId>()
  for (const raw of input.raw) {
    const url = normalizeOriginal(raw.url)
    const canonical = url === null ? null : canonicalize(url)
    if (url === null || canonical === null || !Number.isFinite(raw.rank) || raw.rank < 1) {
      invalid.push(raw)
      continue
    }
    responded.add(raw.engine)
    const member: Member = { raw, url, canonical, decision: decide(url) }
    if (member.decision.visibility === 'hidden') {
      hidden.push(hide(buildDraft([member], ctx), member.decision.hiddenReason ?? 'rule'))
      continue
    }
    const group = groups.get(canonical.key)
    if (group) group.push(member)
    else groups.set(canonical.key, [member])
  }

  // 2–4. Group, fuse, then freshness on the rules-kept groups.
  const stats: FreshnessStats = { fresh: 0, stale: 0 }
  const kept: Draft[] = []
  for (const members of groups.values()) {
    const draft = buildDraft(members, ctx)
    const pinned = draft.result.decision.pin !== undefined
    const verdict = judgeFreshness(draft.result.dates, input.freshness, input.now)
    if (verdict.status === 'fresh') stats.fresh++
    if (verdict.status === 'stale') {
      stats.stale++
      if (pinned) kept.push(withFlags(draft, 'stale'))
      else hidden.push(hide(withFlags(draft, 'stale'), 'stale'))
    } else if (verdict.status === 'unknown') {
      const flagged = withFlags(draft, 'date_unknown')
      if (input.freshness.requireDate && !pinned) hidden.push(hide(flagged, 'date_required'))
      else kept.push(flagged)
    } else {
      kept.push(draft)
    }
  }

  // 5. Order; 6. coverage (deep only), then the limit.
  kept.sort(compareDrafts)
  const respondedInOrder = engines.sort(responded)
  const placed =
    input.depth === 'deep'
      ? placeWithCoverage(kept, limit, respondedInOrder)
      : { top: kept.slice(0, limit), rest: kept.slice(limit), skipped: false }
  const results: MergedResult[] = placed.top.map((d) => d.result)
  const warnings: Warning[] = []
  if (placed.skipped) warnings.push({ code: 'coverage_skipped' })
  if (input.depth === 'deep') warnings.push(...gapWarnings(results, stats))

  hidden.sort(compareHidden)
  invalid.sort((a, b) => compareRaw(a, b, engines))
  return {
    results,
    hidden: hidden.map((d) => d.result),
    overflow: placed.rest.map((d) => d.result),
    invalid,
    warnings,
  }
}
