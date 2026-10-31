// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { anyDialogOpen, isTypingTarget } from './hotkeys.ts'
import { parseLoginFragment } from './session.ts'

describe('parseLoginFragment', () => {
  it('reads the code from #c=<code>', () => {
    expect(parseLoginFragment('#c=abc123')).toBe('abc123')
    expect(parseLoginFragment('#x=1&c=abc')).toBe('abc')
    expect(parseLoginFragment('#c=a%2Fb')).toBe('a/b')
  })

  it('returns null without a usable code', () => {
    for (const hash of ['', '#', '#c=', '#code=abc', '#c=%20%20', `#c=${'a'.repeat(600)}`]) {
      expect(parseLoginFragment(hash)).toBeNull()
    }
  })
})

describe('isTypingTarget', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({
    tagName,
    getAttribute: () => null,
    ...extra,
  })

  it('is true for text fields and editable content', () => {
    expect(isTypingTarget(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTypingTarget(el('INPUT', { type: 'search' }))).toBe(true)
    expect(isTypingTarget(el('INPUT', { type: 'number' }))).toBe(true)
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(el('SELECT'))).toBe(true)
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true)
    expect(
      isTypingTarget(el('DIV', { getAttribute: (n: string) => (n === 'role' ? 'combobox' : null) })),
    ).toBe(true)
  })

  it('is false for buttons, checkboxes, rows and the page', () => {
    expect(isTypingTarget(el('BUTTON'))).toBe(false)
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTypingTarget(el('TR'))).toBe(false)
    expect(isTypingTarget(el('BODY'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('anyDialogOpen', () => {
  it('is true while any dialog is in the document, whatever has focus', () => {
    expect(anyDialogOpen({ querySelector: () => null })).toBe(false)
    expect(
      anyDialogOpen({ querySelector: (s: string) => (s.includes('role="dialog"') ? ({} as Element) : null) }),
    ).toBe(true)
  })
})
