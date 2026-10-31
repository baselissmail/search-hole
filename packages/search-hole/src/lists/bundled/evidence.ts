// SPDX-License-Identifier: Apache-2.0
/**
 * The entry shape of the first-party block lists (`github-clones`, `ai-content-farms`): every
 * entry carries the public evidence it was listed on (ADR-0016, MASTER_PLAN §12.6).
 */
export interface EvidencedEntry {
  /** A host (`example.com`: the host and every subdomain) or host + path prefix (`example.com/answers`). */
  readonly match: string
  /** A public URL showing why the entry is listed: a copied page, or a documented report. */
  readonly evidence: string
  /** The original page the copy was taken from, when the evidence is a copy. */
  readonly original?: string
  /** Corroboration or scope notes. */
  readonly note?: string
}
