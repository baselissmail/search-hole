// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${env:…} strings are client placeholders, not templates
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  backupName,
  codexSnippet,
  describeSetup,
  isEphemeralBundle,
  isSetupClient,
  resolveBundlePath,
  resolveSetupFile,
  SETUP_CLIENT_IDS,
  SETUP_CLIENTS,
  type SetupOptions,
  type SetupResult,
  setupClient,
  setupClientInfo,
  tomlString,
} from '../../src/cli/setup.ts'
import { APPLY_RULE_HOSTS } from '../../src/gateway/panel.ts'
import { isSearchHoleError, type SearchHoleError } from '../../src/shared/errors.ts'

const NOW = Date.UTC(2026, 9, 31, 18, 57, 3)
const posixOnly = process.platform !== 'win32'

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true })
})

/** A temp folder with a space in its name, removed after the test. */
function tempDir(prefix = 'searchhole setup '): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

interface Sandbox {
  home: string
  cwd: string
  bundle: string
}

/** A fake home and project, and a real (fake) bundle file, all under paths with spaces. */
function sandbox(): Sandbox {
  const root = tempDir()
  const home = join(root, 'Jane Doe')
  const cwd = join(root, 'my project')
  const bundle = join(root, 'personal dev', 'search-hole', 'dist', 'searchhole.mjs')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(dirname(bundle), { recursive: true })
  writeFileSync(bundle, '// fake bundle\n')
  return { home, cwd, bundle }
}

const platform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux'

function run(sb: Sandbox, opts: Partial<SetupOptions> & Pick<SetupOptions, 'client'>): SetupResult {
  return setupClient({
    home: sb.home,
    cwd: sb.cwd,
    bundlePath: sb.bundle,
    platform,
    env: {},
    dryRun: false,
    now: () => NOW,
    ...opts,
  })
}

function failure(fn: () => unknown): SearchHoleError {
  try {
    fn()
  } catch (e) {
    if (isSearchHoleError(e)) return e
    throw e
  }
  throw new Error('expected a SearchHoleError')
}

/** Writes a file (creating folders) and returns its path. */
function put(file: string, text: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

const backupsOf = (file: string): string[] =>
  readdirSync(dirname(file)).filter((n) => n.startsWith(`${file.split(/[\\/]/).at(-1)}.bak-`))

const args = (sb: Sandbox, host: string): string[] => [sb.bundle, 'mcp', '--host', host]

describe('the client table', () => {
  it('lists every client once, in a stable order', () => {
    expect(SETUP_CLIENT_IDS).toEqual([
      'vscode',
      'cursor',
      'windsurf',
      'zed',
      'goose',
      'codex',
      'claude-desktop',
      'generic',
    ])
    expect(new Set(SETUP_CLIENT_IDS).size).toBe(SETUP_CLIENT_IDS.length)
    expect(isSetupClient('zed')).toBe(true)
    expect(isSetupClient('claude-code')).toBe(false)
  })

  it('launches each client with its own host profile (ADR-0012)', () => {
    const hosts = Object.fromEntries(SETUP_CLIENTS.map((c) => [c.id, c.host]))
    expect(hosts).toEqual({
      vscode: 'vscode',
      cursor: 'cursor',
      windsurf: 'generic',
      zed: 'zed',
      goose: 'goose',
      codex: 'codex',
      'claude-desktop': 'claude-desktop',
      generic: 'generic',
    })
  })

  it('never gives the model-callable apply_rule to Codex, Zed or unknown hosts', () => {
    for (const id of ['codex', 'zed', 'windsurf', 'generic', 'goose'] as const) {
      expect(APPLY_RULE_HOSTS.has(setupClientInfo(id).host), id).toBe(false)
    }
  })

  it('points every client at a docs page that exists', () => {
    const repo = join(import.meta.dirname, '..', '..', '..', '..')
    for (const c of SETUP_CLIENTS) expect(existsSync(join(repo, c.docs)), c.docs).toBe(true)
  })

  it('describes every client and option in the help text', () => {
    const help = describeSetup()
    expect(help).toMatch(/^Usage: searchhole setup <client>/)
    for (const id of SETUP_CLIENT_IDS) expect(help).toContain(`  ${id} `)
    for (const flag of ['--project', '--env NAME', '--dry-run', '--yes', '--json'])
      expect(help).toContain(flag)
    expect(Math.max(...help.split('\n').map((l) => l.length))).toBeLessThanOrEqual(100)
  })
})

describe('config locations', () => {
  const ctx = (p: NodeJS.Platform, home: string, env: Record<string, string> = {}) => ({
    platform: p,
    home,
    cwd: p === 'win32' ? 'C:\\Users\\Jane Doe\\my project' : '/work/my project',
    env,
  })

  it('macOS', () => {
    const c = ctx('darwin', '/Users/Jane Doe')
    expect(resolveSetupFile('vscode', 'user', c)).toBe(
      '/Users/Jane Doe/Library/Application Support/Code/User/mcp.json',
    )
    expect(resolveSetupFile('cursor', 'user', c)).toBe('/Users/Jane Doe/.cursor/mcp.json')
    expect(resolveSetupFile('windsurf', 'user', c)).toBe('/Users/Jane Doe/.config/devin/mcp_config.json')
    expect(resolveSetupFile('zed', 'user', c)).toBe('/Users/Jane Doe/.config/zed/settings.json')
    expect(resolveSetupFile('goose', 'user', c)).toBe('/Users/Jane Doe/.config/goose/config.yaml')
    expect(resolveSetupFile('codex', 'user', c)).toBe('/Users/Jane Doe/.codex/config.toml')
    expect(resolveSetupFile('claude-desktop', 'user', c)).toBe(
      '/Users/Jane Doe/Library/Application Support/Claude/claude_desktop_config.json',
    )
    expect(resolveSetupFile('generic', 'user', c)).toBeNull()
  })

  it('macOS: Zed ignores XDG_CONFIG_HOME, Goose and Devin follow it', () => {
    const c = ctx('darwin', '/Users/Jane Doe', { XDG_CONFIG_HOME: '/Users/Jane Doe/dot config' })
    expect(resolveSetupFile('zed', 'user', c)).toBe('/Users/Jane Doe/.config/zed/settings.json')
    expect(resolveSetupFile('goose', 'user', c)).toBe('/Users/Jane Doe/dot config/goose/config.yaml')
    expect(resolveSetupFile('windsurf', 'user', c)).toBe('/Users/Jane Doe/dot config/devin/mcp_config.json')
  })

  it('Linux, with and without XDG_CONFIG_HOME (a relative value is ignored)', () => {
    const plain = ctx('linux', '/home/jane doe')
    expect(resolveSetupFile('vscode', 'user', plain)).toBe('/home/jane doe/.config/Code/User/mcp.json')
    expect(resolveSetupFile('zed', 'user', plain)).toBe('/home/jane doe/.config/zed/settings.json')
    expect(resolveSetupFile('claude-desktop', 'user', plain)).toBe(
      '/home/jane doe/.config/Claude/claude_desktop_config.json',
    )
    const xdg = ctx('linux', '/home/jane doe', { XDG_CONFIG_HOME: '/srv/cfg dir' })
    expect(resolveSetupFile('vscode', 'user', xdg)).toBe('/srv/cfg dir/Code/User/mcp.json')
    expect(resolveSetupFile('zed', 'user', xdg)).toBe('/srv/cfg dir/zed/settings.json')
    expect(resolveSetupFile('goose', 'user', xdg)).toBe('/srv/cfg dir/goose/config.yaml')
    const relative = ctx('linux', '/home/jane doe', { XDG_CONFIG_HOME: 'cfg' })
    expect(resolveSetupFile('goose', 'user', relative)).toBe('/home/jane doe/.config/goose/config.yaml')
    const flatpak = ctx('linux', '/home/jane doe', {
      FLATPAK_XDG_CONFIG_HOME: '/home/jane doe/.var/app/dev.zed.Zed/config',
    })
    expect(resolveSetupFile('zed', 'user', flatpak)).toBe(
      '/home/jane doe/.var/app/dev.zed.Zed/config/zed/settings.json',
    )
  })

  it('Windows, with APPDATA and with its default', () => {
    const c = ctx('win32', 'C:\\Users\\Jane Doe', { APPDATA: 'D:\\Roaming Profile' })
    expect(resolveSetupFile('vscode', 'user', c)).toBe('D:\\Roaming Profile\\Code\\User\\mcp.json')
    expect(resolveSetupFile('cursor', 'user', c)).toBe('C:\\Users\\Jane Doe\\.cursor\\mcp.json')
    expect(resolveSetupFile('windsurf', 'user', c)).toBe('D:\\Roaming Profile\\devin\\mcp_config.json')
    expect(resolveSetupFile('zed', 'user', c)).toBe('D:\\Roaming Profile\\Zed\\settings.json')
    expect(resolveSetupFile('goose', 'user', c)).toBe(
      'D:\\Roaming Profile\\Block\\goose\\config\\config.yaml',
    )
    expect(resolveSetupFile('codex', 'user', c)).toBe('C:\\Users\\Jane Doe\\.codex\\config.toml')
    expect(resolveSetupFile('claude-desktop', 'user', c)).toBe(
      'D:\\Roaming Profile\\Claude\\claude_desktop_config.json',
    )
    const noAppData = ctx('win32', 'C:\\Users\\Jane Doe')
    expect(resolveSetupFile('vscode', 'user', noAppData)).toBe(
      'C:\\Users\\Jane Doe\\AppData\\Roaming\\Code\\User\\mcp.json',
    )
  })

  it('honours CODEX_HOME and GOOSE_PATH_ROOT', () => {
    const c = ctx('linux', '/home/jane', {
      CODEX_HOME: '/opt/codex home',
      GOOSE_PATH_ROOT: '/opt/goose root',
    })
    expect(resolveSetupFile('codex', 'user', c)).toBe('/opt/codex home/config.toml')
    expect(resolveSetupFile('goose', 'user', c)).toBe('/opt/goose root/config/config.yaml')
  })

  it('project files live in the current folder; clients without one return null', () => {
    const c = ctx('linux', '/home/jane')
    expect(resolveSetupFile('vscode', 'project', c)).toBe('/work/my project/.vscode/mcp.json')
    expect(resolveSetupFile('cursor', 'project', c)).toBe('/work/my project/.cursor/mcp.json')
    expect(resolveSetupFile('zed', 'project', c)).toBe('/work/my project/.zed/settings.json')
    expect(resolveSetupFile('codex', 'project', c)).toBe('/work/my project/.codex/config.toml')
    expect(resolveSetupFile('goose', 'project', c)).toBeNull()
    const w = ctx('win32', 'C:\\Users\\Jane Doe')
    expect(resolveSetupFile('vscode', 'project', w)).toBe(
      'C:\\Users\\Jane Doe\\my project\\.vscode\\mcp.json',
    )
  })

  it("Windsurf: Devin Desktop's file when it exists, else a pre-rename Windsurf's", () => {
    const home = tempDir()
    const c = { platform: 'linux' as const, home, cwd: home, env: {} }
    const devin = join(home, '.config', 'devin', 'mcp_config.json')
    const legacy = join(home, '.codeium', 'windsurf', 'mcp_config.json')
    // Nothing installed: the current location.
    expect(resolveSetupFile('windsurf', 'user', c)).toBe(devin)
    // The Devin CLI's folder alone (config.json, cli/) says nothing about the editor.
    put(join(home, '.config', 'devin', 'config.json'), '{}')
    expect(resolveSetupFile('windsurf', 'user', c)).toBe(devin)
    // A Windsurf from before the rename (its folder, no mcp_config.json yet), next to the Devin CLI.
    mkdirSync(join(home, '.codeium', 'windsurf'), { recursive: true })
    expect(resolveSetupFile('windsurf', 'user', c)).toBe(legacy)
    put(legacy, '{}')
    expect(resolveSetupFile('windsurf', 'user', c)).toBe(legacy)
    // Devin Desktop's own file wins.
    put(devin, '{}')
    expect(resolveSetupFile('windsurf', 'user', c)).toBe(devin)
  })
})

describe('VS Code (JSONC)', () => {
  const EXISTING = `// My MCP servers
{
    "inputs": [
        { "type": "promptString", "id": "gh-token", "password": true }
    ],
    "servers": {
        /* GitHub, keep */
        "github": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"], // pinned later
        },
    },
}
`

  it('adds search-hole next to other servers and keeps comments, inputs and the 4-space indent', () => {
    const sb = sandbox()
    const file = put(
      resolveSetupFile('vscode', 'user', { platform, home: sb.home, cwd: sb.cwd }) as string,
      EXISTING,
    )
    const res = run(sb, { client: 'vscode' })
    expect(res.changed).toBe(true)
    expect(res.written).toBe(true)
    expect(res.file).toBe(file)
    expect(res.before).toBe(EXISTING)
    const text = readFileSync(file, 'utf8')
    expect(text).toBe(res.after)
    for (const kept of ['// My MCP servers', '/* GitHub, keep */', '// pinned later', '"gh-token"']) {
      expect(text).toContain(kept)
    }
    expect(text).toContain(`\n        "search-hole": {\n            "type": "stdio",`)
    // The result is still JSONC that a comment-aware reader accepts.
    const plain = text
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/,(\s*[}\]])/g, '$1')
    const parsed = JSON.parse(plain)
    expect(Object.keys(parsed.servers)).toEqual(['github', 'search-hole'])
    expect(parsed.servers['search-hole']).toEqual({
      type: 'stdio',
      command: 'node',
      args: args(sb, 'vscode'),
    })
    expect(parsed.servers.github.command).toBe('npx')
  })

  it('backs up the old file, and is idempotent', () => {
    const sb = sandbox()
    const file = put(
      resolveSetupFile('vscode', 'user', { platform, home: sb.home, cwd: sb.cwd }) as string,
      EXISTING,
    )
    const first = run(sb, { client: 'vscode' })
    expect(first.backup).toBe(`${file}.bak-20261031T185703Z`)
    expect(readFileSync(first.backup as string, 'utf8')).toBe(EXISTING)
    const second = run(sb, { client: 'vscode' })
    expect(second.changed).toBe(false)
    expect(second.written).toBe(false)
    expect(second.backup).toBeUndefined()
    expect(second.after).toBe(first.after)
    expect(second.instructions[0]).toContain('already set up')
    expect(backupsOf(file)).toHaveLength(1)
  })

  it('updates an old search-hole entry in place and keeps fields it does not own', () => {
    const sb = sandbox()
    const file = put(
      join(sb.cwd, '.vscode', 'mcp.json'),
      `{\n  "servers": {\n    "search-hole": { "command": "npx", "args": ["-y", "search-hole", "mcp"], "dev": { "watch": "x" } }\n  }\n}\n`,
    )
    const res = run(sb, { client: 'vscode', scope: 'project' })
    expect(res.instructions[0]).toMatch(/^Updated search-hole/)
    expect(JSON.parse(readFileSync(file, 'utf8')).servers['search-hole']).toEqual({
      command: 'node',
      args: args(sb, 'vscode'),
      dev: { watch: 'x' },
      type: 'stdio',
    })
    expect(res.instructions.join('\n')).toContain('keep it out of version control')
  })

  it('passes named variables with ${env:NAME}, never a value', () => {
    const sb = sandbox()
    const res = run(sb, {
      client: 'vscode',
      passEnv: ['TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY'],
      env: { TAVILY_API_KEY: 'tvly-dev-0123456789abcdef0123456789abcdef' },
    })
    const entry = JSON.parse(res.after).servers['search-hole']
    expect(entry.env).toEqual({
      TAVILY_API_KEY: '${env:TAVILY_API_KEY}',
      BRAVE_SEARCH_API_KEY: '${env:BRAVE_SEARCH_API_KEY}',
    })
    expect(res.after).not.toContain('tvly-')
  })
})

describe('creating files', () => {
  it.skipIf(!posixOnly)('creates the folders and the file, private in a user folder (Cursor)', () => {
    const sb = sandbox()
    const res = run(sb, { client: 'cursor' })
    const file = join(sb.home, '.cursor', 'mcp.json')
    expect(res.file).toBe(file)
    expect(res.before).toBeUndefined()
    expect(res.backup).toBeUndefined()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { 'search-hole': { type: 'stdio', command: 'node', args: args(sb, 'cursor') } },
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(res.instructions[0]).toBe(`Added search-hole to Cursor: ${file}`)
    expect(res.warnings.join('\n')).toContain('may not be installed')
  })

  it.skipIf(!posixOnly)('keeps the mode of an existing file', () => {
    const sb = sandbox()
    const file = put(join(sb.home, '.cursor', 'mcp.json'), '{ "mcpServers": {} }\n')
    // Group-readable on purpose; setup must not tighten or loosen it.
    chmodSync(file, 0o640)
    run(sb, { client: 'cursor' })
    expect(statSync(file).mode & 0o777).toBe(0o640)
  })

  it('fills an empty file and a file with only comments', () => {
    const sb = sandbox()
    const zed = put(join(sb.home, '.config', 'zed', 'settings.json'), '')
    run(sb, { client: 'zed', platform: 'linux' })
    expect(JSON.parse(readFileSync(zed, 'utf8'))).toEqual({
      context_servers: { 'search-hole': { command: 'node', args: args(sb, 'zed') } },
    })
    const commented = put(join(sb.cwd, '.zed', 'settings.json'), '// Zed project settings\n')
    run(sb, { client: 'zed', scope: 'project' })
    const text = readFileSync(commented, 'utf8')
    expect(text.startsWith('// Zed project settings\n{')).toBe(true)
  })

  it('a dry run writes nothing at all', () => {
    const sb = sandbox()
    for (const client of [
      'vscode',
      'cursor',
      'windsurf',
      'zed',
      'goose',
      'codex',
      'claude-desktop',
    ] as const) {
      const res = run(sb, { client, dryRun: true })
      expect(res.changed, client).toBe(true)
      expect(res.written, client).toBe(false)
      expect(res.after.length, client).toBeGreaterThan(0)
      expect(res.instructions[0], client).toMatch(/^Dry run: setup would add search-hole/)
    }
    expect(readdirSync(sb.home)).toEqual([])
    expect(readdirSync(sb.cwd)).toEqual([])
  })

  it('a dry run on an existing file leaves it and makes no backup', () => {
    const sb = sandbox()
    const file = put(join(sb.home, '.codex', 'config.toml'), 'model = "o4"\n')
    const res = run(sb, { client: 'codex', dryRun: true })
    expect(res.changed).toBe(true)
    expect(res.after).toContain('[mcp_servers.search-hole]')
    expect(readFileSync(file, 'utf8')).toBe('model = "o4"\n')
    expect(backupsOf(file)).toEqual([])
  })

  it.skipIf(!posixOnly)('writes through a symlinked config to its target', () => {
    const sb = sandbox()
    const real = put(
      join(sb.home, 'dotfiles', 'cursor mcp.json'),
      '{ "mcpServers": { "a": { "command": "x" } } }\n',
    )
    mkdirSync(join(sb.home, '.cursor'))
    const link = join(sb.home, '.cursor', 'mcp.json')
    symlinkSync(real, link)
    const res = run(sb, { client: 'cursor' })
    expect(statSync(link).isFile()).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(real, 'utf8')).mcpServers)).toEqual(['a', 'search-hole'])
    expect(readFileSync(res.backup as string, 'utf8')).toContain('"a"')
  })
})

describe('refusing files it cannot edit safely', () => {
  it('a strict-JSON client refuses comments, and the error carries the entry to paste', () => {
    const sb = sandbox()
    const file = put(
      join(sb.home, '.config', 'Claude', 'claude_desktop_config.json'),
      '{\n  // mine\n  "mcpServers": {}\n}\n',
    )
    const e = failure(() => run(sb, { client: 'claude-desktop', platform: 'linux' }))
    expect(e.code).toBe('config_invalid')
    expect(e.why).toContain(file)
    expect(e.why).toContain('left it unchanged')
    expect(e.fix).toContain('"mcpServers"')
    expect(e.fix).toContain('"--host",\n        "claude-desktop"')
    expect(readFileSync(file, 'utf8')).toContain('// mine')
    expect(backupsOf(file)).toEqual([])
  })

  it('broken JSON, a non-object root and a non-object servers key are refused', () => {
    const sb = sandbox()
    const file = join(sb.home, '.cursor', 'mcp.json')
    for (const text of [
      '{ "mcpServers": { ',
      '[1, 2]',
      '{ "mcpServers": [] }',
      '{ "mcpServers": {}, "mcpServers": {} }',
    ]) {
      put(file, text)
      const e = failure(() => run(sb, { client: 'cursor' }))
      expect(e.code, text).toBe('config_invalid')
      expect(readFileSync(file, 'utf8'), text).toBe(text)
    }
    expect(backupsOf(file)).toEqual([])
  })

  it('names the line of a JSON syntax error', () => {
    const sb = sandbox()
    put(join(sb.home, '.cursor', 'mcp.json'), '{\n  "mcpServers": {\n    "a": tru\n  }\n}\n')
    expect(failure(() => run(sb, { client: 'cursor' })).why).toContain('line 3')
  })

  it('a path that is a folder is refused', () => {
    const sb = sandbox()
    mkdirSync(join(sb.home, '.cursor', 'mcp.json'), { recursive: true })
    expect(failure(() => run(sb, { client: 'cursor' })).why).toContain('is not a file')
  })
})

describe('Zed (JSONC settings)', () => {
  it('adds context_servers to a settings file full of other settings', () => {
    const sb = sandbox()
    const settings = `// Zed settings
//
// For information on how to configure Zed, see the Zed documentation.
{
  "theme": "One Dark", // dark
  "vim_mode": true,
  "agent": { "default_model": { "provider": "zed.dev", "model": "x" } },
}
`
    const file = put(join(sb.home, '.config', 'zed', 'settings.json'), settings)
    const res = run(sb, { client: 'zed', platform: 'linux', passEnv: ['TAVILY_API_KEY'] })
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('"theme": "One Dark", // dark')
    expect(text).toContain('// For information on how to configure Zed')
    expect(text).toMatch(/"agent": \{[^\n]*\},\n {2}"context_servers": \{\n {4}"search-hole": \{/)
    // Zed has no pass-through syntax: nothing is written for the variable, and the user is told.
    expect(text).not.toContain('TAVILY_API_KEY')
    expect(res.warnings.join('\n')).toContain('searchhole keys set')
  })

  it('keeps an "enabled": false the user set, and says so', () => {
    const sb = sandbox()
    put(
      join(sb.cwd, '.zed', 'settings.json'),
      '{ "context_servers": { "search-hole": { "enabled": false, "command": "old", "args": [] } } }',
    )
    const res = run(sb, { client: 'zed', scope: 'project' })
    expect(JSON.parse(res.after).context_servers['search-hole']).toEqual({
      enabled: false,
      command: 'node',
      args: args(sb, 'zed'),
    })
    expect(res.warnings.join('\n')).toContain('switched off')
  })
})

describe('Windsurf (Devin Desktop)', () => {
  it('merges into mcpServers, with ${env:NAME} pass-through and a generic host', () => {
    const sb = sandbox()
    const file = put(
      join(sb.home, '.config', 'devin', 'mcp_config.json'),
      `${JSON.stringify({ mcpServers: { github: { command: 'npx', args: [] } } }, null, 2)}\n`,
    )
    run(sb, { client: 'windsurf', passEnv: ['TAVILY_API_KEY'] })
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers).toEqual({
      github: { command: 'npx', args: [] },
      'search-hole': {
        command: 'node',
        args: args(sb, 'generic'),
        env: { TAVILY_API_KEY: '${env:TAVILY_API_KEY}' },
      },
    })
  })

  it('writes the pre-rename location when only that exists, with a note', () => {
    const sb = sandbox()
    mkdirSync(join(sb.home, '.codeium', 'windsurf'), { recursive: true })
    const res = run(sb, { client: 'windsurf' })
    expect(res.file).toBe(join(sb.home, '.codeium', 'windsurf', 'mcp_config.json'))
    expect(res.warnings.join('\n')).toContain('from before the rename')
  })
})

describe('Claude Desktop', () => {
  it('adds a plain mcpServers entry and mentions the extension', () => {
    const sb = sandbox()
    const file = put(
      join(sb.home, '.config', 'Claude', 'claude_desktop_config.json'),
      '{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}},"globalShortcut":"Alt+Space"}',
    )
    run(sb, { client: 'claude-desktop', platform: 'linux' })
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed.globalShortcut).toBe('Alt+Space')
    expect(parsed.mcpServers['search-hole']).toEqual({ command: 'node', args: args(sb, 'claude-desktop') })
    expect(setupClientInfo('claude-desktop').alternative).toContain('.mcpb')
  })
})

describe('Codex (TOML)', () => {
  const CONFIG = `# Codex settings
model = "gpt-5-codex"
approval_policy = "on-request"
notes = """
[mcp_servers.search-hole]
this is text, not a table
"""

[mcp_servers.context7]
command = "npx"
args = [
  "-y",
  "@upstash/context7-mcp", # pinned
]

[mcp_servers.context7.env]
LOG = 'info'

[profiles.fast]
model = "o4-mini"
`

  it('appends its own table and leaves every other byte alone', () => {
    const sb = sandbox()
    const file = put(join(sb.home, '.codex', 'config.toml'), CONFIG)
    const res = run(sb, { client: 'codex' })
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith(CONFIG)).toBe(true)
    expect(text.slice(CONFIG.length)).toBe(
      `\n# search-hole, added by \`searchhole setup codex\`. Delete this table to remove it.\n[mcp_servers.search-hole]\ncommand = "node"\nargs = ${`[${args(
        sb,
        'codex',
      )
        .map((a) => tomlString(a))
        .join(', ')}]`}\n`,
    )
    expect(res.instructions.join('\n')).toContain('codex mcp list')
    expect(res.instructions.join('\n')).toContain('[mcp_servers.search-hole] table')
  })

  it('is idempotent and backs up only when something changed', () => {
    const sb = sandbox()
    const file = put(join(sb.home, '.codex', 'config.toml'), CONFIG)
    const first = run(sb, { client: 'codex' })
    const second = run(sb, { client: 'codex' })
    expect(second.changed).toBe(false)
    expect(second.after).toBe(first.after)
    expect(backupsOf(file)).toHaveLength(1)
  })

  it('updates its table in place: keys it owns change, the user keys and subtables stay', () => {
    const sb = sandbox()
    const before = `[mcp_servers.search-hole]
command = "npx"   # old launcher
startup_timeout_sec = 20
enabled = false

[mcp_servers.search-hole.env]
SEARCHHOLE_HOME = "/data/sh"

[other]
x = 1
`
    const file = put(join(sb.home, '.codex', 'config.toml'), before)
    const res = run(sb, { client: 'codex', passEnv: ['TAVILY_API_KEY'] })
    const text = readFileSync(file, 'utf8')
    expect(text).toBe(
      before.replace('command = "npx"', 'command = "node"').replace(
        '# old launcher\n',
        `# old launcher\nargs = [${args(sb, 'codex')
          .map((a) => tomlString(a))
          .join(', ')}]\nenv_vars = ["TAVILY_API_KEY"]\n`,
      ),
    )
    expect(res.instructions[0]).toMatch(/^Updated search-hole/)
    expect(res.warnings.join('\n')).toContain('switched off')
  })

  it('accepts a quoted table name, CRLF line endings and no final newline', () => {
    const sb = sandbox()
    const file = put(
      join(sb.home, '.codex', 'config.toml'),
      `model = "x"\r\n[mcp_servers."search-hole"]\r\ncommand = "npx"`,
    )
    run(sb, { client: 'codex' })
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(
      /^model = "x"\r\n\[mcp_servers\."search-hole"\]\r\ncommand = "node"\r\nargs = \[.*\]\r\n$/,
    )
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('escapes Windows paths', () => {
    const sb = sandbox()
    const res = setupClient({
      client: 'codex',
      home: 'C:\\Users\\Jane Doe',
      cwd: 'C:\\Users\\Jane Doe',
      bundlePath: 'C:\\Users\\Jane Doe\\personal dev\\search-hole\\dist\\searchhole.mjs',
      platform: 'win32',
      env: {},
      dryRun: true,
    })
    expect(res.file).toBe('C:\\Users\\Jane Doe\\.codex\\config.toml')
    expect(res.after).toContain(
      'args = ["C:\\\\Users\\\\Jane Doe\\\\personal dev\\\\search-hole\\\\dist\\\\searchhole.mjs", "mcp", "--host", "codex"]',
    )
    expect(sb.home).toBeDefined()
  })

  it.each([
    ['dotted keys', 'mcp_servers.search-hole.command = "node"\n'],
    ['an inline table', '[mcp_servers]\nsearch-hole = { command = "node" }\n'],
    ['an inline mcp_servers', 'mcp_servers = { other = { command = "x" } }\n'],
    ['an array of tables', '[[mcp_servers.search-hole]]\ncommand = "node"\n'],
    ['the table twice', '[mcp_servers.search-hole]\n[mcp_servers.search-hole]\n'],
    ['a key twice', '[mcp_servers.search-hole]\ncommand = "a"\ncommand = "b"\n'],
    ['a broken string', 'model = "gpt\n'],
    ['an unclosed header', '[mcp_servers.x\n'],
    ['an unclosed array', 'args = ["a",\n'],
    ['garbage after a value', 'model = "a" "b"\n'],
    ['an unclosed multi-line string', 'notes = """\nabc\n'],
  ])('refuses %s and prints the table to paste', (_what, text) => {
    const sb = sandbox()
    const file = put(join(sb.home, '.codex', 'config.toml'), text)
    const e = failure(() => run(sb, { client: 'codex' }))
    expect(e.code).toBe('config_invalid')
    expect(e.fix).toContain('[mcp_servers.search-hole]\ncommand = "node"\n')
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(backupsOf(file)).toEqual([])
  })

  it('reads TOML it must step over: literal strings, dates, inline tables, nested arrays', () => {
    const sb = sandbox()
    const text = `title = 'C:\\no escapes'
when = 1979-05-27 07:32:00
utc = 1979-05-27T07:32:00Z
n = +1_000
f = -3.5e+2
big = [[1, 2], ["a", 'b'], [ { x = 1 } ]]
point = { x = 1, y = "two" }
"quoted key" = true
"""
`.replace(/"""\n$/, '')
    put(join(sb.home, '.codex', 'config.toml'), text)
    const res = run(sb, { client: 'codex', dryRun: true })
    expect(res.after.startsWith(text)).toBe(true)
  })

  it('codexSnippet gives the whole table, with env_vars when asked', () => {
    expect(
      codexSnippet({ command: 'node', args: ['/a b/searchhole.mjs', 'mcp', '--host', 'codex'] }, [
        'TAVILY_API_KEY',
      ]),
    ).toBe(
      '[mcp_servers.search-hole]\ncommand = "node"\nargs = ["/a b/searchhole.mjs", "mcp", "--host", "codex"]\nenv_vars = ["TAVILY_API_KEY"]\n',
    )
  })
})

describe('Goose (YAML)', () => {
  const CONFIG = `# goose config
GOOSE_PROVIDER: anthropic
GOOSE_MODEL: claude-sonnet
extensions:
  developer:
    enabled: true
    name: developer
    type: builtin
    timeout: 300
  github:
    # my token comes from the keyring
    args:
    - -y
    - '@modelcontextprotocol/server-github'
    cmd: npx
    enabled: true
    env_keys:
    - GITHUB_PERSONAL_ACCESS_TOKEN
    envs: {}
    name: GitHub
    timeout: 300
    type: stdio
`

  it('adds an extension and keeps the others, the comments and the sequence style', () => {
    const sb = sandbox()
    const file = put(join(sb.home, '.config', 'goose', 'config.yaml'), CONFIG)
    run(sb, { client: 'goose', platform: 'linux' })
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith(CONFIG)).toBe(true)
    expect(text).toContain('# my token comes from the keyring')
    const parsed = parseYaml(text)
    expect(Object.keys(parsed.extensions)).toEqual(['developer', 'github', 'search-hole'])
    expect(parsed.extensions['search-hole']).toMatchObject({
      enabled: true,
      type: 'stdio',
      name: 'search-hole',
      cmd: 'node',
      args: args(sb, 'goose'),
      envs: {},
      timeout: 300,
    })
    expect(parsed.extensions.github.env_keys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN'])
    expect(text).toContain(`\n    args:\n    - ${sb.bundle}\n`)
  })

  it('is idempotent; an update re-enables it, adds env_keys and keeps a custom timeout', () => {
    const sb = sandbox()
    const file = put(join(sb.home, '.config', 'goose', 'config.yaml'), CONFIG)
    const first = run(sb, { client: 'goose', platform: 'linux' })
    expect(run(sb, { client: 'goose', platform: 'linux' }).changed).toBe(false)
    writeFileSync(
      file,
      first.after
        .replace(
          'enabled: true\n    type: stdio\n    name: search-hole',
          'enabled: false\n    type: stdio\n    name: search-hole',
        )
        .replace(/timeout: 300\n$/, 'timeout: 60\n'),
    )
    const res = run(sb, { client: 'goose', platform: 'linux', passEnv: ['TAVILY_API_KEY'] })
    const entry = parseYaml(readFileSync(file, 'utf8')).extensions['search-hole']
    expect(entry.enabled).toBe(true)
    expect(entry.timeout).toBe(60)
    expect(entry.env_keys).toEqual(['TAVILY_API_KEY'])
    expect(res.instructions[0]).toMatch(/^Updated/)
  })

  it('creates a config from nothing', () => {
    const sb = sandbox()
    run(sb, { client: 'goose', platform: 'linux' })
    const parsed = parseYaml(readFileSync(join(sb.home, '.config', 'goose', 'config.yaml'), 'utf8'))
    expect(Object.keys(parsed)).toEqual(['extensions'])
  })

  it('refuses broken YAML and a non-mapping extensions key', () => {
    const sb = sandbox()
    const file = join(sb.home, '.config', 'goose', 'config.yaml')
    for (const text of ['extensions: [\n', 'extensions:\n  - a\n', '- just\n- a list\n', 'a: 1\na: 2\n']) {
      put(file, text)
      const e = failure(() => run(sb, { client: 'goose', platform: 'linux' }))
      expect(e.code, text).toBe('config_invalid')
      expect(e.fix, text).toContain('search-hole:')
      expect(readFileSync(file, 'utf8')).toBe(text)
    }
  })
})

describe('generic', () => {
  it('prints a snippet and writes nothing', () => {
    const sb = sandbox()
    const res = run(sb, { client: 'generic' })
    expect(res.file).toBeNull()
    expect(res.written).toBe(false)
    expect(JSON.parse(res.after)).toEqual({
      mcpServers: { 'search-hole': { command: 'node', args: args(sb, 'generic') } },
    })
    expect(readdirSync(sb.home)).toEqual([])
  })
})

describe('options', () => {
  it('rejects a scope the client does not have', () => {
    const sb = sandbox()
    const e = failure(() => run(sb, { client: 'goose', scope: 'project' }))
    expect(e.code).toBe('invalid_argument')
    expect(e.fix).toContain('without --project')
  })

  it('rejects a relative bundle path', () => {
    const sb = sandbox()
    expect(failure(() => run(sb, { client: 'cursor', bundlePath: 'dist/searchhole.mjs' })).code).toBe(
      'invalid_argument',
    )
  })

  it.each([
    'tvly-dev-0123456789abcdef0123456789abcdef',
    'AKIAIOSFODNN7EXAMPLE',
    'BSAabcdefghijklmnopqrstuvwxyz12',
    'tavily_api_key',
    'TAVILYKEY',
    'TAVILY_API_KEY=abc',
    'A_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ])('refuses %s as a variable name, without echoing it', (value) => {
    const sb = sandbox()
    const e = failure(() => run(sb, { client: 'vscode', passEnv: [value] }))
    expect(e.code).toBe('invalid_argument')
    expect(`${e.why} ${e.fix}`).not.toContain(value)
    expect(readdirSync(sb.home)).toEqual([])
  })

  it('warns about an npx cache bundle and a missing bundle', () => {
    const sb = sandbox()
    const npx = join(
      sb.home,
      '.npm',
      '_npx',
      'abc123',
      'node_modules',
      'search-hole',
      'dist',
      'searchhole.mjs',
    )
    expect(isEphemeralBundle(npx)).toBe(true)
    expect(isEphemeralBundle('C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\1\\searchhole.mjs')).toBe(true)
    expect(isEphemeralBundle(sb.bundle)).toBe(false)
    expect(run(sb, { client: 'cursor', bundlePath: npx, dryRun: true }).warnings.join('\n')).toContain(
      'npm install -g search-hole',
    )
    expect(
      run(sb, {
        client: 'cursor',
        bundlePath: join(sb.home, 'gone', 'searchhole.mjs'),
        dryRun: true,
      }).warnings.join('\n'),
    ).toContain('does not exist')
  })

  it('uses another command when asked', () => {
    const sb = sandbox()
    const res = run(sb, { client: 'cursor', command: '/opt/node 22/bin/node', dryRun: true })
    expect(JSON.parse(res.after).mcpServers['search-hole'].command).toBe('/opt/node 22/bin/node')
  })
})

describe('resolveBundlePath', () => {
  it('returns the real path of the built bundle', () => {
    const sb = sandbox()
    expect(resolveBundlePath(sb.bundle)).toBe(realpathSync(sb.bundle))
    expect(
      resolveBundlePath(
        '/usr/local/bin/searchhole',
        () => '/usr/local/lib/node_modules/search-hole/dist/searchhole.mjs',
      ),
    ).toBe('/usr/local/lib/node_modules/search-hole/dist/searchhole.mjs')
  })

  it('refuses a source entry point or a missing file', () => {
    expect(failure(() => resolveBundlePath('/repo/src/cli/main.ts', (p) => p)).why).toContain(
      'built search-hole bundle',
    )
    expect(failure(() => resolveBundlePath(undefined)).code).toBe('invalid_argument')
    expect(
      failure(() =>
        resolveBundlePath('/nope', () => {
          throw new Error('ENOENT')
        }),
      ).why,
    ).toContain('could not find')
  })
})

describe('backupName', () => {
  it('uses a UTC timestamp without colons and never reuses a name', () => {
    const dir = tempDir()
    const file = join(dir, 'mcp.json')
    const first = backupName(file, NOW)
    expect(first).toBe(`${file}.bak-20261031T185703Z`)
    writeFileSync(first, '')
    expect(backupName(file, NOW)).toBe(`${file}.bak-20261031T185703Z-2`)
  })
})
