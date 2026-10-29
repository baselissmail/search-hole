// SPDX-License-Identifier: Apache-2.0
/**
 * Goggles/ABP-style URL patterns (ADR-0008 "URL patterns"), translated to RE2.
 *
 * - `*` matches any run of characters, including none. In a pattern anchored
 *   with `|scheme://` (or `||`), a `*` written in the scheme or host stays inside
 *   it, so `|https://*.example.com/` can't be satisfied by
 *   `https://evil.example/x.example.com/` (this matters most for `allow` rules).
 * - `^` is Goggles' separator: end of URL, or any character other than a letter,
 *   digit, `_`, `.`, `%` or `-`.
 * - A leading `|` anchors at the URL start, a trailing `|` at the URL end.
 * - A leading `||` is ABP's host anchor: the host itself or any subdomain
 *   (label boundary), so pasted `||example.com^` rules behave as their authors expect.
 * - Anything else is literal, and an unanchored pattern matches anywhere in the URL.
 *
 * Matching is case-insensitive, as in ABP. Non-ASCII characters and spaces are
 * percent-encoded (UTF-8) to match the WHATWG serialisation of result URLs; an
 * IDN host inside a pattern must be written in punycode.
 */
import { escapeRegex } from './regex.ts'

export const MAX_PATTERN_LENGTH = 500
export const MAX_PATTERN_WILDCARDS = 2
export const MAX_PATTERN_SEPARATORS = 2

/** RE2 source for Goggles' `^`. */
export const SEPARATOR_RE = '(?:[^A-Za-z0-9_.%\\-]|$)'
/** RE2 source for ABP's `||`: scheme, then the host or any subdomain of it. */
const HOST_ANCHOR_RE = '^[a-z][a-z0-9+.\\-]*://(?:[^/?#:]*\\.)?'
/** RE2 source for `*` by where it stands in the pattern. */
const WILDCARD_RE = { scheme: '[a-z0-9+.\\-]*', host: '[^/?#]*', rest: '.*' } as const

export type PatternResult =
  | { ok: true; source: string; literal: string; hasPath: boolean }
  | { ok: false; error: string }

const count = (s: string, ch: string): number => s.split(ch).length - 1

/**
 * Translates a URL pattern into an RE2 source (compile it case-insensitively).
 * `literal` is the longest literal run, lower-cased, usable as a cheap substring
 * prefilter before running the regex.
 */
export function urlPatternToRegex(pattern: string): PatternResult {
  if (pattern.length === 0) return { ok: false, error: 'empty URL pattern' }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `URL pattern is longer than ${MAX_PATTERN_LENGTH} characters` }
  }
  if (count(pattern, '*') > MAX_PATTERN_WILDCARDS) {
    return { ok: false, error: `URL pattern has more than ${MAX_PATTERN_WILDCARDS} '*'` }
  }
  if (count(pattern, '^') > MAX_PATTERN_SEPARATORS) {
    return { ok: false, error: `URL pattern has more than ${MAX_PATTERN_SEPARATORS} '^'` }
  }
  let body = pattern
  let head = ''
  if (body.startsWith('||')) {
    head = HOST_ANCHOR_RE
    body = body.slice(2)
  } else if (body.startsWith('|')) {
    head = '^'
    body = body.slice(1)
  }
  let tail = ''
  if (body.endsWith('|') && body.length > 0) {
    tail = '$'
    body = body.slice(0, -1)
  }
  if (body.length === 0) return { ok: false, error: 'URL pattern has no content besides anchors' }
  if (body.replace(/[*^]/g, '').length === 0) {
    return { ok: false, error: 'URL pattern would match every URL' }
  }
  // Start-anchored patterns keep `*` inside the part of the URL it was written in: the scheme,
  // or the host. So `|https://*.d/` matches subdomains of d, never `https://evil.example/x.d/`.
  const scheme = head === '^' ? /^[a-z*][a-z0-9+.*-]*:\/\//i.exec(body) : null
  let region: 'scheme' | 'host' | 'rest' = scheme ? 'scheme' : head === HOST_ANCHOR_RE ? 'host' : 'rest'
  const hostStart = scheme ? scheme[0].length : 0
  let out = head
  let literal = ''
  let run = ''
  let at = 0
  for (const ch of body) {
    if (region === 'scheme' && at >= hostStart) region = 'host'
    if (region === 'host' && (ch === '/' || ch === '?' || ch === '#')) region = 'rest'
    at += ch.length
    if (ch === '*' || ch === '^') {
      if (run.length > literal.length) literal = run
      run = ''
      out += ch === '^' ? SEPARATOR_RE : WILDCARD_RE[region]
      if (ch === '^' && region === 'host') region = 'rest'
    } else {
      // Result URLs are percent-encoded by the WHATWG parser, so encode the pattern the same way.
      const lit = ch === ' ' || ch.charCodeAt(0) > 0x7f ? encodeURIComponent(ch) : ch
      run += lit
      out += escapeRegex(lit)
    }
  }
  if (run.length > literal.length) literal = run
  out += tail
  const afterScheme = body.replace(/^[a-z*][a-z0-9+.*-]*:\/\//i, '')
  return { ok: true, source: out, literal: literal.toLowerCase(), hasPath: afterScheme.includes('/') }
}
