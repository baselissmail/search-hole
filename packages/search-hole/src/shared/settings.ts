// SPDX-License-Identifier: Apache-2.0
/**
 * `<config>/settings.yaml` (ADR-0015 point 2, ADR-0017): schema, defaults, `SEARCHHOLE_*`
 * overrides, and comment-preserving atomic edits.
 *
 * Precedence: environment variables override the file, which overrides the defaults.
 * A field set from the environment is reported as **locked** so the dashboard can show
 * it read-only. Empty values and unset host placeholders (`${user_config.x}`) in the
 * environment count as unset (ADR-0007).
 *
 * Environment mapping (see `SETTINGS_ENV_BINDINGS` for the machine-readable list):
 *
 * | Variable                                             | Field                          |
 * |------------------------------------------------------|--------------------------------|
 * | SEARCHHOLE_HOOK_MODE (steer, strict, off)            | hooks.mode                     |
 * | SEARCHHOLE_HOOK_GUARD, SEARCHHOLE_HOOK_RECEIPT_LINE  | hooks.guard, hooks.receiptLine |
 * | SEARCHHOLE_UI_PORT, SEARCHHOLE_UI_IDLE_MINUTES       | ui.port, ui.idleMinutes        |
 * | SEARCHHOLE_RETENTION_DAYS                            | retention.days                 |
 * | SEARCHHOLE_QUERY_HYGIENE_MODE (block, redact, off)   | queryHygiene.mode              |
 * | SEARCHHOLE_PRIVACY_WAYBACK, SEARCHHOLE_PRIVACY_SITEMAP | privacy.wayback, privacy.sitemap |
 * | SEARCHHOLE_SEARXNG_MANAGED, SEARCHHOLE_SEARXNG_PORT  | searxng.managed, searxng.port  |
 * | SEARCHHOLE_FALLBACK (comma list of engine ids)       | fallback                       |
 * | SEARCHHOLE_PROFILES_DEFAULT                          | profiles_default               |
 * | SEARCHHOLE_<ENGINE>_URL                              | engines.<id>.url               |
 * | SEARCHHOLE_<ENGINE>_ENABLED, _PLAN, _TIMEOUT_MS, _WEIGHT, _PUSHDOWN, _STORAGE_RIGHTS | engines.<id>.* |
 * | SEARCHHOLE_<ENGINE>_CAP_DAY, SEARCHHOLE_<ENGINE>_CAP_MONTH (number or "none") | engines.<id>.caps.* |
 *
 * `<ENGINE>` is the upper-case engine id (SEARXNG, BRAVE, TAVILY, EXA, MOJEEK, KAGI,
 * MARGINALIA). `SEARCHHOLE_<ENGINE>_API_KEY` is a key, not a setting (see `keys/`).
 * An invalid override is ignored with a warning rather than stopping the gateway.
 *
 * Secrets are refused in the file (`secret_in_config`); unknown keys are warnings and
 * survive rewrites because edits go through the yaml Document API.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { isValidAllowPattern, scanConfigForSecrets } from '../core/hygiene.ts'
import { SearchHoleError } from './errors.ts'
import { envValue } from './keys/unset.ts'
import { atomicWriteFile, ensureDir, type LockOptions, withFileLock } from './paths.ts'
import type { EngineId } from './types.ts'

export const SETTINGS_VERSION = 1

export const ENGINE_IDS = [
  'searxng',
  'brave',
  'tavily',
  'exa',
  'mojeek',
  'kagi',
  'marginalia',
] as const satisfies readonly EngineId[]
// Compile-time check that ENGINE_IDS covers the contract's EngineId union.
type MissingEngineIds = Exclude<EngineId, (typeof ENGINE_IDS)[number]>
const _allEnginesListed: [MissingEngineIds] extends [never] ? true : never = true
void _allEnginesListed

type Env = Readonly<Record<string, string | undefined>>
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

// ── Schema ───────────────────────────────────────────────────────────────

const PORT = { min: 1, max: 65535 }
const TIMEOUT_MS = { min: 500, max: 120_000 }

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

const httpUrl = z.string().refine(isHttpUrl, 'must be an http(s) URL without embedded credentials')
const engineIdSchema = z.enum(ENGINE_IDS)
const cap = z.number().int().min(1).nullable()
const retentionDays = z.number().int().min(1).max(3650)

interface EngineSettingsShape {
  enabled: boolean
  url: string | null
  plan: string | null
  timeoutMs: number | null
  weight: number
  pushdown: 'blocks' | 'off'
  storageRights: boolean
  caps: { day: number | null; month: number | null }
}

/** Per-engine defaults (ADR-0015 yaml block, ADR-0017 point 6, ADR-0009 point 6 and 8). */
const ENGINE_DEFAULTS: Readonly<Record<EngineId, EngineSettingsShape>> = {
  searxng: {
    enabled: true,
    url: 'http://127.0.0.1:8888',
    plan: null,
    timeoutMs: 6000,
    weight: 1,
    pushdown: 'off',
    storageRights: false,
    caps: { day: null, month: null },
  },
  brave: {
    enabled: true,
    url: null,
    plan: 'free-credit',
    timeoutMs: null,
    weight: 1,
    pushdown: 'blocks',
    storageRights: false,
    caps: { day: 300, month: 900 },
  },
  tavily: {
    enabled: true,
    url: null,
    plan: null,
    timeoutMs: null,
    weight: 1,
    pushdown: 'blocks',
    storageRights: false,
    caps: { day: 300, month: 900 },
  },
  exa: {
    enabled: true,
    url: null,
    plan: null,
    timeoutMs: null,
    weight: 1,
    pushdown: 'blocks',
    storageRights: false,
    caps: { day: 300, month: 2000 },
  },
  mojeek: {
    enabled: true,
    url: null,
    plan: null,
    timeoutMs: null,
    weight: 1,
    pushdown: 'blocks',
    storageRights: false,
    caps: { day: 300, month: null },
  },
  kagi: {
    enabled: true,
    url: null,
    plan: null,
    timeoutMs: null,
    weight: 1,
    pushdown: 'blocks',
    storageRights: false,
    caps: { day: 300, month: 200 },
  },
  marginalia: {
    enabled: true,
    url: null,
    plan: null,
    timeoutMs: null,
    weight: 1,
    pushdown: 'off',
    storageRights: false,
    caps: { day: null, month: null },
  },
}

/** One engine's schema; every field defaults to that engine's entry above. */
function engineSchema(d: EngineSettingsShape) {
  return z
    .strictObject({
      enabled: z.boolean().default(d.enabled),
      url: httpUrl.nullable().default(d.url),
      plan: z.string().min(1).max(64).nullable().default(d.plan),
      timeoutMs: z.number().int().min(TIMEOUT_MS.min).max(TIMEOUT_MS.max).nullable().default(d.timeoutMs),
      weight: z.number().min(0).max(10).default(d.weight),
      pushdown: z.enum(['blocks', 'off']).default(d.pushdown),
      storageRights: z.boolean().default(d.storageRights),
      caps: z.strictObject({ day: cap.default(d.caps.day), month: cap.default(d.caps.month) }).prefault({}),
    })
    .prefault({})
}

const internalHostSuffix = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (s) => ![...s].some((ch) => ch.trim() === '' || ch === '/' || ch === ':'),
    'must be a host suffix such as corp.example.com',
  )

export const settingsSchema = z.strictObject({
  version: z.number().int().min(1).default(SETTINGS_VERSION),
  engines: z
    .strictObject({
      searxng: engineSchema(ENGINE_DEFAULTS.searxng),
      brave: engineSchema(ENGINE_DEFAULTS.brave),
      tavily: engineSchema(ENGINE_DEFAULTS.tavily),
      exa: engineSchema(ENGINE_DEFAULTS.exa),
      mojeek: engineSchema(ENGINE_DEFAULTS.mojeek),
      kagi: engineSchema(ENGINE_DEFAULTS.kagi),
      marginalia: engineSchema(ENGINE_DEFAULTS.marginalia),
    })
    .prefault({}),
  fallback: z
    .array(engineIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, 'engine ids must be unique')
    .default((): EngineId[] => ['searxng', 'tavily', 'brave', 'exa']),
  profiles_default: z.string().min(1).max(64).default('default'),
  retention: z
    .strictObject({
      days: retentionDays.default(90),
      dailyStatsDays: retentionDays.default(400),
      suggestionsResolvedDays: retentionDays.default(30),
      gatewayDays: retentionDays.default(7),
      backups: z.number().int().min(1).max(50).default(3),
      tables: z
        .strictObject({
          searches: retentionDays.optional(),
          results: retentionDays.optional(),
          fetches: retentionDays.optional(),
          receipts: retentionDays.optional(),
          sessions: retentionDays.optional(),
          resultPayloads: retentionDays.optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  ui: z
    .strictObject({
      port: z.number().int().min(PORT.min).max(PORT.max).default(7341),
      idleMinutes: z.number().int().min(0).max(1440).default(30),
    })
    .prefault({}),
  hooks: z
    .strictObject({
      mode: z.enum(['steer', 'strict', 'off']).default('steer'),
      guard: z.boolean().default(true),
      receiptLine: z.boolean().default(true),
    })
    .prefault({}),
  queryHygiene: z
    .strictObject({
      mode: z.enum(['block', 'redact', 'off']).default('block'),
      allow: z
        .array(
          z.string().min(1).max(500).refine(isValidAllowPattern, 'must be a valid RE2 regular expression'),
        )
        .default(() => []),
      internalHosts: z.array(internalHostSuffix).default(() => []),
      flagLoopback: z.boolean().default(false),
    })
    .prefault({}),
  privacy: z
    .strictObject({ wayback: z.boolean().default(false), sitemap: z.boolean().default(false) })
    .prefault({}),
  searxng: z
    .strictObject({
      managed: z.boolean().default(true),
      port: z.number().int().min(PORT.min).max(PORT.max).default(8888),
      /** The one-time "start a private search engine?" answer, remembered (ADR-0017). */
      offer: z.enum(['pending', 'accepted', 'declined']).default('pending'),
    })
    .prefault({}),
})

export type Settings = DeepReadonly<z.output<typeof settingsSchema>>
export type EngineSettings = Settings['engines'][EngineId]
export type RetentionTable = 'searches' | 'results' | 'fetches' | 'receipts' | 'sessions' | 'resultPayloads'

/** The JSON Schema published for editors (all fields optional, with their defaults). */
export function settingsJsonSchema(): Record<string, unknown> {
  return { title: 'search-hole settings.yaml', ...z.toJSONSchema(settingsSchema, { io: 'input' }) }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/** Every default, frozen. */
export const DEFAULT_SETTINGS: Settings = deepFreeze(settingsSchema.parse({}))

/** Effective retention in days for one table: its override, else `retention.days`. Payloads never exceed `days`. */
export function retentionDaysFor(retention: Settings['retention'], table: RetentionTable): number {
  const days = retention.tables[table] ?? retention.days
  return table === 'resultPayloads' ? Math.min(days, retention.days) : days
}

// ── Environment overrides ────────────────────────────────────────────────

type Parsed = { ok: true; value: unknown } | { ok: false; detail: string }
type Parser = (raw: string) => Parsed

export interface EnvBinding {
  env: string
  /** Dotted settings path, e.g. 'hooks.mode'. */
  path: string
  description: string
  parse: Parser
}

const fail = (detail: string): Parsed => ({ ok: false, detail })
const BOOLEANS = new Map([
  ['1', true],
  ['true', true],
  ['yes', true],
  ['on', true],
  ['0', false],
  ['false', false],
  ['no', false],
  ['off', false],
])

const parseBool: Parser = (raw) => {
  const v = BOOLEANS.get(raw.trim().toLowerCase())
  return v === undefined ? fail('expected true or false') : { ok: true, value: v }
}
const parseInt_ =
  (min: number, max: number): Parser =>
  (raw) => {
    const t = raw.trim()
    const n = Number(t)
    return t !== '' && Number.isInteger(n) && n >= min && n <= max
      ? { ok: true, value: n }
      : fail(`expected an integer from ${min} to ${max}`)
  }
const parseNumber =
  (min: number, max: number): Parser =>
  (raw) => {
    const n = Number(raw.trim())
    return raw.trim() !== '' && Number.isFinite(n) && n >= min && n <= max
      ? { ok: true, value: n }
      : fail(`expected a number from ${min} to ${max}`)
  }
const parseEnum =
  (values: readonly string[]): Parser =>
  (raw) => {
    const v = raw.trim().toLowerCase()
    return values.includes(v) ? { ok: true, value: v } : fail(`expected one of ${values.join(', ')}`)
  }
const parseText: Parser = (raw) => ({ ok: true, value: raw.trim() })
const parseUrl: Parser = (raw) =>
  isHttpUrl(raw.trim())
    ? { ok: true, value: raw.trim() }
    : fail('expected an http(s) URL without credentials')
const parseCap: Parser = (raw) => {
  const t = raw.trim().toLowerCase()
  if (t === 'none' || t === 'off' || t === 'unlimited') return { ok: true, value: null }
  return parseInt_(1, 1_000_000_000)(t)
}
const parseEngineList: Parser = (raw) => {
  const ids = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '')
  const bad = ids.find((id) => !(ENGINE_IDS as readonly string[]).includes(id))
  if (bad !== undefined) return fail(`unknown engine id (expected: ${ENGINE_IDS.join(', ')})`)
  return new Set(ids).size === ids.length ? { ok: true, value: ids } : fail('engine ids must be unique')
}

function buildEnvBindings(): EnvBinding[] {
  const out: EnvBinding[] = []
  const add = (env: string, path: string, description: string, parse: Parser): void => {
    out.push({ env, path, description, parse })
  }
  add(
    'SEARCHHOLE_HOOK_MODE',
    'hooks.mode',
    'Claude Code hook mode: steer, strict or off',
    parseEnum(['steer', 'strict', 'off']),
  )
  add('SEARCHHOLE_HOOK_GUARD', 'hooks.guard', 'Deny Bash/Edit calls that change search-hole rules', parseBool)
  add(
    'SEARCHHOLE_HOOK_RECEIPT_LINE',
    'hooks.receiptLine',
    'Print the one-line receipt at turn end',
    parseBool,
  )
  add('SEARCHHOLE_UI_PORT', 'ui.port', 'Dashboard port on 127.0.0.1', parseInt_(PORT.min, PORT.max))
  add(
    'SEARCHHOLE_UI_IDLE_MINUTES',
    'ui.idleMinutes',
    'Dashboard exits after this many idle minutes (0 = never)',
    parseInt_(0, 1440),
  )
  add(
    'SEARCHHOLE_RETENTION_DAYS',
    'retention.days',
    'Days to keep searches, results, receipts and sessions',
    parseInt_(1, 3650),
  )
  add(
    'SEARCHHOLE_QUERY_HYGIENE_MODE',
    'queryHygiene.mode',
    'Query hygiene: block, redact or off',
    parseEnum(['block', 'redact', 'off']),
  )
  add('SEARCHHOLE_PRIVACY_WAYBACK', 'privacy.wayback', 'Allow Wayback date lookups', parseBool)
  add('SEARCHHOLE_PRIVACY_SITEMAP', 'privacy.sitemap', 'Allow sitemap lastmod lookups', parseBool)
  add(
    'SEARCHHOLE_SEARXNG_MANAGED',
    'searxng.managed',
    'Let search-hole manage the SearXNG container',
    parseBool,
  )
  add(
    'SEARCHHOLE_SEARXNG_PORT',
    'searxng.port',
    'Port of the managed SearXNG container',
    parseInt_(PORT.min, PORT.max),
  )
  add('SEARCHHOLE_FALLBACK', 'fallback', 'Engine fallback order, comma separated', parseEngineList)
  add('SEARCHHOLE_PROFILES_DEFAULT', 'profiles_default', 'Default search profile name', parseText)
  for (const id of ENGINE_IDS) {
    const name = `SEARCHHOLE_${id.toUpperCase()}`
    const at = (field: string): string => `engines.${id}.${field}`
    add(`${name}_ENABLED`, at('enabled'), `Enable or disable ${id}`, parseBool)
    add(`${name}_URL`, at('url'), `Endpoint URL for ${id}`, parseUrl)
    add(`${name}_PLAN`, at('plan'), `Plan label for ${id}`, parseText)
    add(
      `${name}_TIMEOUT_MS`,
      at('timeoutMs'),
      `Request timeout for ${id}`,
      parseInt_(TIMEOUT_MS.min, TIMEOUT_MS.max),
    )
    add(`${name}_WEIGHT`, at('weight'), `Merge weight for ${id}`, parseNumber(0, 10))
    add(
      `${name}_PUSHDOWN`,
      at('pushdown'),
      `Block-rule pushdown for ${id}: blocks or off`,
      parseEnum(['blocks', 'off']),
    )
    add(
      `${name}_STORAGE_RIGHTS`,
      at('storageRights'),
      `Whether you hold storage rights for ${id} results`,
      parseBool,
    )
    add(`${name}_CAP_DAY`, at('caps.day'), `Daily call cap for ${id} (number or none)`, parseCap)
    add(`${name}_CAP_MONTH`, at('caps.month'), `Monthly call cap for ${id} (number or none)`, parseCap)
  }
  return out
}

/** Every `SEARCHHOLE_*` variable that overrides a setting. */
export const SETTINGS_ENV_BINDINGS: readonly EnvBinding[] = buildEnvBindings()

type Dict = Record<string, unknown>
const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v)

function setPath(root: Dict, path: readonly string[], value: unknown): void {
  let cur = root
  for (const key of path.slice(0, -1)) {
    const next = cur[key]
    if (isDict(next)) cur = next
    else {
      const created: Dict = {}
      cur[key] = created
      cur = created
    }
  }
  const last = path[path.length - 1]
  if (last !== undefined) cur[last] = value
}

// ── Loading ──────────────────────────────────────────────────────────────

export type SettingsWarning =
  | { kind: 'unknown_key'; path: string }
  | { kind: 'env_invalid'; env: string; detail: string }
  | { kind: 'version_newer'; found: number; supported: number }

export interface LoadedSettings {
  settings: Settings
  /** Dotted paths forced by `SEARCHHOLE_*` variables: show them read-only. */
  locked: string[]
  warnings: SettingsWarning[]
  /** Dotted paths of keys in the file that this version does not know (kept on rewrite). */
  unknownKeys: string[]
  /** True when file text was supplied (even if empty). */
  fromFile: boolean
}

/** One-line text for a warning (CLI, doctor, dashboard). */
export function describeSettingsWarning(w: SettingsWarning): string {
  switch (w.kind) {
    case 'unknown_key':
      return `settings.yaml: unknown key "${w.path}" is kept but has no effect in this version.`
    case 'env_invalid':
      return `${w.env} ignored: ${w.detail}.`
    case 'version_newer':
      return `settings.yaml is version ${w.found}; this build understands version ${w.supported}. Unknown fields are kept.`
  }
}

const invalid = (why: string, fix: string, details?: Record<string, unknown>): SearchHoleError =>
  new SearchHoleError('config_invalid', why, details === undefined ? { fix } : { fix, details })

function lineOf(text: string, pos: number): number {
  let line = 1
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** Parses YAML text to a plain mapping. Errors name the line, never quote the source. */
function parseYamlMapping(text: string): Dict {
  const doc = YAML.parseDocument(text, { prettyErrors: false })
  const first = doc.errors[0]
  if (first !== undefined) {
    const at = first.pos[0]
    throw invalid(
      `settings.yaml is not valid YAML (line ${lineOf(text, at)}): ${first.code}.`,
      'Fix the syntax, or delete the file to use the defaults.',
    )
  }
  const value: unknown = doc.toJS()
  if (value === null || value === undefined) return {}
  if (!isDict(value))
    throw invalid(
      'settings.yaml must be a mapping of settings.',
      'Start from the documented example, or delete the file.',
    )
  return value
}

const formatPath = (path: ReadonlyArray<PropertyKey>): string => path.map(String).join('.')

/** Mapping-valued sections; a YAML key left empty (`ui:`) reads as null and means "use the defaults". */
const SECTION_PATHS: readonly (readonly string[])[] = [
  ['engines'],
  ['retention'],
  ['retention', 'tables'],
  ['ui'],
  ['hooks'],
  ['queryHygiene'],
  ['privacy'],
  ['searxng'],
  ...ENGINE_IDS.flatMap(
    (id) =>
      [
        ['engines', id],
        ['engines', id, 'caps'],
      ] as const,
  ),
]

/** Removes null-valued sections so their defaults apply. */
function dropNullSections(raw: Dict): void {
  for (const path of SECTION_PATHS) {
    let parent: unknown = raw
    for (const key of path.slice(0, -1)) parent = isDict(parent) ? parent[key] : undefined
    const last = path[path.length - 1]
    if (isDict(parent) && last !== undefined && parent[last] === null) delete parent[last]
  }
}

/** Validates against the strict schema, turning unknown keys into warnings and dropping them. */
function parseStrict(raw: Dict): { settings: z.output<typeof settingsSchema>; unknown: string[] } {
  const cur: Dict = structuredClone(raw)
  const unknown: string[] = []
  for (let pass = 0; pass < 8; pass++) {
    const result = settingsSchema.safeParse(cur)
    if (result.success) return { settings: result.data, unknown }
    const others = result.error.issues.filter((i) => i.code !== 'unrecognized_keys')
    if (others.length > 0 || pass === 7) {
      const shown = (others.length > 0 ? others : result.error.issues).slice(0, 5)
      const lines = shown.map((i) => `${formatPath(i.path) || '(root)'}: ${i.message}`)
      throw invalid(
        `settings.yaml has invalid values: ${lines.join('; ')}.`,
        'Correct these fields, or remove them to use the defaults.',
        {
          issues: shown.map((i) => ({ path: formatPath(i.path), message: i.message })),
        },
      )
    }
    for (const issue of result.error.issues) {
      if (issue.code !== 'unrecognized_keys') continue
      let target: unknown = cur
      for (const key of issue.path) target = isDict(target) ? target[String(key)] : undefined
      if (!isDict(target)) continue
      for (const key of issue.keys) {
        unknown.push(formatPath([...issue.path, key]))
        delete target[key]
      }
    }
  }
  throw invalid('settings.yaml could not be validated.', 'Delete the file to use the defaults.')
}

/**
 * Parses and validates settings text (or the defaults when `text` is undefined), applies
 * `SEARCHHOLE_*` overrides from `opts.env`, and reports which fields they locked.
 * Throws `secret_in_config` if the file holds a secret and `config_invalid` for bad YAML
 * or bad values. Unknown keys are warnings. Pure: reads nothing from the process.
 */
export function loadSettings(text?: string, opts: { env?: Env } = {}): LoadedSettings {
  const env = opts.env ?? {}
  const raw: Dict = text === undefined ? {} : parseYamlMapping(text)

  const secrets = scanConfigForSecrets(raw)
  if (secrets.length > 0) {
    const paths = secrets.map((s) => s.path)
    throw new SearchHoleError(
      'secret_in_config',
      `settings.yaml must not contain secrets, but ${paths.join(', ')} looks like one.`,
      {
        fix: 'Remove it and store the key with `searchhole keys set <engine>` or an environment variable such as TAVILY_API_KEY.',
        details: { paths },
      },
    )
  }

  dropNullSections(raw)
  const warnings: SettingsWarning[] = []
  const locked: string[] = []
  for (const binding of SETTINGS_ENV_BINDINGS) {
    const value = envValue(env, binding.env)
    if (value === undefined) continue
    const parsed = binding.parse(value)
    if (!parsed.ok) {
      warnings.push({ kind: 'env_invalid', env: binding.env, detail: parsed.detail })
      continue
    }
    setPath(raw, binding.path.split('.'), parsed.value)
    locked.push(binding.path)
  }

  const { settings, unknown } = parseStrict(raw)
  for (const path of unknown) warnings.push({ kind: 'unknown_key', path })
  if (settings.version > SETTINGS_VERSION) {
    warnings.push({ kind: 'version_newer', found: settings.version, supported: SETTINGS_VERSION })
  }
  return {
    settings: deepFreeze(settings),
    locked,
    warnings,
    unknownKeys: unknown,
    fromFile: text !== undefined,
  }
}

/** Loads `settings.yaml` from disk (defaults when the file does not exist). */
export function readSettingsFile(file: string, opts: { env?: Env } = {}): LoadedSettings {
  let text: string | undefined
  try {
    text = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  } catch (cause) {
    throw new SearchHoleError('config_invalid', `Cannot read ${file}.`, {
      fix: 'Check the file permissions.',
      cause,
    })
  }
  return loadSettings(text, opts)
}

// ── Editing (comments and unknown keys preserved) ────────────────────────

const NEW_FILE_HEADER = ` search-hole settings. Only the values you change need to be listed;
 everything else uses the defaults.`

function documentForEdit(text: string | undefined): YAML.Document {
  if (text === undefined || text.trim() === '') {
    const doc = new YAML.Document({ version: SETTINGS_VERSION })
    doc.commentBefore = NEW_FILE_HEADER
    return doc
  }
  const doc = YAML.parseDocument(text, { prettyErrors: false })
  const first = doc.errors[0]
  if (first !== undefined) {
    throw invalid(
      `settings.yaml is not valid YAML (line ${lineOf(text, first.pos[0])}): ${first.code}.`,
      'Fix the syntax before changing settings.',
    )
  }
  if (doc.contents !== null && !YAML.isMap(doc.contents))
    throw invalid('settings.yaml must be a mapping of settings.', 'Fix the file before changing settings.')
  return doc
}

function validatedEdit(doc: YAML.Document): string {
  const next = doc.toString()
  loadSettings(next) // throws config_invalid / secret_in_config if the edit made the file unusable
  return next
}

/**
 * Returns `text` with the value at `path` set, keeping comments, formatting and unknown
 * keys. The result is validated, so an invalid value or a secret is rejected before
 * anything is written. `text` undefined starts a new file.
 */
export function setSettingsValue(text: string | undefined, path: readonly string[], value: unknown): string {
  if (path.length === 0) throw invalid('No setting was named.', 'Pass a settings path such as hooks.mode.')
  const doc = documentForEdit(text)
  try {
    doc.setIn([...path], value)
  } catch (cause) {
    throw new SearchHoleError(
      'config_invalid',
      `Cannot set ${path.join('.')}: a parent of it is not a mapping.`,
      {
        fix: 'Fix settings.yaml by hand.',
        cause,
      },
    )
  }
  return validatedEdit(doc)
}

/** Returns `text` with the key at `path` removed (the default applies again). */
export function unsetSettingsValue(text: string | undefined, path: readonly string[]): string {
  if (text === undefined) return documentForEdit(undefined).toString()
  const doc = documentForEdit(text)
  doc.deleteIn([...path])
  return validatedEdit(doc)
}

export interface UpdateOptions {
  /** Lock file path. Default: `<file>.lock`. */
  lockPath?: string
  lock?: LockOptions
}

/**
 * Edits `settings.yaml` under the config lock: reads the current text (undefined if the
 * file is missing), applies `edit`, and writes the result atomically (`0600`). Skips the
 * write when nothing changed. Returns the final text.
 */
export async function updateSettingsFile(
  file: string,
  edit: (current: string | undefined) => string,
  opts: UpdateOptions = {},
): Promise<string> {
  return withFileLock(
    opts.lockPath ?? `${file}.lock`,
    () => {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
      const next = edit(current)
      if (next !== current) {
        ensureDir(dirname(file))
        atomicWriteFile(file, next)
      }
      return next
    },
    opts.lock,
  )
}

/** `updateSettingsFile` for a single value. */
export function setSettingsFileValue(
  file: string,
  path: readonly string[],
  value: unknown,
  opts: UpdateOptions = {},
): Promise<string> {
  return updateSettingsFile(file, (current) => setSettingsValue(current, path, value), opts)
}
