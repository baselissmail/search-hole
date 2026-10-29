// SPDX-License-Identifier: Apache-2.0
/** Builders for RuleDecision values, for tests and for callers that run without rules. */
import type { RuleDecision, RuleRef, Tier } from '../../shared/types.ts'

/** A RuleRef snapshot. */
export function ruleRef(ruleId: string, tier: Tier = 'T3', text = ruleId, listId?: string): RuleRef {
  return { ruleId, tier, text, ...(listId === undefined ? {} : { listId }) }
}

/** A kept decision with no rule, weight 1 and prefer 1, plus overrides. */
export function keptDecision(overrides: Partial<RuleDecision> = {}): RuleDecision {
  return { visibility: 'kept', weight: { factor: 1 }, preferFactor: 1, matches: [], ...overrides }
}

/** A hidden decision for one rule, plus overrides. */
export function hiddenDecision(
  rule: RuleRef,
  reason: NonNullable<RuleDecision['hiddenReason']> = 'rule',
  overrides: Partial<RuleDecision> = {},
): RuleDecision {
  return {
    visibility: 'hidden',
    visibilityRule: rule,
    hiddenReason: reason,
    weight: { factor: 1 },
    preferFactor: 1,
    matches: [rule],
    ...overrides,
  }
}
