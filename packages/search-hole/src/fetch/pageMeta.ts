// SPDX-License-Identifier: Apache-2.0
/**
 * Light `<head>` scan for the fetcher: `<title>`, `og:title`, `<base href>`,
 * `<link rel=canonical>` and `<html lang>`. Stops at `<body>`.
 */
import { Parser } from 'htmlparser2'

export interface PageMeta {
  title: string | null
  ogTitle: string | null
  /** Raw canonical href (unresolved). */
  canonicalHref: string | null
  baseHref: string | null
  lang: string | null
  /** Target of `<meta http-equiv="refresh" content="N; url=…">` (unresolved). */
  refreshHref: string | null
}

const HEAD_LIMIT = 1024 * 1024
const CHUNK = 16 * 1024

/** Scans the document head for title, canonical link, base and language. */
export function scanPageMeta(html: string): PageMeta {
  const meta: PageMeta = {
    title: null,
    ogTitle: null,
    canonicalHref: null,
    baseHref: null,
    lang: null,
    refreshHref: null,
  }
  let inTitle = false
  let titleText = ''
  let done = false
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (done) return
        if (name === 'html' && attribs.lang && meta.lang === null)
          meta.lang = attribs.lang.trim().slice(0, 35)
        else if (name === 'title' && meta.title === null) inTitle = true
        else if (name === 'base' && attribs.href && meta.baseHref === null)
          meta.baseHref = attribs.href.trim()
        else if (name === 'link' && meta.canonicalHref === null && attribs.href) {
          const rels = (attribs.rel ?? '').toLowerCase().split(/\s+/)
          if (rels.includes('canonical')) meta.canonicalHref = attribs.href.trim()
        } else if (name === 'meta') {
          const key = (attribs.property ?? attribs.name ?? '').toLowerCase()
          if (key === 'og:title' && attribs.content && meta.ogTitle === null)
            meta.ogTitle = attribs.content.trim()
          const equiv = (attribs['http-equiv'] ?? '').toLowerCase()
          if (equiv === 'refresh' && meta.refreshHref === null) {
            const m = /^\s*\d*(?:\.\d+)?\s*[;,]\s*(?:url\s*=\s*)?['"]?([^'"\s]+)/i.exec(attribs.content ?? '')
            if (m?.[1]) meta.refreshHref = m[1]
          }
        } else if (name === 'body') done = true
      },
      ontext(text) {
        if (inTitle) titleText += text
      },
      onclosetag(name) {
        if (name === 'title' && inTitle) {
          inTitle = false
          meta.title = titleText.replace(/\s+/g, ' ').trim() || null
        } else if (name === 'head') done = true
      },
    },
    { decodeEntities: true },
  )
  for (let i = 0; i < html.length && i < HEAD_LIMIT && !done; i += CHUNK)
    parser.write(html.slice(i, i + CHUNK))
  if (inTitle && meta.title === null) meta.title = titleText.replace(/\s+/g, ' ').trim() || null
  return meta
}
