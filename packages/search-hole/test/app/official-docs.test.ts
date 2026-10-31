// SPDX-License-Identifier: Apache-2.0
// The bundled official-docs list: source typing and the default profile's `prefer` (ADR-0016/0017).
import { describe, expect, it } from 'vitest'
import { compileRuleSet } from '../../src/core/rules/index.ts'
import { bundledLists, OFFICIAL_DOCS } from '../../src/lists/bundled/index.ts'
import { hookSession, setup } from './helpers.ts'

describe('bundled official-docs list', () => {
  it('every entry compiles, with no duplicates', () => {
    const set = compileRuleSet({ lists: bundledLists() })
    expect(set.issues).toEqual([])
    expect(new Set(OFFICIAL_DOCS).size).toBe(OFFICIAL_DOCS.length)
    expect(set.size.list).toBe(OFFICIAL_DOCS.length)
  })

  it('never hides or reweights anything on its own', () => {
    const set = compileRuleSet({ lists: bundledLists() })
    const d = set.decide('https://react.dev/blog/2025/10/07/react-compiler-1', { profile: 'x', now: 0 })
    expect(d.visibility).toBe('kept')
    expect(d.weight.factor).toBe(1)
    expect(d.preferFactor).toBe(1)
  })

  it('built-in results: official docs are typed official and the default profile lifts them', async () => {
    const h = await setup({})
    const out = await h.app.filterBuiltinResults(
      'react compiler',
      [
        { title: 'Some blog', url: 'https://blog.example.net/react-compiler' },
        { title: 'Medium post', url: 'https://medium.com/@x/react-compiler' },
        { title: 'React Compiler v1.0', url: 'https://react.dev/blog/2025/10/07/react-compiler-1' },
      ],
      hookSession(),
    )
    // With equal input ranks the prefer lift (×1.45) moves the official page to the top.
    expect(out.kept[0]?.url).toBe('https://react.dev/blog/2025/10/07/react-compiler-1')
    const [entry] = await h.app.log.recent()
    const detail = await h.app.log.detail(entry?.searchId ?? 0)
    const react = detail?.results.find((r) => r.domain === 'react.dev')
    expect(react?.sourceType).toBe('official')
  })

  it('a user-defined default profile replaces the built-in one (no lift)', async () => {
    const h = await setup({ rules: 'version: 1\nprofiles:\n  default: {}\n' })
    const out = await h.app.filterBuiltinResults(
      'react compiler',
      [
        { title: 'Some blog', url: 'https://blog.example.net/react-compiler' },
        { title: 'React Compiler v1.0', url: 'https://react.dev/blog/2025/10/07/react-compiler-1' },
      ],
      hookSession(),
    )
    expect(out.kept[0]?.url).toBe('https://blog.example.net/react-compiler')
  })
})
