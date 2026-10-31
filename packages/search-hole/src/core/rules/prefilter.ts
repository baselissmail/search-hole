// SPDX-License-Identifier: Apache-2.0
/**
 * A sound prefilter for URL-pattern and regex rules, so a lookup does not have
 * to run every pattern against every URL (ADR-0008 "Compiled matcher").
 *
 * Each pattern or regex entry goes into exactly one bucket:
 *
 * 1. **host**: the entry can only match when the URL's host is a given host or
 *    one of its subdomains (`||example.com^…`, `|https://*.example.com/…`,
 *    `|http*://example.com/…`). Looked up by walking the host's label suffixes.
 * 2. **gram**: the entry needs a literal (one of a URL pattern's `runs`, or a
 *    literal run that every match of a regex contains); it is filed under one
 *    3- or 4-character gram of that literal (the rarest one so far). Looked up
 *    with the grams of the lower-cased URL, then confirmed with `includes`.
 * 3. **rest**: nothing could be extracted; tested linearly.
 *
 * The prefilter only narrows the candidates: every candidate is still tested
 * with `testMatch`, so a lookup returns exactly the entries a linear scan
 * would. Soundness relies on two facts about normalised result URLs: the host
 * is lower-case and the href is ASCII (WHATWG serialisation). URLs whose host
 * has other characters (`ex!ample.com` is a valid WHATWG host), IPv6 literals,
 * and non-ASCII hrefs fall back to a linear scan, so they are never missed.
 */
import type { ParsedMatch } from './match.ts'
import type { NormalizedUrl } from './normalize.ts'

/** Characters of a host this prefilter can reason about (IPv4 included). */
const PLAIN_HOST = /^[a-z0-9_.-]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the point
const NON_ASCII = /[^\x00-\x7f]/
/** A dotted host literal with no empty labels. */
const HOST_LITERAL = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*/
/** A pattern scheme part (as `urlPatternToRegex` reads it), `*` allowed. */
const PATTERN_SCHEME = /^[a-z*][a-z0-9+.*-]*:\/\//
const REGEX_TEXT = /^\/(.+)\/(i?)$/s

/**
 * The host (or host suffix) a URL pattern requires, or null. Only patterns
 * anchored on the host qualify, and only when the host literal is followed by
 * a character that cannot occur in a plain host (`^`, `/`, `:`, `?`, or a final
 * `|`), so the URL's host must equal the literal or end with `.` + literal.
 */
export function patternHostKey(pattern: string): string | null {
  const p = pattern.toLowerCase()
  let rest: string
  if (p.startsWith('||')) rest = p.slice(2)
  else if (p.startsWith('|')) {
    const scheme = PATTERN_SCHEME.exec(p.slice(1))
    if (!scheme) return null
    rest = p.slice(1 + scheme[0].length)
    if (rest.startsWith('*.')) rest = rest.slice(2)
    else if (rest.startsWith('*')) return null
  } else return null
  const host = HOST_LITERAL.exec(rest)?.[0]
  if (!host) return null
  const next = rest[host.length]
  if (next === '^' || next === '/' || next === ':' || next === '?') return host
  if (next === '|' && rest.length === host.length + 1) return host
  return null
}

/**
 * Literal runs (lower-cased, ASCII only) that every match of an RE2 regex
 * contains, or null when the regex has a top-level alternation or a construct
 * this conservative scanner does not understand. Lower-casing is sound for
 * case-sensitive and case-insensitive regexes alike, because it is compared
 * with the lower-cased ASCII href.
 */
export function requiredLiterals(source: string): string[] | null {
  const runs: string[] = []
  let cur = ''
  let lastLiteral = false
  const flush = (): void => {
    if (cur.length > 0) runs.push(cur)
    cur = ''
    lastLiteral = false
  }
  /** Index just past the class that starts at `i` (a `[`), or -1. */
  const skipClass = (i: number): number => {
    let j = i + 1
    if (source[j] === '^') j++
    if (source[j] === ']') j++
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') j += 2
      else if (c === '[' && source[j + 1] === ':') {
        const end = source.indexOf(':]', j + 2)
        if (end === -1) return -1
        j = end + 2
      } else if (c === ']') return j + 1
      else j++
    }
    return -1
  }
  /** Index just past the group that starts at `i` (a `(`), or -1. */
  const skipGroup = (i: number): number => {
    let depth = 0
    let j = i
    while (j < source.length) {
      const c = source[j]
      if (c === '\\') {
        if (source[j + 1] === 'Q') {
          const end = source.indexOf('\\E', j + 2)
          if (end === -1) return -1
          j = end + 2
        } else j += 2
        continue
      }
      if (c === '[') {
        j = skipClass(j)
        if (j === -1) return -1
        continue
      }
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
    return -1
  }
  let i = 0
  while (i < source.length) {
    const c = source[i] as string
    if (c === '|') return null
    if (c === '*' || c === '?' || c === '+' || c === '{') {
      let min: number
      let end = i + 1
      if (c === '{') {
        const m = /^\{(\d+)(,\d*)?\}/.exec(source.slice(i))
        if (!m) return null
        min = Number(m[1])
        end = i + m[0].length
      } else min = c === '+' ? 1 : 0
      if (lastLiteral) {
        if (min === 0) cur = cur.slice(0, -1)
        flush()
      }
      lastLiteral = false
      if (source[end] === '?') end++
      i = end
      continue
    }
    if (c === '\\') {
      const n = source[i + 1]
      if (n === undefined) return null
      if (/[!-/:-@[-`{-~]/.test(n)) {
        cur += n
        lastLiteral = true
        i += 2
        continue
      }
      flush()
      if (n === 'Q') {
        const end = source.indexOf('\\E', i + 2)
        i = end === -1 ? source.length : end + 2
      } else if (n === 'p' || n === 'P' || n === 'x') {
        if (source[i + 2] === '{') {
          const end = source.indexOf('}', i + 3)
          if (end === -1) return null
          i = end + 1
        } else i += n === 'x' ? 4 : 3
      } else if (n >= '0' && n <= '7') {
        // Octal escape: up to two more octal digits belong to it.
        i += 2
        for (let k = 0; k < 2 && (source[i] ?? '') >= '0' && (source[i] ?? '') <= '7'; k++) i++
      } else i += 2
      continue
    }
    if (c === '(') {
      flush()
      const end = skipGroup(i)
      if (end === -1) return null
      i = end
      continue
    }
    if (c === '[') {
      flush()
      const end = skipClass(i)
      if (end === -1) return null
      i = end
      continue
    }
    if (c === ')') return null
    const code = c.charCodeAt(0)
    if (c === '.' || c === '^' || c === '$' || c === ']' || c === '}' || code < 0x20 || code > 0x7e) {
      flush()
      i++
      continue
    }
    cur += c.toLowerCase()
    lastLiteral = true
    i++
  }
  flush()
  return runs
}

/** Gram keys pack 7-bit characters: 3 grams in 21 bits, 4 grams in 28 bits. */
function gramKey(s: string, at: number, len: 3 | 4): number {
  let k = 0
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(at + i)
    if (c > 0x7f) return -1
    k = (k << 7) | c
  }
  return k
}

/** Grams so common in result URLs that a bucket under them would be hit by almost every lookup. */
const COMMON_GRAMS: ReadonlySet<string> = (() => {
  const s = new Set<string>()
  for (const w of [
    'https://www.',
    'http://',
    '.com/',
    '.org/',
    '.net/',
    '.html',
    '.php',
    '/index',
    '/wiki/',
  ]) {
    for (let i = 0; i + 3 <= w.length; i++) s.add(w.slice(i, i + 3))
    for (let i = 0; i + 4 <= w.length; i++) s.add(w.slice(i, i + 4))
  }
  return s
})()

interface Candidate<E> {
  entry: E
  /** Lower-case literal that every match contains; confirmed with `includes` before the full test. */
  needle: string
}

interface Bucket<E> {
  items: Candidate<E>[]
  /** Lookup epoch that last visited this bucket (a URL repeats grams). */
  mark: number
}

export interface PrefilterStats {
  host: number
  gram: number
  rest: number
}

/** Pattern/regex entries bucketed by required host or literal (see the module comment). */
export class PatternIndex<E extends { match: ParsedMatch }> {
  private readonly byHost = new Map<string, E[]>()
  private readonly gram3 = new Map<number, Bucket<E>>()
  private readonly gram4 = new Map<number, Bucket<E>>()
  private readonly rest: E[] = []
  private readonly all: E[] = []
  private epoch = 0
  readonly stats: PrefilterStats = { host: 0, gram: 0, rest: 0 }

  get size(): number {
    return this.all.length
  }

  add(e: E): void {
    const m = e.match
    if (m.kind !== 'url_pattern' && m.kind !== 'regex') throw new Error('PatternIndex holds patterns only')
    this.all.push(e)
    if (m.kind === 'url_pattern') {
      const host = patternHostKey(m.canonical)
      if (host !== null) {
        const list = this.byHost.get(host)
        if (list) list.push(e)
        else this.byHost.set(host, [e])
        this.stats.host++
        return
      }
      if (this.addByGram(e, m.runs)) return
    } else {
      const src = REGEX_TEXT.exec(m.canonical)?.[1]
      const runs = src === undefined ? null : requiredLiterals(src)
      if (runs && this.addByGram(e, runs)) return
    }
    this.rest.push(e)
    this.stats.rest++
  }

  /** Files `e` under the rarest gram of `runs`, to be confirmed with the run that holds the gram. */
  private addByGram(e: E, runs: readonly string[]): boolean {
    let best: { map: Map<number, Bucket<E>>; key: number; run: string; score: number } | null = null
    for (const run of runs) {
      const len = run.length >= 4 ? 4 : run.length === 3 ? 3 : 0
      if (len === 0) continue
      const map = len === 4 ? this.gram4 : this.gram3
      for (let i = 0; i + len <= run.length; i++) {
        const key = gramKey(run, i, len)
        if (key < 0) continue
        const score =
          (map.get(key)?.items.length ?? 0) +
          (COMMON_GRAMS.has(run.slice(i, i + len)) ? 1e9 : 0) +
          (len === 3 ? 0.5 : 0)
        if (best === null || score < best.score) best = { map, key, run, score }
      }
    }
    if (best === null) return false
    let bucket = best.map.get(best.key)
    if (!bucket) {
      bucket = { items: [], mark: 0 }
      best.map.set(best.key, bucket)
    }
    bucket.items.push({ entry: e, needle: best.run })
    this.stats.gram++
    return true
  }

  /**
   * Pushes every entry whose match accepts `url` onto `out` (in no particular
   * order). `test` is the full match test; `lowerHref` is `url.href.toLowerCase()`.
   */
  collect(url: NormalizedUrl, lowerHref: string, test: (e: E) => boolean, out: E[]): void {
    if (this.all.length === 0) return
    if (!PLAIN_HOST.test(url.host) || NON_ASCII.test(lowerHref)) {
      for (const e of this.all) if (test(e)) out.push(e)
      return
    }
    if (this.byHost.size > 0) {
      let suffix = url.host
      for (;;) {
        const list = this.byHost.get(suffix)
        if (list) for (const e of list) if (test(e)) out.push(e)
        const dot = suffix.indexOf('.')
        if (dot === -1) break
        suffix = suffix.slice(dot + 1)
      }
    }
    const epoch = ++this.epoch
    if (this.gram4.size > 0) this.scan(this.gram4, 4, lowerHref, epoch, test, out)
    if (this.gram3.size > 0) this.scan(this.gram3, 3, lowerHref, epoch, test, out)
    for (const e of this.rest) if (test(e)) out.push(e)
  }

  private scan(
    map: Map<number, Bucket<E>>,
    len: 3 | 4,
    s: string,
    epoch: number,
    test: (e: E) => boolean,
    out: E[],
  ): void {
    const mask = len === 4 ? 0xfffffff : 0x1fffff
    let key = 0
    for (let i = 0; i < s.length; i++) {
      key = ((key << 7) | s.charCodeAt(i)) & mask
      if (i + 1 < len) continue
      const bucket = map.get(key)
      if (bucket === undefined || bucket.mark === epoch) continue
      bucket.mark = epoch
      for (const c of bucket.items) {
        if (s.includes(c.needle) && test(c.entry)) out.push(c.entry)
      }
    }
  }
}
