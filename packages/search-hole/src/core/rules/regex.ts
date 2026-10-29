// SPDX-License-Identifier: Apache-2.0
/**
 * Linear-time regex compilation via re2js only (ADR-0008 "Regex rules").
 * Lookarounds and backreferences are rejected with a clear reason before RE2
 * sees the pattern; RE2 then rejects anything else that is not linear-time.
 */
import { RE2JS } from 're2js'

/** ADR-0008 cap for `/…/` regex rules and profile regexes. */
export const MAX_REGEX_LENGTH = 1000

export type RegexResult = { ok: true; re: RE2JS } | { ok: false; error: string }

/**
 * Scans a regex source for constructs RE2 cannot run in linear time, skipping
 * escapes, `\Q…\E` literals and character classes. Returns a reason or null.
 */
export function findNonLinearSyntax(source: string): string | null {
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const n = source[i + 1]
      if (n === 'Q') {
        const end = source.indexOf('\\E', i + 2)
        if (end === -1) return null
        i = end + 1
        continue
      }
      if (!inClass && n !== undefined) {
        if (n >= '1' && n <= '9') return 'backreferences are not supported (linear-time regex only)'
        if (n === 'k' && "<'{".includes(source[i + 2] ?? '')) {
          return 'backreferences are not supported (linear-time regex only)'
        }
      }
      i++
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      inClass = true
      if (source[i + 1] === '^') i++
      if (source[i + 1] === ']') i++
      continue
    }
    if (c === '(' && source[i + 1] === '?') {
      const a = source[i + 2]
      const b = source[i + 3]
      if (a === '=' || a === '!') return 'lookahead is not supported (linear-time regex only)'
      if (a === '<' && (b === '=' || b === '!')) return 'lookbehind is not supported (linear-time regex only)'
    }
  }
  return null
}

/**
 * Compiles a user or list regex with re2js. `caseInsensitive` maps to the `i`
 * flag of `/…/i`. Never throws.
 */
export function compileRegex(source: string, caseInsensitive = false): RegexResult {
  if (source.length === 0) return { ok: false, error: 'empty regex' }
  if (source.length > MAX_REGEX_LENGTH) {
    return { ok: false, error: `regex is longer than ${MAX_REGEX_LENGTH} characters` }
  }
  const bad = findNonLinearSyntax(source)
  if (bad) return { ok: false, error: bad }
  try {
    return { ok: true, re: RE2JS.compile(source, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `invalid regex: ${msg}` }
  }
}

/** Escapes RE2 metacharacters so `text` matches literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}
