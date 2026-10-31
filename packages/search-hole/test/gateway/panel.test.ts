// SPDX-License-Identifier: Apache-2.0
// The receipt panel (ADR-0021): data in `_meta` for app hosts only, and the token-gated apply_rule.
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, test } from 'vitest'
import type { Receipt } from '../../src/app/types.ts'
import {
  ACTION_TOKEN_TTL_MS,
  ActionTokens,
  PANEL_META_KEY,
  PANEL_MIME,
  UI_EXTENSION,
} from '../../src/gateway/panel.ts'
import { type Connected, connect, harness, textOf } from './helpers.ts'

const UI_CAPS = { extensions: { [UI_EXTENSION]: { mimeTypes: [PANEL_MIME] } } }

const RECEIPT: Receipt = {
  receiptId: 'rcpt_PPPPPPPPPPPPPPPPPPPPPP',
  startedAt: '2026-10-31T10:00:00.000Z',
  searches: [
    {
      query: 'react compiler',
      at: '2026-10-31T10:00:01.000Z',
      mode: 'builtin',
      engines: [],
      kept: 5,
      hidden: 1,
      hiddenByReason: { rule: 1 },
    },
  ],
  sources: [
    {
      url: 'https://www.w3schools.com/react/react_compiler.asp',
      title: '<img src=x onerror=alert(1)>',
      dates: [],
      sourceType: 'blog',
      freshness: 'unknown',
    },
    { url: 'https://react.dev/learn', dates: [], sourceType: 'official', freshness: 'fresh' },
  ],
  warnings: [],
  summaryLine: 'search-hole · 1 search · 5 kept · 1 hidden',
}
const SUGGESTION = {
  id: 7,
  input: { match: 'geeksforgeeks.org', action: 'lower' as const, weight: 3, reason: 'Often outdated' },
  createdAt: '2026-10-31T10:00:02.000Z',
  status: 'pending',
}

type Panel = {
  receipts: Receipt[]
  blockable: Array<{ site: string; token?: string }>
  suggestions: Array<{ id: number; match: string; token?: string }>
}

const open: Connected[] = []
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

// In-process HTTP serving is stateless in the legacy era (no initialize per request), so the
// legacy path is covered over real stdio below, as Claude Desktop runs it.
describe.each(['modern'] as const)('receipt panel (%s era)', (era) => {
  async function setup(host: 'claude-desktop' | 'generic' | 'claude-code', ui: boolean) {
    const h = harness({ host, env: {}, fake: { receipts: [RECEIPT], suggestions: [SUGGESTION] } })
    const c = await connect(h.gateway, era, ui ? { capabilities: UI_CAPS } : {})
    open.push(c)
    return { h, client: c.client }
  }
  const panelOf = (r: { _meta?: unknown }) =>
    (r._meta as Record<string, unknown> | undefined)?.[PANEL_META_KEY] as Panel | undefined

  test('an app host gets receipts, sites to block and suggestions with one-time tokens in _meta only', async () => {
    const { client } = await setup('claude-desktop', true)
    const res = await client.callTool({ name: 'receipt', arguments: {} })
    const panel = panelOf(res)
    expect(panel?.receipts[0]?.receiptId).toBe(RECEIPT.receiptId)
    expect(panel?.blockable.map((b) => b.site)).toEqual(['w3schools.com', 'react.dev'])
    expect(panel?.blockable.every((b) => typeof b.token === 'string')).toBe(true)
    expect(panel?.suggestions).toMatchObject([{ id: 7, match: 'geeksforgeeks.org' }])
    const token = panel?.blockable[0]?.token ?? 'missing'
    expect(textOf(res)).not.toContain(token)
    expect(JSON.stringify(res.structuredContent ?? {})).not.toContain(token)
  })

  test('no panel data for clients that do not render apps; no tokens where apply_rule does not exist', async () => {
    const plain = await setup('claude-desktop', false)
    expect(panelOf(await plain.client.callTool({ name: 'receipt', arguments: {} }))).toBeUndefined()
    const generic = await setup('generic', true)
    const panel = panelOf(await generic.client.callTool({ name: 'receipt', arguments: {} }))
    expect(panel?.blockable.map((b) => b.token)).toEqual([undefined, undefined])
  })

  test('apply_rule: a panel token blocks the site once; replay, swaps and non-app clients are refused', async () => {
    const { h, client } = await setup('claude-desktop', true)
    const panel = panelOf(await client.callTool({ name: 'receipt', arguments: {} }))
    const [w3, react] = panel?.blockable ?? []
    const block = (value: string, token: string) =>
      client.callTool({ name: 'apply_rule', arguments: { kind: 'block', value, token } })

    const swapped = await block('react.dev', w3?.token ?? '')
    expect(swapped.isError).toBe(true)
    const ok = await block('w3schools.com', w3?.token ?? '')
    expect(ok.isError).not.toBe(true)
    expect(textOf(ok)).toContain('Blocked w3schools.com')
    expect(h.app()?.callsTo('rules.add')[0]?.args[0]).toMatchObject({
      match: 'w3schools.com',
      action: 'block',
    })
    const replay = await block('w3schools.com', w3?.token ?? '')
    expect(replay.isError).toBe(true)
    expect(textOf(replay)).toContain('searchhole block w3schools.com')

    const approve = await client.callTool({
      name: 'apply_rule',
      arguments: { kind: 'approve', value: '7', token: panel?.suggestions[0]?.token ?? '' },
    })
    expect(textOf(approve)).toContain('Approved: lower geeksforgeeks.org')

    const noUi = await setup('claude-desktop', false)
    const refused = await noUi.client.callTool({
      name: 'apply_rule',
      arguments: { kind: 'block', value: 'react.dev', token: react?.token ?? '' },
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('only for the search-hole receipt panel')
    expect(h.app()?.callsTo('rules.add')).toHaveLength(1)
  })
})

describe('legacy era over real stdio (how Claude Desktop runs the gateway)', () => {
  test('the panel data and apply_rule work with initialize-time capabilities', async () => {
    const entry = join(import.meta.dirname, 'fixtures', 'stdio-entry.ts')
    const client = new Client({ name: 'claude-desktop-test', version: '1.0.0' }, { capabilities: UI_CAPS })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          STDIO_HOST: 'claude-desktop',
          STDIO_FAKE: JSON.stringify({ receipts: [RECEIPT] }),
          SEARCHHOLE_LOG: 'silent',
        },
        stderr: 'ignore',
      }),
    )
    try {
      expect(client.getProtocolEra()).toBe('legacy')
      const res = await client.callTool({ name: 'receipt', arguments: {} })
      const panel = (res._meta as Record<string, unknown> | undefined)?.[PANEL_META_KEY] as Panel | undefined
      const site = panel?.blockable[0]
      expect(site?.site).toBe('w3schools.com')
      const ok = await client.callTool({
        name: 'apply_rule',
        arguments: { kind: 'block', value: 'w3schools.com', token: site?.token ?? '' },
      })
      expect(textOf(ok)).toContain('Blocked w3schools.com')
    } finally {
      await client.close()
    }
  })
})

describe('ActionTokens', () => {
  test('bind kind and value, expire after 10 minutes, and work once', () => {
    let now = 1_000
    const t = new ActionTokens(() => now)
    const a = t.mint('block', 'a.com')
    expect(t.consume('block', 'b.com', a)).toBe('invalid')
    expect(t.consume('approve', 'a.com', a)).toBe('invalid')
    expect(t.consume('block', 'a.com', `${a}x`)).toBe('invalid')
    expect(t.consume('block', 'a.com', 'garbage')).toBe('invalid')
    expect(t.consume('block', 'a.com', a)).toBe('ok')
    expect(t.consume('block', 'a.com', a)).toBe('used')
    const b = t.mint('block', 'a.com')
    now += ACTION_TOKEN_TTL_MS + 1
    expect(t.consume('block', 'a.com', b)).toBe('expired')
    expect(new ActionTokens(() => now).consume('block', 'a.com', t.mint('block', 'a.com'))).toBe('invalid')
  })
})
