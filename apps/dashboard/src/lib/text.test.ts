// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { displayUrl, middleTruncate } from './text.ts'

describe('middleTruncate', () => {
  it('leaves short text alone', () => {
    expect(middleTruncate('example.com', 20)).toBe('example.com')
    expect(middleTruncate('exact', 5)).toBe('exact')
    expect(middleTruncate('', 5)).toBe('')
  })

  it('keeps both ends and fits the limit exactly', () => {
    const url = 'docs.example.com/guides/getting-started/installation/linux'
    for (const max of [10, 11, 20, 33]) {
      const out = middleTruncate(url, max)
      expect(Array.from(out)).toHaveLength(max)
      expect(out).toContain('…')
      expect(url.startsWith(out.slice(0, out.indexOf('…')))).toBe(true)
      expect(url.endsWith(out.slice(out.indexOf('…') + 1))).toBe(true)
    }
    expect(middleTruncate('abcdefghij', 5)).toBe('ab…ij')
    expect(middleTruncate('abcdefghij', 6)).toBe('abc…ij')
  })

  it('never splits astral characters', () => {
    const text = '😀😀😀😀😀😀😀😀😀😀'
    const out = middleTruncate(text, 5)
    expect(out).toBe('😀😀…😀😀')
    expect(out.includes('�')).toBe(false)
  })

  it('handles tiny limits', () => {
    expect(middleTruncate('abcdef', 2)).toBe('a…')
    expect(middleTruncate('abcdef', 1)).toBe('…')
    expect(middleTruncate('abcdef', 0)).toBe('')
  })

  it('works on right-to-left text by code point', () => {
    const arabic = 'محرك البحث المحلي للمساعدين'
    const out = middleTruncate(arabic, 9)
    expect(Array.from(out)).toHaveLength(9)
    expect(arabic.startsWith(out.slice(0, 4))).toBe(true)
  })
})

describe('displayUrl', () => {
  it('hides https:// and keeps every other scheme visible', () => {
    expect(displayUrl('https://example.com/a')).toBe('example.com/a')
    expect(displayUrl('http://example.com/a')).toBe('http://example.com/a')
    expect(displayUrl('javascript:alert(1)')).toBe('javascript:alert(1)')
  })
})
