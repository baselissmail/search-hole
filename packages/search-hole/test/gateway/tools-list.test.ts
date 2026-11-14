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
  test('claude-code registers the four model tools, then the app-only apply_rule and hook, in order', async () => {
    const h = harness({ host: 'claude-code' })
    const { client } = track(await connect(h.gateway, era))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([
      'search',
      'fetch',
      'receipt',
      'suggest_rule',
      'apply_rule',
      'hook',
    ])
    for (const name of ['hook', 'apply_rule']) {
      expect(tools.find((t) => t.name === name)?._meta).toEqual({ ui: { visibility: ['app'] } })
    }
  })

  test('apply_rule only on hosts that hide app-only tools or render the panel (ADR-0012, ADR-0021); hook only on claude-code', async () => {
    for (const host of ['cursor', 'claude-desktop', 'vscode'] as const) {
      const c = track(await connect(harness({ host, env: {} }).gateway, era))
      const { tools } = await c.client.listTools()
      expect(
        tools.map((t) => t.name),
        host,
      ).toEqual(['search', 'fetch', 'receipt', 'suggest_rule', 'apply_rule'])
    }
    for (const host of ['generic', 'codex'] as const) {
      const c = track(await connect(harness({ host, env: {} }).gateway, era))
      const { tools } = await c.client.listTools()
      expect(
        tools.map((t) => t.name),
        host,
      ).toEqual(['search', 'fetch', 'receipt', 'suggest_rule'])
    }
  })

  test('receipt links the versioned panel resource, which serves the MCP App', async () => {
    const h = harness({ host: 'claude-desktop', env: {} })
    const { client } = track(await connect(h.gateway, era))
    const receipt = (await client.listTools()).tools.find((t) => t.name === 'receipt')
    const meta = (receipt?._meta ?? {}) as { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string }
    const uri = meta.ui?.resourceUri ?? ''
    expect(uri).toMatch(/^ui:\/\/search-hole\/v[\w.-]+\/receipt\.html$/)
    expect(meta['ui/resourceUri']).toBe(uri)
    const read = await client.readResource({ uri })
    expect(read.contents[0]).toMatchObject({ uri, mimeType: 'text/html;profile=mcp-app' })
    expect(String((read.contents[0] as { text?: string }).text)).toContain('<html')
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
      // Claude Code profile: text only (it would hand structuredContent to the model).
      expect(t.outputSchema, t.name).toBeUndefined()
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

  test('with no engine set up, Claude Code is told to use the built-in search, not to try search first', async () => {
    const h = harness({ host: 'claude-code', engineSetUp: false })
    const { client } = track(await connect(h.gateway, era))
    const text = client.getInstructions() ?? ''
    expect(text).toContain('No search engine is set up, so use the built-in web search')
    expect(text).not.toContain('Prefer search and fetch')
    const search = (await client.listTools()).tools.find((t) => t.name === 'search')
    expect(search?.description).toContain('No engine is set up')
    expect(search?.description).not.toContain('Use it instead of built-in web search')
    expect(h.appCreations()).toBe(0)
  })

  test('outside Claude Code the instructions never promise a filtered built-in search', async () => {
    for (const engineSetUp of [true, false]) {
      const h = harness({ host: 'generic', engineSetUp })
      const { client } = track(await connect(h.gateway, era))
      const text = client.getInstructions() ?? ''
      expect(text).toContain("search-hole can't filter any other web search you have")
      expect(text).not.toContain('filters it with the same rules')
      const search = (await client.listTools()).tools.find((t) => t.name === 'search')
      expect(search?.description).toContain('Use it instead of built-in web search')
    }
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

  test.each(ERAS)('%s era: other hosts get object-rooted output schemas', async (era) => {
    const h = harness({ host: 'generic' })
    const { client } = track(await connect(h.gateway, era))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['search', 'fetch', 'receipt', 'suggest_rule'])
    for (const t of tools) expect(t.outputSchema?.type, t.name).toBe('object')
  })
})
