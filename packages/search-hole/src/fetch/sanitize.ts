// SPDX-License-Identifier: Apache-2.0
/**
 * Removes invisible characters that can smuggle instructions past a human
 * reviewer (Unicode tag characters, bidi overrides and isolates, zero-width
 * space, word joiner, BOM) and C0/C1 controls other than tab and newline.
 * ZWJ/ZWNJ are kept: emoji sequences and several scripts need them.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​⁠﻿‪-‮⁦-⁩]|[\u{e0000}-\u{e007f}]/gu

export interface Sanitized {
  text: string
  /** How many characters were removed. */
  removed: number
}

/** Strips invisible and control characters; `\r\n` and `\r` become `\n`. */
export function stripInvisible(input: string): Sanitized {
  let removed = 0
  const text = input.replace(/\r\n?/g, '\n').replace(INVISIBLE, () => {
    removed++
    return ''
  })
  return { text, removed }
}
