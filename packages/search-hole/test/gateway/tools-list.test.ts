// SPDX-License-Identifier: Apache-2.0
// tools/list and discovery in both protocol eras (ADR-0012, ADR-0013).
import { afterEach, describe, expect, test } from 'vitest'
import { MAX_INSTRUCTIONS_CHARS, SERVER_INSTRUCTIONS } from '../../src/gateway/instructions.ts'
import { type Connected, connect, ERAS, harness } from './helpers.ts'

let open: Connected[] = []
afterEach(async () => {
  for (const c of open) await c.close()
  open = []
})

const track = (c: Connected): Connected => {
  open.push(c)
  return c
}

describe.each(ERAS)('tools/list (%s era)', (era) => {
  test('claude-code registers the four model tools, then the app-only hook, in order', async () => {
    const h = harness({ host: 'claude-code' })
    const { client } = track(await connect(h.gateway, era))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['search', 'fetch', 'receipt', 'suggest_rule', 'hook'])
    const hook = tools.find((t) => t.name === 'hook')
    expect(hook?._meta).toEqual({ ui: { visibility: ['app'] } })
    expect(tools.some((t) => t.name === 'apply_rule')).toBe(false)
  })

  test('other hosts get no hook tool', async () => {
    for (const host of ['generic', 'cursor', 'codex', 'claude-desktop'] as const) {
      const h = harness({ host, env: {} })
      const c = track(await connect(h.gateway, era))
      const { tools } = await c.client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['search', 'fetch', 'receipt', 'suggest_rule'])
    }
  })

  test('search carries anthropic/alwaysLoad; schemas are object-rooted; annotations explicit', async () => {
    const h = harness()
    const { client } = track(await connect(h.gateway, era))
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('search')?._meta?.['anthropic/alwaysLoad']).toBe(true)
    for (const name of ['fetch', 'receipt', 'suggest_rule']) {
      expect(byName.get(name)?._meta?.['anthropic/alwaysLoad']).toBeUndefined()
    }
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object')
      if (t.name !== 'hook') expect(t.outputSchema?.type).toBe('object')
      expect(t.annotations?.readOnlyHint).toBeTypeOf('boolean')
      expect(t.annotations?.openWorldHint).toBeTypeOf('boolean')
      expect(t.description?.length ?? 0).toBeGreaterThan(20)
    }
    expect(byName.get('search')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
    expect(byName.get('fetch')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
    expect(byName.get('receipt')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
    expect(byName.get('suggest_rule')?.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(byName.get('hook')?.annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    })
  })

  test('the tool list is identical across connections (byte-stable for caching)', async () => {
    const h = harness()
    const a = track(await connect(h.gateway, era))
    const b = track(await connect(h.gateway, era))
    expect(JSON.stringify((await a.client.listTools()).tools)).toBe(
      JSON.stringify((await b.client.listTools()).tools),
    )
  })

  test('static instructions within 2,000 characters', async () => {
    const h = harness()
    const { client } = track(await connect(h.gateway, era))
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS)
  })

  test('listing tools never creates the App (the factory is side-effect free)', async () => {
    const h = harness()
    const { client } = track(await connect(h.gateway, era))
    await client.listTools()
    expect(h.appCreations()).toBe(0)
  })
})

describe('modern-era cache hints', () => {
  test('tools/list and server/discover carry ttlMs 3600000, private', async () => {
    const h = harness({ version: '0.1.0' })
    const { client } = track(await connect(h.gateway, 'modern'))
    const discover = client.getDiscoverResult() as Record<string, unknown> | undefined
    expect(discover?.ttlMs).toBe(3_600_000)
    expect(discover?.cacheScope).toBe('private')
    const list = (await client.listTools()) as Record<string, unknown>
    expect(list.ttlMs).toBe(3_600_000)
    expect(list.cacheScope).toBe('private')
  })

  test('development builds are not cached', async () => {
    const h = harness({ version: '0.0.0' })
    const { client } = track(await connect(h.gateway, 'modern'))
    const list = (await client.listTools()) as Record<string, unknown>
    expect(list.ttlMs).toBe(0)
  })
})
