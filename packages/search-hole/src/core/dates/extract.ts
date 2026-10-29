// SPDX-License-Identifier: Apache-2.0
/**
 * Page date extraction, ADR-0011 chain rows 2–7. Pure: htmlparser2 only, the
 * caller supplies the URL, the HTTP `Last-Modified` value and the fetch time.
 *
 * Every source is kept (nothing is overwritten); exact duplicates of the same
 * method, kind and instant are dropped. Output is ordered best first: chain
 * row, then specificity (JSON-LD article types before page types), then
 * document order.
 */
import { Parser } from 'htmlparser2'
import type { Confidence, DateKind, FoundDate } from '../../shared/types.ts'
import { jsonLdDateCandidates } from './jsonld.ts'
import { parseStrictDate } from './parse.ts'
import { extractUrlDate } from './urlDates.ts'

/** ADR-0011: scan the whole `<head>` plus this much of `<body>` (UTF-16 code units of the decoded page). */
export const BODY_SCAN_LIMIT = 512 * 1024
/** Safety bound for a `<head>` that is never closed. */
const HEAD_SCAN_LIMIT = 2 * 1024 * 1024
const FEED_CHUNK = 16 * 1024
const MAX_LD_SCRIPTS = 20
const MAX_LD_CHARS = 1024 * 1024
const MAX_TEXT_VALUE = 100
/** ADR-0011 row 7: a Last-Modified this close to the fetch time is a dynamic page sending "now". */
export const LAST_MODIFIED_IGNORE_WINDOW_MS = 5 * 60_000

export interface PageDateContext {
  /** Final URL of the page (after redirects); used for URL path dates. */
  url: string
  /** Raw HTTP `Last-Modified` header value, if any. */
  httpLastModified?: string
  /** Fetch time, epoch ms. Also the reference "now" for the future-date check. */
  fetchedAt: number
}

interface Candidate {
  raw: string
  kind: DateKind
  method: string
  confidence: Confidence
  row: number
  rank: number
  order: number
}

const OG_PROPERTIES: Readonly<Record<string, DateKind>> = {
  'article:published_time': 'published',
  'article:modified_time': 'modified',
  'og:updated_time': 'modified',
}

const META_NAMES: Readonly<Record<string, DateKind>> = {
  date: 'published',
  'dc.date': 'published',
  'dcterms.created': 'published',
  'dcterms.modified': 'modified',
  'last-modified': 'modified',
  'article.published': 'published',
  'sailthru.date': 'published',
  'parsely-pub-date': 'published',
}

const ITEMPROP_KINDS: Readonly<Record<string, DateKind>> = {
  datePublished: 'published',
  dateModified: 'modified',
}

function itempropKind(attr: string | undefined): { kind: DateKind; prop: string } | null {
  if (!attr) return null
  for (const token of attr.split(/\s+/)) {
    const kind = ITEMPROP_KINDS[token]
    if (kind) return { kind, prop: token }
  }
  return null
}

/** Collects raw candidates for rows 2–5 from the markup. */
function scanMarkup(html: string): Candidate[] {
  const out: Candidate[] = []
  let order = 0
  const push = (c: Omit<Candidate, 'order'>): void => {
    out.push({ ...c, order: order++ })
  }

  let headOpen = false
  let headEnd: number | null = null
  let bodyStart: number | null = null
  let sectionDepth = 0
  let timeTaken = false
  let ld: string | null = null
  let ldCount = 0
  let capture: { tag: string; nest: number; text: string; kind: DateKind; prop: string } | null = null

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'head') headOpen = true
        else if (name === 'body' && bodyStart === null) bodyStart = parser.startIndex
        else if (name === 'article' || name === 'header') sectionDepth++

        if (capture && name === capture.tag) capture.nest++

        if (name === 'script') {
          const type = (attribs.type ?? '').trim().toLowerCase()
          if (type.startsWith('application/ld+json') && ldCount < MAX_LD_SCRIPTS) ld = ''
          return
        }

        if (name === 'meta') {
          const content = attribs.content
          if (content !== undefined) {
            const key = (attribs.property ?? attribs.name ?? '').trim().toLowerCase()
            const ogKind = OG_PROPERTIES[key]
            if (ogKind) {
              const method = key.startsWith('og:') ? key : `og:${key}`
              push({ raw: content, kind: ogKind, method, confidence: 'high', row: 3, rank: 0 })
            }
            const metaKind = META_NAMES[key]
            if (metaKind) {
              push({
                raw: content,
                kind: metaKind,
                method: `meta:${key}`,
                confidence: 'medium',
                row: 4,
                rank: 0,
              })
            }
            const equiv = (attribs['http-equiv'] ?? '').trim().toLowerCase()
            if (equiv === 'last-modified' && !metaKind) {
              push({
                raw: content,
                kind: 'modified',
                method: 'meta:last-modified',
                confidence: 'medium',
                row: 4,
                rank: 0,
              })
            }
          }
        }

        const prop = itempropKind(attribs.itemprop)
        if (prop) {
          const value = attribs.content ?? attribs.datetime
          if (value !== undefined) {
            push({
              raw: value,
              kind: prop.kind,
              method: `itemprop:${prop.prop}`,
              confidence: 'medium',
              row: 4,
              rank: 0,
            })
          } else if (!capture && name !== 'meta') {
            capture = { tag: name, nest: 0, text: '', kind: prop.kind, prop: prop.prop }
          }
        }

        if (name === 'time' && !timeTaken && sectionDepth > 0 && attribs.datetime !== undefined && !prop) {
          timeTaken = true
          push({
            raw: attribs.datetime,
            kind: 'published',
            method: 'time:datetime',
            confidence: 'medium',
            row: 5,
            rank: 0,
          })
        }
      },
      ontext(text) {
        if (ld !== null && ld.length < MAX_LD_CHARS) ld += text
        if (capture && capture.text.length <= MAX_TEXT_VALUE) capture.text += text
      },
      onclosetag(name) {
        if (name === 'head' && headEnd === null) {
          headOpen = false
          headEnd = parser.endIndex
        } else if ((name === 'article' || name === 'header') && sectionDepth > 0) sectionDepth--

        if (name === 'script' && ld !== null) {
          for (const c of jsonLdDateCandidates(ld)) {
            push({ raw: c.raw, kind: c.kind, method: c.method, confidence: 'high', row: 2, rank: c.rank })
          }
          ld = null
          ldCount++
        }

        if (capture && name === capture.tag) {
          if (capture.nest > 0) capture.nest--
          else {
            const text = capture.text.trim()
            if (text && text.length <= MAX_TEXT_VALUE) {
              push({
                raw: text,
                kind: capture.kind,
                method: `itemprop:${capture.prop}`,
                confidence: 'medium',
                row: 4,
                rank: 0,
              })
            }
            capture = null
          }
        }
      },
    },
    { decodeEntities: true },
  )

  const limitReached = (pos: number): boolean => {
    if (bodyStart !== null) return pos > bodyStart + BODY_SCAN_LIMIT
    if (headEnd !== null) return pos > headEnd + BODY_SCAN_LIMIT
    if (headOpen) return pos > HEAD_SCAN_LIMIT
    return pos > BODY_SCAN_LIMIT
  }

  for (let i = 0; i < html.length; i += FEED_CHUNK) {
    parser.write(html.slice(i, i + FEED_CHUNK))
    if (limitReached(i + FEED_CHUNK)) break
  }
  return out
}

function lastModified(raw: string | undefined, fetchedAt: number): FoundDate | null {
  if (raw === undefined) return null
  const parsed = parseStrictDate(raw, { now: fetchedAt })
  if (!parsed || Math.abs(parsed.ms - fetchedAt) <= LAST_MODIFIED_IGNORE_WINDOW_MS) return null
  return {
    value: parsed.value,
    kind: 'modified',
    method: 'http:last-modified',
    confidence: 'low',
    tzAssumed: parsed.tzAssumed,
  }
}

/**
 * Extracts typed page dates from HTML (ADR-0011 rows 2–7). `html` may be empty
 * (non-HTML responses still get URL-path and Last-Modified dates).
 */
export function extractPageDates(html: string, ctx: PageDateContext): FoundDate[] {
  const candidates = html ? scanMarkup(html) : []
  candidates.sort((a, b) => a.row - b.row || a.rank - b.rank || a.order - b.order)

  const out: FoundDate[] = []
  const seen = new Set<string>()
  const add = (d: FoundDate): void => {
    const key = `${d.method}|${d.kind}|${d.value}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(d)
  }

  for (const c of candidates) {
    const parsed = parseStrictDate(c.raw, { now: ctx.fetchedAt })
    if (!parsed) continue
    add({
      value: parsed.value,
      kind: c.kind,
      method: c.method,
      confidence: c.confidence,
      tzAssumed: parsed.tzAssumed,
    })
  }
  const fromUrl = extractUrlDate(ctx.url, ctx.fetchedAt)
  if (fromUrl) add(fromUrl)
  const fromHttp = lastModified(ctx.httpLastModified, ctx.fetchedAt)
  if (fromHttp) add(fromHttp)
  return out
}
