// SPDX-License-Identifier: Apache-2.0
/**
 * Match expressions (ADR-0008 "Rule syntax"): classification, validation and
 * compilation into a predicate over a {@link NormalizedUrl}.
 *
 * | Written as              | Kind          | Matches                                   |
 * |-------------------------|---------------|-------------------------------------------|
 * | `pinterest.com`         | `domain`      | the host and every subdomain (label boundary) |
 * | `*.medium.com`          | `domain`      | same as `medium.com` (uBlacklist meaning) |
 * | `=example.com`          | `exact_host`  | that host only                            |
 * | `github.com/org/`       | `host_path`   | host + subdomains, path prefix            |
 * | `=www.x.com/docs`       | `host_path`   | exact host, path prefix                   |
 * | `\|https://x.com/amp/^` | `url_pattern` | Goggles/ABP pattern (`*`, `^`, `\|`) over the URL |
 * | `/re/` or `/re/i`       | `regex`       | RE2 search over the URL                   |
 */
import type { RE2JS } from 're2js'
import type { MatchKind } from '../../shared/types.ts'
import {
  hostMatchesDomain,
  labelCount,
  type NormalizedUrl,
  normalizeHost,
  normalizePath,
} from './normalize.ts'
import { urlPatternToRegex } from './pattern.ts'
import { compileRegex } from './regex.ts'

/** A validated, compiled match expression. */
export type ParsedMatch =
  | { kind: 'domain'; canonical: string; host: string }
  | { kind: 'exact_host'; canonical: string; host: string }
  | { kind: 'host_path'; canonical: string; host: string; exactHost: boolean; path: string }
  | {
      kind: 'url_pattern'
      canonical: string
      re: RE2JS
      literal: string
      /** Every literal run (lower-case); the prefilter files the rule under one of them. */
      runs: readonly string[]
      hasPath: boolean
    }
  | { kind: 'regex'; canonical: string; re: RE2JS }

export type MatchParseResult = { ok: true; match: ParsedMatch } | { ok: false; error: string }

const REGEX_LITERAL = /^\/(.+)\/(i?)$/s

/**
 * Infers the match kind from how the expression is written (see the table in
 * this module's doc comment). Never throws; validation happens in {@link parseMatch}.
 */
export function classifyMatch(text: string): MatchKind {
  const t = text.trim()
  if (REGEX_LITERAL.test(t)) return 'regex'
  const rest = t.startsWith('*.') ? t.slice(2) : t
  if (rest.includes('://') || /[*^|]/.test(rest)) return 'url_pattern'
  if (t.startsWith('=')) return t.includes('/') ? 'host_path' : 'exact_host'
  return rest.includes('/') ? 'host_path' : 'domain'
}

/**
 * Validates and compiles a match expression. When `kind` is given it must agree
 * with the written form (a stored rule whose text and kind disagree is rejected).
 */
export function parseMatch(text: string, kind?: MatchKind): MatchParseResult {
  const t = text.trim()
  if (t === '') return { ok: false, error: 'match is empty' }
  const inferred = classifyMatch(t)
  if (kind !== undefined && kind !== inferred) {
    return { ok: false, error: `match '${t}' is written as ${inferred}, not ${kind}` }
  }
  switch (inferred) {
    case 'domain': {
      const host = normalizeHost(t.startsWith('*.') ? t.slice(2) : t)
      if (!host) return { ok: false, error: `'${t}' is not a valid host name` }
      return { ok: true, match: { kind: 'domain', canonical: host, host } }
    }
    case 'exact_host': {
      const host = normalizeHost(t.slice(1))
      if (!host) return { ok: false, error: `'${t}' is not a valid host name` }
      return { ok: true, match: { kind: 'exact_host', canonical: `=${host}`, host } }
    }
    case 'host_path': {
      const exactHost = t.startsWith('=')
      const body = exactHost ? t.slice(1) : t.startsWith('*.') ? t.slice(2) : t
      const slash = body.indexOf('/')
      const host = normalizeHost(body.slice(0, slash))
      if (!host) return { ok: false, error: `'${t}' does not start with a valid host name` }
      const path = normalizePath(body.slice(slash))
      if (path === null) return { ok: false, error: `'${t}' has an invalid path` }
      const canonical = `${exactHost ? '=' : ''}${host}${path}`
      return { ok: true, match: { kind: 'host_path', canonical, host, exactHost, path } }
    }
    case 'url_pattern': {
      const p = urlPatternToRegex(t)
      if (!p.ok) return p
      const r = compileRegex(p.source, true)
      if (!r.ok) return r
      return {
        ok: true,
        match: {
          kind: 'url_pattern',
          canonical: t.toLowerCase(),
          re: r.re,
          literal: p.literal,
          runs: p.runs,
          hasPath: p.hasPath,
        },
      }
    }
    case 'regex': {
      const m = REGEX_LITERAL.exec(t)
      const source = m?.[1] ?? ''
      const r = compileRegex(source, m?.[2] === 'i')
      if (!r.ok) return r
      return { ok: true, match: { kind: 'regex', canonical: t, re: r.re } }
    }
  }
}

/**
 * Path-prefix test with a segment boundary: `/org` matches `/org`, `/org/x` and
 * `/org?q`, never `/organisation`. A prefix ending in `/`, `?`, `&` or `=` is a
 * plain prefix.
 */
export function pathHasPrefix(pathQuery: string, prefix: string): boolean {
  if (!pathQuery.startsWith(prefix)) return false
  if (pathQuery.length === prefix.length || '/?&='.includes(prefix[prefix.length - 1] ?? '')) return true
  return '/?&'.includes(pathQuery[prefix.length] ?? '')
}

/** Tests a compiled match against a normalised URL. `lowerHref` is `url.href.toLowerCase()`. */
export function testMatch(m: ParsedMatch, url: NormalizedUrl, lowerHref: string): boolean {
  switch (m.kind) {
    case 'domain':
      return hostMatchesDomain(url.host, m.host, url.ip)
    case 'exact_host':
      return url.host === m.host
    case 'host_path':
      return (
        (m.exactHost ? url.host === m.host : hostMatchesDomain(url.host, m.host, url.ip)) &&
        pathHasPrefix(url.pathQuery, m.path)
      )
    case 'url_pattern':
      return (m.literal === '' || lowerHref.includes(m.literal)) && m.re.test(url.href)
    case 'regex':
      return m.re.test(url.href)
  }
}

/**
 * Specificity for the weight pass inside one user tier (ADR-0008 pass 3); larger
 * compares first. Order: regex or URL pattern with a path > host + path prefix
 * (longer path first, exact host before suffix) > exact host > URL pattern
 * without a path > domain suffix (more labels first).
 */
export function specificity(m: ParsedMatch): readonly [number, number, number] {
  switch (m.kind) {
    case 'regex':
      return [5, 0, 0]
    case 'url_pattern':
      return m.hasPath ? [5, 0, 0] : [2, 0, 0]
    case 'host_path':
      return [4, m.path.length, m.exactHost ? 1000 : labelCount(m.host)]
    case 'exact_host':
      return [3, 0, 0]
    case 'domain':
      return [1, labelCount(m.host), 0]
  }
}
