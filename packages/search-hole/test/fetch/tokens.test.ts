// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { contentHash, decodeCursor, encodeCursor } from '../../src/fetch/cursor.ts'
import { stripInvisible } from '../../src/fetch/sanitize.ts'
import { estimateTokens, takeChunk } from '../../src/fetch/tokens.ts'

describe('estimateTokens (ADR-0012)', () => {
  it.each([
    ['', 0],
    ['hello world', 4],
    ['a'.repeat(35), 10],
    ['日本語のテキスト', 8],
    ['한국어 텍스트', 7],
    ['中文文本', 4],
    ['日本 and English', 2 + Math.ceil(12 / 3.5)],
    ['「テスト」。', 6],
    ['😀😀', 1],
  ])('%j → %i', (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens)
  })
})

describe('takeChunk', () => {
  it('cuts at a paragraph boundary when one is near the budget', () => {
    const text = `${'word '.repeat(300).trim()}\n\n${'next '.repeat(300).trim()}`
    const c = takeChunk(text, 0, 500)
    expect(text.slice(0, c.end).endsWith('\n\n')).toBe(true)
    expect(c.tokens).toBeLessThanOrEqual(500)
  })

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(5000)
    const c = takeChunk(text, 0, 100)
    expect(c.end % 2).toBe(0)
  })

  it('property: successive chunks partition the text and respect the budget', () => {
    const textArb = fc
      .array(
        fc.oneof(
          fc.constantFrom('\n\n', '\n', '. ', ' ', '。', '😀'),
          fc.string({ minLength: 1, maxLength: 30 }),
          fc.string({ unit: fc.constantFrom('日', '本', '語', '한', 'カ'), minLength: 1, maxLength: 20 }),
        ),
        { maxLength: 200 },
      )
      .map((parts) => parts.join(''))
    fc.assert(
      fc.property(textArb, fc.integer({ min: 1, max: 300 }), (text, budget) => {
        let start = 0
        const pieces: string[] = []
        let guard = 0
        while (start < text.length && guard++ < 100_000) {
          const c = takeChunk(text, start, budget)
          if (c.end <= start) return false
          if (c.tokens > budget && c.end - c.start > 2) return false
          pieces.push(text.slice(c.start, c.end))
          start = c.end
        }
        return pieces.join('') === text
      }),
      { numRuns: 300 },
    )
  })
})

describe('cursor', () => {
  it('round-trips and rejects tampering', () => {
    const h = contentHash('some text')
    const c = encodeCursor({ offset: 1234, contentHash: h })
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(c)).toEqual({ offset: 1234, contentHash: h })
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('!!!')).toBeNull()
    expect(
      decodeCursor(Buffer.from('{"v":1,"offset":-1,"contentHash":"0123456789abcdef"}').toString('base64url')),
    ).toBeNull()
    expect(
      decodeCursor(Buffer.from('{"v":2,"offset":1,"contentHash":"0123456789abcdef"}').toString('base64url')),
    ).toBeNull()
    expect(
      decodeCursor(Buffer.from('{"v":1,"offset":1,"contentHash":"zz"}').toString('base64url')),
    ).toBeNull()
  })

  it('property: any valid state round-trips', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1e9 }), fc.string(), (offset, text) => {
        const state = { offset, contentHash: contentHash(text) }
        const decoded = decodeCursor(encodeCursor(state))
        return decoded?.offset === offset && decoded.contentHash === state.contentHash
      }),
    )
  })
})

describe('stripInvisible', () => {
  it('removes tag characters, bidi controls and zero-width spaces but keeps ZWJ/ZWNJ', () => {
    const input = 'a​b\u{e0049}\u{e0067}c‮d⁦e‍f‌g\u0007h\r\ni'
    const out = stripInvisible(input)
    expect(out.text).toBe('abcde‍f‌gh\ni')
    expect(out.removed).toBe(6)
  })
})
