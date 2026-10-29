// SPDX-License-Identifier: Apache-2.0
/**
 * Source typing (MASTER_PLAN §5 step 8, ADR-0010 §7). No LLM, no authority table:
 * 1. membership in a typed list (`kind: official | content-farm | clone`);
 * 2. URL patterns, first match wins, kept here as data;
 * 3. otherwise `unknown`.
 *
 * Source type is an annotation. It never changes ranking: authority comes from the
 * user's rules and lists (ADR-0010 alternatives).
 */
import type { ListKind, SourceType } from '../shared/types.ts'
import { parseHttpUrl, registrableDomain } from './url.ts'

/** Dependencies of `classifySource`. */
export interface SourceTypeDeps {
  /** Kinds of every enabled typed list whose entries match this host. */
  typedLists: (host: string) => readonly ListKind[]
}

/**
 * One pattern row. Every field given must match (AND):
 * - `domains`: the host equals one of these or is a subdomain of one (label boundary);
 * - `firstLabels`: the host's first label is one of these **and** is a subdomain label
 *   (so `developer.com` is not docs, `developer.apple.com` is);
 * - `host`: a regex over the whole host;
 * - `path`: a regex over the path.
 */
export interface SourcePattern {
  name: string
  type: SourceType
  domains?: readonly string[]
  firstLabels?: readonly string[]
  host?: RegExp
  path?: RegExp
}

/** Typed-list kinds that set a source type, in priority order (first wins). */
export const TYPED_LIST_TYPES: readonly (readonly [ListKind, SourceType])[] = [
  ['official', 'official'],
  ['content-farm', 'content_farm'],
  ['clone', 'content_farm'],
]

/** GitHub top-level paths that are not `<org>/<repo>`. */
const GITHUB_RESERVED =
  'about|apps|codespaces|collections|contact|customer-stories|enterprise|events|explore|features|login|marketplace|new|notifications|orgs|organizations|pricing|readme|resources|search|security|settings|site|solutions|sponsors|team|topics|trending|users'

const LOCALE = '(?:[a-z]{2}(?:[-_][a-z]{2,4})?/)?'

/** Ordered pattern table: first match wins. */
export const SOURCE_PATTERNS: readonly SourcePattern[] = [
  {
    name: 'government',
    type: 'official',
    host: /(?:^|\.)(?:gov|mil|int)$|(?:^|\.)(?:gov|gouv|gob|govt|go|gc)\.[a-z]{2}$|(?:^|\.)europa\.eu$/,
  },
  {
    name: 'github-discussion',
    type: 'forum',
    domains: ['github.com'],
    path: /^\/[^/]+\/[^/]+\/(?:issues|discussions)(?:\/|$)/i,
  },
  {
    name: 'github-repo',
    type: 'repo',
    domains: ['github.com'],
    path: new RegExp(
      `^/(?!(?:${GITHUB_RESERVED})(?:/|$))[^/]+/[^/]+(?:/(?:releases|blob|tree|wiki|tags)(?:/.*)?)?/?$`,
      'i',
    ),
  },
  {
    name: 'gitlab-repo',
    type: 'repo',
    domains: ['gitlab.com', 'codeberg.org'],
    path: /^\/.+\/(?:-\/)?(?:releases|blob|tree|tags|wikis|src)(?:\/|$)/i,
  },
  {
    name: 'stack-exchange',
    type: 'forum',
    domains: [
      'stackoverflow.com',
      'stackexchange.com',
      'serverfault.com',
      'superuser.com',
      'askubuntu.com',
      'mathoverflow.net',
      'stackapps.com',
    ],
  },
  {
    name: 'community-sites',
    type: 'forum',
    domains: ['reddit.com', 'news.ycombinator.com', 'lobste.rs', 'quora.com'],
  },
  {
    name: 'forum-hosts',
    type: 'forum',
    firstLabels: ['forum', 'forums', 'discourse', 'discuss', 'community'],
  },
  { name: 'docs-hosts', type: 'docs', firstLabels: ['docs', 'developer', 'developers'] },
  { name: 'docs-hosting', type: 'docs', domains: ['readthedocs.io', 'readthedocs-hosted.com', 'docs.rs'] },
  { name: 'docs-path', type: 'docs', path: new RegExp(`^/${LOCALE}(?:docs|documentation)(?:/|$)`, 'i') },
  {
    name: 'reference',
    type: 'reference',
    domains: ['wikipedia.org', 'wiktionary.org', 'wikibooks.org', 'britannica.com', 'merriam-webster.com'],
  },
  {
    name: 'news',
    type: 'news',
    domains: [
      'apnews.com',
      'arstechnica.com',
      'bbc.co.uk',
      'bbc.com',
      'bloomberg.com',
      'cnbc.com',
      'cnn.com',
      'economist.com',
      'ft.com',
      'lwn.net',
      'npr.org',
      'nytimes.com',
      'reuters.com',
      'techcrunch.com',
      'theguardian.com',
      'theregister.com',
      'theverge.com',
      'washingtonpost.com',
      'wired.com',
      'wsj.com',
    ],
  },
  {
    name: 'blog-platforms',
    type: 'blog',
    domains: [
      'blogspot.com',
      'dev.to',
      'ghost.io',
      'hashnode.dev',
      'hackernoon.com',
      'medium.com',
      'substack.com',
      'tumblr.com',
      'wordpress.com',
    ],
  },
  { name: 'blog-hosts', type: 'blog', firstLabels: ['blog', 'blogs'] },
  { name: 'blog-path', type: 'blog', path: new RegExp(`^/${LOCALE}blogs?(?:/|$)`, 'i') },
]

/** How a source type was decided, for `--explain`. */
export interface SourceTypeExplained {
  type: SourceType
  /** `list:<kind>`, `pattern:<name>` or `none`. */
  basis: string
}

function inDomains(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

function matchesPattern(p: SourcePattern, host: string, path: string): boolean {
  if (p.domains && !inDomains(host, p.domains)) return false
  if (p.firstLabels) {
    const first = host.split('.')[0] ?? ''
    if (!p.firstLabels.includes(first) || registrableDomain(host) === host) return false
  }
  if (p.host && !p.host.test(host)) return false
  if (p.path && !p.path.test(path)) return false
  return true
}

/** Source type from the pattern table alone; null when no row matches. */
export function classifyByPattern(
  host: string,
  path: string,
  patterns: readonly SourcePattern[] = SOURCE_PATTERNS,
): SourcePattern | null {
  return patterns.find((p) => matchesPattern(p, host, path)) ?? null
}

/** Like `classifySource`, also saying which list kind or pattern decided. */
export function explainSource(
  url: string,
  deps: SourceTypeDeps,
  patterns: readonly SourcePattern[] = SOURCE_PATTERNS,
): SourceTypeExplained {
  const u = parseHttpUrl(url)
  if (!u) return { type: 'unknown', basis: 'none' }
  const host = u.hostname
  const kinds = deps.typedLists(host)
  for (const [kind, type] of TYPED_LIST_TYPES) {
    if (kinds.includes(kind)) return { type, basis: `list:${kind}` }
  }
  const p = classifyByPattern(host, u.pathname, patterns)
  return p ? { type: p.type, basis: `pattern:${p.name}` } : { type: 'unknown', basis: 'none' }
}

/** Source type of a URL: typed-list membership first, then URL patterns, else `unknown`. */
export function classifySource(url: string, deps: SourceTypeDeps): SourceType {
  return explainSource(url, deps).type
}
