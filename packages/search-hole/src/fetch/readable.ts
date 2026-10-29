// SPDX-License-Identifier: Apache-2.0
/**
 * Readable text (ADR-0011 point 7): `@mozilla/readability` over `linkedom`,
 * both loaded lazily so they stay out of the startup path (ADR-0002). When
 * Readability finds no article (or fails), htmlparser2 text extraction over
 * the whole page is the fallback.
 */
import { countHiddenTextBlocks, htmlToText } from './htmlText.ts'

export type ExtractionMethod = 'readability' | 'html-text'

export interface ReadableResult {
  text: string
  /** Readability's cleaned title, when it produced one. */
  title: string | null
  method: ExtractionMethod
  /** Hidden elements with real text in the source page (possible prompt injection), all dropped. */
  hiddenTextBlocks: number
}

export interface ReadableOptions {
  /** Base for relative links. */
  baseUrl: string
  links?: boolean
  /** Below this many characters Readability's output is treated as "nothing". Default 200. */
  minArticleChars?: number
  /** Readability `maxElemsToParse`; larger documents go straight to the fallback. Default 60 000. */
  maxElements?: number
}

interface Article {
  title?: string | null
  content?: string | null
  textContent?: string | null
}
type ReadabilityCtor = new (
  doc: unknown,
  opts: {
    maxElemsToParse?: number
    charThreshold?: number
    keepClasses?: boolean
    classesToPreserve?: string[]
  },
) => { parse(): Article | null }
type ParseHtml = (html: string) => { document: unknown }

let loaded: Promise<{ Readability: ReadabilityCtor; parseHTML: ParseHtml }> | null = null

async function loadLibraries(): Promise<{ Readability: ReadabilityCtor; parseHTML: ParseHtml }> {
  loaded ??= Promise.all([import('@mozilla/readability'), import('linkedom')]).then(([r, l]) => {
    const rmod = r as unknown as {
      Readability?: ReadabilityCtor
      default?: { Readability?: ReadabilityCtor }
    }
    const lmod = l as unknown as { parseHTML?: ParseHtml }
    const Readability = rmod.Readability ?? rmod.default?.Readability
    if (!Readability || !lmod.parseHTML) throw new Error('readability/linkedom exports not found')
    return { Readability, parseHTML: lmod.parseHTML }
  })
  return loaded
}

/** Extracts the main readable text of an HTML page. Never throws. */
export async function extractReadable(html: string, opts: ReadableOptions): Promise<ReadableResult> {
  const minChars = opts.minArticleChars ?? 200
  const links = opts.links ?? true
  const hiddenTextBlocks = countHiddenTextBlocks(html)
  try {
    const { Readability, parseHTML } = await loadLibraries()
    const { document } = parseHTML(html)
    const article = new Readability(document, {
      maxElemsToParse: opts.maxElements ?? 60_000,
      // Keep classes so fenced code blocks keep their `language-*` hint (we only read text).
      keepClasses: true,
    }).parse()
    const content = article?.content ?? ''
    if (article && content && (article.textContent ?? '').trim().length >= minChars) {
      const converted = htmlToText(content, { baseUrl: opts.baseUrl, mode: 'article', links })
      if (converted.text.length >= minChars) {
        const title = article.title?.replace(/\s+/g, ' ').trim() || null
        return { text: converted.text, title, method: 'readability', hiddenTextBlocks }
      }
    }
  } catch {
    // Fall through to the htmlparser2 extraction.
  }
  const fallback = htmlToText(html, { baseUrl: opts.baseUrl, mode: 'page', links })
  return { text: fallback.text, title: null, method: 'html-text', hiddenTextBlocks }
}
