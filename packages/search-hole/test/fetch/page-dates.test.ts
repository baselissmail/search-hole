// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPageDates } from '../../src/core/dates/extract.ts'
import type { FoundDate } from '../../src/shared/types.ts'

const DIR = join(import.meta.dirname, '../fixtures/pages/dates')

interface Expected {
  fetchedAt: string
  cases: Record<string, { url: string; httpLastModified?: string; dates: FoundDate[] }>
}

const expected = JSON.parse(readFileSync(join(DIR, 'expected.json'), 'utf8')) as Expected
const fetchedAt = Date.parse(expected.fetchedAt)

describe('page date fixtures (ADR-0011 rows 2–7)', () => {
  it('has an expectation for every fixture and at least 15 fixtures', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.html'))
    expect(files.length).toBeGreaterThanOrEqual(15)
    expect(files.sort()).toEqual(Object.keys(expected.cases).sort())
  })

  for (const [file, c] of Object.entries(expected.cases)) {
    it(file, () => {
      const html = readFileSync(join(DIR, file), 'utf8')
      const dates = extractPageDates(html, {
        url: c.url,
        fetchedAt,
        ...(c.httpLastModified === undefined ? {} : { httpLastModified: c.httpLastModified }),
      })
      expect(dates).toEqual(c.dates)
    })
  }
})
