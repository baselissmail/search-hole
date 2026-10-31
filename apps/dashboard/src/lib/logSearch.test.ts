// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { parseLogSearch } from './logSearch.ts'

describe('parseLogSearch', () => {
  it('is empty by default', () => {
    expect(parseLogSearch({})).toEqual({})
  })

  it('reads the hidden filter in the forms a URL can carry', () => {
    for (const value of [true, 1, '1', 'true'])
      expect(parseLogSearch({ hidden: value })).toEqual({ hidden: true })
    for (const value of [false, 0, '0', 'false', 'yes', null, {}])
      expect(parseLogSearch({ hidden: value })).toEqual({})
  })

  it('reads ids as positive safe integers only', () => {
    expect(parseLogSearch({ selected: 12, expanded: '12' })).toEqual({ selected: 12, expanded: 12 })
    for (const bad of [
      0,
      -3,
      1.5,
      '1e3',
      '12abc',
      'NaN',
      Number.MAX_SAFE_INTEGER + 1,
      '9'.repeat(20),
      [],
      true,
    ]) {
      expect(parseLogSearch({ selected: bad })).toEqual({})
    }
  })

  it('keeps a result rank only inside the expanded, selected search', () => {
    expect(parseLogSearch({ selected: 5, expanded: 5, result: 3 })).toEqual({
      selected: 5,
      expanded: 5,
      result: 3,
    })
    expect(parseLogSearch({ selected: 5, expanded: 6, result: 3 })).toEqual({ selected: 5, expanded: 6 })
    expect(parseLogSearch({ selected: 5, result: 3 })).toEqual({ selected: 5 })
  })

  it('drops unknown keys', () => {
    expect(parseLogSearch({ mock: '1', q: 'x', hidden: true })).toEqual({ hidden: true })
  })
})
