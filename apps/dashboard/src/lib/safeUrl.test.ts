// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { safeHttpUrl } from './safeUrl.ts'

describe('safeHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d')
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com/')
    expect(safeHttpUrl('HTTPS://EXAMPLE.com/X')).toBe('https://example.com/X')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0000javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/',
    'blob:https://example.com/uuid',
    'about:blank',
    'mailto:a@example.com',
  ])('refuses %j', (raw) => {
    expect(safeHttpUrl(raw)).toBeNull()
  })

  it('refuses relative, protocol-relative, empty and missing values', () => {
    for (const raw of ['/path', '//evil.example', 'example.com', '', undefined, null])
      expect(safeHttpUrl(raw)).toBeNull()
  })

  it('refuses absurdly long values', () => {
    expect(safeHttpUrl(`https://example.com/${'a'.repeat(9000)}`)).toBeNull()
  })
})
