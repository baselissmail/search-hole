// SPDX-License-Identifier: Apache-2.0
/**
 * Brave Goggles (ADR-0008 import mapping), written from the documented syntax
 * (docs/research/goggles-quickstart.md); no goggle text or code is used.
 *
 * `[pattern][$option,…]` with options `site=<domain>`, `boost[=N]`,
 * `downrank[=N]`, `discard` (and the default target `inurl`):
 *
 * - `discard` → block, `boost=N` → raise N, `downrank=N` → lower N; a bare
 *   instruction is `boost=1`. Strengths are clamped to 1–10.
 * - `$site=d` alone → a domain rule; a pattern alone → a URL pattern; both →
 *   one regex that requires the site and finds the pattern in the path and
 *   query (approximate: a pattern that would only occur in the host is missed).
 * - Each goggle is resolved with its own semantics: instructions with the same
 *   match collapse into one rule (discard is final, then the largest boost,
 *   then the weakest downrank). The list tier's commutative weight pass
 *   (any raise beats any lower, largest raise, weakest lower) then gives the
 *   same answer per result as Goggles does.
 * - A generic `$discard` (no pattern, no site) is allowlist mode: it sets
 *   `allowlistMode`; each instruction then also gets an `allow` companion and
 *   discards become list-important (see `ListBuilder.addAllowlistCompanions`).
 * - `$intitle`, `$indescription`, `$incontent` are not supported (Brave lists
 *   them as future work) and are skipped.
 */
import { normalizeHost } from '../../core/rules/normalize.ts'
import { urlPatternToRegex } from '../../core/rules/pattern.ts'
import { escapeRegex } from '../../core/rules/regex.ts'
import type { Intent, ListBuilder } from './builder.ts'
import { urlPatternMatch } from './patterns.ts'
import { type EachLine, readHeaderComment } from './text.ts'

const OPTION = /^([a-z_]+)(?:=(.*))?$/i
/** Characters a host can contain; a pattern starting with one cannot begin the path. */
const HOST_CHAR = /[a-z0-9_.-]/i

/**
 * The regex for "host is `site` or a subdomain, and the path or query contains
 * `pattern`" (see the module comment), or an error.
 */
export function sitePatternRegex(site: string, pattern: string): { match: string } | { error: string } {
  // Leading and trailing `*` are neutral in an unanchored pattern.
  let p = pattern
  while (p.startsWith('*')) p = p.slice(1)
  while (p.endsWith('*')) p = p.slice(0, -1)
  if (p === '') return { match: '' }
  if (p.startsWith('|')) return { error: 'a start-anchored pattern combined with site= is not supported' }
  const r = urlPatternToRegex(p)
  if (!r.ok) return { error: r.error }
  // Escape each bare slash for the /regex/ form; a backslash escape, an escaped slash included, stays as it is.
  const src = r.source.replace(/\\.|\//g, (m) => (m === '/' ? '\\/' : m))
  const head = `^[a-z][a-z0-9+.\\-]*:\\/\\/(?:[^\\/?#:]*\\.)?${escapeRegex(site)}(?::[0-9]+)?`
  // At the very start of the path only when the pattern cannot also continue the host name.
  const atStart = HOST_CHAR.test(p[0] ?? '') ? '' : `${src}|`
  return { match: `/${head}(?:${atStart}[\\/?].*${src})/i` }
}

export function parseGoggles(b: ListBuilder, each: EachLine): void {
  let header = true
  let clamped = 0
  let sitePatterns = 0
  each((line, n) => {
    const t = line.trim()
    if (t === '') {
      b.ignore()
      return
    }
    if (t.startsWith('!')) {
      if (header) readHeaderComment(t.slice(1), b.header)
      b.ignore()
      return
    }
    header = false
    const dollar = t.lastIndexOf('$')
    const pattern = (dollar === -1 ? t : t.slice(0, dollar)).trim()
    const options = dollar === -1 ? [] : t.slice(dollar + 1).split(',')
    let site: string | null = null
    let action: Intent | null = null
    for (const raw of options) {
      const o = raw.trim()
      if (o === '') continue
      const m = OPTION.exec(o)
      const name = (m?.[1] ?? '').toLowerCase()
      const value = m?.[2]
      if (!m) {
        b.skip(n, t, 'invalid option', o)
        return
      }
      if (name === 'inurl' && value === undefined) continue
      if (name === 'intitle' || name === 'indescription' || name === 'incontent') {
        b.skip(n, t, `unsupported target $${name}`)
        return
      }
      if (name === 'site') {
        if (site !== null) {
          b.skip(n, t, 'more than one site=')
          return
        }
        const host = normalizeHost((value ?? '').replace(/^\*?\./, ''))
        if (host === null) {
          b.skip(n, t, 'invalid site=', value)
          return
        }
        site = host
        continue
      }
      if (name !== 'boost' && name !== 'downrank' && name !== 'discard') {
        b.skip(n, t, `unknown option $${name}`)
        return
      }
      if (action !== null) {
        b.skip(n, t, 'more than one action')
        return
      }
      if (name === 'discard') {
        if (value !== undefined) {
          b.skip(n, t, 'invalid option', o)
          return
        }
        action = { type: 'discard' }
        continue
      }
      let weight = 1
      if (value !== undefined) {
        if (!/^\d{1,6}$/.test(value)) {
          b.skip(n, t, 'invalid strength', o)
          return
        }
        const v = Number(value)
        weight = Math.min(10, Math.max(1, v))
        if (weight !== v) clamped++
      }
      action = name === 'boost' ? { type: 'raise', weight } : { type: 'lower', weight }
    }
    const intent: Intent = action ?? { type: 'raise', weight: 1 }
    if (pattern === '' && site === null) {
      if (intent.type === 'discard') {
        b.allowlistMode = true
        b.ignore()
        return
      }
      b.skip(n, t, 'generic instruction without a pattern or site= (no effect)')
      return
    }
    if (pattern === '' && site !== null) {
      b.add(n, t, site, intent)
      return
    }
    if (site === null) {
      const m = urlPatternMatch(pattern)
      if ('error' in m) {
        b.skip(n, t, 'invalid pattern', m.error)
        return
      }
      b.add(n, t, m.match, intent)
      return
    }
    const m = sitePatternRegex(site, pattern)
    if ('error' in m) {
      b.skip(n, t, 'unsupported pattern with site=', m.error)
      return
    }
    if (m.match === '') {
      b.add(n, t, site, intent)
      return
    }
    sitePatterns++
    b.add(n, t, m.match, intent)
  })
  if (b.allowlistMode) {
    const kept = b.addAllowlistCompanions()
    b.warn(
      'generic $discard: this goggle keeps only what it matches (allowlist mode); apply it with a profile that sets default: block' +
        (kept > 0 ? ` (${kept} instruction(s) also allow what they match; discards are $important)` : ''),
    )
  }
  if (sitePatterns > 0) {
    b.warn(
      `${sitePatterns} instruction(s) combine a pattern with site=; the pattern is matched in the path and query only (approximate)`,
    )
  }
  if (clamped > 0) b.warn(`${clamped} strength(s) outside 1–10 were clamped`)
}
