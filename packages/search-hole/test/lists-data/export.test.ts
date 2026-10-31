// SPDX-License-Identifier: Apache-2.0
// The CC0 text copies in lists/ match the TS modules (ADR-0016); regenerate with
// `node scripts/export-lists.mjs`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { exportLine, exportPath, FIRST_PARTY_LISTS, renderListText } from '../../src/lists/bundled/index.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

describe('exported list files', () => {
  for (const list of FIRST_PARTY_LISTS) {
    it(`${exportPath(list.id)} is in sync with its module`, () => {
      const text = readFileSync(join(ROOT, exportPath(list.id)), 'utf8')
      expect(text).toBe(renderListText(list))
      const header = text.split('\n').filter((l) => l.startsWith('! '))
      expect(text.startsWith('! License: CC0-1.0\n')).toBe(true)
      for (const key of ['Title', 'Homepage', 'Expires']) {
        expect(
          header.some((l) => l.startsWith(`! ${key}: `)),
          key,
        ).toBe(true)
      }
      const rules = text.split('\n').filter((l) => l !== '' && !l.startsWith('!'))
      expect(rules.length).toBe(list.entries.length)
    })
  }

  it('host entries are plain domains; host + path entries are uBlacklist match patterns', () => {
    expect(exportLine('example.com')).toBe('example.com')
    expect(exportLine('lightrun.com/answers')).toBe('*://*.lightrun.com/answers/*')
    expect(exportLine('example.com/docs/')).toBe('*://*.example.com/docs/*')
    expect(exportLine('=www.example.com')).toBe('*://www.example.com/*')
  })
})
