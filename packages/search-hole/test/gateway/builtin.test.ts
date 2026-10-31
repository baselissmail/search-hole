// SPDX-License-Identifier: Apache-2.0
// The built-in WebSearch shape contract (ADR-0018 "validate early": shape drift must be caught).
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  collectResults,
  coveredBy,
  MAX_BLOCKED_DOMAINS,
  mergeDomains,
  parseWebSearchInput,
  parseWebSearchResponse,
  planBuiltinInput,
  rebuildWebSearchResponse,
  SUMMARY_WITHHELD,
} from '../../src/gateway/builtin.ts'

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/websearch-react-compiler.json', import.meta.url), 'utf8'),
) as { tool_input: unknown; tool_response: unknown }

describe('parseWebSearchResponse', () => {
  test('accepts the recorded shape, as a JSON string or an object', () => {
    const fromString = parseWebSearchResponse(JSON.stringify(FIXTURE.tool_response))
    const fromObject = parseWebSearchResponse(FIXTURE.tool_response)
    expect(fromString).toEqual(fromObject)
    expect(fromString?.results.length).toBe(2)
    expect(collectResults(fromString ?? { results: [] }).map((r) => r.url)[2]).toBe(
      'https://az.react.dev/learn/react-compiler',
    )
  })

  test.each([
    ['not json', '{oops'],
    ['empty', ''],
    ['no results', { query: 'q' }],
    ['results not an array', { results: 'x' }],
  ])('rejects %s', (_name, raw) => {
    expect(parseWebSearchResponse(typeof raw === 'string' ? raw : JSON.stringify(raw))).toBeNull()
  })

  test('one odd entry does not unfilter the rest: bad items skipped, error blocks kept in place', () => {
    const error = {
      tool_use_id: 'e',
      content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    }
    const resp = parseWebSearchResponse(
      JSON.stringify({
        query: 'q',
        results: [
          {
            tool_use_id: 'a',
            content: [{ title: 't' }, null, { title: 'Pin', url: 'https://pinterest.com/x' }],
          },
          42,
          error,
          {
            tool_use_id: 'b',
            content: [{ title: 'MDN', url: 'https://developer.mozilla.org/' }, { url: '' }],
          },
        ],
      }),
    )
    if (resp === null) throw new Error('expected a parse')
    expect(collectResults(resp).map((r) => r.url)).toEqual([
      'https://pinterest.com/x',
      'https://developer.mozilla.org/',
    ])
    const rebuilt = rebuildWebSearchResponse(resp, {
      kept: [{ title: 'MDN', url: 'https://developer.mozilla.org/' }],
      hidden: [{ title: 'Pin', url: 'https://pinterest.com/x', reason: 'rule' }],
      removedPostSearch: false,
    })
    expect(rebuilt?.results).toEqual([
      { tool_use_id: 'a', content: [{ title: 'MDN', url: 'https://developer.mozilla.org/' }] },
      error,
    ])
  })

  test('keeps unknown fields so the rebuilt output matches the original shape', () => {
    const raw = {
      query: 'q',
      results: [
        { tool_use_id: 't1', content: [{ title: 'A', url: 'https://a.com/', page_age: '2 days' }], extra: 1 },
      ],
      durationSeconds: 1,
      searchCount: 1,
      future: 'field',
    }
    const parsed = parseWebSearchResponse(raw)
    const rebuilt =
      parsed &&
      rebuildWebSearchResponse(parsed, {
        kept: [],
        hidden: [{ title: 'A', url: 'https://a.com/', reason: 'rule' }],
        removedPostSearch: false,
      })
    expect(rebuilt).toEqual({ ...raw, results: [{ tool_use_id: 't1', content: [], extra: 1 }] })
  })
})

describe('rebuildWebSearchResponse', () => {
  const resp = parseWebSearchResponse(FIXTURE.tool_response)
  if (resp === null) throw new Error('fixture does not parse')
  const all = collectResults(resp)

  test('null when nothing changes', () => {
    expect(rebuildWebSearchResponse(resp, { kept: all, hidden: [], removedPostSearch: false })).toBeNull()
  })

  test('multiple result blocks merge into the first, in the App order', () => {
    const multi = parseWebSearchResponse({
      query: 'q',
      results: [
        { tool_use_id: 'a', content: [{ title: 'A', url: 'https://a.com/' }] },
        'summary one',
        { tool_use_id: 'b', content: [{ title: 'B', url: 'https://b.com/' }] },
      ],
    })
    if (multi === null) throw new Error('parse')
    const out = rebuildWebSearchResponse(multi, {
      kept: [
        { title: 'B', url: 'https://b.com/' },
        { title: 'A', url: 'https://a.com/' },
      ],
      hidden: [],
      removedPostSearch: false,
    })
    expect(out?.results).toEqual([
      {
        tool_use_id: 'a',
        content: [
          { title: 'B', url: 'https://b.com/' },
          { title: 'A', url: 'https://a.com/' },
        ],
      },
      'summary one',
    ])
  })

  test('the summary is withheld only when results were removed after the search', () => {
    const kept = all.slice(1)
    const hidden = [
      { ...all[0], title: all[0]?.title ?? '', url: all[0]?.url ?? '', reason: 'rule' as const },
    ]
    expect(rebuildWebSearchResponse(resp, { kept, hidden, removedPostSearch: false })?.results[1]).toBe(
      (FIXTURE.tool_response as { results: unknown[] }).results[1],
    )
    expect(rebuildWebSearchResponse(resp, { kept, hidden, removedPostSearch: true })?.results[1]).toBe(
      SUMMARY_WITHHELD,
    )
  })
})

describe('domains', () => {
  test('mergeDomains normalises, dedupes, keeps existing first and caps', () => {
    expect(mergeDomains(['Example.org.', '*.foo.com'], ['foo.com', 'bar.com', ''])).toEqual([
      'example.org',
      'foo.com',
      'bar.com',
    ])
    const many = Array.from({ length: 500 }, (_, i) => `d${i}.com`)
    expect(mergeDomains(undefined, many).length).toBe(MAX_BLOCKED_DOMAINS)
  })

  test('coveredBy matches the domain and its subdomains only', () => {
    expect(coveredBy('www.pinterest.com', ['pinterest.com'])).toBe(true)
    expect(coveredBy('pinterest.com', ['pinterest.com'])).toBe(true)
    expect(coveredBy('notpinterest.com', ['pinterest.com'])).toBe(false)
    expect(coveredBy('pinterest.com', ['www.pinterest.com'])).toBe(false)
  })

  test('planBuiltinInput keeps every other field of the tool input', () => {
    const input = parseWebSearchInput({ query: 'q', mode: 'extended', blocked_domains: ['a.com'] })
    if (input === null) throw new Error('parse')
    expect(planBuiltinInput(input, ['b.com'], 'q')).toEqual({
      kind: 'rewrite',
      input: { query: 'q', mode: 'extended', blocked_domains: ['a.com', 'b.com'] },
    })
    expect(planBuiltinInput(input, ['a.com'], 'q')).toEqual({ kind: 'unchanged' })
  })

  test('an empty allowed_domains is dropped when blocks are added (both lists are a 400)', () => {
    const input = parseWebSearchInput({ query: 'q', allowed_domains: [] })
    if (input === null) throw new Error('parse')
    expect(planBuiltinInput(input, ['pinterest.com'], 'q')).toEqual({
      kind: 'rewrite',
      input: { query: 'q', blocked_domains: ['pinterest.com'] },
    })
  })

  test('parseWebSearchInput rejects non-objects', () => {
    expect(parseWebSearchInput('"a string"')).toBeNull()
    expect(parseWebSearchInput('[1]')).toBeNull()
    expect(parseWebSearchInput({ query: 'q', blocked_domains: 'x' })).toBeNull()
  })
})
