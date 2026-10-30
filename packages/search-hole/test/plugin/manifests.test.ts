// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the ${...} strings are Claude Code placeholders, not templates
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HOOK_SERVER, MARKETPLACE_DIR, PLUGIN_DIR, readJson, readText } from './helpers.ts'

// Mirrors Claude Code's strict userConfig option object (manifest reference): an unknown key is an error.
const UserConfigOption = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
    title: z.string().min(1),
    description: z.string().min(1),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    options: z.array(z.string().min(1).max(64)).optional(),
    multiple: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()

const PluginJson = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(20),
  author: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().url().optional(),
  }),
  license: z.string(),
  homepage: z.string().url(),
  repository: z.string().url(),
  keywords: z.array(z.string()).optional(),
  userConfig: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), UserConfigOption),
})

const McpJson = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
    }),
  ),
})

const MarketplaceJson = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  owner: z.object({ name: z.string().min(1) }),
  description: z.string().optional(),
  plugins: z.array(
    z.object({
      name: z.string(),
      source: z.string(),
      description: z.string().optional(),
      version: z.string().optional(),
    }),
  ),
})

const plugin = PluginJson.parse(readJson(PLUGIN_DIR, '.claude-plugin', 'plugin.json'))

describe('plugin.json', () => {
  it('has the required identity fields', () => {
    expect(plugin.name).toBe('search-hole')
    expect(plugin.version).toBe('0.1.0')
    expect(plugin.license).toBe('Apache-2.0')
    expect(plugin.author.name).toBe('Basel Issmail')
    expect(plugin.homepage).toBe('https://github.com/baselissmail/search-hole')
    expect(plugin.repository).toBe('https://github.com/baselissmail/search-hole')
  })

  it('is not a name Claude Code reserves for Anthropic plugins', () => {
    expect(plugin.name).not.toMatch(/^(claude|anthropic|anthropics|cc-plugin)-/)
  })

  it('declares exactly the three documented options', () => {
    expect(Object.keys(plugin.userConfig).sort()).toEqual(['brave_api_key', 'search_mode', 'tavily_api_key'])
  })

  it('keeps both API keys optional and sensitive, with signup hints', () => {
    for (const key of ['brave_api_key', 'tavily_api_key']) {
      const option = plugin.userConfig[key]
      expect(option, key).toMatchObject({ type: 'string', sensitive: true, required: false })
      expect(option?.default, `${key} has no default`).toBeUndefined()
    }
    const tavily = plugin.userConfig.tavily_api_key?.description ?? ''
    expect(tavily).toContain('1,000')
    expect(tavily.toLowerCase()).toContain('no credit card')
    expect(tavily).toContain('https://app.tavily.com')
    expect(plugin.userConfig.brave_api_key?.description).toContain('https://brave.com/search/api/')
  })

  it('defaults search_mode to auto and offers the three ADR-0018 modes', () => {
    const mode = plugin.userConfig.search_mode
    expect(mode).toMatchObject({ type: 'string', default: 'auto', options: ['auto', 'builtin', 'engines'] })
    expect(mode?.sensitive).toBeUndefined()
    for (const m of ['auto', 'builtin', 'engines']) expect(mode?.description).toContain(m)
  })
})

describe('.mcp.json', () => {
  const mcp = McpJson.parse(readJson(PLUGIN_DIR, '.mcp.json'))

  it('launches the bundled gateway with node, exec form, for the claude-code host', () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(['search-hole'])
    const server = mcp.mcpServers['search-hole']
    expect(server?.command).toBe('node')
    expect(server?.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs',
      'mcp',
      '--host',
      'claude-code',
    ])
  })

  it('passes the options through the documented environment variables', () => {
    expect(mcp.mcpServers['search-hole']?.env).toEqual({
      SEARCHHOLE_BRAVE_API_KEY: '${user_config.brave_api_key}',
      SEARCHHOLE_TAVILY_API_KEY: '${user_config.tavily_api_key}',
      SEARCHHOLE_MODE: '${user_config.search_mode}',
    })
  })

  it('only references user_config options that plugin.json declares', () => {
    const refs = [...readText(PLUGIN_DIR, '.mcp.json').matchAll(/\$\{user_config\.([^}]+)\}/g)].map(
      (m) => m[1],
    )
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(Object.keys(plugin.userConfig)).toContain(ref)
  })

  it('names the server so that hooks address it as plugin:<plugin>:<server>', () => {
    const [serverKey] = Object.keys(mcp.mcpServers)
    expect(`plugin:${plugin.name}:${serverKey}`).toBe(HOOK_SERVER)
  })
})

describe('marketplace.json', () => {
  const marketplace = MarketplaceJson.parse(readJson(MARKETPLACE_DIR, '.claude-plugin', 'marketplace.json'))

  it('is the local marketplace search-hole-local', () => {
    expect(marketplace.name).toBe('search-hole-local')
    expect(marketplace.owner.name).toBe('Basel Issmail')
  })

  it('lists the plugin with a relative source next to the marketplace', () => {
    expect(marketplace.plugins).toHaveLength(1)
    const entry = marketplace.plugins[0]
    expect(entry?.name).toBe(plugin.name)
    expect(entry?.source).toBe('./search-hole')
    expect(entry?.source.startsWith('./')).toBe(true)
    expect(entry?.source).not.toContain('..')
  })

  it('never disagrees with plugin.json about the version', () => {
    const version = marketplace.plugins[0]?.version
    if (version !== undefined) expect(version).toBe(plugin.version)
  })

  it('is not inside the plugin directory', () => {
    expect(existsSync(join(PLUGIN_DIR, '.claude-plugin', 'marketplace.json'))).toBe(false)
  })

  it('git-ignores the assembled plugin directory', () => {
    const lines = readFileSync(join(MARKETPLACE_DIR, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
    expect(lines).toContain('search-hole/')
  })
})
