// SPDX-License-Identifier: Apache-2.0
/**
 * uBlacklist rulesets (ADR-0008 import mapping), written from the documented
 * syntax (docs/research/ublacklist.md); no uBlacklist code is used.
 *
 * | uBlacklist                     | search-hole                                   |
 * |--------------------------------|-----------------------------------------------|
 * | `*://*.d/*`                    | domain `d` (host and subdomains)              |
 * | `*://d/*`                      | exact host `=d`                               |
 * | `*://*.d/p/*`, `*://d/p/*`     | host + path prefix `d/p/`, `=d/p/`            |
 * | other match patterns           | URL pattern (`\|\|d/p`, `\|http*://d/p\|`), else an exact regex |
 * | `/re/flags`, `url/re/`, `u/re/` | regex (only `i` changes matching on a URL)    |
 * | `@rule`                        | `allow`                                       |
 * | `@N rule`                      | `raise N`, clamped to 1–10 (approximate)      |
 * | `title/…/`, expressions, `@if(…)` | skipped and counted                       |
 *
 * Optional YAML front matter between `---` lines supplies the header (`name`,
 * `license`, `homepage`, `expires`, …). Match-pattern paths are matched
 * case-insensitively when they become URL patterns (uBlacklist compares them
 * exactly); ports are not matched.
 */
import { parse as parseYaml } from 'yaml'
import { classifyMatch, parseMatch } from '../../core/rules/match.ts'
import { normalizeHost, normalizePath } from '../../core/rules/normalize.ts'
import { escapeRegex } from '../../core/rules/regex.ts'
import { EXCEPTION, type Intent, type ListBuilder, POSITIVE } from './builder.ts'
import { regexMatch } from './patterns.ts'
import { type EachLine, readHeaderComment, setHeaderField } from './text.ts'

/** Front matter longer than this is not front matter. */
const MAX_FRONT_MATTER_LINES = 200
const MATCH_PATTERN = /^(\*|https?):\/\/([^/]*)(\/.*)?$/i
const EXPRESSION = /^!?\(?\s*\$?[a-z_][a-z0-9_]*\s*(?:=~|\^=|\$=|\*=|=)/i

/** Index of the `/` that closes the regex literal starting at `s[0]`, or -1. */
export function regexLiteralEnd(s: string): number {
  let inClass = false
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') i++
    else if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') inClass = true
    else if (c === '/') return i
  }
  return -1
}

type Mapped = { match: string } | { reason: string; detail?: string }

/** A WebExtensions-style match pattern (`*://*.d/path*`) as a search-hole match. */
export function matchPatternToMatch(token: string): Mapped {
  const mp = MATCH_PATTERN.exec(token)
  if (!mp) return { reason: 'not a uBlacklist rule' }
  const scheme = (mp[1] ?? '*').toLowerCase()
  const hostSpec = mp[2] ?? ''
  const path = mp[3]
  if (path === undefined) return { reason: 'invalid match pattern', detail: 'a match pattern needs a path' }
  const anyHost = hostSpec === '*'
  const sub = hostSpec.startsWith('*.')
  let host = ''
  if (!anyHost) {
    const h = normalizeHost(sub ? hostSpec.slice(2) : hostSpec)
    if (h === null) return { reason: 'invalid host name', detail: hostSpec }
    host = h
  }
  const anyScheme = scheme === '*'
  // Host (and subdomains) or exact host: the fast lanes.
  if (!anyHost && anyScheme && path === '/*') return { match: sub ? host : `=${host}` }
  // Host + path prefix, when the prefix is a plain prefix (ends in / ? & =) and already normalised.
  if (!anyHost && anyScheme && path.indexOf('*') === path.length - 1) {
    const prefix = path.slice(0, -1)
    if ('/?&='.includes(prefix[prefix.length - 1] ?? '') && normalizePath(prefix) === prefix) {
      const m = `${sub ? '' : '='}${host}${prefix}`
      if (classifyMatch(m) === 'host_path') return { match: m }
    }
  }
  // URL pattern: the match-pattern path must match the whole path and query.
  if (!/[\^|]/.test(path)) {
    const rest = path.endsWith('*') ? path.slice(0, -1) : `${path}|`
    let head: string | null = null
    if (anyHost) head = `|${anyScheme ? 'http*' : scheme}://*`
    else if (sub && anyScheme) head = `||${host}`
    else if (!sub) head = `|${anyScheme ? 'http*' : scheme}://${host}`
    if (head !== null) {
      const p = head + rest
      if (classifyMatch(p) === 'url_pattern' && parseMatch(p).ok) return { match: p }
    }
  }
  // Exact regex (case-sensitive path, as uBlacklist matches it).
  const open = path.endsWith('*')
  const body = open ? path.slice(0, -1) : path
  let re = `^${anyScheme ? 'https?' : scheme}:\\/\\/`
  re += anyHost ? '[^/?#]*' : `${sub ? '(?:[^/?#:]*\\.)?' : ''}${escapeRegex(host)}`
  for (const ch of body) {
    if (ch === '*') re += '.*'
    else if (ch === '/') re += '\\/'
    else re += escapeRegex(ch === ' ' || ch.charCodeAt(0) > 0x7f ? encodeURIComponent(ch) : ch)
  }
  if (!open) re += '$'
  return { match: `/${re}/` }
}

export function parseUblacklist(b: ListBuilder, each: EachLine): void {
  let front: Array<[string, number]> | null = null
  let header = true
  let highlights = 0
  let clamped = 0

  const ruleLine = (line: string, n: number): void => {
    const t = line.trim()
    if (t === '') {
      b.ignore()
      return
    }
    if (t.startsWith('#')) {
      if (header) readHeaderComment(t.slice(1), b.header)
      b.ignore()
      return
    }
    header = false
    let rest = t
    let intent: Intent = POSITIVE
    const at = /^@(\d+)?\s*/.exec(rest)
    if (at) {
      rest = rest.slice(at[0].length)
      if (at[1] !== undefined) {
        const raw = Number(at[1])
        const weight = Math.min(10, Math.max(1, raw))
        highlights++
        if (weight !== raw) clamped++
        intent = { type: 'raise', weight }
      } else intent = EXCEPTION
    }
    if (rest === '') {
      b.skip(n, t, 'not a uBlacklist rule')
      return
    }
    if (/^(?:title|t)\//.test(rest)) {
      b.skip(n, t, 'title rule (not supported)')
      return
    }
    const reBody = /^(?:url|u)\//.test(rest) ? rest.slice(rest.indexOf('/')) : rest
    let token: string
    let tail: string
    if (reBody.startsWith('/')) {
      const end = regexLiteralEnd(reBody)
      if (end < 0) {
        b.skip(n, t, 'invalid regex', 'the regex has no closing /')
        return
      }
      const flags = /^[a-z]*/.exec(reBody.slice(end + 1))?.[0] ?? ''
      if (/[^imsu]/.test(flags)) {
        b.skip(n, t, 'invalid regex', `unsupported flags '${flags}'`)
        return
      }
      token = regexMatch(reBody.slice(1, end), flags.includes('i'))
      tail = reBody.slice(end + 1 + flags.length).trim()
    } else {
      const sp = rest.search(/[\s#]/)
      token = sp === -1 ? rest : rest.slice(0, sp)
      tail = sp === -1 ? '' : rest.slice(sp).trim()
      if (token !== '<all_urls>' && !MATCH_PATTERN.test(token)) {
        if (EXPRESSION.test(rest)) {
          b.skip(n, t, 'expression rule (not supported)')
          return
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
          b.skip(n, t, 'unsupported scheme (http, https or *)')
          return
        }
        b.skip(n, t, 'not a uBlacklist rule')
        return
      }
    }
    if (tail !== '' && !tail.startsWith('#')) {
      if (tail.startsWith('@if')) {
        b.skip(n, t, 'conditional rule (@if) not supported')
        return
      }
      b.skip(n, t, 'unexpected text after the rule')
      return
    }
    if (token.startsWith('/')) {
      b.add(n, t, token, intent)
      return
    }
    if (token === '<all_urls>') {
      b.skip(n, t, 'matches every URL')
      return
    }
    const mapped = matchPatternToMatch(token)
    if ('reason' in mapped) {
      b.skip(n, t, mapped.reason, mapped.detail)
      return
    }
    b.add(n, t, mapped.match, intent)
  }

  /** Front matter that never closed is read as rules after all. */
  const flushFront = (): void => {
    const lines = front ?? []
    front = null
    b.warn('the front matter opened with --- is not closed; its lines were read as rules')
    b.ignore()
    for (const [line, n] of lines.slice(1)) ruleLine(line, n)
  }

  each((line, n) => {
    if (n === 1 && line.trim() === '---') {
      front = [[line, n]]
      return
    }
    if (front !== null) {
      if (line.trim() === '---') {
        readFrontMatter(
          front
            .slice(1)
            .map(([l]) => l)
            .join('\n'),
          b,
        )
        for (let i = 0; i <= front.length; i++) b.ignore()
        front = null
        return
      }
      front.push([line, n])
      if (front.length <= MAX_FRONT_MATTER_LINES) return
      flushFront()
      return
    }
    ruleLine(line, n)
  })
  if (front !== null) flushFront()

  if (highlights > 0) {
    b.warn(
      `${highlights} highlight rule(s) (@N) imported as raise N: approximate, since uBlacklist colours highlighted results and does not rank them` +
        (clamped > 0 ? `; ${clamped} weight(s) clamped to 1–10` : ''),
    )
  }
}

function readFrontMatter(text: string, b: ListBuilder): void {
  let v: unknown
  try {
    v = parseYaml(text, { maxAliasCount: 10 })
  } catch {
    b.warn('the front matter is not valid YAML; its fields were ignored')
    return
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' || typeof val === 'number') setHeaderField(k, String(val), b.header)
  }
}
