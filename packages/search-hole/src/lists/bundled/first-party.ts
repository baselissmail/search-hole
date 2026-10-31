// SPDX-License-Identifier: Apache-2.0
/**
 * Registry of the first-party lists (ADR-0016): id, kind, default mode and entries. The single
 * source for `bundledLists()` and for the CC0 text copies in `lists/` (scripts/export-lists.mjs).
 *
 * Pure data with type-only imports, so Node can load it with type stripping.
 */
import type { ListKind, ListMode } from '../../shared/types.ts'
import { AI_CONTENT_FARMS, AI_CONTENT_FARMS_ID } from './ai-content-farms.ts'
import type { EvidencedEntry } from './evidence.ts'
import { GITHUB_CLONES, GITHUB_CLONES_ID } from './github-clones.ts'
import { OFFICIAL_DOCS, OFFICIAL_DOCS_ID } from './official-docs.ts'
import { OFFICIAL_HEALTH, OFFICIAL_HEALTH_ID } from './official-health.ts'

export interface FirstPartyList {
  id: string
  kind: ListKind
  /** Mode when bundled (ADR-0017 point 7). */
  mode: ListMode
  title: string
  description: string
  /** Repo-relative path of the module that holds the entries and their evidence. */
  source: string
  entries: readonly EvidencedEntry[] | readonly string[]
}

const SRC = 'packages/search-hole/src/lists/bundled'

export const FIRST_PARTY_LISTS: readonly FirstPartyList[] = [
  {
    id: OFFICIAL_DOCS_ID,
    kind: 'official',
    mode: 'enforce',
    title: 'search-hole official-docs',
    description:
      'Official documentation sites, one ecosystem per block. Annotation only: never hides anything.',
    source: `${SRC}/official-docs.ts`,
    entries: OFFICIAL_DOCS,
  },
  {
    id: OFFICIAL_HEALTH_ID,
    kind: 'official',
    mode: 'enforce',
    title: 'search-hole official-health',
    description:
      'Official health authorities, medicines regulators and clinical reference sites. Annotation only: never hides anything.',
    source: `${SRC}/official-health.ts`,
    entries: OFFICIAL_HEALTH,
  },
  {
    id: GITHUB_CLONES_ID,
    kind: 'clone',
    mode: 'enforce',
    title: 'search-hole github-clones',
    description:
      'Sites that republish Stack Exchange or GitHub content wholesale. Every entry has a copied page and its original as evidence.',
    source: `${SRC}/github-clones.ts`,
    entries: GITHUB_CLONES,
  },
  {
    id: AI_CONTENT_FARMS_ID,
    kind: 'content-farm',
    mode: 'audit',
    title: 'search-hole ai-content-farms',
    description:
      'Sites that mass-publish machine-generated articles, each with a documented report. Short and conservative.',
    source: `${SRC}/ai-content-farms.ts`,
    entries: AI_CONTENT_FARMS,
  },
]

/** The match strings of a list, whichever entry shape it uses. */
export function entryMatches(list: FirstPartyList): string[] {
  return list.entries.map((e) => (typeof e === 'string' ? e : e.match))
}
