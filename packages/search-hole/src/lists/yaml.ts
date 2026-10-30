// SPDX-License-Identifier: Apache-2.0
/**
 * Loader for `rules.yaml` (global) and `.searchhole.yaml` (project), schema
 * version 1 (ADR-0008 "Files and scopes", "Strict loading"; ADR-0015 point 2;
 * ADR-0007 point 6).
 *
 * - Strict: a bad rule fails the whole load with file, line and reason; the
 *   caller keeps the last good compiled rules.
 * - Forward-compatible within version 1: unknown fields are warnings, and an
 *   unknown `action` makes only that rule a counted no-op.
 * - Project files may hold only `rules` and `profiles` (plus `defaults`); no
 *   `important: true`, no `subscriptions`, nothing from `settings.yaml`.
 * - Secrets are refused everywhere (`secret_in_config`), and never echoed.
 */
import { type Document, isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from 'yaml'
import { z } from 'zod'
import { assignRuleIds, isWeighted, type RuleIdentity } from '../core/rules/ids.ts'
import { parseMatch } from '../core/rules/match.ts'
import type { ProfileDefaults } from '../core/rules/profile.ts'
import { compileRegex } from '../core/rules/regex.ts'
import { parseDuration, untilToMs } from '../core/rules/time.ts'
import { SearchHoleError } from '../shared/errors.ts'
import type { EngineId, ListKind, ListMode, Profile, Rule, RuleAction } from '../shared/types.ts'

export const RULES_SCHEMA_VERSION = 1

export type RulesFileScope = 'global' | 'project'

export type ListFormat =
  | 'auto'
  | 'ublacklist'
  | 'abp'
  | 'adguard'
  | 'hosts'
  | 'domains'
  | 'goggles'
  | 'searchhole'

/** A list subscription from global `rules.yaml` (ADR-0008 "Lists"). */
export interface Subscription {
  name: string
  url: string
  format: ListFormat
  kind: ListKind
  /** Refresh interval, e.g. `7d`. */
  update: string
  mode: ListMode
  sha256?: string
}

export type RulesWarningCode = 'unknown_field' | 'unknown_action' | 'duplicate_rule' | 'ignored_weight'

export interface RulesWarning {
  code: RulesWarningCode
  message: string
  /** e.g. `rules[3].colour`. */
  path: string
  line?: number
  col?: number
}

/** One validation problem; a load error carries all of them in `details.issues`. */
export interface RulesIssue {
  message: string
  path: string
  line?: number
  col?: number
}

export interface LoadedRules {
  rules: Rule[]
  profiles: Profile[]
  defaults: ProfileDefaults
  /** Always empty for project files. */
  subscriptions: Subscription[]
  warnings: RulesWarning[]
  /** Rules skipped because their action needs a newer search-hole. */
  noopRules: number
}

export interface LoadRulesOptions {
  scope: RulesFileScope
  /** Path shown in messages. */
  file: string
}

// ── Vocabularies ─────────────────────────────────────────────────────────

const ENGINES: Record<EngineId, true> = {
  searxng: true,
  brave: true,
  tavily: true,
  exa: true,
  mojeek: true,
  kagi: true,
  marginalia: true,
}
export const ENGINE_IDS = Object.keys(ENGINES) as [EngineId, ...EngineId[]]
const ACTIONS: ReadonlySet<string> = new Set<RuleAction>([
  'block',
  'allow',
  'pin',
  'raise',
  'lower',
  'normal',
])
const FORMATS = ['auto', 'ublacklist', 'abp', 'adguard', 'hosts', 'domains', 'goggles', 'searchhole'] as const
const KINDS = ['block', 'allow', 'official', 'content-farm', 'clone'] as const
const MODES = ['enforce', 'audit', 'disabled'] as const

const TOP_KEYS = new Set(['version', '$schema', 'rules', 'profiles', 'defaults', 'subscriptions'])
/** Keys that belong in settings.yaml (ADR-0015); an error in any rule file. */
const SETTINGS_TOP_KEYS = new Set([
  'engines',
  'fallback',
  'retention',
  'ui',
  'hooks',
  'queryHygiene',
  'query_hygiene',
  'privacy',
  'searxng',
  'profiles_default',
  'endpoint',
  'endpoints',
  'keys',
  'settings',
  'caps',
])
/** Settings-like keys inside a profile or `defaults`: profiles select engines by id only. */
const SETTINGS_PROFILE_KEYS = new Set([
  'url',
  'endpoint',
  'endpoints',
  'baseUrl',
  'base_url',
  'caps',
  'timeoutMs',
  'plan',
  'pushdown',
  'storageRights',
  'retention',
  'queryHygiene',
  'hooks',
  'subscriptions',
])
const RULE_KEYS = new Set(['match', 'action', 'weight', 'profile', 'important', 'until', 'ttl', 'note', 'id'])
const PROFILE_KEYS = new Set(['match', 'engines', 'depth', 'freshness', 'prefer', 'default'])
const DEFAULTS_KEYS = new Set(['engines', 'depth', 'freshness', 'prefer', 'default'])
const NESTED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  match: new Set(['keywords', 'regex']),
  freshness: new Set(['maxAgeDays', 'requireDate', 'basis']),
  prefer: new Set(['lists', 'factor']),
}
const SUB_KEYS = new Set(['name', 'url', 'format', 'kind', 'update', 'mode', 'sha256'])

// ── Schemas ──────────────────────────────────────────────────────────────

const nonEmpty = z.string().trim().min(1, 'must not be empty')
const stringList = z.union([nonEmpty, z.array(nonEmpty)]).transform((v) => (typeof v === 'string' ? [v] : v))

const ruleSchema = z.object({
  match: z.string({ error: 'match is required and must be a string' }).trim().min(1, 'match is empty'),
  action: z.string({ error: 'action is required and must be a string' }),
  weight: z
    .number()
    .int('weight must be an integer')
    .min(1, 'weight must be 1–10')
    .max(10, 'weight must be 1–10')
    .optional(),
  profile: stringList.optional(),
  important: z.boolean().optional(),
  until: z.string({ error: 'until must be a date such as 2026-12-31' }).optional(),
  ttl: z.unknown().optional(),
  note: z.string().max(2000).optional(),
  id: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'id must be 1–64 letters, digits or _ . : -')
    .optional(),
})

const bodyShape = {
  engines: z.array(z.enum(ENGINE_IDS)).optional(),
  depth: z.enum(['quick', 'standard', 'deep']).optional(),
  freshness: z
    .object({
      maxAgeDays: z.number().int().positive().optional(),
      requireDate: z.boolean().optional(),
      basis: z.enum(['published', 'modified', 'newest']).optional(),
    })
    .optional(),
  prefer: z.object({ lists: stringList.optional(), factor: z.number().gt(0).max(10).optional() }).optional(),
  default: z.enum(['keep', 'block']).optional(),
}
const defaultsSchema = z.object(bodyShape)
const profileSchema = z.object({
  ...bodyShape,
  match: z.object({ keywords: stringList.optional(), regex: stringList.optional() }).optional(),
})
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

const subscriptionSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, 'name must be 1–64 letters, digits or . _ -'),
  url: z.string(),
  format: z.enum(FORMATS).default('auto'),
  kind: z.enum(KINDS).default('block'),
  update: z.string().default('7d'),
  mode: z.enum(MODES).default('enforce'),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be 64 hex characters')
    .optional(),
})

// ── Secrets (ADR-0007 point 6) ───────────────────────────────────────────

const words = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
const SECRET_FIELD =
  /(?:^|_)(?:api_?key|apikey|token|password|passwd|pwd|secret|private_key|credentials?)(?:$|_)/
const KEYISH_FIELD = /(?:^|_)(?:key|auth|bearer|pat|access|credential)(?:$|_)/

/** True when a field name is one rule files must never contain (`api_key`, `braveApiKey`, `token`, …). */
export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD.test(words(name))
}

const looksRandom = (s: string): boolean => /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)
const TOKEN_PATTERNS: ReadonlyArray<{ re: RegExp; what: string; random?: true }> = [
  { re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/, what: 'an API key (sk-…)', random: true },
  { re: /\bBSA[A-Za-z0-9_-]{20,}/, what: 'a Brave Search API key', random: true },
  { re: /\btvly-[A-Za-z0-9_-]{16,}/, what: 'a Tavily API key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, what: 'a GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/, what: 'a GitHub token' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/, what: 'a GitLab token' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}/, what: 'a Google API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, what: 'a JWT' },
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, what: 'a URL with a password' },
  {
    re: /[?&](?:api[_-]?key|apikey|key|token|access_token|auth|password|secret)=[^&#\s]{8,}/i,
    what: 'a key in a URL',
  },
]
const OPAQUE = /^[A-Za-z0-9+/_-]{32,}={0,2}$/

/**
 * Describes the kind of secret a string looks like (`'a GitHub token'`), or
 * null. `field` is the YAML key it sits under: long opaque values are refused
 * anywhere except under `sha256`, and key-like fields (`key`, `auth`, …) refuse
 * any long token.
 */
export function detectSecretValue(value: string, field?: string): string | null {
  for (const p of TOKEN_PATTERNS) {
    const m = p.re.exec(value)
    if (m && (!p.random || looksRandom(m[0]))) return p.what
  }
  const v = value.trim()
  if (field !== 'sha256' && OPAQUE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) return 'a long opaque token'
  if (field !== undefined && KEYISH_FIELD.test(words(field)) && /^\S{16,}$/.test(v)) return 'a key'
  return null
}

// ── YAML positions ───────────────────────────────────────────────────────

type Path = ReadonlyArray<string | number>

const pathText = (path: Path): string =>
  path.reduce<string>((s, seg) => (typeof seg === 'number' ? `${s}[${seg}]` : s ? `${s}.${seg}` : seg), '')

class Positions {
  private readonly doc: Document
  private readonly lc: LineCounter

  constructor(doc: Document, lc: LineCounter) {
    this.doc = doc
    this.lc = lc
  }

  /** Line/column of the deepest node on `path`; `key: true` points at the last key instead of its value. */
  at(path: Path, key = false): { line: number; col: number } | undefined {
    let node: unknown = this.doc.contents
    let range = isNode(node) ? node.range : undefined
    for (let i = 0; i < path.length; i++) {
      const seg = path[i]
      const last = i === path.length - 1
      if (isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg))
        if (!pair) break
        const keyRange = isScalar(pair.key) ? pair.key.range : undefined
        const v = pair.value
        range = (key && last) || !isNode(v) || !v.range ? (keyRange ?? range) : v.range
        node = v
      } else if (isSeq(node) && typeof seg === 'number') {
        const item = node.items[seg]
        if (!isNode(item)) break
        range = item.range ?? range
        node = item
      } else break
    }
    return range ? this.lc.linePos(range[0]) : undefined
  }
}

// ── Loader ───────────────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

/**
 * Parses and validates a rules file. Throws `SearchHoleError` with code
 * `rules_invalid` (details: `file`, `issues[]` with line/col) or
 * `secret_in_config`. An empty file is a valid empty rule set.
 */
export function loadRulesYaml(text: string, opts: LoadRulesOptions): LoadedRules {
  const { file, scope } = opts
  const lc = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true })
  const pos = new Positions(doc, lc)
  const issues: RulesIssue[] = []
  const warnings: RulesWarning[] = []
  const located = <T extends object>(base: T, path: Path, key = false) => {
    const p = pos.at(path, key)
    return { ...base, path: pathText(path), ...(p && { line: p.line, col: p.col }) }
  }
  const fail = (): never => {
    issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.col ?? 0) - (b.col ?? 0))
    const first = issues[0]
    const where = first?.line !== undefined ? `${file}:${first.line}:${first.col ?? 1}` : file
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''
    throw new SearchHoleError('rules_invalid', `${where}: ${first?.message ?? 'invalid rules file'}${more}`, {
      fix: 'Fix the file; search-hole keeps using the last rules that loaded.',
      details: { file, issues },
    })
  }
  const issue = (message: string, path: Path, key = false) => issues.push(located({ message }, path, key))
  const warn = (code: RulesWarningCode, message: string, path: Path, key = false) =>
    warnings.push(located({ code, message }, path, key))

  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const p = lc.linePos(e.pos[0])
      issues.push({
        message: `YAML: ${e.message.split('\n')[0] ?? e.code}`,
        path: '',
        line: p.line,
        col: p.col,
      })
    }
    fail()
  }

  refuseSecrets(doc, lc, file)

  let root: unknown
  try {
    root = doc.toJS({ maxAliasCount: 100 })
  } catch (e) {
    issues.push({ message: `YAML: ${e instanceof Error ? e.message : String(e)}`, path: '' })
    fail()
  }
  const empty: LoadedRules = {
    rules: [],
    profiles: [],
    defaults: {},
    subscriptions: [],
    warnings,
    noopRules: 0,
  }
  if (root === null || root === undefined) return empty
  if (!isPlainObject(root)) {
    issue('the top level must be a mapping (version, rules, profiles, …)', [])
    return fail()
  }

  if (root.version === undefined) issue(`version: ${RULES_SCHEMA_VERSION} is required`, [])
  else if (root.version !== RULES_SCHEMA_VERSION) {
    const newer = typeof root.version === 'number' && root.version > RULES_SCHEMA_VERSION
    issue(
      newer
        ? `this file uses version ${root.version}, which needs a newer search-hole (update required)`
        : `version must be ${RULES_SCHEMA_VERSION}`,
      ['version'],
    )
  }
  for (const k of Object.keys(root)) {
    if (TOP_KEYS.has(k)) continue
    if (SETTINGS_TOP_KEYS.has(k)) issue(`'${k}' belongs in settings.yaml, not in a rules file`, [k], true)
    else warn('unknown_field', `unknown top-level field '${k}' is ignored`, [k], true)
  }
  if (scope === 'project' && root.subscriptions !== undefined) {
    issue(
      'subscriptions can only be set in the global rules.yaml, never in a project file',
      ['subscriptions'],
      true,
    )
  }
  if (root.$schema !== undefined && typeof root.$schema !== 'string')
    issue('$schema must be a string', ['$schema'])

  /** Warns about unknown keys; settings-like keys inside profiles and defaults are errors. */
  const checkKeys = (obj: Record<string, unknown>, known: ReadonlySet<string>, path: Path, what: string) => {
    const profileLike = what !== 'rule' && what !== 'subscription'
    for (const k of Object.keys(obj)) {
      if (known.has(k)) {
        const nested = NESTED_KEYS[k]
        const v = obj[k]
        if (profileLike && nested && isPlainObject(v)) checkKeys(v, nested, [...path, k], k)
        continue
      }
      if (profileLike && SETTINGS_PROFILE_KEYS.has(k)) {
        issue(
          `'${k}' is not allowed here: profiles select engines by id; endpoints and limits live in settings.yaml`,
          [...path, k],
        )
      } else warn('unknown_field', `unknown ${what} field '${k}' is ignored`, [...path, k], true)
    }
  }
  const zodIssues = (err: z.ZodError, base: Path) => {
    for (const zi of err.issues) {
      const path = [...base, ...zi.path.filter((s): s is string | number => typeof s !== 'symbol')]
      issue(`${pathText(path)}: ${zi.message}`, path)
    }
  }

  // Profiles and defaults.
  const profiles: Profile[] = []
  const rawProfiles = root.profiles
  if (rawProfiles !== undefined && rawProfiles !== null) {
    const node = doc.get('profiles', true)
    if (!isPlainObject(rawProfiles) || !isMap(node))
      issue('profiles must be a mapping of name → profile', ['profiles'])
    else {
      for (const pair of node.items) {
        const name = isScalar(pair.key) ? String(pair.key.value) : ''
        const path = ['profiles', name]
        if (!PROFILE_NAME.test(name)) {
          issue(`profile name '${name}' must be 1–64 letters, digits or _ . -`, path, true)
          continue
        }
        const body = rawProfiles[name] ?? {}
        if (!isPlainObject(body)) {
          issue(`profile '${name}' must be a mapping`, path)
          continue
        }
        checkKeys(body, PROFILE_KEYS, path, 'profile')
        const r = profileSchema.safeParse(body)
        if (!r.success) {
          zodIssues(r.error, path)
          continue
        }
        for (const [i, re] of (r.data.match?.regex ?? []).entries()) {
          const c = compileRegex(re)
          if (!c.ok) issue(`profile regex: ${c.error}`, [...path, 'match', 'regex', i])
        }
        profiles.push(toProfile(name, r.data))
      }
    }
  }
  let defaults: ProfileDefaults = {}
  if (root.defaults !== undefined && root.defaults !== null) {
    if (!isPlainObject(root.defaults)) issue('defaults must be a mapping', ['defaults'])
    else {
      checkKeys(root.defaults, DEFAULTS_KEYS, ['defaults'], 'defaults')
      const r = defaultsSchema.safeParse(root.defaults)
      if (r.success) defaults = toBody(r.data)
      else zodIssues(r.error, ['defaults'])
    }
  }

  // Subscriptions (global only).
  const subscriptions: Subscription[] = []
  if (scope === 'global' && root.subscriptions !== undefined && root.subscriptions !== null) {
    if (!Array.isArray(root.subscriptions)) issue('subscriptions must be a list', ['subscriptions'])
    else {
      const names = new Set<string>()
      for (const [i, raw] of (root.subscriptions as unknown[]).entries()) {
        const path = ['subscriptions', i]
        if (!isPlainObject(raw)) {
          issue('each subscription must be a mapping', path)
          continue
        }
        checkKeys(raw, SUB_KEYS, path, 'subscription')
        const r = subscriptionSchema.safeParse(raw)
        if (!r.success) {
          zodIssues(r.error, path)
          continue
        }
        const s = r.data
        let url: URL | null = null
        try {
          url = new URL(s.url)
        } catch {
          url = null
        }
        if (url?.protocol !== 'https:') issue('subscription url must be an https:// URL', [...path, 'url'])
        else if (url.username !== '' || url.password !== '') {
          issue('subscription url must not contain credentials', [...path, 'url'])
        }
        if (parseDuration(s.update) === null)
          issue('update must be a duration such as 12h or 7d', [...path, 'update'])
        if (names.has(s.name)) issue(`duplicate subscription name '${s.name}'`, [...path, 'name'])
        names.add(s.name)
        const sub: Subscription = {
          name: s.name,
          url: s.url,
          format: s.format,
          kind: s.kind,
          update: s.update,
          mode: s.mode,
        }
        if (s.sha256 !== undefined) sub.sha256 = s.sha256.toLowerCase()
        subscriptions.push(sub)
      }
    }
  }

  // Rules.
  const drafts: { rule: Rule; identity: RuleIdentity; path: Path; userId?: string }[] = []
  let noopRules = 0
  if (root.rules !== undefined && root.rules !== null) {
    if (!Array.isArray(root.rules)) issue('rules must be a list', ['rules'])
    else {
      for (const [i, raw] of (root.rules as unknown[]).entries()) {
        const path = ['rules', i]
        if (!isPlainObject(raw)) {
          issue('each rule must be a mapping such as { match: x.com, action: block }', path)
          continue
        }
        checkKeys(raw, RULE_KEYS, path, 'rule')
        const r = ruleSchema.safeParse(raw)
        if (!r.success) {
          zodIssues(r.error, path)
          continue
        }
        const d = r.data
        if (!ACTIONS.has(d.action)) {
          noopRules++
          warn('unknown_action', `unknown action '${d.action}': rule ignored (needs a newer search-hole)`, [
            ...path,
            'action',
          ])
          continue
        }
        const action = d.action as RuleAction
        const parsed = parseMatch(d.match)
        if (!parsed.ok) {
          issue(parsed.error, [...path, 'match'])
          continue
        }
        if (scope === 'project' && d.important === true) {
          issue('important is not allowed in project files (a repo cannot outrank your own rules)', [
            ...path,
            'important',
          ])
          continue
        }
        if (d.ttl !== undefined) {
          issue('ttl needs a start time: write until: YYYY-MM-DD (rules add --ttl writes it for you)', [
            ...path,
            'ttl',
          ])
          continue
        }
        if (d.until !== undefined && untilToMs(d.until) === null) {
          issue('until must be a date (2026-12-31) or a date-time with a zone (…T12:00:00Z)', [
            ...path,
            'until',
          ])
          continue
        }
        if (!isWeighted(action) && d.weight !== undefined && d.weight !== 1) {
          warn('ignored_weight', `weight only applies to raise and lower; ignored for ${action}`, [
            ...path,
            'weight',
          ])
        }
        const p = pos.at(path)
        const rule: Rule = {
          id: '',
          scope,
          match: d.match,
          matchKind: parsed.match.kind,
          action,
          weight: isWeighted(action) ? (d.weight ?? 1) : 1,
          important: d.important ?? false,
          order: i,
          source: p ? `${file}:${p.line}` : file,
        }
        if (d.profile) rule.profiles = d.profile
        if (d.until !== undefined) rule.until = d.until
        if (d.note !== undefined) rule.note = d.note
        const identity: RuleIdentity = {
          scope,
          match: parsed.match.canonical,
          action,
          weight: rule.weight,
          profiles: rule.profiles,
          important: rule.important,
        }
        drafts.push({ rule, identity, path, ...(d.id !== undefined && { userId: d.id }) })
      }
    }
  }

  const ids = assignRuleIds(drafts.map((d) => d.identity))
  const used = new Map<string, number>()
  drafts.forEach((d, i) => {
    const assigned = ids[i]
    if (!assigned) return
    if (assigned.duplicateOf !== undefined) {
      const first = drafts[assigned.duplicateOf]
      warn('duplicate_rule', `exact duplicate of ${first ? pathText(first.path) : 'an earlier rule'}`, d.path)
    }
    d.rule.id = d.userId ?? assigned.id
    const prev = used.get(d.rule.id)
    if (prev !== undefined) issue(`rule id '${d.rule.id}' is used twice`, [...d.path, 'id'])
    used.set(d.rule.id, i)
  })

  if (issues.length > 0) fail()
  return { rules: drafts.map((d) => d.rule), profiles, defaults, subscriptions, warnings, noopRules }
}

type ProfileBody = z.infer<typeof defaultsSchema>

function toBody(b: ProfileBody): ProfileDefaults {
  const out: ProfileDefaults = {}
  if (b.engines) out.engines = b.engines
  if (b.depth) out.depth = b.depth
  if (b.freshness) {
    const f: NonNullable<Profile['freshness']> = {}
    if (b.freshness.maxAgeDays !== undefined) f.maxAgeDays = b.freshness.maxAgeDays
    if (b.freshness.requireDate !== undefined) f.requireDate = b.freshness.requireDate
    if (b.freshness.basis !== undefined) f.basis = b.freshness.basis
    out.freshness = f
  }
  if (b.prefer) {
    const p: NonNullable<Profile['prefer']> = {}
    if (b.prefer.lists) p.lists = b.prefer.lists
    if (b.prefer.factor !== undefined) p.factor = b.prefer.factor
    out.prefer = p
  }
  if (b.default) out.defaultAction = b.default
  return out
}

function toProfile(name: string, b: z.infer<typeof profileSchema>): Profile {
  const out: Profile = { name, ...toBody(b) }
  if (b.match) {
    const m: NonNullable<Profile['match']> = {}
    if (b.match.keywords) m.keywords = b.match.keywords
    if (b.match.regex) m.regex = b.match.regex
    out.match = m
  }
  return out
}

/** Walks every key and scalar; throws `secret_in_config` naming each location, never the value. */
function refuseSecrets(doc: Document, lc: LineCounter, file: string): void {
  const findings: { path: string; line: number; col: number; kind: string }[] = []
  const visit = (node: unknown, path: (string | number)[], field: string | undefined): void => {
    if (isMap(node)) {
      const profileNames = path.length === 1 && path[0] === 'profiles'
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : undefined
        const childPath = [...path, k ?? '?']
        const v = pair.value
        const hasValue = isScalar(v) ? v.value !== null && String(v.value).trim() !== '' : v !== null
        if (k !== undefined && !profileNames && isSecretFieldName(k) && hasValue && isScalar(pair.key)) {
          const p = pair.key.range ? lc.linePos(pair.key.range[0]) : { line: 0, col: 0 }
          findings.push({ path: pathText(childPath), ...p, kind: `a field named '${k}'` })
        }
        visit(v, childPath, profileNames ? undefined : k)
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        visit(item, [...path, i], field)
      })
    } else if (isScalar(node) && typeof node.value === 'string') {
      const what = detectSecretValue(node.value, field)
      if (what) {
        const p = node.range ? lc.linePos(node.range[0]) : { line: 0, col: 0 }
        findings.push({ path: pathText(path), ...p, kind: what })
      }
    }
  }
  visit(doc.contents, [], undefined)
  const first = findings[0]
  if (!first) return
  const more = findings.length > 1 ? ` (and ${findings.length - 1} more)` : ''
  throw new SearchHoleError(
    'secret_in_config',
    `${file}:${first.line}:${first.col}: ${first.path || 'value'} looks like a secret (${first.kind}); rule files never hold keys${more}`,
    {
      fix: 'Remove it and store the key with `searchhole keys set <engine>` or an environment variable.',
      details: { file, findings },
    },
  )
}
