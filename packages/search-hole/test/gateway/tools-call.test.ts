// SPDX-License-Identifier: Apache-2.0
// search / fetch / receipt / suggest_rule against a fake App, in both protocol eras.
import { afterEach, describe, expect, test } from 'vitest'
import type { Receipt } from '../../src/app/types.ts'
import { INTERNAL_ERROR_TEXT } from '../../src/gateway/errors.ts'
import { FETCH_OVERHEAD_TOKENS, UNTRUSTED_FOOTER } from '../../src/gateway/render.ts'
import { mergedResult, searchOutcome } from './fake-app.ts'
import { type Connected, connect, ERAS, harness, textOf } from './helpers.ts'

let open: Connected[] = []
afterEach(async () => {
  for (const c of open) await c.close()
  open = []
})

async function connected(era: (typeof ERAS)[number], h = harness()) {
  const c = await connect(h.gateway, era)
  open.push(c)
  return { h, client: c.client }
}

const RECEIPT: Receipt = {
  receiptId: 'rcpt_CCCCCCCCCCCCCCCCCCCCCC',
  sessionKey: 'sess-1',
  startedAt: '2026-10-30T10:00:00.000Z',
  searches: [
    {
      query: 'react compiler',
      at: '2026-10-30T10:00:01.000Z',
      mode: 'engines',
      engines: ['searxng', 'tavily'],
      kept: 8,
      hidden: 3,
      hiddenByReason: { rule: 2, stale: 1 },
    },
  ],
  sources: [
    {
      url: 'https://react.dev/learn/react-compiler',
      title: 'React Compiler',
      status: 200,
      dates: [
        {
          value: '2025-10-07T00:00:00.000Z',
          kind: 'modified',
          method: 'jsonld',
          confidence: 'high',
          tzAssumed: false,
        },
      ],
      sourceType: 'official',
      freshness: 'fresh',
    },
  ],
  warnings: ['1 result had no date'],
  summaryLine: '1 search · 11 results · 3 hidden · sources: 1 official',
}

describe.each(ERAS)('tool calls (%s era)', (era) => {
  test('search renders compact text and structuredContent, and passes the request context', async () => {
    const { h, client } = await connected(
      era,
      harness({ env: { CLAUDE_PROJECT_DIR: '/work/project', CLAUDE_CODE_SESSION_ID: 'sess-env' } }),
    )
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'react compiler', depth: 'quick', freshness: { maxAgeDays: 30 }, limit: 15 },
      _meta: { 'claudecode/toolUseId': 'toolu_01ABC' },
    })
    expect(result.isError).not.toBe(true)
    const text = textOf(result)
    expect(text.split('\n')[0]).toBe(
      'search-hole · 3 results · 0 hidden · searxng 412ms · receipt rcpt_AAAAAAAAAAAAAAAAAAAAAA',
    )
    expect(text).toContain('1. Result 1 title  [docs]')
    expect(text.endsWith(UNTRUSTED_FOOTER)).toBe(true)
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.receiptId).toBe('rcpt_AAAAAAAAAAAAAAAAAAAAAA')
    expect((sc.results as unknown[]).length).toBe(3)

    const call = h.app()?.callsTo('search')[0]
    expect(call?.args[0]).toEqual({ query: 'react compiler', depth: 'quick', maxAgeDays: 30, limit: 10 })
    expect(call?.ctx?.toolUseId).toBe('toolu_01ABC')
    expect(call?.ctx?.session).toEqual({ key: 'sess-env', source: 'env' })
    expect(call?.ctx?.projectDir).toBe('/work/project')
    expect(call?.ctx?.protocolEra).toBe(era)
    expect(call?.ctx?.signal).toBeInstanceOf(AbortSignal)
  })

  test('host conversation keys in _meta become the session (ADR-0005)', async () => {
    const { h, client } = await connected(era, harness({ env: {}, cwd: '/home/tester' }))
    for (const [key, value] of [
      ['openai/session', 'conv-openai'],
      ['vscode.conversationId', 'conv-vscode'],
      ['agent-session-id', 'conv-goose'],
    ] as const) {
      await client.callTool({ name: 'search', arguments: { query: 'q' }, _meta: { [key]: value } })
      expect(h.app()?.callsTo('search').at(-1)?.ctx?.session).toEqual({ key: value, source: 'meta' })
    }
    // No key anywhere: an approximate fallback label; the home directory is not a project.
    await client.callTool({ name: 'search', arguments: { query: 'q' } })
    const last = h.app()?.callsTo('search').at(-1)?.ctx
    expect(last?.session?.source).toBe('fallback')
    expect(last?.session?.key).toMatch(/^fallback:claude-code:4242:/)
    expect(last?.projectDir).toBeUndefined()
  })

  test('search errors are isError results with why → fix and never echo the query', async () => {
    const { client } = await connected(era)
    const result = await client.callTool({ name: 'search', arguments: { query: 'token ghp_abc123secret' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      'Query not sent: it looks like an API key or access token. → Remove it from the query and search again.',
    )
    expect(textOf(result)).not.toContain('ghp_')
  })

  test('unexpected failures become a generic tool error and are logged', async () => {
    const { h, client } = await connected(era, harness({ fake: { failing: ['search'] } }))
    const result = await client.callTool({ name: 'search', arguments: { query: 'q' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(INTERNAL_ERROR_TEXT)
    expect(h.logs().some((l) => l.msg === 'tool failed' && l.tool === 'search')).toBe(true)
  })

  test('a failed App start is a tool error, and the next call retries', async () => {
    const { h, client } = await connected(era, harness({ failCreate: 1 }))
    const first = await client.callTool({ name: 'search', arguments: { query: 'q' } })
    expect(first.isError).toBe(true)
    const second = await client.callTool({ name: 'search', arguments: { query: 'q' } })
    expect(second.isError).not.toBe(true)
    expect(h.appCreations()).toBe(2)
  })

  test('invalid arguments are rejected before the App is touched', async () => {
    const { h, client } = await connected(era)
    const result = await client.callTool({ name: 'search', arguments: { query: '' } })
    expect(result.isError).toBe(true)
    expect(h.appCreations()).toBe(0)
  })

  test('search text stays within the depth budget with a "+N more" line', async () => {
    const long = 'x'.repeat(600)
    const outcome = searchOutcome(20, {
      depth: 'quick',
      results: Array.from({ length: 20 }, (_, i) =>
        mergedResult(i + 1, { title: `T${i} ${long}`, snippet: long }),
      ),
    })
    const { client } = await connected(era, harness({ fake: { search: () => outcome } }))
    const result = await client.callTool({ name: 'search', arguments: { query: 'q', depth: 'quick' } })
    const text = textOf(result)
    expect(text).toMatch(/\+\d+ more \(raise limit or use deep\)/)
    expect((result.structuredContent as { results: unknown[] }).results.length).toBe(20)
  })

  test('fetch returns the page text with a header and the untrusted footer', async () => {
    const { h, client } = await connected(era)
    const result = await client.callTool({ name: 'fetch', arguments: { url: 'https://react.dev/learn' } })
    expect(result.isError).not.toBe(true)
    const text = textOf(result)
    expect(text.split('\n')[0]).toBe(
      'search-hole fetch · 200 · text/html · 4096 bytes · receipt rcpt_AAAAAAAAAAAAAAAAAAAAAA',
    )
    expect(text).toContain('dates: 2025-10-07 updated (jsonld:dateModified)')
    expect(text).toContain('Readable page text.')
    expect(text.endsWith(UNTRUSTED_FOOTER)).toBe(true)
    expect(h.app()?.callsTo('fetch')[0]?.args[0]).toEqual({
      url: 'https://react.dev/learn',
      maxTokens: 8_000 - FETCH_OVERHEAD_TOKENS,
    })
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.finalUrl).toBe('https://react.dev/learn')
    expect(sc.title).toBe('A page')
  })

  test('fetch of a blocked site is a tool error naming the rule', async () => {
    const { client } = await connected(era, harness({ fake: { blockedDomains: ['pinterest.com'] } }))
    const result = await client.callTool({
      name: 'fetch',
      arguments: { url: 'https://www.pinterest.com/pin/1' },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe(
      'search-hole did not open this page: www.pinterest.com is blocked by your rule "block www.pinterest.com" (rule: block www.pinterest.com) → use another source; if the user wants this site, propose a rule with suggest_rule',
    )
  })

  test("receipt with no ids shows the session's latest; unknown ids are an error", async () => {
    const { client } = await connected(era, harness({ fake: { receipts: [RECEIPT] } }))
    const latest = await client.callTool({ name: 'receipt', arguments: {} })
    expect(latest.isError).not.toBe(true)
    expect(textOf(latest)).toContain('receipt rcpt_CCCCCCCCCCCCCCCCCCCCCC · 1 search · 11 results')
    expect(textOf(latest)).toContain(
      '- "react compiler" · searxng, tavily · 8 kept, 3 hidden (2 rule, 1 stale)',
    )
    expect((latest.structuredContent as { receipts: Receipt[] }).receipts[0]).toEqual(RECEIPT)

    const full = await client.callTool({ name: 'receipt', arguments: { format: 'full' } })
    expect(textOf(full)).toContain(
      'opened: https://react.dev/learn/react-compiler  [official · 2025-10-07 updated]',
    )

    const unknown = await client.callTool({ name: 'receipt', arguments: { receiptIds: ['rcpt_nope'] } })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toContain('→')
  })

  test('suggest_rule queues and hands the approval step to the user', async () => {
    const { h, client } = await connected(era)
    const result = await client.callTool({
      name: 'suggest_rule',
      arguments: { match: 'w3schools.com', action: 'block', reason: 'Low-quality copies of MDN content' },
    })
    expect(result.isError).not.toBe(true)
    expect(textOf(result)).toBe(
      'search-hole · suggestion #3 queued; nothing has changed yet.\nTell the user: Ask the user to type /search-hole:approve 3, or click Approve in the dashboard.',
    )
    expect(result.structuredContent).toEqual({
      suggestionId: 3,
      status: 'queued',
      howToApprove: 'Ask the user to type /search-hole:approve 3, or click Approve in the dashboard.',
    })
    expect(h.app()?.callsTo('suggestRule')[0]?.args[0]).toEqual({
      match: 'w3schools.com',
      action: 'block',
      reason: 'Low-quality copies of MDN content',
    })
  })

  test('identical structuredContent in both eras', async () => {
    const results: string[] = []
    for (const e of ERAS) {
      const { client } = await connected(e)
      const r = await client.callTool({ name: 'search', arguments: { query: 'react compiler' } })
      results.push(JSON.stringify(r.structuredContent))
    }
    expect(results[0]).toBe(results[1])
  })
})
