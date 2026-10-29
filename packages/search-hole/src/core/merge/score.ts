// SPDX-License-Identifier: Apache-2.0
/** Reciprocal rank fusion and rule multipliers (ADR-0010 §3–4). */
import type { EngineId } from '../../shared/types.ts'

/** RRF constant. 20, not the textbook 60, because we fuse short lists (ADR-0010 §3). */
export const RRF_K = 20
/** `raise N` multiplies by `1 + WEIGHT_STEP·N`; `lower N` divides by it. */
export const WEIGHT_STEP = 0.15
/** Comparison resolution: scores closer than this are a tie, decided by the tie-break. */
const SCORE_RESOLUTION = 1e12

/** One engine's RRF term: `w / (k + rank)`. */
export function rrfTerm(rank: number, weight = 1, k = RRF_K): number {
  return weight / (k + rank)
}

/** Multiplier for a weight rule: `raise N` → 1 + 0.15·N, `lower N` → 1 ÷ (1 + 0.15·N), `normal` → 1. */
export function weightMultiplier(action: 'raise' | 'lower' | 'normal', n: number): number {
  if (action === 'normal') return 1
  const m = 1 + WEIGHT_STEP * n
  return action === 'raise' ? m : 1 / m
}

/**
 * `fused = Σ w_e / (k + rank_e)` over the engines in `order`, each contributing at most one
 * term (its minimum raw rank). Summed in a fixed order, so equal inputs give equal floats.
 */
export function fuse(
  positions: Partial<Record<EngineId, number>>,
  order: readonly EngineId[],
  weightOf: (engine: EngineId) => number,
  k = RRF_K,
): number {
  let sum = 0
  for (const e of order) {
    const rank = positions[e]
    if (rank !== undefined) sum += rrfTerm(rank, weightOf(e), k)
  }
  return sum
}

/** A score quantised to 1e-12 so floating-point noise never decides an order. */
export function scoreKey(score: number): number {
  return Math.round(score * SCORE_RESOLUTION)
}

/** A multiplier or weight that is finite and ≥ 0, else the fallback. */
export function sanitizeFactor(value: number | undefined, fallback = 1): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}
