// SPDX-License-Identifier: Apache-2.0
/**
 * Turning list syntax into search-hole match expressions that the engine
 * classifies the way the importer means them.
 */
import { classifyMatch, parseMatch } from '../../core/rules/match.ts'
import { urlPatternToRegex } from '../../core/rules/pattern.ts'

/**
 * A Goggles/ABP URL pattern (`*`, `^`, `|`, `||`, otherwise a substring) as a
 * match expression with the same meaning. Written as is when the engine reads
 * it as a URL pattern; a plain pattern the engine would read as a host, a
 * host + path or a regex (`example.com/ads`, `/blog/`) gets a neutral `*` at an
 * unanchored end; failing that, the pattern's own RE2 translation is used as a
 * case-insensitive regex. Returns the pattern error when it is not valid.
 */
export function urlPatternMatch(pattern: string): { match: string } | { error: string } {
  const direct = urlPatternToRegex(pattern)
  if (!direct.ok) return { error: direct.error }
  const candidates = [pattern]
  if (!pattern.startsWith('|')) candidates.push(`*${pattern}`)
  if (!pattern.endsWith('|')) candidates.push(`${pattern}*`)
  for (const c of candidates) {
    if (classifyMatch(c) === 'url_pattern' && parseMatch(c).ok) return { match: c }
  }
  return { match: `/${direct.source}/i` }
}

/**
 * Rewrites JavaScript regex syntax that RE2 spells differently (`\uXXXX` and
 * `\u{X}` → `\x{…}`). Anything else RE2 cannot run is left for the engine to
 * reject, so it becomes a counted skip.
 */
export function jsRegexSource(source: string): string {
  if (!source.includes('\\u')) return source
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = source[i + 1]
    if (n === 'u') {
      const hex4 = /^[0-9a-fA-F]{4}/.exec(source.slice(i + 2))
      if (hex4) {
        out += `\\x{${hex4[0]}}`
        i += 5
        continue
      }
      const braced = /^\{[0-9a-fA-F]{1,6}\}/.exec(source.slice(i + 2))
      if (braced) {
        out += `\\x${braced[0]}`
        i += 1 + braced[0].length
        continue
      }
    }
    out += c + (n ?? '')
    i++
  }
  return out
}

/** A regex rule from a JS-style source and flags; only `i` changes matching on a URL. */
export function regexMatch(source: string, caseInsensitive: boolean): string {
  return `/${jsRegexSource(source)}/${caseInsensitive ? 'i' : ''}`
}
