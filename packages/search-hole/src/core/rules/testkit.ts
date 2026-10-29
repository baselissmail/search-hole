// SPDX-License-Identifier: Apache-2.0
/**
 * Test-only builders shared by the rules tests (not part of the public API).
 */
import type { ListKind, ListMode, Profile, Rule, RuleAction, RuleScope } from '../../shared/types.ts'
import type { ListInput, RuleSetInput } from './engine.ts'
import { classifyMatch } from './match.ts'

export interface RuleSpec {
  scope: RuleScope
  action: RuleAction
  match?: string
  weight?: number
  important?: boolean
  listImportant?: boolean
  list?: string
  profiles?: string[]
  until?: string
}

export interface ListSpec {
  mode?: ListMode
  kind?: ListKind
}

/** Builds a Rule with id `r<index>`; order is the index. */
export function makeRule(spec: RuleSpec, index: number, defaultMatch = 'example.com'): Rule {
  const match = spec.match ?? defaultMatch
  const r: Rule = {
    id: `r${index}`,
    scope: spec.scope,
    match,
    matchKind: classifyMatch(match),
    action: spec.action,
    weight: spec.weight ?? 1,
    important: spec.important ?? false,
    order: index,
  }
  if (spec.listImportant !== undefined) r.listImportant = spec.listImportant
  if (spec.profiles) r.profiles = spec.profiles
  if (spec.until) r.until = spec.until
  if (spec.scope === 'list') r.listId = spec.list ?? 'L1'
  return r
}

/** Splits specs into user rules and lists (lists default to enforce/block). */
export function buildInput(
  specs: readonly RuleSpec[],
  lists: Readonly<Record<string, ListSpec>> = {},
  profiles: readonly Profile[] = [],
  defaultMatch?: string,
): RuleSetInput {
  const rules: Rule[] = []
  const byList = new Map<string, Rule[]>()
  specs.forEach((s, i) => {
    const r = makeRule(s, i, defaultMatch)
    if (s.scope === 'list') {
      const id = s.list ?? 'L1'
      const arr = byList.get(id) ?? []
      arr.push(r)
      byList.set(id, arr)
    } else rules.push(r)
  })
  for (const id of Object.keys(lists)) if (!byList.has(id)) byList.set(id, [])
  const listInputs: ListInput[] = [...byList.entries()].map(([id, rs]) => ({
    id,
    mode: lists[id]?.mode ?? 'enforce',
    kind: lists[id]?.kind ?? 'block',
    rules: rs,
  }))
  return { rules, lists: listInputs, profiles: [...profiles] }
}
