// SPDX-License-Identifier: Apache-2.0
/**
 * `searchhole setup <client>` (MASTER_PLAN §9.3, P7; ADR-0002 point 3): adds search-hole's MCP
 * server to another AI client's own config file, so that client starts
 * `node <bundle> mcp --host <profile>`.
 *
 * Rules this module enforces:
 * - **Merge, never clobber.** Other servers, unknown keys and, where the format has them,
 *   comments survive. An existing search-hole entry is updated in place; fields search-hole
 *   does not own (a timeout, a disabled flag) are kept.
 * - **A file that does not parse as the client reads it is refused untouched**, with the entry
 *   to add by hand in the error's `fix`.
 * - **Backup, then atomic write.** The old file is copied to `<file>.bak-<UTC time>`, the new one
 *   is written through a temp file and a rename, the file's mode is kept, and a symlinked config
 *   is written through to its target.
 * - **No secrets.** An engine key is only referenced by its environment variable *name*, in the
 *   client's own pass-through syntax. Keys stored with `searchhole keys set` (OS keychain) need
 *   nothing in any config.
 * - **`dryRun` writes nothing**: no directory, no backup, no file.
 *
 * Formats: JSON with comments where the client reads JSONC (VS Code, Zed, Cursor), strict JSON
 * elsewhere, TOML for Codex (a small scanner that only edits search-hole's own table; anything
 * it can't edit safely is refused with the table to paste) and YAML for Goose (the `yaml`
 * Document API). Nothing here reads `process`: callers pass the home, platform and environment.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { posix, win32 } from 'node:path'
import { type Document, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { HostProfile } from '../app/types.ts'
import { detectSecrets } from '../core/hygiene.ts'
import { SearchHoleError } from '../shared/errors.ts'
import { atomicWriteFile, ensureDir } from '../shared/paths.ts'
import { isSetupClient, SETUP_CLIENT_IDS, type SetupClient } from './setup-clients.ts'

// ── The client table ──────────────────────────────────────────────────────

export type { SetupClient }
export type SetupScope = 'user' | 'project'
export type SetupFormat = 'json' | 'jsonc' | 'toml' | 'yaml' | 'snippet'

/** The name of search-hole's entry in every client config. */
export const SERVER_NAME = 'search-hole'

export interface SetupClientInfo {
  readonly id: SetupClient
  /** The product name people know. */
  readonly name: string
  /** The `--host` profile the client's entry launches (ADR-0012). */
  readonly host: HostProfile
  readonly format: SetupFormat
  readonly scopes: readonly SetupScope[]
  /** Where the user file lives, for help text (the exact path depends on OS and environment). */
  readonly userFile: string
  readonly projectFile?: string
  /**
   * How a named environment variable reaches the gateway:
   * `interpolate` writes `"NAME": "${env:NAME}"`, `env_vars` and `env_keys` list the name,
   * `none` means the client has no pass-through (keys go in the keychain).
   */
  readonly envPassing: 'interpolate' | 'env_vars' | 'env_keys' | 'none'
  /** A packaged install that does the same job, when there is one. */
  readonly alternative?: string
  readonly docs: string
}

/**
 * Every client `setup` knows. Windsurf has no host profile of its own, so it runs as `generic`;
 * Codex and Zed never get `apply_rule` (ADR-0012), which their profiles already ensure.
 */
export const SETUP_CLIENTS: readonly SetupClientInfo[] = [
  {
    id: 'vscode',
    name: 'VS Code (GitHub Copilot)',
    host: 'vscode',
    format: 'jsonc',
    scopes: ['user', 'project'],
    userFile: 'mcp.json in your VS Code user folder',
    projectFile: '.vscode/mcp.json',
    envPassing: 'interpolate',
    docs: 'docs/clients/vscode.md',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    host: 'cursor',
    format: 'jsonc',
    scopes: ['user', 'project'],
    userFile: '~/.cursor/mcp.json',
    projectFile: '.cursor/mcp.json',
    envPassing: 'interpolate',
    alternative: 'the search-hole Cursor plugin',
    docs: 'docs/clients/cursor.md',
  },
  {
    id: 'windsurf',
    name: 'Windsurf (Devin Desktop)',
    host: 'generic',
    format: 'json',
    scopes: ['user'],
    userFile: '~/.config/devin/mcp_config.json (older Windsurf: ~/.codeium/windsurf/)',
    envPassing: 'interpolate',
    docs: 'docs/clients/windsurf.md',
  },
  {
    id: 'zed',
    name: 'Zed',
    host: 'zed',
    format: 'jsonc',
    scopes: ['user', 'project'],
    userFile: '~/.config/zed/settings.json',
    projectFile: '.zed/settings.json',
    envPassing: 'none',
    docs: 'docs/clients/zed.md',
  },
  {
    id: 'goose',
    name: 'Goose',
    host: 'goose',
    format: 'yaml',
    scopes: ['user'],
    userFile: '~/.config/goose/config.yaml',
    envPassing: 'env_keys',
    docs: 'docs/clients/goose.md',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    host: 'codex',
    format: 'toml',
    scopes: ['user', 'project'],
    userFile: '~/.codex/config.toml',
    projectFile: '.codex/config.toml',
    envPassing: 'env_vars',
    alternative: 'the search-hole Codex plugin',
    docs: 'docs/clients/codex.md',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    host: 'claude-desktop',
    format: 'json',
    scopes: ['user'],
    userFile: 'claude_desktop_config.json in your Claude folder',
    envPassing: 'none',
    alternative: 'the Claude Desktop extension (.mcpb), which keeps keys in your keychain',
    docs: 'docs/clients/claude-desktop.md',
  },
  {
    id: 'generic',
    name: 'Any other MCP client',
    host: 'generic',
    format: 'snippet',
    scopes: ['user'],
    userFile: 'nothing is written; a JSON snippet is printed',
    envPassing: 'none',
    docs: 'docs/clients/generic.md',
  },
]

// Client ids live in setup-clients.ts (loaded on every CLI start); the table must match it.
export { isSetupClient, SETUP_CLIENT_IDS }

/** The table row for a client. */
export function setupClientInfo(client: SetupClient): SetupClientInfo {
  const info = SETUP_CLIENTS.find((c) => c.id === client)
  if (info === undefined) throw new SearchHoleError('internal', `No setup entry for ${client}.`)
  return info
}

// ── Where each client keeps its config ───────────────────────────────────

type Env = Readonly<Record<string, string | undefined>>

export interface SetupPathContext {
  platform: NodeJS.Platform
  home: string
  cwd: string
  env?: Env
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix)

const envDir = (env: Env | undefined, name: string, platform: NodeJS.Platform): string | undefined => {
  const value = env?.[name]?.trim()
  return value !== undefined && value !== '' && pathFor(platform).isAbsolute(value) ? value : undefined
}

/** `%APPDATA%` (Roaming), or its default under the home folder. */
const appData = (ctx: SetupPathContext): string =>
  envDir(ctx.env, 'APPDATA', 'win32') ?? win32.join(ctx.home, 'AppData', 'Roaming')

/** `$XDG_CONFIG_HOME` when it is an absolute path (the XDG rule), else `~/.config`. */
const xdgConfig = (ctx: SetupPathContext): string =>
  envDir(ctx.env, 'XDG_CONFIG_HOME', ctx.platform) ?? pathFor(ctx.platform).join(ctx.home, '.config')

/** Devin Desktop's own folder (`~/.config/devin`, `%APPDATA%\devin`). */
const devinDir = (ctx: SetupPathContext): string =>
  ctx.platform === 'win32' ? win32.join(appData(ctx), 'devin') : posix.join(xdgConfig(ctx), 'devin')

/** Windsurf's folder from before the Devin Desktop rename. */
const legacyWindsurfDir = (ctx: SetupPathContext): string =>
  pathFor(ctx.platform).join(ctx.home, '.codeium', 'windsurf')

/**
 * The config file `setup` edits for a client and scope; null for `generic` (nothing is written)
 * or a scope the client doesn't have. Sources and dates: docs/clients/README.md.
 */
export function resolveSetupFile(
  client: SetupClient,
  scope: SetupScope,
  ctx: SetupPathContext,
): string | null {
  const p = pathFor(ctx.platform)
  const { platform, home, cwd } = ctx
  if (scope === 'project') {
    const rel: Partial<Record<SetupClient, string[]>> = {
      vscode: ['.vscode', 'mcp.json'],
      cursor: ['.cursor', 'mcp.json'],
      zed: ['.zed', 'settings.json'],
      codex: ['.codex', 'config.toml'],
    }
    const parts = rel[client]
    return parts === undefined ? null : p.join(cwd, ...parts)
  }
  switch (client) {
    case 'vscode':
      if (platform === 'win32') return win32.join(appData(ctx), 'Code', 'User', 'mcp.json')
      if (platform === 'darwin')
        return posix.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
      return posix.join(xdgConfig(ctx), 'Code', 'User', 'mcp.json')
    case 'cursor':
      return p.join(home, '.cursor', 'mcp.json')
    case 'windsurf': {
      // Devin Desktop (Windsurf renamed in 3.0, 2026) keeps Cascade's servers in
      // ~/.config/devin/mcp_config.json; Windsurf before the rename reads ~/.codeium/windsurf.
      // The folders alone prove little (the Devin CLI also creates ~/.config/devin, and Devin
      // Desktop keeps using ~/.codeium/windsurf for other data), so the files decide: Devin's
      // file if it exists, else Windsurf's file or folder if either exists, else Devin's.
      const current = p.join(devinDir(ctx), 'mcp_config.json')
      const legacyDir = legacyWindsurfDir(ctx)
      const legacy = p.join(legacyDir, 'mcp_config.json')
      if (existsSync(current)) return current
      return existsSync(legacy) || existsSync(legacyDir) ? legacy : current
    }
    case 'zed':
      if (platform === 'win32') return win32.join(appData(ctx), 'Zed', 'settings.json')
      if (platform === 'darwin') return posix.join(home, '.config', 'zed', 'settings.json')
      return posix.join(
        envDir(ctx.env, 'FLATPAK_XDG_CONFIG_HOME', platform) ?? xdgConfig(ctx),
        'zed',
        'settings.json',
      )
    case 'goose': {
      const root = envDir(ctx.env, 'GOOSE_PATH_ROOT', platform)
      if (root !== undefined) return p.join(root, 'config', 'config.yaml')
      if (platform === 'win32') return win32.join(appData(ctx), 'Block', 'goose', 'config', 'config.yaml')
      return posix.join(xdgConfig(ctx), 'goose', 'config.yaml')
    }
    case 'codex':
      return p.join(envDir(ctx.env, 'CODEX_HOME', platform) ?? p.join(home, '.codex'), 'config.toml')
    case 'claude-desktop':
      if (platform === 'win32') return win32.join(appData(ctx), 'Claude', 'claude_desktop_config.json')
      if (platform === 'darwin')
        return posix.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      return posix.join(xdgConfig(ctx), 'Claude', 'claude_desktop_config.json')
    case 'generic':
      return null
  }
}

// ── Options and result ───────────────────────────────────────────────────

export interface SetupOptions extends SetupPathContext {
  client: SetupClient
  /** Default `user`. */
  scope?: SetupScope
  /** Absolute path of the built bundle, `…/dist/searchhole.mjs` (see `resolveBundlePath`). */
  bundlePath: string
  /** Compute and report the change, write nothing. */
  dryRun: boolean
  /**
   * Names (never values) of environment variables, such as `TAVILY_API_KEY`, that the client
   * should pass to the gateway. Optional: keys from `searchhole keys set` need none.
   */
  passEnv?: readonly string[]
  /** What the client runs. Default `node`, which must be on the client's PATH. */
  command?: string
  /** Clock for the backup name. */
  now?: () => number
}

export interface SetupResult {
  client: SetupClient
  host: HostProfile
  scope: SetupScope
  format: SetupFormat
  /** The config file; null for `generic`, which only prints a snippet. */
  file: string | null
  /** The file's text before; absent when it did not exist. */
  before?: string
  /** The file's text after (for `generic`, the snippet). */
  after: string
  /** True when `after` differs from the file (whether or not it was written). */
  changed: boolean
  /** True when the file was written (changed and not a dry run). */
  written: boolean
  /** The copy of the previous file, when one was made. */
  backup?: string
  /** What happened and what to do next, one line each. */
  instructions: string[]
  /** Things worth knowing that did not stop the change. */
  warnings: string[]
}

// ── Validation ───────────────────────────────────────────────────────────

const invalid = (why: string, fix: string): SearchHoleError =>
  new SearchHoleError('invalid_argument', why, { fix })

/** An environment variable name: upper case, digits, at least one underscore, short words. */
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

/**
 * Checks `passEnv`. The value is never echoed: a mistyped key pasted where a name belongs must
 * not end up in a terminal log.
 */
function checkEnvNames(names: readonly string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    const ok =
      name.length <= 64 &&
      ENV_NAME.test(name) &&
      name.split('_').every((part) => part.length <= 24) &&
      detectSecrets(name).length === 0
    if (!ok) {
      throw invalid(
        'An environment variable for setup must be a NAME such as TAVILY_API_KEY, never a key itself.',
        'Pass the variable name only, or store the key with `searchhole keys set <engine>`.',
      )
    }
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/** True when the bundle sits in npx's temporary cache, which npm may delete. */
export const isEphemeralBundle = (bundlePath: string): boolean => /[\\/]_npx[\\/]/.test(bundlePath)

/**
 * The bundle path to write into client configs: the real path of the running entry script,
 * which main.ts hands over (argv index 1; a symlink for global npm installs). Throws when the
 * CLI is not running from a built `searchhole.mjs` (for example `node src/cli/main.ts`).
 */
export function resolveBundlePath(
  entry: string | undefined,
  realpath: (path: string) => string = realpathSync,
): string {
  const fix =
    'Build it (pnpm -C packages/search-hole build), then run `node packages/search-hole/dist/searchhole.mjs setup <client>`.'
  if (entry === undefined || entry === '') {
    throw invalid('setup needs to know where the search-hole bundle is.', fix)
  }
  let real: string
  try {
    real = realpath(entry)
  } catch {
    throw invalid('setup could not find the search-hole bundle it runs from.', fix)
  }
  if (!/[\\/]searchhole\.mjs$/.test(real)) {
    throw invalid('setup must run from the built search-hole bundle (dist/searchhole.mjs).', fix)
  }
  return real
}

// ── What each client gets ────────────────────────────────────────────────

interface Launch {
  command: string
  args: string[]
}

function launchFor(opts: SetupOptions, host: HostProfile): Launch {
  return { command: opts.command ?? 'node', args: [opts.bundlePath, 'mcp', '--host', host] }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObjectValue = { [key: string]: Json }

const isPlainObject = (v: unknown): v is JsonObjectValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  }
  return false
}

interface JsonClientShape {
  /** The top-level key holding the servers. */
  rootKey: string
  jsonc: boolean
  /** Fields search-hole owns in its entry (set every time). */
  managed: JsonObjectValue
  /** Merged into the entry's `env` (only for clients that interpolate). */
  env?: Record<string, string>
}

function jsonShape(client: SetupClient, l: Launch, passEnv: readonly string[]): JsonClientShape {
  const env =
    passEnv.length > 0 && setupClientInfo(client).envPassing === 'interpolate'
      ? Object.fromEntries(passEnv.map((n) => [n, `\${env:${n}}`]))
      : undefined
  const base = { command: l.command, args: l.args }
  const withEnv = (s: JsonClientShape): JsonClientShape => (env === undefined ? s : { ...s, env })
  switch (client) {
    case 'vscode':
      return withEnv({ rootKey: 'servers', jsonc: true, managed: { type: 'stdio', ...base } })
    case 'cursor':
      return withEnv({ rootKey: 'mcpServers', jsonc: true, managed: { type: 'stdio', ...base } })
    case 'windsurf':
      return withEnv({ rootKey: 'mcpServers', jsonc: false, managed: base })
    case 'zed':
      return { rootKey: 'context_servers', jsonc: true, managed: base }
    case 'claude-desktop':
      return { rootKey: 'mcpServers', jsonc: false, managed: base }
    default:
      throw new SearchHoleError('internal', `${client} is not a JSON client.`)
  }
}

/** The entry merged over what the file has: managed fields win, `env` is merged, the rest stays. */
function mergeJsonEntry(existing: JsonObjectValue | undefined, shape: JsonClientShape): JsonObjectValue {
  const out: JsonObjectValue = { ...(existing ?? {}) }
  for (const [k, v] of Object.entries(shape.managed)) out[k] = v
  if (shape.env !== undefined) {
    const prev = isPlainObject(out.env) ? out.env : {}
    out.env = { ...prev, ...shape.env }
  }
  return out
}

/** A snippet for any MCP client that takes the common `mcpServers` JSON. */
export function genericSnippet(l: Launch): string {
  return `${JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: l.command, args: l.args } } }, null, 2)}\n`
}

// ── Errors with a way out ────────────────────────────────────────────────

/** Why a file can't be edited safely; turned into a SearchHoleError with the snippet to paste. */
class Refusal extends Error {}

/** What a format editor returns. */
interface EditOutcome {
  after: string
  /** search-hole had an entry before. */
  existed: boolean
  /** That entry is switched off by a field setup keeps (`disabled: true`, `enabled = false`). */
  disabled: boolean
}

const lineOf = (text: string, offset: number): number => text.slice(0, offset).split('\n').length

function refused(file: string, why: string, snippet: string): SearchHoleError {
  return new SearchHoleError('config_invalid', `${file} ${why}, so search-hole left it unchanged.`, {
    fix: `Fix the file, or add search-hole to it by hand:\n${snippet}`,
    details: { file, snippet },
  })
}

// ── JSON and JSONC: parse with positions, edit as text ──────────────────

interface JsonObjectNode {
  kind: 'object'
  start: number
  end: number
  props: JsonPropNode[]
  /** Offset of a trailing comma after the last property (JSONC only). */
  trailingComma: number | undefined
}
interface JsonArrayNode {
  kind: 'array'
  start: number
  end: number
  items: JsonNode[]
}
interface JsonScalarNode {
  kind: 'scalar'
  start: number
  end: number
  value: string | number | boolean | null
}
type JsonNode = JsonObjectNode | JsonArrayNode | JsonScalarNode
interface JsonPropNode {
  key: string
  keyStart: number
  value: JsonNode
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

/**
 * Parses JSON (or JSONC: `//` and `/* *\/` comments, trailing commas) keeping every node's
 * offsets. Returns undefined for a file with no value at all (empty, or only comments).
 */
function parseJsonText(text: string, jsonc: boolean): JsonNode | undefined {
  let pos = 0
  const problem = (what: string): Refusal =>
    new Refusal(`does not parse (line ${lineOf(text, pos)}: ${what})`)
  const skip = (): void => {
    for (;;) {
      const c = text[pos]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos++
      else if (jsonc && c === '/' && text[pos + 1] === '/') {
        const nl = text.indexOf('\n', pos)
        pos = nl === -1 ? text.length : nl
      } else if (jsonc && c === '/' && text[pos + 1] === '*') {
        const close = text.indexOf('*/', pos + 2)
        if (close === -1) throw problem('a /* comment is never closed')
        pos = close + 2
      } else return
    }
  }
  const str = (): JsonScalarNode => {
    const start = pos
    pos++
    for (;;) {
      const c = text[pos]
      if (c === undefined) throw problem('a string is never closed')
      if (c === '"') break
      if (c === '\\') pos += 2
      else if (c < ' ') throw problem('a string runs past the end of its line')
      else pos++
    }
    pos++
    let value: unknown
    try {
      value = JSON.parse(text.slice(start, pos))
    } catch {
      pos = start
      throw problem('a string has an unknown escape')
    }
    return { kind: 'scalar', start, end: pos, value: String(value) }
  }
  const val = (depth: number): JsonNode => {
    if (depth > 100) throw problem('values are nested too deeply')
    skip()
    const c = text[pos]
    const start = pos
    if (c === '{') {
      pos++
      const props: JsonPropNode[] = []
      let trailingComma: number | undefined
      skip()
      if (text[pos] === '}') {
        pos++
        return { kind: 'object', start, end: pos, props, trailingComma }
      }
      for (;;) {
        skip()
        if (text[pos] !== '"') throw problem('expected a "name" in double quotes')
        const key = str()
        skip()
        if (text[pos] !== ':') throw problem("expected ':' after a name")
        pos++
        const value = val(depth + 1)
        props.push({ key: String(key.value), keyStart: key.start, value })
        skip()
        if (text[pos] === ',') {
          const comma = pos
          pos++
          skip()
          if (text[pos] === '}') {
            if (!jsonc) throw problem('a comma before } is not allowed in this file')
            trailingComma = comma
            pos++
            break
          }
          continue
        }
        if (text[pos] === '}') {
          pos++
          break
        }
        throw problem("expected ',' or '}'")
      }
      return { kind: 'object', start, end: pos, props, trailingComma }
    }
    if (c === '[') {
      pos++
      const items: JsonNode[] = []
      skip()
      if (text[pos] === ']') {
        pos++
        return { kind: 'array', start, end: pos, items }
      }
      for (;;) {
        items.push(val(depth + 1))
        skip()
        if (text[pos] === ',') {
          pos++
          skip()
          if (text[pos] === ']') {
            if (!jsonc) throw problem('a comma before ] is not allowed in this file')
            pos++
            break
          }
          continue
        }
        if (text[pos] === ']') {
          pos++
          break
        }
        throw problem("expected ',' or ']'")
      }
      return { kind: 'array', start, end: pos, items }
    }
    if (c === '"') return str()
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(word, pos)) {
        pos += word.length
        return { kind: 'scalar', start, end: pos, value }
      }
    }
    JSON_NUMBER.lastIndex = pos
    const m = JSON_NUMBER.exec(text)
    if (m === null) throw problem(c === undefined ? 'the file ends early' : 'expected a value')
    pos += m[0].length
    return { kind: 'scalar', start, end: pos, value: Number(m[0]) }
  }
  skip()
  if (pos >= text.length) return undefined
  const root = val(0)
  skip()
  if (pos < text.length) throw problem('unexpected text after the end')
  return root
}

function toJson(node: JsonNode): Json {
  if (node.kind === 'scalar') return node.value
  if (node.kind === 'array') return node.items.map(toJson)
  // fromEntries defines own properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(node.props.map((p) => [p.key, toJson(p.value)]))
}

interface Layout {
  eol: string
  unit: string
}

function detectLayout(text: string): Layout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const m = /^([ \t]+)\S/m.exec(text)
  const indent = m?.[1]
  const unit =
    indent === undefined
      ? '  '
      : indent.startsWith('\t')
        ? '\t'
        : ' '.repeat(Math.min(Math.max(indent.length, 1), 8))
  return { eol, unit }
}

const lineStartOf = (text: string, offset: number): number => text.lastIndexOf('\n', offset - 1) + 1
const indentAt = (text: string, offset: number): string =>
  /^[ \t]*/.exec(text.slice(lineStartOf(text, offset), offset))?.[0] ?? ''
const startsOwnLine = (text: string, offset: number): boolean =>
  text.slice(lineStartOf(text, offset), offset).trim() === ''

const serialize = (value: Json, baseIndent: string, l: Layout): string =>
  JSON.stringify(value, null, l.unit).split('\n').join(`${l.eol}${baseIndent}`)

interface TextEdit {
  at: number
  remove: number
  insert: string
}

/** Applies edits from the end backwards; of two edits at one offset, the first listed ends up first. */
function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text
  const order = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.at - a.e.at || b.i - a.i)
  for (const { e } of order) out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove)
  return out
}

/** Past spaces and a comment that ends on the same line; otherwise `pos` itself. */
function pastSameLineComment(text: string, pos: number): number {
  let p = pos
  while (text[p] === ' ' || text[p] === '\t') p++
  if (text.startsWith('//', p)) {
    const nl = text.indexOf('\n', p)
    if (nl === -1) return text.length
    return text[nl - 1] === '\r' ? nl - 1 : nl
  }
  if (text.startsWith('/*', p)) {
    const close = text.indexOf('*/', p + 2)
    const nl = text.indexOf('\n', p)
    if (close !== -1 && (nl === -1 || close < nl)) return close + 2
  }
  return pos
}

/** Edits that add `"key": value` as the last property of `obj`, in the file's own layout. */
function insertPropEdits(text: string, obj: JsonObjectNode, key: string, value: Json, l: Layout): TextEdit[] {
  const objIndent = indentAt(text, obj.start)
  const first = obj.props[0]
  const propIndent =
    first !== undefined && startsOwnLine(text, first.keyStart)
      ? indentAt(text, first.keyStart)
      : objIndent + l.unit
  const prop = `${JSON.stringify(key)}: ${serialize(value, propIndent, l)}`
  const last = obj.props.at(-1)
  if (last === undefined) {
    const inner = text.slice(obj.start + 1, obj.end - 1)
    if (inner.trim() === '') {
      return [
        {
          at: obj.start + 1,
          remove: inner.length,
          insert: `${l.eol}${propIndent}${prop}${l.eol}${objIndent}`,
        },
      ]
    }
    // Only comments inside: keep them after the new property.
    return [{ at: obj.start + 1, remove: 0, insert: `${l.eol}${propIndent}${prop}` }]
  }
  const edits: TextEdit[] = []
  let anchor: number
  if (obj.trailingComma !== undefined) anchor = obj.trailingComma + 1
  else {
    edits.push({ at: last.value.end, remove: 0, insert: ',' })
    anchor = last.value.end
  }
  edits.push({ at: pastSameLineComment(text, anchor), remove: 0, insert: `${l.eol}${propIndent}${prop}` })
  return edits
}

interface JsonEditResult {
  after: string
  existing: JsonObjectValue | undefined
  entry: JsonObjectValue
}

/** Sets `<rootKey>.search-hole` in a JSON/JSONC text, merging over an existing entry. */
function editJsonText(text: string, shape: JsonClientShape): JsonEditResult {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const body = text.slice(bom.length)
  const l = detectLayout(body)
  const root = parseJsonText(body, shape.jsonc)
  if (!shape.jsonc && body.trim() !== '') {
    try {
      JSON.parse(body)
    } catch {
      throw new Refusal('is not plain JSON (this app does not accept comments)')
    }
  }
  if (root === undefined) {
    const entry = mergeJsonEntry(undefined, shape)
    const fresh = serialize({ [shape.rootKey]: { [SERVER_NAME]: entry } }, '', { ...l, unit: '  ' })
    const lead = body.trim() === '' ? '' : `${body.replace(/\s*$/, '')}${l.eol}`
    return { after: `${bom}${lead}${fresh}${l.eol}`, existing: undefined, entry }
  }
  if (root.kind !== 'object') throw new Refusal('does not hold a JSON object')
  const rootProps = root.props.filter((p) => p.key === shape.rootKey)
  if (rootProps.length > 1) throw new Refusal(`has "${shape.rootKey}" twice`)
  const rootProp = rootProps[0]
  let edits: TextEdit[]
  let existing: JsonObjectValue | undefined
  let entry: JsonObjectValue
  if (rootProp === undefined) {
    entry = mergeJsonEntry(undefined, shape)
    edits = insertPropEdits(body, root, shape.rootKey, { [SERVER_NAME]: entry }, l)
  } else {
    const servers = rootProp.value
    if (servers.kind !== 'object') throw new Refusal(`has "${shape.rootKey}" that is not an object`)
    const mine = servers.props.filter((p) => p.key === SERVER_NAME)
    if (mine.length > 1) throw new Refusal(`has "${SERVER_NAME}" twice`)
    const prop = mine[0]
    if (prop === undefined) {
      entry = mergeJsonEntry(undefined, shape)
      edits = insertPropEdits(body, servers, SERVER_NAME, entry, l)
    } else {
      const current = toJson(prop.value)
      if (!isPlainObject(current)) throw new Refusal(`has a "${SERVER_NAME}" entry that is not an object`)
      existing = current
      entry = mergeJsonEntry(current, shape)
      if (jsonEqual(current, entry)) return { after: text, existing, entry }
      const indent = startsOwnLine(body, prop.keyStart)
        ? indentAt(body, prop.keyStart)
        : indentAt(body, servers.start)
      edits = [
        {
          at: prop.value.start,
          remove: prop.value.end - prop.value.start,
          insert: serialize(entry, indent, l),
        },
      ]
    }
  }
  let after = applyEdits(body, edits)
  const bare = body.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  if (!body.trimEnd().includes('\n') && !/\/[/*]/.test(bare) && numbersPrintBack(bare)) {
    // A one-line file (minified, or written by a tool) has no layout or comments to keep:
    // print it readably instead of splicing a pretty entry into a single line. Only when
    // every number survives the trip: 12345678901234567890 or 1.0 in someone else's key
    // would come back changed, so such a file keeps its bytes and gets the entry spliced in.
    const value = toJson(root)
    const top: JsonObjectValue = isPlainObject(value) ? value : {}
    const servers = top[shape.rootKey]
    const merged = {
      ...top,
      [shape.rootKey]: { ...(isPlainObject(servers) ? servers : {}), [SERVER_NAME]: entry },
    }
    after = `${JSON.stringify(merged, null, 2).split('\n').join(l.eol)}${l.eol}`
  }
  verifyJson(after, shape, entry)
  return { after: `${bom}${after}`, existing, entry }
}

/** True when every number in a JSON text (strings blanked) prints back exactly as it is written. */
function numbersPrintBack(bare: string): boolean {
  return (bare.match(/-?\d[\d.eE+-]*/g) ?? []).every((n) => String(Number(n)) === n)
}

/** Re-reads the edited text the way the client will and checks the entry landed as intended. */
function verifyJson(after: string, shape: JsonClientShape, entry: JsonObjectValue): void {
  let parsed: Json | undefined
  try {
    const root = parseJsonText(after, shape.jsonc)
    parsed = root === undefined ? undefined : toJson(root)
    if (!shape.jsonc) JSON.parse(after)
  } catch {
    parsed = undefined
  }
  const servers = isPlainObject(parsed) ? parsed[shape.rootKey] : undefined
  if (!isPlainObject(servers) || !jsonEqual(servers[SERVER_NAME], entry)) {
    throw new SearchHoleError(
      'internal',
      'setup produced a config it could not read back; nothing was written.',
    )
  }
}

// ── TOML (Codex): a scanner that finds statement boundaries ─────────────

interface TomlStatement {
  kind: 'blank' | 'comment' | 'table' | 'array-table' | 'keyval'
  /** Start of the statement's first line. */
  start: number
  /** End of the header or key/value (before trailing spaces and a comment). */
  bodyEnd: number
  /** End of the last line, before its line break. */
  lineEnd: number
  /** After the line break (or the end of the text). */
  end: number
  /** Table path, or key path for a key/value. */
  path: string[]
}

const TOML_BARE_KEY = /[A-Za-z0-9_-]+/y
const TOML_SCALAR = /[A-Za-z0-9_+\-.:]+/y
const TOML_SCALAR_OK =
  /^(?:true|false|[+-]?(?:inf|nan)|[+-]?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?|0x[\dA-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\u001b',
  '"': '"',
  '\\': '\\',
}

/**
 * Splits a TOML document into statements, following strings (all four kinds), arrays and inline
 * tables across lines. It checks structure, not every TOML rule: enough to know where tables and
 * keys begin and end, and to refuse a file whose structure is broken.
 */
function scanToml(text: string): TomlStatement[] {
  let pos = 0
  const problem = (what: string): Refusal =>
    new Refusal(`does not parse as TOML (line ${lineOf(text, pos)}: ${what})`)
  const peek = (o = 0): string | undefined => text[pos + o]
  const at = (s: string): boolean => text.startsWith(s, pos)
  const atEol = (): boolean => pos >= text.length || peek() === '\n' || (peek() === '\r' && peek(1) === '\n')
  const skipWs = (): void => {
    while (peek() === ' ' || peek() === '\t') pos++
  }
  const skipComment = (): void => {
    if (peek() !== '#') return
    while (!atEol()) pos++
  }
  const lineBreak = (): void => {
    if (peek() === '\r') pos += 2
    else if (peek() === '\n') pos += 1
  }
  /** Spaces, comments and line breaks, inside an array or inline table. */
  const skipBlanks = (): void => {
    for (;;) {
      skipWs()
      if (peek() === '#') skipComment()
      else if (pos < text.length && atEol()) lineBreak()
      else return
    }
  }
  const basic = (): string => {
    const open = pos
    pos++
    for (;;) {
      const c = peek()
      if (c === undefined || c === '\n' || c === '\r') throw problem('a "string" is not closed on its line')
      if (c === '\\') pos += 2
      else if (c === '"') break
      else pos++
    }
    pos++
    return text
      .slice(open + 1, pos - 1)
      .replace(/\\(?:u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})|x([\dA-Fa-f]{2})|([\s\S]))/g, (_m, u4, u8, x2, ch) => {
        const hex = (u4 ?? u8 ?? x2) as string | undefined
        if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
        const out = TOML_ESCAPES[ch as string]
        if (out === undefined) throw problem('a string has an unknown escape')
        return out
      })
  }
  const literal = (): string => {
    const open = pos
    pos++
    for (;;) {
      const c = peek()
      if (c === undefined || c === '\n' || c === '\r') throw problem("a 'string' is not closed on its line")
      if (c === "'") break
      pos++
    }
    pos++
    return text.slice(open + 1, pos - 1)
  }
  const multiline = (quote: '"""' | "'''"): void => {
    pos += 3
    for (;;) {
      if (pos >= text.length) throw problem(`a ${quote} string is never closed`)
      if (at(quote)) {
        pos += 3
        // Up to two more quotes right before the delimiter belong to the string.
        for (let extra = 0; extra < 2 && peek() === quote[0]; extra++) pos++
        return
      }
      pos += quote === '"""' && peek() === '\\' ? 2 : 1
    }
  }
  const simpleKey = (): string => {
    const c = peek()
    if (c === '"') return basic()
    if (c === "'") return literal()
    TOML_BARE_KEY.lastIndex = pos
    const m = TOML_BARE_KEY.exec(text)
    if (m === null) throw problem('expected a key')
    pos += m[0].length
    return m[0]
  }
  const key = (): string[] => {
    const parts = [simpleKey()]
    for (;;) {
      const save = pos
      skipWs()
      if (peek() !== '.') {
        pos = save
        return parts
      }
      pos++
      skipWs()
      parts.push(simpleKey())
    }
  }
  const scalar = (): void => {
    TOML_SCALAR.lastIndex = pos
    const m = TOML_SCALAR.exec(text)
    if (m === null) throw problem('expected a value')
    let token = m[0]
    pos += token.length
    // A local date and time may be separated by one space.
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && peek() === ' ' && /\d/.test(peek(1) ?? '')) {
      TOML_SCALAR.lastIndex = pos + 1
      const t = TOML_SCALAR.exec(text)
      if (t !== null) {
        token += ` ${t[0]}`
        pos += 1 + t[0].length
      }
    }
    if (!TOML_SCALAR_OK.test(token)) throw problem('a value is not valid TOML')
  }
  const value = (depth: number): void => {
    if (depth > 100) throw problem('values are nested too deeply')
    if (at('"""') || at("'''")) {
      multiline(at('"""') ? '"""' : "'''")
      return
    }
    const c = peek()
    if (c === '"') {
      basic()
      return
    }
    if (c === "'") {
      literal()
      return
    }
    if (c === '[' || c === '{') {
      const close = c === '[' ? ']' : '}'
      pos++
      for (;;) {
        skipBlanks()
        if (peek() === close) {
          pos++
          return
        }
        if (close === '}') {
          key()
          skipWs()
          if (peek() !== '=') throw problem("expected '=' in an inline table")
          pos++
          skipWs()
        }
        value(depth + 1)
        skipBlanks()
        if (peek() === ',') {
          pos++
          continue
        }
        if (peek() === close) {
          pos++
          return
        }
        throw problem(`expected ',' or '${close}'`)
      }
    }
    scalar()
  }

  const out: TomlStatement[] = []
  while (pos < text.length) {
    const start = pos
    skipWs()
    if (atEol() || peek() === '#') {
      const kind = peek() === '#' ? 'comment' : 'blank'
      skipComment()
      const lineEnd = pos
      lineBreak()
      out.push({ kind, start, bodyEnd: start, lineEnd, end: pos, path: [] })
      continue
    }
    let kind: TomlStatement['kind']
    let path: string[]
    if (peek() === '[') {
      const arrayTable = peek(1) === '['
      pos += arrayTable ? 2 : 1
      skipWs()
      path = key()
      skipWs()
      if (!at(arrayTable ? ']]' : ']')) throw problem('a [table] header is not closed')
      pos += arrayTable ? 2 : 1
      kind = arrayTable ? 'array-table' : 'table'
    } else {
      path = key()
      skipWs()
      if (peek() !== '=') throw problem("expected '=' after a key")
      pos++
      skipWs()
      if (atEol()) throw problem('a key has no value')
      value(0)
      kind = 'keyval'
    }
    const bodyEnd = pos
    skipWs()
    skipComment()
    if (!atEol()) throw problem('unexpected text after a value')
    const lineEnd = pos
    lineBreak()
    out.push({ kind, start, bodyEnd, lineEnd, end: pos, path })
  }
  return out
}

const pathEquals = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])
const pathStartsWith = (a: readonly string[], prefix: readonly string[]): boolean =>
  a.length >= prefix.length && prefix.every((x, i) => x === a[i])

const CODEX_TABLE = ['mcp_servers', SERVER_NAME]

/**
 * Finds `[mcp_servers.search-hole]` (header index, and the index of the next header). Refuses
 * every other way of defining it (dotted keys, inline tables, arrays of tables), since editing
 * those safely needs a real TOML library.
 */
function locateCodexTable(stmts: readonly TomlStatement[]): { header: number; next: number } | undefined {
  let table: string[] = []
  let header: number | undefined
  let next: number | undefined
  for (const [i, s] of stmts.entries()) {
    if (s.kind === 'table' || s.kind === 'array-table') {
      if (header !== undefined && next === undefined) next = i
      table = s.path
      if (
        s.kind === 'array-table' &&
        (pathStartsWith(s.path, CODEX_TABLE) || pathEquals(s.path, ['mcp_servers']))
      ) {
        throw new Refusal('defines mcp_servers as an array of tables')
      }
      if (s.kind === 'table' && pathEquals(s.path, CODEX_TABLE)) {
        if (header !== undefined) throw new Refusal('has [mcp_servers.search-hole] twice')
        header = i
        next = undefined
      }
    } else if (s.kind === 'keyval') {
      const full = [...table, ...s.path]
      if (pathEquals(full, ['mcp_servers'])) throw new Refusal('sets mcp_servers as an inline table')
      if (pathStartsWith(full, CODEX_TABLE) && !pathStartsWith(table, CODEX_TABLE)) {
        throw new Refusal('defines search-hole with dotted keys or an inline table')
      }
    }
  }
  if (header === undefined) return undefined
  return { header, next: next ?? stmts.length }
}

/** A TOML basic string. */
export function tomlString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

const tomlArray = (items: readonly string[]): string => `[${items.map(tomlString).join(', ')}]`

/** The `key = value` lines search-hole owns in its Codex table. */
function codexLines(l: Launch, passEnv: readonly string[]): Array<[key: string, line: string]> {
  const lines: Array<[string, string]> = [
    ['command', `command = ${tomlString(l.command)}`],
    ['args', `args = ${tomlArray(l.args)}`],
  ]
  if (passEnv.length > 0) lines.push(['env_vars', `env_vars = ${tomlArray(passEnv)}`])
  return lines
}

/** The table as one would paste it by hand. */
export function codexSnippet(l: Launch, passEnv: readonly string[] = []): string {
  return `[mcp_servers.${SERVER_NAME}]\n${codexLines(l, passEnv)
    .map(([, line]) => line)
    .join('\n')}\n`
}

const CODEX_COMMENT = '# search-hole, added by `searchhole setup codex`. Delete this table to remove it.'

/** The `env_vars` line with `add` joined to the names an existing statement already lists. */
function mergedEnvVars(existing: string, add: readonly string[]): string {
  const value = existing.slice(existing.indexOf('=') + 1)
  if (value.includes('#')) throw new Refusal('has a comment inside env_vars in [mcp_servers.search-hole]')
  const names = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) =>
    m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : (m[2] ?? ''),
  )
  return `env_vars = ${tomlArray([...new Set([...names, ...add])])}`
}

/** Sets search-hole's keys in its Codex table, or appends the table. Other keys and tables stay. */
function editCodexToml(text: string, l: Launch, passEnv: readonly string[]): EditOutcome {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const stmts = scanToml(text)
  const loc = locateCodexTable(stmts)
  const wanted = codexLines(l, passEnv)
  if (loc === undefined) {
    let prefix = text
    if (prefix !== '' && !prefix.endsWith('\n')) prefix += eol
    if (prefix.trim() !== '' && !/\r?\n[ \t]*\r?\n$/.test(prefix)) prefix += eol
    const block = [CODEX_COMMENT, `[mcp_servers.${SERVER_NAME}]`, ...wanted.map(([, line]) => line)]
    const after = `${prefix}${block.join(eol)}${eol}`
    verifyCodex(after, wanted)
    return { after, existed: false, disabled: false }
  }
  const body = stmts.slice(loc.header + 1, loc.next)
  const disabled = body.some(
    (s) =>
      s.kind === 'keyval' &&
      pathEquals(s.path, ['enabled']) &&
      /=\s*false$/.test(text.slice(s.start, s.bodyEnd)),
  )
  const edits: TextEdit[] = []
  const missing: string[] = []
  /** What the table must say afterwards (our lines, with the user's own `env_vars` kept). */
  const result: Array<[string, string]> = []
  let anchor = stmts[loc.header] as TomlStatement
  for (const [key, ownLine] of wanted) {
    const found = body.filter((s) => s.kind === 'keyval' && pathEquals(s.path, [key]))
    if (found.length > 1) throw new Refusal(`sets ${key} twice in [mcp_servers.search-hole]`)
    const s = found[0]
    if (s === undefined) {
      missing.push(ownLine)
      result.push([key, ownLine])
      continue
    }
    // Variables the user already passes through stay: ours are added to them, like in the other apps.
    const line = key === 'env_vars' ? mergedEnvVars(text.slice(s.start, s.bodyEnd), passEnv) : ownLine
    result.push([key, line])
    if (s.start > anchor.start) anchor = s
    const indent = /^[ \t]*/.exec(text.slice(s.start))?.[0] ?? ''
    const from = s.start + indent.length
    if (text.slice(from, s.bodyEnd) !== line) edits.push({ at: from, remove: s.bodyEnd - from, insert: line })
  }
  if (missing.length > 0) {
    const lead = anchor.end === anchor.lineEnd ? eol : ''
    edits.push({ at: anchor.end, remove: 0, insert: `${lead}${missing.map((m) => `${m}${eol}`).join('')}` })
  }
  const after = applyEdits(text, edits)
  if (after !== text) verifyCodex(after, result)
  return { after, existed: true, disabled }
}

function verifyCodex(after: string, wanted: ReadonlyArray<[string, string]>): void {
  let ok = false
  try {
    const stmts = scanToml(after)
    const loc = locateCodexTable(stmts)
    if (loc !== undefined) {
      const body = stmts.slice(loc.header + 1, loc.next)
      ok = wanted.every(([key, line]) =>
        body.some(
          (s) =>
            s.kind === 'keyval' &&
            pathEquals(s.path, [key]) &&
            after.slice(s.start, s.bodyEnd).trim() === line,
        ),
      )
    }
  } catch {
    ok = false
  }
  if (!ok)
    throw new SearchHoleError(
      'internal',
      'setup produced a Codex config it could not read back; nothing was written.',
    )
}

// ── YAML (Goose) ─────────────────────────────────────────────────────────

const GOOSE_TIMEOUT = 300

function gooseEntry(l: Launch): Record<string, unknown> {
  return {
    enabled: true,
    type: 'stdio',
    name: SERVER_NAME,
    description: 'search-hole: web search through your own engines and source rules, with receipts',
    cmd: l.command,
    args: l.args,
    envs: {},
    timeout: GOOSE_TIMEOUT,
  }
}

/** Fields search-hole sets every time; the others are only added when missing. */
const GOOSE_MANAGED = ['enabled', 'type', 'cmd', 'args'] as const

export function gooseSnippet(l: Launch, passEnv: readonly string[] = []): string {
  const entry = gooseEntry(l)
  const doc = parseDocument('extensions: {}\n')
  doc.setIn(
    ['extensions', SERVER_NAME],
    doc.createNode(passEnv.length > 0 ? { ...entry, env_keys: passEnv } : entry),
  )
  return doc.toString({ lineWidth: 0, indentSeq: false })
}

/** The file's own indentation, so an edit does not reflow the rest of it. */
function yamlStyle(text: string): { indent: number; indentSeq: boolean } {
  const lines = text.split(/\r?\n/)
  const m = lines.map((line) => /^( +)[^\s#-]/.exec(line)?.[1]).find((x) => x !== undefined)
  const indent = m === undefined ? 2 : Math.min(Math.max(m.length, 1), 8)
  let indentSeq = false
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = /^( *)[^\s#-][^:]*:\s*(#.*)?$/.exec(lines[i] ?? '')
    const item = /^( *)- /.exec(lines[i + 1] ?? '')
    if (head !== null && item !== null) {
      indentSeq = (item[1]?.length ?? 0) > (head[1]?.length ?? 0)
      break
    }
  }
  return { indent, indentSeq }
}

function editGooseYaml(text: string, l: Launch, passEnv: readonly string[]): EditOutcome {
  const doc: Document = parseDocument(text, { prettyErrors: false })
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message.split('\n')[0] ?? 'a syntax error'
    throw new Refusal(`does not parse as YAML (${first})`)
  }
  if (
    doc.contents !== null &&
    !isMap(doc.contents) &&
    !(isScalar(doc.contents) && doc.contents.value === null)
  ) {
    throw new Refusal('does not hold a YAML mapping')
  }
  const desired = gooseEntry(l)
  const withKeys = passEnv.length > 0 ? { ...desired, env_keys: [...passEnv] } : desired
  let changed = false
  let existed = false
  const exts = doc.get('extensions', true)
  if (!isMap(doc.contents)) {
    // An empty file (or only comments): comments stay in the document.
    doc.contents = doc.createNode({ extensions: { [SERVER_NAME]: withKeys } })
    changed = true
  } else if (exts === undefined || exts === null || (isScalar(exts) && exts.value === null)) {
    doc.set('extensions', doc.createNode({ [SERVER_NAME]: withKeys }))
    changed = true
  } else if (!isMap(exts)) {
    throw new Refusal('has extensions: that is not a mapping')
  } else {
    const entry = exts.get(SERVER_NAME, true)
    if (entry === undefined || entry === null) {
      exts.set(SERVER_NAME, doc.createNode(withKeys))
      changed = true
    } else if (!isMap(entry)) {
      throw new Refusal('has a search-hole extension that is not a mapping')
    } else {
      existed = true
      const current = entry.toJSON() as Record<string, unknown>
      for (const [k, v] of Object.entries(desired)) {
        const managed = (GOOSE_MANAGED as readonly string[]).includes(k)
        if ((managed && !jsonEqual(current[k], v)) || (!managed && !(k in current))) {
          entry.set(k, doc.createNode(v))
          changed = true
        }
      }
      if (passEnv.length > 0) {
        const prev = entry.get('env_keys', true)
        const have = isSeq(prev)
          ? (prev.toJSON() as unknown[]).filter((x): x is string => typeof x === 'string')
          : []
        const union = [...have, ...passEnv.filter((n) => !have.includes(n))]
        if (!jsonEqual(have, union) || !isSeq(prev)) {
          entry.set('env_keys', doc.createNode(union))
          changed = true
        }
      }
    }
  }
  if (!changed) return { after: text, existed, disabled: false }
  const after = doc.toString({ lineWidth: 0, ...yamlStyle(text) })
  const check = parseDocument(after)
  const got = check.errors.length === 0 ? (check.getIn(['extensions', SERVER_NAME]) as unknown) : undefined
  const gotJson =
    got !== null && typeof got === 'object' && 'toJSON' in got ? (got as { toJSON(): unknown }).toJSON() : got
  if (!isPlainObject(gotJson) || !GOOSE_MANAGED.every((k) => jsonEqual(gotJson[k], desired[k]))) {
    throw new SearchHoleError(
      'internal',
      'setup produced a Goose config it could not read back; nothing was written.',
    )
  }
  return { after, existed, disabled: false }
}

// ── Files ────────────────────────────────────────────────────────────────

interface ExistingFile {
  text?: string
  /** Where to write: the file itself, or a symlink's target. */
  real: string
  mode?: number
}

function readExisting(file: string): ExistingFile {
  let isLink = false
  try {
    isLink = lstatSync(file).isSymbolicLink()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { real: file }
    throw e
  }
  let real = file
  if (isLink) {
    try {
      real = realpathSync(file)
    } catch {
      throw new SearchHoleError('config_invalid', `${file} is a link to a file that does not exist.`, {
        fix: 'Fix or remove the link, then run setup again.',
      })
    }
  }
  const st = statSync(real)
  if (!st.isFile()) {
    throw new SearchHoleError('config_invalid', `${file} is not a file.`, {
      fix: 'Move it aside, then run setup again.',
    })
  }
  return { text: readFileSync(real, 'utf8'), real, mode: st.mode & 0o777 }
}

/** `<file>.bak-20261031T185703Z`, with `-2`, `-3`… if that name is taken. */
export function backupName(file: string, nowMs: number): string {
  const stamp = new Date(nowMs)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
  let name = `${file}.bak-${stamp}`
  for (let n = 2; existsSync(name); n++) name = `${file}.bak-${stamp}-${n}`
  return name
}

function writeConfig(
  file: string,
  existing: ExistingFile,
  after: string,
  opts: { platform: NodeJS.Platform; scope: SetupScope; now: () => number },
): { backup?: string; createdDir?: string } {
  const p = pathFor(opts.platform)
  const dir = p.dirname(existing.real)
  let createdDir: string | undefined
  if (!existsSync(dir)) {
    createdDir = dir
    if (opts.scope === 'user') ensureDir(dir)
    else mkdirSync(dir, { recursive: true })
  }
  let backup: string | undefined
  if (existing.text !== undefined) {
    if (readFileSync(existing.real, 'utf8') !== existing.text) {
      throw new SearchHoleError('config_invalid', `${file} changed while setup was running.`, {
        fix: 'Run setup again.',
      })
    }
    backup = backupName(file, opts.now())
    copyFileSync(existing.real, backup, fsConstants.COPYFILE_EXCL)
    if (opts.platform !== 'win32' && existing.mode !== undefined) chmodSync(backup, existing.mode)
  }
  const mode = existing.mode ?? (opts.scope === 'user' ? 0o600 : 0o644)
  atomicWriteFile(existing.real, after, { mode })
  if (opts.platform !== 'win32') chmodSync(existing.real, mode)
  const out: { backup?: string; createdDir?: string } = {}
  if (backup !== undefined) out.backup = backup
  if (createdDir !== undefined) out.createdDir = createdDir
  return out
}

// ── setup ────────────────────────────────────────────────────────────────

const NEXT_STEPS: Readonly<Record<SetupClient, readonly string[]>> = {
  vscode: [
    'Reload VS Code (Command Palette → "Developer: Reload Window"). VS Code asks you to trust search-hole the first time it starts it.',
    'In Copilot Chat, pick Agent mode and check that search-hole is ticked in the tools list.',
  ],
  cursor: [
    'In Cursor, open Customize (or Cursor Settings → MCP), check that search-hole is on, and start a new chat.',
  ],
  windsurf: ['In Windsurf, open the MCP servers list in Cascade and press Refresh (or restart the app).'],
  zed: [
    'Zed reloads its settings by itself. In the Agent panel settings, search-hole should show a green dot.',
  ],
  goose: [
    'Start a new goose session (in goose Desktop, restart the app); search-hole is listed under Extensions.',
  ],
  codex: ['Start a new Codex session; `codex mcp list` should show search-hole.'],
  'claude-desktop': ['Quit Claude Desktop completely and open it again.'],
  generic: [
    "Paste this into your app's MCP server settings (most apps use this mcpServers shape), then restart it.",
  ],
}

function removalHint(client: SetupClient, file: string): string {
  if (client === 'codex')
    return `To remove it later, delete the [mcp_servers.search-hole] table from ${file}.`
  if (client === 'goose')
    return `To remove it later, delete extensions → search-hole from ${file} (or remove it in goose).`
  return `To remove it later, delete the "search-hole" entry from ${file}.`
}

/**
 * Adds or updates search-hole in a client's config (see the module comment for the rules).
 * Throws `invalid_argument` for bad options, and `config_invalid` (with the entry to add by hand
 * in `fix`) for a file it will not edit.
 */
export function setupClient(opts: SetupOptions): SetupResult {
  const info = setupClientInfo(opts.client)
  const scope = opts.scope ?? 'user'
  const p = pathFor(opts.platform)
  if (opts.client !== 'generic' && !info.scopes.includes(scope)) {
    throw invalid(
      `${info.name} has no ${scope} config file that setup can write.`,
      info.scopes.length === 1 ? `Run it without --${scope}.` : `Use one of: ${info.scopes.join(', ')}.`,
    )
  }
  if (!p.isAbsolute(opts.bundlePath)) {
    throw invalid('The bundle path for setup must be absolute.', 'Pass the full path to dist/searchhole.mjs.')
  }
  const passEnv = checkEnvNames(opts.passEnv ?? [])
  const l = launchFor(opts, info.host)
  const warnings: string[] = []
  if (isEphemeralBundle(opts.bundlePath)) {
    warnings.push(
      "This copy of search-hole runs from npx's temporary cache, which npm can delete at any time. Install it for good (npm install -g search-hole) and run setup again.",
    )
  } else if (!existsSync(opts.bundlePath)) {
    warnings.push(
      `${opts.bundlePath} does not exist on this computer, so ${info.name} will not be able to start it.`,
    )
  }
  if (passEnv.length > 0 && info.envPassing === 'none') {
    warnings.push(
      `${info.name} has no way to pass a named variable through, so ${passEnv.join(', ')} ${passEnv.length === 1 ? 'was' : 'were'} not written. Store keys with \`searchhole keys set <engine>\` instead.`,
    )
  }
  const tail = [
    'Then ask something that needs the web: the search shows in `searchhole log` and in the dashboard (`searchhole ui --open`).',
    'Outside Claude Code search-hole needs an engine: `searchhole keys set tavily` (a free key, kept in your OS keychain) or `searchhole searxng up` (Docker). `searchhole doctor` checks it.',
  ]

  if (opts.client === 'generic') {
    const after = genericSnippet(l)
    return {
      client: opts.client,
      host: info.host,
      scope,
      format: info.format,
      file: null,
      after,
      changed: false,
      written: false,
      instructions: [
        ...NEXT_STEPS.generic,
        ...(passEnv.length > 0
          ? [`If your app can pass environment variables to a server, pass ${passEnv.join(', ')}.`]
          : []),
        ...tail,
      ],
      warnings,
    }
  }

  const file = resolveSetupFile(opts.client, scope, opts)
  if (file === null) throw new SearchHoleError('internal', `No ${scope} config file for ${opts.client}.`)
  if (opts.client === 'windsurf' && file.includes(`${p.sep}.codeium${p.sep}`)) {
    warnings.push(
      `Wrote the Windsurf file from before the rename (~/.codeium/windsurf), since Devin Desktop's ${p.join(devinDir(opts), 'mcp_config.json')} does not exist. On Devin Desktop (Windsurf 3.0 or newer), open Cascade's MCP settings once, then run setup again.`,
    )
  }
  const existing = readExisting(file)
  const before = existing.text
  let outcome: EditOutcome
  try {
    if (info.format === 'toml') outcome = editCodexToml(before ?? '', l, passEnv)
    else if (info.format === 'yaml') outcome = editGooseYaml(before ?? '', l, passEnv)
    else {
      const res = editJsonText(before ?? '', jsonShape(opts.client, l, passEnv))
      const entry = res.existing
      outcome = {
        after: res.after,
        existed: entry !== undefined,
        disabled: entry !== undefined && (entry.disabled === true || entry.enabled === false),
      }
    }
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    const snippet =
      info.format === 'toml'
        ? codexSnippet(l, passEnv)
        : info.format === 'yaml'
          ? gooseSnippet(l, passEnv)
          : jsonSnippet(opts.client, l, passEnv)
    throw refused(file, e.message, snippet)
  }
  const { after } = outcome
  if (outcome.disabled) {
    warnings.push(
      `search-hole is switched off in this file (a "disabled" or "enabled" setting that setup keeps). Turn it on in ${info.name}, or delete that line.`,
    )
  }

  const changed = before !== after
  let written = false
  let backup: string | undefined
  if (changed && !opts.dryRun) {
    const res = writeConfig(file, existing, after, {
      platform: opts.platform,
      scope,
      now: opts.now ?? Date.now,
    })
    written = true
    backup = res.backup
    if (res.createdDir !== undefined && scope === 'user') {
      warnings.push(
        `${res.createdDir} did not exist, so ${info.name} may not be installed or may never have run here. It will read the file when it starts.`,
      )
    }
  }

  const verb = outcome.existed ? 'update' : 'add'
  const headline = !changed
    ? `search-hole is already set up in ${file}; nothing changed.`
    : opts.dryRun
      ? `Dry run: setup would ${verb} search-hole ${verb === 'add' ? 'to' : 'in'} ${file} (nothing was written).`
      : verb === 'add'
        ? `Added search-hole to ${info.name}: ${file}`
        : `Updated search-hole in ${info.name}: ${file}`
  const instructions = [headline]
  if (backup !== undefined) instructions.push(`The previous file is saved as ${backup}`)
  if (!opts.dryRun) instructions.push(...NEXT_STEPS[opts.client])
  if (scope === 'project') {
    if (opts.client === 'codex')
      instructions.push('Codex reads .codex/config.toml only in projects you have trusted.')
    instructions.push(
      'This file now holds a path on this computer: keep it out of version control (add it to .gitignore).',
    )
  }
  instructions.push(...tail, removalHint(opts.client, file))

  const result: SetupResult = {
    client: opts.client,
    host: info.host,
    scope,
    format: info.format,
    file,
    after,
    changed,
    written,
    instructions,
    warnings,
  }
  if (before !== undefined) result.before = before
  if (backup !== undefined) result.backup = backup
  return result
}

/** The JSON entry as one would paste it by hand into that client's file. */
function jsonSnippet(client: SetupClient, l: Launch, passEnv: readonly string[]): string {
  const shape = jsonShape(client, l, passEnv)
  return `${JSON.stringify({ [shape.rootKey]: { [SERVER_NAME]: mergeJsonEntry(undefined, shape) } }, null, 2)}\n`
}

// ── Help ─────────────────────────────────────────────────────────────────

/** Help text for `searchhole help setup`. */
export function describeSetup(): string {
  const width = Math.max(...SETUP_CLIENTS.map((c) => c.id.length)) + 2
  const rows = SETUP_CLIENTS.map((c) => {
    const where =
      c.id === 'generic' ? c.userFile : `${c.userFile}${c.projectFile ? `; --project: ${c.projectFile}` : ''}`
    return `  ${c.id.padEnd(width)}${c.name}\n  ${' '.repeat(width)}${where}`
  })
  return `Usage: searchhole setup <client> [--project] [--env NAME]... [--dry-run] [--yes] [--json]

Adds search-hole to another AI app's MCP settings, so the app starts it. Other servers, settings
and comments in the file are kept, the old file is saved next to it as <file>.bak-<time>, and a
file that does not parse is left alone (setup prints what to add by hand).

Clients:
${rows.join('\n')}

Options:
  --project      Write this project's file (in the current folder) instead of your user file
  --env NAME     Let the app pass this environment variable to search-hole: a name such as
                 TAVILY_API_KEY, never a key. Repeat for more. Keys stored with
                 \`searchhole keys set\` need nothing here
  --dry-run      Show what would change and write nothing
  --yes, -y      Do not ask before writing (needed when there is no terminal)
  --json         Print the result as JSON

Claude Code uses the search-hole plugin instead, and Claude Desktop has an extension (.mcpb).
Guides for every app: docs/clients/README.md`
}
