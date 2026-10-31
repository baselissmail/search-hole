// SPDX-License-Identifier: Apache-2.0
/**
 * Lists bundled with search-hole (ADR-0016, ADR-0017 starter set). v0.1 ships only the
 * annotation-only `official-docs` list; subscriptions and block lists come in P6.
 */

import type { ListInput } from '../../core/rules/engine.ts'
import { classifyMatch } from '../../core/rules/match.ts'
import type { ListKind, Profile, Rule } from '../../shared/types.ts'
import { OFFICIAL_DOCS, OFFICIAL_DOCS_ID } from './official-docs.ts'

/** Turns plain match strings into list rules for one bundled list. */
function listRules(listId: string, matches: readonly string[]): Rule[] {
  return matches.map((match, order) => ({
    id: `l_${listId}_${order + 1}`,
    scope: 'list',
    match,
    matchKind: classifyMatch(match),
    // Kind `official` lists only annotate; the action is never applied.
    action: 'normal',
    weight: 1,
    important: false,
    listId,
    order,
  }))
}

/** The bundled lists, ready for `compileRuleSet({ lists })`. */
export function bundledLists(): ListInput[] {
  return [
    {
      id: OFFICIAL_DOCS_ID,
      kind: 'official',
      mode: 'enforce',
      rules: listRules(OFFICIAL_DOCS_ID, OFFICIAL_DOCS),
    },
  ]
}

/** List id → kind, for source typing. */
export const BUNDLED_LIST_KINDS: ReadonlyMap<string, ListKind> = new Map([[OFFICIAL_DOCS_ID, 'official']])

/**
 * The built-in default profile (used when the user defines no profile with the default name):
 * prefer official documentation, the same lift as `raise 3` (ADR-0008, ADR-0010).
 */
export function builtinDefaultProfile(name: string): Profile {
  return { name, prefer: { lists: [OFFICIAL_DOCS_ID] } }
}

export { OFFICIAL_DOCS, OFFICIAL_DOCS_ID }
