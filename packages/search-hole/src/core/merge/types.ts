// SPDX-License-Identifier: Apache-2.0
/** Merge inputs and outputs (ADR-0010). Module-local additions to the shared contract live here. */
import type {
  Depth,
  EngineId,
  Freshness,
  HiddenReason,
  MergedResult,
  RawResult,
  RuleDecision,
  SourceType,
  Warning,
} from '../../shared/types.ts'

export interface MergeInput {
  /** Every engine's results with raw (pre-block) ranks. */
  raw: readonly RawResult[]
  /** Rule decision for one original URL, already losslessly normalised (ADR-0008). */
  decide: (normalizedOriginalUrl: string) => RuleDecision
  depth: Depth
  /** Output slots. Hidden results never consume one. */
  limit: number
  freshness: Freshness
  /** Epoch milliseconds. */
  now: number
  /** The plan's engine order: the second tie-break after the best raw rank. */
  engineOrder: readonly EngineId[]
  /** Per-profile RRF weights `w_e` (default 1.0). */
  engineWeights?: Partial<Record<EngineId, number>>
  /** Source type for a display URL and its host. */
  sourceType: (url: string, host: string) => SourceType
}

/** A hidden result with why it was hidden (`stale` and `date_required` aren't rule reasons). */
export interface HiddenResult extends MergedResult {
  hiddenReason: HiddenReason
}

export interface MergeOutput {
  /** Kept results in output order, at most `limit`. */
  results: MergedResult[]
  /**
   * Hidden results: one per hidden raw result for rule and list decisions (raw rank kept),
   * one per group for freshness decisions. Ordered by best raw rank, engine order, key.
   */
  hidden: HiddenResult[]
  /** Kept results ranked below `limit`, in order (for `--explain` and replay). */
  overflow: MergedResult[]
  /** Raw results whose URL is not an http(s) URL or whose rank isn't ≥ 1. Never shown or grouped. */
  invalid: RawResult[]
  warnings: Warning[]
}
