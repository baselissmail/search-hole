// SPDX-License-Identifier: Apache-2.0
/**
 * HTML → compact, Markdown-flavoured text with htmlparser2. Used on
 * Readability's article HTML and, as the fallback, on the whole page.
 *
 * Keeps structure the model can use (headings, lists, code blocks, tables as
 * pipe rows, links as `[text](url)`), drops scripts, styles, forms and
 * elements hidden with `hidden`, `aria-hidden="true"` or inline
 * `display:none` / `visibility:hidden` (a common prompt-injection hiding place).
 */
import { Parser } from 'htmlparser2'

export interface HtmlTextOptions {
  /** Base for resolving relative links (the final URL, or the page's `<base href>`). */
  baseUrl: string
  /** `page` (fallback) also drops nav, footer, aside and header chrome. Default `article`. */
  mode?: 'article' | 'page'
  /** Render links as `[text](url)`. Default true. */
  links?: boolean
}

export interface HtmlTextResult {
  text: string
  /** Elements skipped because they were hidden. */
  hiddenElements: number
}

const ALWAYS_SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'head',
  'title',
  'select',
  'button',
  'input',
  'textarea',
  'form',
  'dialog',
])
const PAGE_SKIP = new Set(['nav', 'footer', 'aside', 'menu'])
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'blockquote',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'address',
  'details',
  'summary',
  'hgroup',
  'body',
  'html',
  'caption',
])
/** Placeholder for list indentation, so whitespace collapsing keeps nesting. */
const INDENT = '\u0001'
const HEADINGS: Readonly<Record<string, number>> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

function isHidden(attribs: Record<string, string>): boolean {
  if ('hidden' in attribs) return true
  if ((attribs['aria-hidden'] ?? '').trim().toLowerCase() === 'true') return true
  const style = (attribs.style ?? '').toLowerCase().replace(/\s+/g, '')
  return style.includes('display:none') || style.includes('visibility:hidden')
}

function resolveHref(href: string | undefined, base: string): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null
  try {
    const u = new URL(trimmed, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}

function codeLanguage(attribs: Record<string, string>): string {
  const m = /(?:^|\s)(?:lang(?:uage)?-)([a-z0-9+#_-]{1,20})/i.exec(attribs.class ?? '')
  return m?.[1]?.toLowerCase() ?? ''
}

/** Collapses whitespace runs, trims lines and paragraph gaps (outside fenced code). */
function tidy(raw: string): string {
  const lines = raw.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence
    if (inFence || line.startsWith('```')) {
      out.push(line.replace(/\s+$/, ''))
      continue
    }
    let indent = 0
    while (line[indent] === INDENT) indent++
    const body = line
      .replaceAll(INDENT, '')
      .replace(/[ \t]+/g, ' ')
      .trim()
    out.push(body === '' ? '' : `${'  '.repeat(indent)}${body}`)
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const HIDDEN_TEXT_MIN_CHARS = 20
const NON_TEXT = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head', 'title'])

/**
 * Counts hidden elements (`hidden`, `aria-hidden="true"`, inline `display:none`
 * / `visibility:hidden`) that carry at least 20 characters of text: the shape
 * of a hidden prompt injection. Icon-only `aria-hidden` spans don't count.
 */
export function countHiddenTextBlocks(html: string): number {
  let count = 0
  let hidden: { tag: string; nest: number; chars: number } | null = null
  let nonText = 0
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (NON_TEXT.has(name)) nonText++
        if (hidden) {
          if (name === hidden.tag && !VOID.has(name)) hidden.nest++
          return
        }
        if (!VOID.has(name) && !NON_TEXT.has(name) && isHidden(attribs))
          hidden = { tag: name, nest: 0, chars: 0 }
      },
      ontext(text) {
        if (hidden && nonText === 0) hidden.chars += text.trim().length
      },
      onclosetag(name) {
        if (NON_TEXT.has(name) && nonText > 0) nonText--
        if (hidden && name === hidden.tag) {
          if (hidden.nest > 0) hidden.nest--
          else {
            if (hidden.chars >= HIDDEN_TEXT_MIN_CHARS) count++
            hidden = null
          }
        }
      },
    },
    { decodeEntities: true },
  )
  parser.write(html)
  parser.end()
  return count
}

/** Converts HTML to text. Pure apart from htmlparser2. */
export function htmlToText(html: string, opts: HtmlTextOptions): HtmlTextResult {
  const mode = opts.mode ?? 'article'
  const withLinks = opts.links ?? true
  const parts: string[] = []
  const linkStack: Array<{ href: string | null; start: number }> = []
  const listStack: Array<{ ordered: boolean; n: number }> = []
  let skipDepth = 0
  let skipTag: string | null = null
  let preDepth = 0
  let inlineCode = 0
  let hiddenElements = 0
  let base = opts.baseUrl
  let fence: { index: number; lang: string } | null = null

  const emit = (s: string): void => {
    parts.push(s)
  }
  const block = (): void => {
    emit('\n\n')
  }

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (skipTag !== null) {
          if (name === skipTag && !VOID.has(name)) skipDepth++
          return
        }
        if (name === 'base' && attribs.href) {
          const b = resolveHref(attribs.href, base)
          if (b) base = b
        }
        const hidden = isHidden(attribs)
        if (ALWAYS_SKIP.has(name) || (mode === 'page' && PAGE_SKIP.has(name)) || hidden) {
          if (hidden) hiddenElements++
          if (!VOID.has(name)) {
            skipTag = name
            skipDepth = 0
          }
          return
        }
        const level = HEADINGS[name]
        if (level !== undefined) {
          block()
          emit(`${'#'.repeat(level)} `)
          return
        }
        switch (name) {
          case 'br':
            emit('\n')
            return
          case 'hr':
            block()
            emit('---')
            block()
            return
          case 'pre':
            if (preDepth === 0) {
              block()
              fence = { index: parts.length, lang: codeLanguage(attribs) }
              emit(`\`\`\`${fence.lang}\n`)
            }
            preDepth++
            return
          case 'code':
            if (preDepth === 0) {
              inlineCode++
              emit('`')
            } else if (fence && fence.lang === '' && parts.length === fence.index + 1) {
              fence.lang = codeLanguage(attribs)
              parts[fence.index] = `\`\`\`${fence.lang}\n`
            }
            return
          case 'ul':
          case 'ol':
            listStack.push({ ordered: name === 'ol', n: Number.parseInt(attribs.start ?? '1', 10) || 1 })
            block()
            return
          case 'li': {
            const list = listStack[listStack.length - 1]
            const indent = INDENT.repeat(Math.max(0, listStack.length - 1))
            const marker = list?.ordered ? `${list.n++}.` : '-'
            emit(`\n${indent}${marker} `)
            return
          }
          case 'tr':
            emit('\n| ')
            return
          case 'td':
          case 'th':
            return
          case 'a':
            linkStack.push({ href: withLinks ? resolveHref(attribs.href, base) : null, start: parts.length })
            return
          case 'img':
            return
          default:
            if (BLOCK.has(name)) block()
        }
      },
      ontext(raw) {
        if (skipTag !== null) return
        const text = raw.replaceAll(INDENT, '')
        if (preDepth > 0) emit(text)
        else emit(text.replace(/\s+/g, ' '))
      },
      onclosetag(name) {
        if (skipTag !== null) {
          if (name === skipTag) {
            if (skipDepth > 0) skipDepth--
            else skipTag = null
          }
          return
        }
        if (HEADINGS[name] !== undefined) {
          block()
          return
        }
        switch (name) {
          case 'pre':
            if (preDepth > 0) preDepth--
            if (preDepth === 0) {
              emit('\n```')
              block()
              fence = null
            }
            return
          case 'code':
            if (preDepth === 0 && inlineCode > 0) {
              inlineCode--
              emit('`')
            }
            return
          case 'ul':
          case 'ol':
            listStack.pop()
            block()
            return
          case 'td':
          case 'th':
            emit(' | ')
            return
          case 'tr':
            return
          case 'a': {
            const link = linkStack.pop()
            if (!link?.href) return
            const inner = parts.splice(link.start).join('').replace(/\s+/g, ' ').trim()
            if (inner === '') return
            emit(inner === link.href ? inner : `[${inner}](${link.href})`)
            return
          }
          default:
            if (BLOCK.has(name)) block()
        }
      },
    },
    { decodeEntities: true },
  )
  parser.write(html)
  parser.end()
  return { text: tidy(parts.join('')), hiddenElements }
}
