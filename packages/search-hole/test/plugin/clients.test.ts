// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${...} strings are plugin placeholders, not templates
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { APPLY_RULE_HOSTS } from '../../src/gateway/panel.ts'
import { BUILD_SCRIPT, PLUGIN_DIR, REPO_ROOT, readJson, readText, tempDir } from './helpers.ts'

const CODEX_DIR = join(REPO_ROOT, 'distribution', 'codex')
const CURSOR_DIR = join(REPO_ROOT, 'distribution', 'cursor-plugin')
const PACKAGE_VERSION = (
  readJson(REPO_ROOT, 'packages', 'search-hole', 'package.json') as { version: string }
).version
const CLAUDE_VERSION = (readJson(PLUGIN_DIR, '.claude-plugin', 'plugin.json') as { version: string }).version

/** Every file under `dir`, relative, sorted. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    )
    .sort()
}

/** Every key, at any depth, of a parsed JSON value. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)])
  }
  return []
}

// ── Agent Plugins 1.0 (agent-plugins.org/schemas/1.0.0), mirrored strictly ──

const AGENT_PLUGIN_NAME = /^(?!.*--)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/

const AgentPluginJson = z
  .object({
    $schema: z.literal('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'),
    name: z.string().regex(AGENT_PLUGIN_NAME),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .object({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() })
      .strict()
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z
      .record(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict()

const AgentStdioServer = z
  .object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z
      .string()
      .regex(/^(\.\/|\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\})/)
      .optional(),
  })
  .strict()

const AgentMcpJson = z
  .object({
    $schema: z.literal('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'),
    mcpServers: z.record(z.string(), AgentStdioServer),
  })
  .strict()

const OpenAiInterface = z.object({
  displayName: z.string().min(1),
  shortDescription: z.string().min(1).max(80),
  longDescription: z.string().min(1),
  developerName: z.string().min(1),
  category: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  defaultPrompt: z.array(z.string().min(1)).min(1),
  websiteURL: z.string().url(),
  logo: z.string().regex(/^\.\/(?!.*\.\.)/),
})

// ── Cursor plugin manifest (cursor.com/docs/reference/plugins), only documented fields ──

const CursorPluginJson = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(20),
    author: z.object({ name: z.string().min(1), email: z.string().email().optional() }).strict(),
    homepage: z.string().url(),
    repository: z.string().url(),
    license: z.string(),
    keywords: z.array(z.string()),
    logo: z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.(png|svg)$/),
  })
  .strict()

const CursorMcpJson = z
  .object({
    mcpServers: z.record(
      z.string(),
      z.object({ type: z.literal('stdio'), command: z.string(), args: z.array(z.string()) }).strict(),
    ),
  })
  .strict()

interface Skill {
  dir: string
  name: string
  description: string
  body: string
  raw: string
}

function readSkills(pluginDir: string): Skill[] {
  const root = join(pluginDir, 'skills')
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const raw = readText(root, e.name, 'SKILL.md')
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw)
      if (m === null) throw new Error(`${e.name}/SKILL.md has no frontmatter`)
      const front = m[1] ?? ''
      const field = (k: string): string =>
        (new RegExp(`^${k}: (.*)$`, 'm').exec(front)?.[1] ?? '').replace(/^"(.*)"$/, '$1')
      return { dir: e.name, name: field('name'), description: field('description'), body: m[2] ?? '', raw }
    })
}

describe('Codex plugin (distribution/codex)', () => {
  const plugin = AgentPluginJson.parse(readJson(CODEX_DIR, 'plugin.json'))
  const mcp = AgentMcpJson.parse(readJson(CODEX_DIR, 'mcp.json'))

  it('has a root plugin.json and mcp.json in the Agent Plugins 1.0 shape', () => {
    expect(plugin.name).toBe('search-hole')
    expect(plugin.license).toBe('Apache-2.0')
    expect(plugin.author?.name).toBe('Basel Issmail')
    expect(plugin.repository).toBe('https://github.com/baselissmail/search-hole')
  })

  it('carries the package version, like the Claude plugin', () => {
    expect(plugin.version).toBe(PACKAGE_VERSION)
    expect(plugin.version).toBe(CLAUDE_VERSION)
  })

  it('puts Codex presentation under extensions["com.openai"].interface', () => {
    expect(Object.keys(plugin.extensions ?? {})).toEqual(['com.openai'])
    const openai = plugin.extensions?.['com.openai'] ?? {}
    expect(Object.keys(openai)).toEqual(['interface'])
    const ui = OpenAiInterface.parse(openai.interface)
    expect(ui.logo).toBe('./assets/logo.png')
  })

  it('is hookless, so it can be listed in the OpenAI plugin directory', () => {
    expect(allKeys(plugin).map((k) => k.toLowerCase())).not.toContain('hooks')
    expect(existsSync(join(CODEX_DIR, 'hooks'))).toBe(false)
    // The Codex compatibility layout would bring its own (hook-capable) manifest and .mcp.json.
    expect(existsSync(join(CODEX_DIR, '.codex-plugin'))).toBe(false)
    expect(existsSync(join(CODEX_DIR, '.mcp.json'))).toBe(false)
    expect(existsSync(join(CODEX_DIR, '.claude-plugin'))).toBe(false)
  })

  it('launches the bundle with node, exec form, for the codex host', () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(['search-hole'])
    const server = mcp.mcpServers['search-hole']
    expect(server).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['${PLUGIN_ROOT}/dist/searchhole.mjs', 'mcp', '--host', 'codex'],
    })
  })

  it('follows the spec rules for command and placeholders', () => {
    const server = mcp.mcpServers['search-hole']
    // A bare executable name or a ./ path, never a shell string, and no placeholders in command.
    expect(server?.command).toMatch(/^(\.\/[^\s]+|[A-Za-z0-9._-]+)$/)
    for (const arg of server?.args ?? []) {
      for (const ph of arg.match(/\$\{[^}]*\}/g) ?? [])
        expect(['${PLUGIN_ROOT}', '${PLUGIN_DATA}']).toContain(ph)
      // Exec form: a path with spaces needs no quoting, so none must be added.
      expect(arg).not.toMatch(/^["']/)
    }
  })

  it('holds no secrets and no env (the format cannot reference user variables)', () => {
    expect(mcp.mcpServers['search-hole']?.env).toBeUndefined()
    const text = readText(CODEX_DIR, 'mcp.json') + readText(CODEX_DIR, 'plugin.json')
    expect(text).not.toMatch(/api[_-]?key|token|secret|tvly-|password/i)
  })

  it('never gets the model-callable apply_rule (ADR-0012)', () => {
    expect(APPLY_RULE_HOSTS.has('codex')).toBe(false)
  })
})

describe('Cursor plugin (distribution/cursor-plugin)', () => {
  const plugin = CursorPluginJson.parse(readJson(CURSOR_DIR, '.cursor-plugin', 'plugin.json'))
  const mcp = CursorMcpJson.parse(readJson(CURSOR_DIR, 'mcp.json'))

  it('has the documented manifest fields and the package version', () => {
    expect(plugin.name).toBe('search-hole')
    expect(plugin.version).toBe(PACKAGE_VERSION)
    expect(plugin.license).toBe('Apache-2.0')
    expect(plugin.logo).toBe('assets/logo.png')
  })

  it('launches the bundle with node for the cursor host, through ${CURSOR_PLUGIN_ROOT}', () => {
    expect(mcp.mcpServers).toEqual({
      'search-hole': {
        type: 'stdio',
        command: 'node',
        args: ['${CURSOR_PLUGIN_ROOT}/dist/searchhole.mjs', 'mcp', '--host', 'cursor'],
      },
    })
    // Cursor does not expand the Agent Plugins placeholder.
    expect(readText(CURSOR_DIR, 'mcp.json')).not.toContain('${PLUGIN_ROOT}')
  })

  it('ships no hooks, and its README says why', () => {
    expect(existsSync(join(CURSOR_DIR, 'hooks'))).toBe(false)
    expect(allKeys(readJson(CURSOR_DIR, '.cursor-plugin', 'plugin.json'))).not.toContain('hooks')
    const readme = readText(CURSOR_DIR, 'README.md')
    expect(readme).toContain('## Why there are no hooks')
    expect(readme).toContain('command hooks only')
  })

  it('holds no secrets and no env', () => {
    const text = readText(CURSOR_DIR, 'mcp.json') + readText(CURSOR_DIR, '.cursor-plugin', 'plugin.json')
    expect(text).not.toMatch(/api[_-]?key|token|secret|tvly-|password|"env"/i)
  })

  it('gets apply_rule, since Cursor renders the receipt panel (ADR-0012)', () => {
    expect(APPLY_RULE_HOSTS.has('cursor')).toBe(true)
  })
})

describe('skills in the Codex and Cursor plugins', () => {
  for (const [label, dir] of [
    ['codex', CODEX_DIR],
    ['cursor', CURSOR_DIR],
  ] as const) {
    it(`${label}: follow the Agent Skills rules and need no hooks or Claude Code features`, () => {
      const skills = readSkills(dir)
      expect(skills.map((s) => s.dir)).toEqual(['research'])
      for (const s of skills) {
        expect(s.name).toBe(s.dir)
        expect(s.name.length).toBeLessThanOrEqual(64)
        expect(s.description.length).toBeGreaterThan(20)
        expect(s.description.length).toBeLessThanOrEqual(1024)
        // No pre-execution commands, no Claude Code-only fields or paths, no hook guard promises.
        expect(s.raw).not.toMatch(/^!`/m)
        expect(s.raw).not.toMatch(/disable-model-invocation|allowed-tools|CLAUDE_PLUGIN_ROOT|mcp__plugin_/)
        expect(s.body).not.toMatch(/A guard blocks|WebSearch|WebFetch/)
        expect(s.body).toContain('suggest_rule')
      }
    })
  }

  it('the two copies are identical', () => {
    expect(readText(CURSOR_DIR, 'skills', 'research', 'SKILL.md')).toBe(
      readText(CODEX_DIR, 'skills', 'research', 'SKILL.md'),
    )
  })
})

// ── The build assembles both (scripts/build-plugin.mjs --target) ──

function build(args: string[]) {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

function fakeDist(): string {
  const dist = join(tempDir('searchhole fake dist '), 'dist')
  mkdirSync(join(dist, 'panel'), { recursive: true })
  writeFileSync(join(dist, 'searchhole.mjs'), '// fake bundle\n')
  writeFileSync(join(dist, 'panel', 'receipt.html'), '<!doctype html>\n')
  writeFileSync(join(dist, '.DS_Store'), 'junk')
  return dist
}

describe('scripts/build-plugin.mjs --target codex|cursor', () => {
  it('assembles the Codex plugin: sources, dist, LICENSE and the logo, and no hooks', () => {
    const out = join(tempDir('searchhole codex '), 'search-hole')
    const res = build(['--skip-build', '--target', 'codex', '--dist', fakeDist(), '--out', out])
    expect(res.status, res.stderr).toBe(0)
    const files = listFiles(out)
    expect(files).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'README.md',
        'assets/logo.png',
        'dist/panel/receipt.html',
        'dist/searchhole.mjs',
        'mcp.json',
        'plugin.json',
        'skills/research/SKILL.md',
      ]),
    )
    expect(files.some((f) => f.startsWith('hooks/') || f.endsWith('.DS_Store'))).toBe(false)
    expect(readFileSync(join(out, 'assets', 'logo.png'))).toEqual(
      readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'icon.png')),
    )
    expect(readText(out, 'mcp.json')).toBe(readText(CODEX_DIR, 'mcp.json'))
    expect(res.stdout).toContain('Codex plugin assembled at')
    expect(res.stdout).toContain('no hooks')
    // A caller-chosen folder never gets a marketplace written next to it.
    expect(existsSync(join(out, '..', '.agents'))).toBe(false)
  })

  it('assembles the Cursor plugin and prints the local install steps', () => {
    const out = join(tempDir('searchhole cursor '), 'search-hole')
    const res = build(['--skip-build', '--target', 'cursor', '--dist', fakeDist(), '--out', out])
    expect(res.status, res.stderr).toBe(0)
    const files = listFiles(out)
    expect(files).toEqual(
      expect.arrayContaining([
        '.cursor-plugin/plugin.json',
        'LICENSE',
        'assets/logo.png',
        'dist/searchhole.mjs',
        'mcp.json',
        'skills/research/SKILL.md',
      ]),
    )
    expect(files.some((f) => f.startsWith('hooks/'))).toBe(false)
    expect(res.stdout).toContain('~/.cursor/plugins/local')
    expect(res.stdout).toContain('Developer: Reload Window')
  })

  it('refuses to replace a folder that is not an earlier assembly of that target', () => {
    const out = tempDir('searchhole precious ')
    writeFileSync(join(out, 'plugin.json'), '{}')
    writeFileSync(join(out, 'important.txt'), 'keep me')
    const res = build(['--skip-build', '--target', 'cursor', '--dist', fakeDist(), '--out', out])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('Refusing to replace')
    expect(readText(out, 'important.txt')).toBe('keep me')
  })

  it('rejects an unknown target, and --out with --target all', () => {
    expect(build(['--target', 'vim']).status).toBe(2)
    expect(build(['--target']).status).toBe(2)
    const both = build(['--target', 'all', '--out', tempDir()])
    expect(both.status).toBe(2)
    expect(both.stderr).toContain('--out cannot be used with --target all')
    expect(build(['--help']).stdout).toContain('--target <name>')
  })

  it('writes a local Codex marketplace that points at the plugin folder', async () => {
    const mod = (await import(pathToFileURL(BUILD_SCRIPT).href)) as {
      writeCodexMarketplace(out: string): Promise<string>
    }
    const root = tempDir('searchhole codex mp ')
    const file = await mod.writeCodexMarketplace(join(root, 'search-hole'))
    expect(file).toBe(join(root, '.agents', 'plugins', 'marketplace.json'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      name: 'search-hole-local',
      interface: { displayName: 'search-hole (local build)' },
      plugins: [
        {
          name: 'search-hole',
          source: { source: 'local', path: './search-hole' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ],
    })
  })
})
