// SPDX-License-Identifier: Apache-2.0
/**
 * Command-line parsing with `node:util` `parseArgs`. `parseCommand` turns argv into one
 * typed `Command` or throws `invalid_argument` with a fix. Error messages never repeat
 * what the user typed (a mistyped key must not be echoed back).
 */
import { parseArgs } from 'node:util'
import type { HostProfile, ListFormat, ListKind, ListMode, SearchMode } from '../app/types.ts'
import { parseDuration, ttlToUntil, untilToMs } from '../core/rules/time.ts'
import { SearchHoleError } from '../shared/errors.ts'
import {
  AVAILABLE_ENGINES,
  type Depth,
  ENGINE_ID_LIST,
  type EngineId,
  type RuleAction,
} from '../shared/types.ts'
import { isSetupClient, SETUP_CLIENT_IDS, type SetupClient } from './setup-clients.ts'

export type ScopeFlag = 'global' | 'project' | 'session'
export type SearxngSub = 'up' | 'down' | 'status' | 'apply'

/** One parsed invocation. */
export type Command =
  | { name: 'help'; topic?: string }
  | { name: 'version'; json: boolean }
  | {
      name: 'search'
      query: string
      depth?: Depth
      profile?: string
      engines: EngineId[]
      maxAgeDays?: number
      limit?: number
      explain: boolean
      json: boolean
    }
  | {
      name: 'rule'
      action: RuleAction
      match: string
      weight?: number
      profile?: string
      scope: ScopeFlag
      note?: string
      until?: string
      important: boolean
      yes: boolean
      json: boolean
    }
  | { name: 'unrule'; target: string; scope?: ScopeFlag; yes: boolean; json: boolean }
  | { name: 'rules'; scope?: ScopeFlag; json: boolean }
  | { name: 'lists'; json: boolean }
  | { name: 'lists-catalog'; json: boolean }
  | {
      name: 'lists-add'
      source: string
      listName?: string
      format?: ListFormat
      kind?: ListKind
      mode?: ListMode
      update?: string
      sha256?: string
      fetch: boolean
      yes: boolean
      json: boolean
    }
  | { name: 'lists-remove'; id: string; yes: boolean; json: boolean }
  | { name: 'lists-mode'; id: string; mode: ListMode; yes: boolean; json: boolean }
  | { name: 'lists-update'; ids: string[]; force: boolean; yes: boolean; json: boolean }
  | {
      name: 'lists-import'
      file: string
      listName: string
      kind: ListKind
      format?: ListFormat
      mode?: ListMode
      yes: boolean
      json: boolean
    }
  | { name: 'explain'; url: string; profile?: string; json: boolean }
  | { name: 'log'; limit?: number; hidden: boolean; json: boolean }
  | { name: 'log-show'; searchId: number; json: boolean }
  | { name: 'suggestions'; json: boolean }
  | { name: 'approve'; id: number; yes: boolean; json: boolean }
  | { name: 'reject'; id: number; yes: boolean; json: boolean }
  | { name: 'trust'; dir?: string; yes: boolean; json: boolean }
  | { name: 'mode'; mode?: SearchMode; yes: boolean; json: boolean }
  | { name: 'keys-set'; engine: EngineId }
  | { name: 'keys-status'; json: boolean }
  | { name: 'keys-remove'; engine: EngineId; yes: boolean }
  | { name: 'doctor'; probe: boolean; strict: boolean; json: boolean }
  | { name: 'searxng'; sub: SearxngSub; yes: boolean; json: boolean }
  | { name: 'mcp'; host: HostProfile }
  | { name: 'ui'; port?: number; open: boolean; detach: boolean; stay: boolean }
  | { name: 'uninstall'; purge: boolean; yes: boolean; json: boolean }
  | {
      name: 'setup'
      client: SetupClient
      project: boolean
      env: string[]
      dryRun: boolean
      yes: boolean
      json: boolean
    }

/** Every command word, in help order. */
export const COMMAND_NAMES = [
  'search',
  'block',
  'allow',
  'pin',
  'raise',
  'lower',
  'normal',
  'unrule',
  'rules',
  'lists',
  'explain',
  'log',
  'suggestions',
  'approve',
  'reject',
  'trust',
  'mode',
  'keys',
  'doctor',
  'searxng',
  'setup',
  'ui',
  'uninstall',
  'mcp',
  'version',
  'help',
] as const

const RULE_ACTIONS = [
  'block',
  'allow',
  'pin',
  'raise',
  'lower',
  'normal',
] as const satisfies readonly RuleAction[]
const DEPTHS = ['quick', 'standard', 'deep'] as const satisfies readonly Depth[]
const LIST_KINDS = [
  'block',
  'allow',
  'official',
  'content-farm',
  'clone',
] as const satisfies readonly ListKind[]
const LIST_MODES = ['enforce', 'audit', 'disabled'] as const satisfies readonly ListMode[]
const LIST_FORMATS = [
  'auto',
  'ublacklist',
  'abp',
  'adguard',
  'hosts',
  'domains',
  'goggles',
  'searchhole',
] as const satisfies readonly ListFormat[]
/** `lists <verb> <id>` words that set a mode. */
const LIST_MODE_VERBS: Readonly<Record<string, ListMode>> = {
  enforce: 'enforce',
  audit: 'audit',
  disable: 'disabled',
}
const LIST_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MODES = ['auto', 'builtin', 'engines'] as const satisfies readonly SearchMode[]
const SEARXNG_SUBS = ['up', 'down', 'status', 'apply'] as const satisfies readonly SearxngSub[]
/** Host profiles `mcp --host` accepts (`cli` is the terminal, not an MCP host). */
export const MCP_HOSTS = [
  'claude-code',
  'claude-desktop',
  'cursor',
  'codex',
  'vscode',
  'goose',
  'zed',
  'generic',
] as const satisfies readonly HostProfile[]

function usageError(command: string | undefined, message: string): SearchHoleError {
  return new SearchHoleError('invalid_argument', message, {
    fix: command === undefined ? 'Run `searchhole help`.' : `Run \`searchhole help ${command}\`.`,
  })
}

/** A long option name short and plain enough to be a real flag, never a pasted secret. */
const PLAIN_LONG_OPTION = /^--[a-z][a-z-]{1,19}$/

/**
 * Rewords a parseArgs TypeError from its code and, when it looks like a real flag name,
 * the option name. The original message can quote what the user typed
 * (`Unexpected argument 'sk-...'`, `Unknown option '--=sk-...'`), and a mistyped key must
 * never be echoed back.
 */
function describeParseError(code: string, message: string): string {
  const quoted = /'([^']*)'/.exec(message.split('\n')[0] ?? '')?.[1] ?? ''
  const name = PLAIN_LONG_OPTION.test(quoted.split(' ')[0] ?? '') ? quoted.split(' ')[0] : undefined
  switch (code) {
    case 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL':
      return 'Too many arguments.'
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return name === undefined ? 'Unknown option.' : `Unknown option '${name}'.`
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      if (name === undefined) return 'An option has a missing or unexpected value.'
      if (message.includes('does not take an argument')) return `Option '${name}' does not take a value.`
      if (message.includes('ambiguous'))
        return `Option '${name}' got a value that starts with a dash; write ${name}=VALUE.`
      return `Option '${name}' needs a value.`
    default:
      return 'Invalid arguments.'
  }
}

/** Runs a parseArgs call, rewording its TypeError (which can quote the user's input). */
function guard<T>(command: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS_')) {
      throw usageError(command, describeParseError(String(e.code), e.message))
    }
    throw e
  }
}

function wholeNumber(command: string, flag: string, raw: string, min: number, max: number): number {
  if (!/^\d{1,9}$/.test(raw))
    throw usageError(command, `${flag} must be a whole number from ${min} to ${max}.`)
  const n = Number(raw)
  if (n < min || n > max) throw usageError(command, `${flag} must be a whole number from ${min} to ${max}.`)
  return n
}

function oneOf<T extends string>(command: string, label: string, raw: string, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === raw)
  if (hit === undefined) throw usageError(command, `${label} must be one of: ${allowed.join(', ')}.`)
  return hit
}

/**
 * Validates an engine id without echoing a wrong value (it may be a key typed by mistake).
 * Only engines this build can use are accepted; `any` also takes the reserved ids, so a key
 * stored for one by an older version can still be removed.
 */
function engineId(command: string, raw: string | undefined, any = false): EngineId {
  const allowed: readonly EngineId[] = any ? ENGINE_ID_LIST : AVAILABLE_ENGINES
  const hit = allowed.find((e) => e === raw)
  if (hit === undefined) {
    throw usageError(command, `Name an engine: ${AVAILABLE_ENGINES.join(', ')}.`)
  }
  return hit
}

function scopeFrom(
  command: string,
  flags: { global?: boolean | undefined; project?: boolean | undefined; session?: boolean | undefined },
): ScopeFlag | undefined {
  const chosen: ScopeFlag[] = []
  if (flags.global === true) chosen.push('global')
  if (flags.project === true) chosen.push('project')
  if (flags.session === true) chosen.push('session')
  if (chosen.length > 1) throw usageError(command, 'Use only one of --global, --project and --session.')
  return chosen[0]
}

function nonEmpty(command: string, label: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') throw usageError(command, `Missing ${label}.`)
  return raw
}

function noExtra(command: string, positionals: readonly string[], max: number): void {
  if (positionals.length > max) throw usageError(command, 'Too many arguments.')
}

/** `--until` takes an ISO date, an ISO date-time with an offset, or a duration such as `7d`. */
export function normalizeUntil(command: string, raw: string, now: number): string {
  const text = raw.trim()
  if (parseDuration(text) !== null) {
    const until = ttlToUntil(text, now)
    if (until !== null) return until
  }
  if (untilToMs(text) === null) {
    throw usageError(
      command,
      '--until must be a date (2026-12-31), a date-time with an offset (2026-12-31T09:00:00Z) or a duration (7d, 12h).',
    )
  }
  return text
}

const SIMILAR_MAX = 2

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0
      row[j] = Math.min(tmp + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length] ?? 0
}

/** The nearest command word, when one is close enough to suggest. */
export function suggestCommand(word: string): string | undefined {
  let best: { name: string; d: number } | undefined
  for (const name of COMMAND_NAMES) {
    const d = distance(word.toLowerCase(), name)
    if (d <= SIMILAR_MAX && (best === undefined || d < best.d)) best = { name, d }
  }
  return best?.name
}

const HELP_OPTION = { help: { type: 'boolean', short: 'h' } } as const

function parseSearch(args: readonly string[]): Command {
  const { values, positionals } = guard('search', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        depth: { type: 'string' },
        profile: { type: 'string' },
        engine: { type: 'string', multiple: true },
        'max-age-days': { type: 'string' },
        limit: { type: 'string' },
        explain: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'search' }
  const query = positionals.join(' ').trim()
  if (query === '') throw usageError('search', 'Missing the search query.')
  return {
    name: 'search',
    query,
    engines: (values.engine ?? []).map((e) => engineId('search', e)),
    explain: values.explain === true,
    json: values.json === true,
    ...(values.depth === undefined ? {} : { depth: oneOf('search', '--depth', values.depth, DEPTHS) }),
    ...(values.profile === undefined
      ? {}
      : { profile: nonEmpty('search', '--profile value', values.profile) }),
    ...(values['max-age-days'] === undefined
      ? {}
      : { maxAgeDays: wholeNumber('search', '--max-age-days', values['max-age-days'], 1, 36500) }),
    ...(values.limit === undefined ? {} : { limit: wholeNumber('search', '--limit', values.limit, 1, 100) }),
  }
}

function parseRuleVerb(action: RuleAction, args: readonly string[], now: number): Command {
  const { values, positionals } = guard(action, () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        weight: { type: 'string' },
        profile: { type: 'string' },
        global: { type: 'boolean' },
        project: { type: 'boolean' },
        session: { type: 'boolean' },
        note: { type: 'string' },
        until: { type: 'string' },
        important: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: action }
  const match = nonEmpty(action, 'match (a domain, host/path or pattern)', positionals[0])
  if (positionals.length > 1) {
    throw usageError(action, 'Give one match at a time (quote a pattern that contains spaces).')
  }
  if (values.weight !== undefined && action !== 'raise' && action !== 'lower') {
    throw usageError(action, '--weight applies only to raise and lower.')
  }
  return {
    name: 'rule',
    action,
    match,
    scope: scopeFrom(action, values) ?? 'global',
    important: values.important === true,
    yes: values.yes === true,
    json: values.json === true,
    ...(values.weight === undefined ? {} : { weight: wholeNumber(action, '--weight', values.weight, 1, 10) }),
    ...(values.profile === undefined ? {} : { profile: nonEmpty(action, '--profile value', values.profile) }),
    ...(values.note === undefined ? {} : { note: values.note }),
    ...(values.until === undefined ? {} : { until: normalizeUntil(action, values.until, now) }),
  }
}

function parseUnrule(args: readonly string[]): Command {
  const { values, positionals } = guard('unrule', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        global: { type: 'boolean' },
        project: { type: 'boolean' },
        session: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'unrule' }
  const target = nonEmpty('unrule', 'rule id or match', positionals[0])
  noExtra('unrule', positionals, 1)
  const scope = scopeFrom('unrule', values)
  return {
    name: 'unrule',
    target,
    yes: values.yes === true,
    json: values.json === true,
    ...(scope === undefined ? {} : { scope }),
  }
}

function parseRules(args: readonly string[]): Command {
  const { values, positionals } = guard('rules', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        global: { type: 'boolean' },
        project: { type: 'boolean' },
        session: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'rules' }
  noExtra('rules', positionals, 0)
  const scope = scopeFrom('rules', values)
  return { name: 'rules', json: values.json === true, ...(scope === undefined ? {} : { scope }) }
}

function listId(raw: string | undefined): string {
  const id = nonEmpty('lists', 'list id (see `searchhole lists`)', raw)
  if (!LIST_ID_RE.test(id))
    throw usageError('lists', 'A list id is lower-case letters, digits, ".", "_" or "-".')
  return id
}

function parseLists(args: readonly string[]): Command {
  const { values, positionals } = guard('lists', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        name: { type: 'string' },
        format: { type: 'string' },
        kind: { type: 'string' },
        mode: { type: 'string' },
        update: { type: 'string' },
        sha256: { type: 'string' },
        'no-fetch': { type: 'boolean' },
        force: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'lists' }
  const [sub, ...rest] = positionals
  const yes = values.yes === true
  const json = values.json === true
  const only = (allowed: readonly string[]): void => {
    const extra = (['name', 'format', 'kind', 'mode', 'update', 'sha256', 'no-fetch', 'force'] as const).find(
      (k) => values[k] !== undefined && !allowed.includes(k),
    )
    if (extra !== undefined) throw usageError('lists', `--${extra} does not apply to "lists ${sub ?? ''}".`)
  }
  const format =
    values.format === undefined ? undefined : oneOf('lists', '--format', values.format, LIST_FORMATS)
  const kind = values.kind === undefined ? undefined : oneOf('lists', '--kind', values.kind, LIST_KINDS)
  const mode = values.mode === undefined ? undefined : oneOf('lists', '--mode', values.mode, LIST_MODES)
  switch (sub) {
    case undefined:
    case 'list':
      only([])
      noExtra('lists', rest, 0)
      return { name: 'lists', json }
    case 'catalog':
      only([])
      noExtra('lists', rest, 0)
      return { name: 'lists-catalog', json }
    case 'add': {
      only(['name', 'format', 'kind', 'mode', 'update', 'sha256', 'no-fetch'])
      const source = nonEmpty('lists', 'catalog id or https:// URL (see `searchhole lists catalog`)', rest[0])
      noExtra('lists', rest, 1)
      if (values.update !== undefined && parseDuration(values.update) === null)
        throw usageError('lists', '--update takes a duration such as 12h, 1d or 7d.')
      if (values.sha256 !== undefined && !/^[0-9a-fA-F]{64}$/.test(values.sha256))
        throw usageError('lists', '--sha256 takes 64 hex characters.')
      return {
        name: 'lists-add',
        source,
        fetch: values['no-fetch'] !== true,
        yes,
        json,
        ...(values.name === undefined ? {} : { listName: listId(values.name) }),
        ...(format === undefined ? {} : { format }),
        ...(kind === undefined ? {} : { kind }),
        ...(mode === undefined ? {} : { mode }),
        ...(values.update === undefined ? {} : { update: values.update }),
        ...(values.sha256 === undefined ? {} : { sha256: values.sha256.toLowerCase() }),
      }
    }
    case 'remove':
      only([])
      noExtra('lists', rest, 1)
      return { name: 'lists-remove', id: listId(rest[0]), yes, json }
    case 'enforce':
    case 'audit':
    case 'disable':
      only([])
      noExtra('lists', rest, 1)
      return { name: 'lists-mode', id: listId(rest[0]), mode: LIST_MODE_VERBS[sub] as ListMode, yes, json }
    case 'update':
      only(['force'])
      return { name: 'lists-update', ids: rest.map(listId), force: values.force === true, yes, json }
    case 'import': {
      only(['name', 'format', 'kind', 'mode'])
      const file = nonEmpty('lists', 'file to import', rest[0])
      noExtra('lists', rest, 1)
      if (values.name === undefined) throw usageError('lists', 'Name the list with --name <id>.')
      if (kind === undefined)
        throw usageError('lists', `Say what the list holds with --kind (${LIST_KINDS.join(', ')}).`)
      return {
        name: 'lists-import',
        file,
        listName: listId(values.name),
        kind,
        yes,
        json,
        ...(format === undefined ? {} : { format }),
        ...(mode === undefined ? {} : { mode }),
      }
    }
    default:
      throw usageError(
        'lists',
        'Use lists, lists catalog, lists add, lists remove, lists enforce|audit|disable, lists update or lists import.',
      )
  }
}

function parseExplain(args: readonly string[]): Command {
  const { values, positionals } = guard('explain', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, profile: { type: 'string' }, json: { type: 'boolean' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'explain' }
  const url = nonEmpty('explain', 'URL', positionals[0])
  noExtra('explain', positionals, 1)
  return {
    name: 'explain',
    url,
    json: values.json === true,
    ...(values.profile === undefined
      ? {}
      : { profile: nonEmpty('explain', '--profile value', values.profile) }),
  }
}

function parseLog(args: readonly string[]): Command {
  const { values, positionals } = guard('log', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        limit: { type: 'string' },
        hidden: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'log' }
  if (positionals[0] === 'show') {
    const raw = nonEmpty('log', 'search id (searchhole log show <searchId>)', positionals[1])
    noExtra('log', positionals, 2)
    return {
      name: 'log-show',
      searchId: wholeNumber('log', 'The search id', raw, 1, 2_000_000_000),
      json: values.json === true,
    }
  }
  noExtra('log', positionals, 0)
  return {
    name: 'log',
    hidden: values.hidden === true,
    json: values.json === true,
    ...(values.limit === undefined ? {} : { limit: wholeNumber('log', '--limit', values.limit, 1, 1000) }),
  }
}

function parseIdVerb(name: 'approve' | 'reject', args: readonly string[]): Command {
  const { values, positionals } = guard(name, () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: name }
  const raw = nonEmpty(name, 'suggestion id (see `searchhole suggestions`)', positionals[0])
  noExtra(name, positionals, 1)
  return {
    name,
    id: wholeNumber(name, 'The suggestion id', raw, 1, 2_000_000_000),
    yes: values.yes === true,
    json: values.json === true,
  }
}

function parseTrust(args: readonly string[]): Command {
  const { values, positionals } = guard('trust', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'trust' }
  noExtra('trust', positionals, 1)
  const dir = positionals[0]
  return {
    name: 'trust',
    yes: values.yes === true,
    json: values.json === true,
    ...(dir === undefined ? {} : { dir }),
  }
}

function parseMode(args: readonly string[]): Command {
  const { values, positionals } = guard('mode', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'mode' }
  noExtra('mode', positionals, 1)
  const raw = positionals[0]
  return {
    name: 'mode',
    yes: values.yes === true,
    json: values.json === true,
    ...(raw === undefined ? {} : { mode: oneOf('mode', 'The mode', raw, MODES) }),
  }
}

function parseKeys(args: readonly string[]): Command {
  const { values, positionals } = guard('keys', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'keys' }
  const sub = positionals[0]
  if (sub === 'set') {
    if (positionals.length > 2) {
      throw usageError(
        'keys',
        'keys set takes only the engine name. A key is never accepted on the command line: type it at the prompt or pipe it on stdin.',
      )
    }
    return { name: 'keys-set', engine: engineId('keys', positionals[1]) }
  }
  if (sub === 'status') {
    noExtra('keys', positionals, 1)
    return { name: 'keys-status', json: values.json === true }
  }
  if (sub === 'remove') {
    noExtra('keys', positionals, 2)
    return { name: 'keys-remove', engine: engineId('keys', positionals[1], true), yes: values.yes === true }
  }
  throw usageError('keys', 'Use keys set <engine>, keys status or keys remove <engine>.')
}

function parseDoctor(args: readonly string[]): Command {
  const { values, positionals } = guard('doctor', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        probe: { type: 'boolean' },
        strict: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'doctor' }
  noExtra('doctor', positionals, 0)
  return {
    name: 'doctor',
    probe: values.probe === true,
    strict: values.strict === true,
    json: values.json === true,
  }
}

function parseSearxng(args: readonly string[]): Command {
  const { values, positionals } = guard('searxng', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'searxng' }
  noExtra('searxng', positionals, 1)
  const raw = positionals[0]
  if (raw === undefined) throw usageError('searxng', 'Use searxng up, down, status or apply.')
  return {
    name: 'searxng',
    sub: oneOf('searxng', 'The searxng command', raw, SEARXNG_SUBS),
    yes: values.yes === true,
    json: values.json === true,
  }
}

function parseMcp(args: readonly string[]): Command {
  const { values, positionals } = guard('mcp', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { ...HELP_OPTION, host: { type: 'string' } },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'mcp' }
  noExtra('mcp', positionals, 0)
  return {
    name: 'mcp',
    host: values.host === undefined ? 'generic' : oneOf('mcp', '--host', values.host, MCP_HOSTS),
  }
}

function parseUi(args: readonly string[]): Command {
  const { values, positionals } = guard('ui', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        port: { type: 'string' },
        open: { type: 'boolean' },
        detach: { type: 'boolean' },
        stay: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'ui' }
  noExtra('ui', positionals, 0)
  let port: number | undefined
  if (values.port !== undefined) {
    port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : Number.NaN
    if (!(port >= 1024 && port <= 65535)) throw usageError('ui', '--port takes a number from 1024 to 65535.')
  }
  return {
    name: 'ui',
    ...(port === undefined ? {} : { port }),
    open: values.open === true,
    detach: values.detach === true,
    stay: values.stay === true,
  }
}

function parseSetup(args: readonly string[]): Command {
  const { values, positionals } = guard('setup', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        project: { type: 'boolean' },
        env: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'setup' }
  noExtra('setup', positionals, 1)
  const client = positionals[0]
  if (client === undefined || !isSetupClient(client)) {
    throw usageError('setup', `Name the app to set up: ${SETUP_CLIENT_IDS.join(', ')}.`)
  }
  return {
    name: 'setup',
    client,
    project: values.project === true,
    env: [...(values.env ?? [])],
    dryRun: values['dry-run'] === true,
    yes: values.yes === true,
    json: values.json === true,
  }
}

function parseUninstall(args: readonly string[]): Command {
  const { values, positionals } = guard('uninstall', () =>
    parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        ...HELP_OPTION,
        purge: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
      },
    }),
  )
  if (values.help === true) return { name: 'help', topic: 'uninstall' }
  noExtra('uninstall', positionals, 0)
  return {
    name: 'uninstall',
    purge: values.purge === true,
    yes: values.yes === true,
    json: values.json === true,
  }
}

function parseVersion(args: readonly string[]): Command {
  const { values, positionals } = guard('version', () =>
    parseArgs({ args: [...args], allowPositionals: true, options: { json: { type: 'boolean' } } }),
  )
  noExtra('version', positionals, 0)
  return { name: 'version', json: values.json === true }
}

/**
 * Parses argv (without the node and script entries) into a `Command`. `now` (epoch ms)
 * resolves `--until 7d`. Throws `invalid_argument` for anything malformed.
 */
export function parseCommand(argv: readonly string[], now: number = Date.now()): Command {
  const [first, ...rest] = argv
  if (first === undefined || first === '-h' || first === '--help') return { name: 'help' }
  if (first === '-v' || first === '--version') return { name: 'version', json: false }
  if (first === 'help') return rest[0] === undefined ? { name: 'help' } : { name: 'help', topic: rest[0] }
  const verb = RULE_ACTIONS.find((a) => a === first)
  if (verb !== undefined) return parseRuleVerb(verb, rest, now)
  switch (first) {
    case 'search':
      return parseSearch(rest)
    case 'unrule':
      return parseUnrule(rest)
    case 'rules':
      return parseRules(rest)
    case 'lists':
      return parseLists(rest)
    case 'explain':
      return parseExplain(rest)
    case 'log':
      return parseLog(rest)
    case 'suggestions': {
      const { values } = guard('suggestions', () =>
        parseArgs({ args: [...rest], options: { ...HELP_OPTION, json: { type: 'boolean' } } }),
      )
      return values.help === true
        ? { name: 'help', topic: 'suggestions' }
        : { name: 'suggestions', json: values.json === true }
    }
    case 'approve':
    case 'reject':
      return parseIdVerb(first, rest)
    case 'trust':
      return parseTrust(rest)
    case 'mode':
      return parseMode(rest)
    case 'keys':
      return parseKeys(rest)
    case 'doctor':
      return parseDoctor(rest)
    case 'searxng':
      return parseSearxng(rest)
    case 'mcp':
      return parseMcp(rest)
    case 'ui':
      return parseUi(rest)
    case 'uninstall':
      return parseUninstall(rest)
    case 'setup':
      return parseSetup(rest)
    case 'version':
      return parseVersion(rest)
    default: {
      const near = first.startsWith('-') ? undefined : suggestCommand(first)
      throw new SearchHoleError(
        'invalid_argument',
        first.startsWith('-') ? 'Unknown option before the command.' : 'Unknown command.',
        {
          fix:
            near === undefined
              ? 'Run `searchhole help` for the commands.'
              : `Did you mean \`searchhole ${near}\`? Run \`searchhole help\` for the commands.`,
        },
      )
    }
  }
}
