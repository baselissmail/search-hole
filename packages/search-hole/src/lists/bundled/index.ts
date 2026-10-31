// SPDX-License-Identifier: Apache-2.0
/**
 * Lists bundled with search-hole (ADR-0016, ADR-0017 point 7): the four first-party lists.
 * - `official-docs`, `official-health`: kind `official`, annotation only.
 * - `github-clones`: kind `clone`, enforced (hides).
 * - `ai-content-farms`: kind `content-farm`, audit mode (records "would hide" only).
 * The vendored third-party starter lists are described in `../catalog.ts`.
 */

import type { ListInput } from '../../core/rules/engine.ts'
import { classifyMatch } from '../../core/rules/match.ts'
import type { ListKind, Profile, Rule, RuleAction } from '../../shared/types.ts'
import { AI_CONTENT_FARMS, AI_CONTENT_FARMS_ID } from './ai-content-farms.ts'
import { FIRST_PARTY_LISTS, type FirstPartyList } from './first-party.ts'
import { GITHUB_CLONES, GITHUB_CLONES_ID } from './github-clones.ts'
import { OFFICIAL_DOCS, OFFICIAL_DOCS_ID } from './official-docs.ts'
import { OFFICIAL_HEALTH, OFFICIAL_HEALTH_ID } from './official-health.ts'

/** Turns one first-party list into list rules. */
function listRules(list: FirstPartyList): Rule[] {
  // Kind `official` lists only annotate (the action is never applied); the others block.
  const action: RuleAction = list.kind === 'official' ? 'normal' : 'block'
  return list.entries.map((entry, order) => {
    const match = typeof entry === 'string' ? entry : entry.match
    const rule: Rule = {
      id: `l_${list.id}_${order + 1}`,
      scope: 'list',
      match,
      matchKind: classifyMatch(match),
      action,
      weight: 1,
      important: false,
      listId: list.id,
      order,
    }
    if (typeof entry !== 'string') rule.note = `evidence: ${entry.evidence}`
    return rule
  })
}

/** The bundled lists, ready for `compileRuleSet({ lists })`. */
export function bundledLists(): ListInput[] {
  return FIRST_PARTY_LISTS.map((list) => ({
    id: list.id,
    kind: list.kind,
    mode: list.mode,
    rules: listRules(list),
  }))
}

/** List id → kind, for source typing. */
export const BUNDLED_LIST_KINDS: ReadonlyMap<string, ListKind> = new Map(
  FIRST_PARTY_LISTS.map((list) => [list.id, list.kind]),
)

/**
 * The built-in default profile (used when the user defines no profile with the default name):
 * prefer official documentation and official health authorities, the same lift as `raise 3`
 * (ADR-0008, ADR-0010). Both lists only annotate; preferring them reorders, never hides.
 */
export function builtinDefaultProfile(name: string): Profile {
  return { name, prefer: { lists: [OFFICIAL_DOCS_ID, OFFICIAL_HEALTH_ID] } }
}

export type { EvidencedEntry } from './evidence.ts'
export { entryMatches, FIRST_PARTY_LISTS, type FirstPartyList } from './first-party.ts'
export { exportLine, exportPath, LISTS_HOMEPAGE, renderListText } from './render-text.ts'
export {
  AI_CONTENT_FARMS,
  AI_CONTENT_FARMS_ID,
  GITHUB_CLONES,
  GITHUB_CLONES_ID,
  OFFICIAL_DOCS,
  OFFICIAL_DOCS_ID,
  OFFICIAL_HEALTH,
  OFFICIAL_HEALTH_ID,
}
