// SPDX-License-Identifier: Apache-2.0
/**
 * Stable rule ids and rule-text snapshots (ADR-0008 "Rule ids").
 */
import { createHash } from 'node:crypto'
import type { Rule, RuleAction, RuleScope } from '../../shared/types.ts'

/** The tuple a rule id is derived from. `match` must be the canonical match text. */
export interface RuleIdentity {
  scope: RuleScope
  match: string
  action: RuleAction
  weight: number
  profiles?: readonly string[] | undefined
  important: boolean
}

/** True for actions that carry a 1–10 weight. */
export const isWeighted = (action: RuleAction): action is 'raise' | 'lower' =>
  action === 'raise' || action === 'lower'

/**
 * `r_` + the first 10 hex characters of SHA-256 over the JSON array
 * `[scope, match, action, weight, sorted unique profiles, important]`. The
 * weight is normalised to 1 for actions without one. JSON keeps the tuple
 * unambiguous even when the match text contains separators.
 */
export function ruleIdBase(t: RuleIdentity): string {
  const profiles = [...new Set(t.profiles ?? [])].sort()
  const weight = isWeighted(t.action) ? t.weight : 1
  const payload = JSON.stringify([t.scope, t.match, t.action, weight, profiles, t.important])
  return `r_${createHash('sha256').update(payload).digest('hex').slice(0, 10)}`
}

/**
 * Assigns ids in file order: exact-duplicate tuples get `-2`, `-3`, … The result
 * lists, per input, its id and (for duplicates) the index of the first copy, so
 * the loader can warn.
 */
export function assignRuleIds(items: readonly RuleIdentity[]): { id: string; duplicateOf?: number }[] {
  const seen = new Map<string, { first: number; n: number }>()
  return items.map((item, i) => {
    const base = ruleIdBase(item)
    const s = seen.get(base)
    if (!s) {
      seen.set(base, { first: i, n: 1 })
      return { id: base }
    }
    s.n += 1
    return { id: `${base}-${s.n}`, duplicateOf: s.first }
  })
}

/**
 * A one-line snapshot of a rule (`lower 3 *.medium.com profile=coding`), stored
 * with every decision so explanations survive rule deletion.
 */
export function ruleText(r: Rule): string {
  const parts: string[] = [r.action]
  if (isWeighted(r.action)) parts.push(String(r.weight))
  parts.push(r.match)
  if (r.profiles && r.profiles.length > 0) parts.push(`profile=${r.profiles.join(',')}`)
  if (r.important && r.scope !== 'list') parts.push('important')
  if (r.listImportant && r.scope === 'list') parts.push('$important')
  if (r.until) parts.push(`until=${r.until}`)
  return parts.join(' ')
}
