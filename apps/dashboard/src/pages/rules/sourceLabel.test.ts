// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { sourceLabel } from './RulesTable.tsx'

describe('sourceLabel', () => {
  it('shows a file name for a path and keeps other sources as they are', () => {
    expect(sourceLabel('/Users/u/.searchhole/rules.yaml')).toBe('rules.yaml')
    expect(sourceLabel('C:\\\\Users\\\\u\\\\AppData\\\\search-hole\\\\rules.yaml')).toBe('rules.yaml')
    expect(sourceLabel('session')).toBe('session')
  })
})
