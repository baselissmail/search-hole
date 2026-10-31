// SPDX-License-Identifier: Apache-2.0
/**
 * Adblock Plus / uBlock / AdGuard filter lists, network rules only (ADR-0008
 * import mapping), written from the documented syntax (docs/research/ublock.md,
 * adguardhome.md); no GPL code is used.
 *
 * | Filter                         | search-hole                                   |
 * |--------------------------------|-----------------------------------------------|
 * | `\|\|d^`, `\|\|d^\|`, bare `d.tld` | domain `d` (host and subdomains)          |
 * | `0.0.0.0 d` (hosts syntax)     | exact host `=d`                               |
 * | `@@…`                          | `allow` (an exception)                        |
 * | `…$important`                  | list-important (beats `@@` inside the list tier) |
 * | `…$badfilter`                  | a cancel entry for the same rule, across lists |
 * | `/re/`                         | regex, case-insensitive unless `$match-case`  |
 * | other patterns (`*`, `^`, `\|`, `\|\|`) | URL pattern                          |
 *
 * Modifiers that keep a rule applying to a top-level page (`document`, `doc`,
 * `all`, `match-case`) are accepted. Every other modifier narrows a rule to
 * contexts a search result does not have (`$script`, `$third-party`,
 * `$domain=`, AdGuard DNS's `$client`, `$dnstype`, `$denyallow`, …), so the
 * rule is skipped and counted per modifier. Cosmetic filters (`##`, `#@#`,
 * `#?#`, `#$#`, `#%#`, `$$`, …) are skipped and counted. `!#include` and
 * `!#if` directives are not followed; a warning says so.
 */
import { normalizeHost } from '../../core/rules/normalize.ts'
import { EXCEPTION, type ListBuilder, POSITIVE } from './builder.ts'
import { addHostsLine, isHostsLine } from './hosts.ts'
import { regexMatch, urlPatternMatch } from './patterns.ts'
import { type EachLine, readHeaderComment } from './text.ts'

const COSMETIC = /#@?[$%?]{0,2}#|\$@?\$/
const HOST_RULE = /^\|\|([^/^|*:?$]+)\^\|?$/
const PLAIN_HOST = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i
const OPTIONS_START = /^~?[a-z0-9_-]+(?:=|,|$)/i
const ACCEPTED_MODIFIERS: ReadonlySet<string> = new Set(['document', 'doc', 'all', 'match-case'])

/** Splits `pattern$options` (the last `$` that starts a modifier list; regex-aware). */
function splitOptions(body: string): { pattern: string; options: string[] } {
  if (body.startsWith('/')) {
    const i = body.lastIndexOf('/$')
    if (i > 0 && OPTIONS_START.test(body.slice(i + 2))) {
      return { pattern: body.slice(0, i + 1), options: body.slice(i + 2).split(',') }
    }
    if (body.endsWith('/')) return { pattern: body, options: [] }
  }
  const i = body.lastIndexOf('$')
  if (i >= 0 && OPTIONS_START.test(body.slice(i + 1))) {
    return { pattern: body.slice(0, i), options: body.slice(i + 1).split(',') }
  }
  return { pattern: body, options: [] }
}

export function parseAbp(b: ListBuilder, each: EachLine): void {
  let header = true
  let includes = 0
  let conditionals = 0
  each((line, n) => {
    const t = line.trim()
    if (t === '') {
      b.ignore()
      return
    }
    if (/^\[(?:adblock|adguard|ublock|abp)[^\]]*\]$/i.test(t)) {
      b.ignore()
      return
    }
    if (t.startsWith('!')) {
      if (t.startsWith('!#include')) includes++
      else if (t.startsWith('!#if')) conditionals++
      else if (header) readHeaderComment(t.slice(1), b.header)
      b.ignore()
      return
    }
    if (t === '#' || t.startsWith('# ') || t.startsWith('#\t')) {
      if (header) readHeaderComment(t.slice(1), b.header)
      b.ignore()
      return
    }
    header = false
    if (COSMETIC.test(t)) {
      b.skip(n, t, 'cosmetic filter')
      return
    }
    if (t.startsWith('#')) {
      b.ignore()
      return
    }
    if (isHostsLine(t)) {
      const hash = t.indexOf('#')
      addHostsLine(b, n, t, (hash === -1 ? t : t.slice(0, hash)).trim())
      return
    }
    const exception = t.startsWith('@@')
    const { pattern: rawPattern, options } = splitOptions(exception ? t.slice(2) : t)
    let important = false
    let badfilter = false
    let matchCase = false
    for (const raw of options) {
      const o = raw.trim().toLowerCase()
      if (o === '') continue
      if (o === 'important') important = true
      else if (o === 'badfilter') badfilter = true
      else if (o === 'match-case') matchCase = true
      else if (!ACCEPTED_MODIFIERS.has(o)) {
        const name = o.replace(/^~/, '').replace(/=.*$/s, '')
        b.skip(n, t, `unsupported modifier $${name}`)
        return
      }
    }
    const intent = exception ? EXCEPTION : POSITIVE
    const match = abpPatternMatch(rawPattern.trim(), matchCase)
    if ('reason' in match) {
      b.skip(n, t, match.reason, match.detail)
      return
    }
    if (badfilter) {
      b.addCancel(n, t, match.match, intent, important)
      return
    }
    b.add(n, t, match.match, intent, important)
  })
  if (b.format === 'adguard' && b.stats.regex > 0) {
    b.warn(
      `${b.stats.regex} regex rule(s) are matched against the whole URL; AdGuard Home matches them against the host name only`,
    )
  }
  if (includes > 0) b.warn(`${includes} !#include directive(s) were not followed`)
  if (conditionals > 0)
    b.warn(`${conditionals} !#if directive(s) were ignored; the lines inside them were read`)
}

/** A network filter's pattern (options removed) as a search-hole match. */
export function abpPatternMatch(
  pattern: string,
  matchCase: boolean,
): { match: string } | { reason: string; detail?: string } {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    return { match: regexMatch(pattern.slice(1, -1), !matchCase) }
  }
  // A leading or trailing `*` adds nothing to an unanchored pattern (`||d^*` is `||d^`).
  let p = pattern
  while (p.startsWith('*')) p = p.slice(1)
  while (p.endsWith('*')) p = p.slice(0, -1)
  const host = HOST_RULE.exec(p)?.[1]
  const hostName = host !== undefined ? normalizeHost(host) : null
  if (hostName !== null) return { match: hostName }
  if (PLAIN_HOST.test(p)) {
    const h = normalizeHost(p)
    if (h !== null) return { match: h }
  }
  if (p === '' || p === '|' || p === '||') return { reason: 'matches every URL' }
  const m = urlPatternMatch(p)
  if ('error' in m) {
    const every = m.error.includes('every URL') || m.error.includes('besides anchors')
    return { reason: every ? 'matches every URL' : 'invalid pattern', detail: m.error }
  }
  return m
}
