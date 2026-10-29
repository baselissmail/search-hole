// SPDX-License-Identifier: Apache-2.0
/**
 * JSON-LD date candidates (ADR-0011 row 2). Walks the root, `@graph` and
 * `mainEntity` (not arbitrary nesting, so a listing page's related articles do
 * not leak their dates) and reads `datePublished` / `dateModified` from the
 * listed types and their schema.org subtypes. Pure.
 */

/** Article and its schema.org subtypes (ADR-0011 lists Article, NewsArticle, BlogPosting, TechArticle, ScholarlyArticle). */
const ARTICLE_TYPES = new Set([
  'article',
  'newsarticle',
  'blogposting',
  'techarticle',
  'scholarlyarticle',
  'analysisnewsarticle',
  'askpublicnewsarticle',
  'backgroundnewsarticle',
  'opinionnewsarticle',
  'reportagenewsarticle',
  'reviewnewsarticle',
  'liveblogposting',
  'socialmediaposting',
  'discussionforumposting',
  'apireference',
  'medicalscholarlyarticle',
  'report',
  'satiricalarticle',
  'advertisercontentarticle',
])

/** WebPage and its schema.org subtypes. */
const PAGE_TYPES = new Set([
  'webpage',
  'aboutpage',
  'collectionpage',
  'faqpage',
  'itempage',
  'medicalwebpage',
  'profilepage',
  'qapage',
  'searchresultspage',
])

const MAX_DEPTH = 6
const MAX_ENTITIES = 500

export interface JsonLdCandidate {
  raw: string
  kind: 'published' | 'modified'
  method: 'jsonld:datePublished' | 'jsonld:dateModified'
  /** 0 for article types, 1 for page types (articles are more specific). */
  rank: 0 | 1
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function normaliseType(t: string): string {
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf(':'), t.lastIndexOf('#'))
  return t.slice(cut + 1).toLowerCase()
}

function typeRank(entity: Obj): 0 | 1 | null {
  const raw = entity['@type']
  const types = (Array.isArray(raw) ? raw : [raw]).filter((t): t is string => typeof t === 'string')
  const names = types.map(normaliseType)
  if (names.some((n) => ARTICLE_TYPES.has(n))) return 0
  if (names.some((n) => PAGE_TYPES.has(n))) return 1
  return null
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v))
    return v.flatMap((x) => (typeof x === 'string' ? [x] : isObj(x) ? strings(x['@value']) : []))
  if (isObj(v)) return strings(v['@value'])
  return []
}

function* entities(node: unknown, depth: number, budget: { left: number }): Generator<Obj> {
  if (depth > MAX_DEPTH || budget.left <= 0) return
  if (Array.isArray(node)) {
    for (const item of node) yield* entities(item, depth + 1, budget)
    return
  }
  if (!isObj(node)) return
  budget.left--
  yield node
  if ('@graph' in node) yield* entities(node['@graph'], depth + 1, budget)
  if ('mainEntity' in node) yield* entities(node.mainEntity, depth + 1, budget)
}

/** Strips HTML comment and CDATA wrappers some CMSs put around JSON-LD. */
function unwrap(text: string): string {
  return text
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\s*(?:\/\/\s*)?<!\[CDATA\[/, '')
    .replace(/(?:\/\/\s*)?\]\]>\s*$/, '')
    .trim()
}

/** Parses one `<script type="application/ld+json">` body; returns [] on invalid JSON. */
export function jsonLdDateCandidates(scriptText: string): JsonLdCandidate[] {
  let doc: unknown
  try {
    doc = JSON.parse(unwrap(scriptText))
  } catch {
    return []
  }
  const out: JsonLdCandidate[] = []
  for (const entity of entities(doc, 0, { left: MAX_ENTITIES })) {
    const rank = typeRank(entity)
    if (rank === null) continue
    for (const raw of strings(entity.datePublished)) {
      out.push({ raw, kind: 'published', method: 'jsonld:datePublished', rank })
    }
    for (const raw of strings(entity.dateModified)) {
      out.push({ raw, kind: 'modified', method: 'jsonld:dateModified', rank })
    }
  }
  return out
}
