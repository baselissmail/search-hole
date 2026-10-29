// SPDX-License-Identifier: Apache-2.0
/**
 * Token estimate and chunking for `fetch` output (ADR-0012 budgets).
 * Estimator: 1 token per CJK, kana or hangul character (plus CJK punctuation
 * and full-width forms, to stay conservative), characters / 3.5 otherwise.
 */

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u

const isCjk = (ch: string): boolean => CJK_CHAR.test(ch)

/** ADR-0012 token estimate for a string. */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjk(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 3.5)
}

export interface Chunk {
  /** Inclusive start offset (UTF-16 code units). */
  start: number
  /** Exclusive end offset. */
  end: number
  /** Estimated tokens of `text.slice(start, end)`. */
  tokens: number
}

/** Prefer a cut no earlier than this share of the chunk. */
const MIN_CUT_SHARE = 0.6

function findCut(text: string, start: number, hardEnd: number): number {
  const floor = start + Math.floor((hardEnd - start) * MIN_CUT_SHARE)
  const window = text.slice(floor, hardEnd)
  for (const sep of ['\n\n', '\n', '. ', '。', '! ', '? ', ' ']) {
    const idx = window.lastIndexOf(sep)
    if (idx >= 0) return floor + idx + sep.length
  }
  return hardEnd
}

/**
 * Takes the longest slice from `start` whose estimate stays within
 * `maxTokens`, cut at a paragraph, line, sentence or word boundary when one
 * exists in the last 40% of the slice. Never splits a surrogate pair.
 */
export function takeChunk(text: string, start: number, maxTokens: number): Chunk {
  const budget = Math.max(1, Math.floor(maxTokens))
  let cjk = 0
  let other = 0
  let i = Math.min(Math.max(0, start), text.length)
  const from = i
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0
    const width = cp > 0xffff ? 2 : 1
    const ch = text.slice(i, i + width)
    const nextCjk = isCjk(ch) ? cjk + 1 : cjk
    const nextOther = isCjk(ch) ? other : other + 1
    if (nextCjk + Math.ceil(nextOther / 3.5) > budget) break
    cjk = nextCjk
    other = nextOther
    i += width
  }
  if (i >= text.length) return { start: from, end: text.length, tokens: cjk + Math.ceil(other / 3.5) }
  let end = findCut(text, from, i)
  if (end <= from) end = i
  // Never end between a high and a low surrogate.
  const prev = text.charCodeAt(end - 1)
  if (end < text.length && prev >= 0xd800 && prev <= 0xdbff) end--
  return { start: from, end, tokens: estimateTokens(text.slice(from, end)) }
}
