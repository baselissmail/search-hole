// SPDX-License-Identifier: Apache-2.0
/**
 * User rules for the app (ADR-0005, ADR-0008):
 * - global `<config>/rules.yaml` (created only by `rules.add`);
 * - project `<projectDir>/.searchhole.yaml`, applied only when its SHA-256 is trusted;
 * - session rules from `rules_session` for the request's session key.
 *
 * Files load strictly. A file that fails keeps the last good loaded rules persisted in
 * `rules_lastgood` (per content hash). Compiled rule sets are cached by file hashes and the
 * session rule set. Writes go through the yaml Document API (comments preserved), atomically
 * and under a lock.
 */

import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { isMap, isSeq, type YAMLMap } from 'yaml'
import { z } from 'zod'
import {
  type CompiledRuleSet,
  compileRuleSet,
  isWeighted,
  matchProfile,
  type ParsedMatch,
  type ProfileDefaults,
  parseMatch,
  resolveProfiles,
  ruleIdBase,
  ruleText,
  untilToMs,
} from '../core/rules/index.ts'
import { classifySource } from '../core/sourcetype.ts'
import { builtinDefaultProfile } from '../lists/bundled/index.ts'
import { type ListSetting, type LoadedRules, loadRulesYaml, type Subscription } from '../lists/yaml.ts'
import { isSearchHoleError, SearchHoleError } from '../shared/errors.ts'
import type {
  ListKind,
  MatchKind,
  Profile,
  Rule,
  RuleAction,
  RuleDecision,
  SourceType,
  Tier,
} from '../shared/types.ts'
import type { Store } from '../store/index.ts'
import type { AppContext } from './context.ts'
import { editRulesFile, readTextIfExists, rulesSeq, sha256Hex } from './fsutil.ts'
import type { ListsService } from './lists.ts'
import type { AddRuleInput, RequestCtx, RuleListing } from './types.ts'

/** Bumped when the persisted last-good shape changes. */
export const RULES_COMPILER_VERSION = '1'
export const PROJECT_FILE = '.searchhole.yaml'

const ACTIONS: readonly RuleAction[] = ['block', 'allow', 'pin', 'raise', 'lower', 'normal']
/** Above this many list rules, at most 4 compiled rule sets stay cached. */
const LARGE_LISTS = 100_000
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** ADR-0005: session rules on hosts that do not identify chats are refused. */
export const FALLBACK_SESSION_REFUSAL =
  "This host doesn't identify chats, so a session rule could leak into other conversations; use a global rule with `until:` instead."

/** One rules file as loaded for this request. */
export interface FileState {
  path: string
  exists: boolean
  sha256?: string
  /** The rules in force from this file (null when none). */
  loaded: LoadedRules | null
  /** The strict-load error, when the file is invalid. */
  error?: SearchHoleError
  /** True when `loaded` is the persisted last good copy because the file failed to load. */
  lastGood?: boolean
}

/** A project rules file and whether it is trusted (ADR-0008). */
export interface ProjectState extends FileState {
  dir: string
  /** absent: no file; trusted: hash approved; untrusted: never approved; changed: approved hash differs. */
  trust: 'absent' | 'trusted' | 'untrusted' | 'changed'
}

/** Everything a request needs from the rules. */
export interface RuleContext {
  ruleSet: CompiledRuleSet
  /** Session, then project (when trusted), then global rules. */
  userRules: Rule[]
  profiles: Profile[]
  defaults: ProfileDefaults
  global: FileState
  project?: ProjectState
  sessionRules: Rule[]
  /** Kind of each enabled list (bundled, starter, subscribed, imported), for source typing. */
  listKinds: ReadonlyMap<string, ListKind>
}

const sessionRuleSchema = z.object({
  match: z.string().min(1).max(2000),
  action: z.enum(['block', 'allow', 'pin', 'raise', 'lower', 'normal']),
  weight: z.number().int().min(1).max(10).default(1),
  profiles: z.array(z.string()).optional(),
  important: z.boolean().default(false),
  until: z.string().optional(),
  note: z.string().max(2000).optional(),
  source: z.string().max(200).optional(),
})

const lastGoodRule = z.object({
  id: z.string(),
  scope: z.enum(['session', 'project', 'global']),
  match: z.string(),
  matchKind: z.enum(['domain', 'exact_host', 'host_path', 'url_pattern', 'regex']),
  action: z.enum(['block', 'allow', 'pin', 'raise', 'lower', 'normal']),
  weight: z.number(),
  profiles: z.array(z.string()).optional(),
  important: z.boolean(),
  until: z.string().optional(),
  note: z.string().optional(),
  source: z.string().optional(),
  order: z.number(),
})
const lastGoodSchema = z.object({
  rules: z.array(lastGoodRule),
  profiles: z.array(z.looseObject({ name: z.string() })),
  defaults: z.looseObject({}),
  // Since P6 (additive: older copies have neither, older binaries ignore them).
  subscriptions: z.array(z.looseObject({ name: z.string(), url: z.string() })).optional(),
  lists: z.record(z.string(), z.looseObject({})).optional(),
})

/** Rebuilds a `Rule` from validated JSON, omitting absent optional fields. */
function toRule(r: z.infer<typeof lastGoodRule>): Rule {
  const rule: Rule = {
    id: r.id,
    scope: r.scope,
    match: r.match,
    matchKind: r.matchKind,
    action: r.action,
    weight: r.weight,
    important: r.important,
    order: r.order,
  }
  if (r.profiles) rule.profiles = r.profiles
  if (r.until !== undefined) rule.until = r.until
  if (r.note !== undefined) rule.note = r.note
  if (r.source !== undefined) rule.source = r.source
  return rule
}

/** The persisted last good rules, validated; null when unusable. */
function lastGoodFrom(json: unknown): LoadedRules | null {
  const parsed = lastGoodSchema.safeParse(json)
  if (!parsed.success) return null
  return {
    rules: parsed.data.rules.map(toRule),
    // Profiles, defaults, subscriptions and list settings were validated by the strict loader
    // before they were saved.
    profiles: parsed.data.profiles as unknown as Profile[],
    defaults: parsed.data.defaults as ProfileDefaults,
    subscriptions: (parsed.data.subscriptions ?? []) as unknown as Subscription[],
    lists: (parsed.data.lists ?? {}) as Record<string, ListSetting>,
    warnings: [],
    noopRules: 0,
  }
}

/** Primary key of a session rule row: the rule id plus a short hash of the session key. */
export function sessionRowId(ruleId: string, sessionKey: string): string {
  return `${ruleId}@${createHash('sha256').update(sessionKey).digest('hex').slice(0, 12)}`
}

/** The tier a user rule lands in (ADR-0008 table). */
export function tierOf(rule: Rule): Tier {
  if (rule.scope === 'session') return rule.important ? 'T0s' : 'T1'
  if (rule.scope === 'global') return rule.important ? 'T0g' : 'T3'
  if (rule.scope === 'project') return 'T2'
  return 'T4'
}

const TIER_ORDER: Readonly<Record<Tier, number>> = { T0s: 0, T0g: 1, T1: 2, T2: 3, T3: 4, T4: 5 }

/** User rules in tier order (important session, important global, session, project, global), then file order. */
export function inTierOrder(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => TIER_ORDER[tierOf(a)] - TIER_ORDER[tierOf(b)] || a.order - b.order)
}

/** A rule as the CLI lists it. */
export function listingOf(rule: Rule): RuleListing {
  const scope = rule.scope === 'list' ? 'global' : rule.scope
  const out: RuleListing = {
    id: rule.id,
    scope,
    match: rule.match,
    action: rule.action,
    weight: rule.weight,
    important: rule.important,
    source: rule.source ?? scope,
  }
  if (rule.profiles && rule.profiles.length > 0) out.profiles = rule.profiles
  if (rule.until !== undefined) out.until = rule.until
  if (rule.note !== undefined) out.note = rule.note
  return out
}

/** True when a rule applies to `profile` at `now`. */
export function ruleApplies(rule: Rule, profile: string, now: number): boolean {
  if (rule.profiles && rule.profiles.length > 0 && !rule.profiles.includes(profile)) return false
  if (rule.until === undefined) return true
  const until = untilToMs(rule.until)
  return until !== null && now < until
}

/** The literal host a rule's match is scoped to, or null for regex and URL patterns. */
export function literalHost(match: ParsedMatch): { host: string; subdomains: boolean } | null {
  if (match.kind === 'domain') return { host: match.host, subdomains: true }
  if (match.kind === 'exact_host') return { host: match.host, subdomains: false }
  if (match.kind === 'host_path') return { host: match.host, subdomains: !match.exactHost }
  return null
}

const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** True when a keep rule's host scope and a block's host scope can contain the same URL. */
export function scopesOverlap(
  keep: { host: string; subdomains: boolean },
  block: { host: string; subdomains: boolean },
): boolean {
  if (block.subdomains && within(keep.host, block.host)) return true
  if (keep.subdomains && within(block.host, keep.host)) return true
  return keep.host === block.host
}

export interface BlockHost {
  host: string
  ruleId: string
}

/**
 * Domain blocks that are safe to apply outside our own decision (engine pushdown, ADR-0009
 * point 8; WebSearch `blocked_domains`, ADR-0018): user tiers first; a block whose host scope
 * overlaps any user allow or pin is left out, and any allow or pin that is not a literal host
 * (regex, URL pattern) disables the list entirely. Exact-host blocks (`=github.com`) are never
 * pushed: `blocked_domains` and `-site:` both cover subdomains, so they would also drop
 * `docs.github.com`, unlogged. Our own decision applies them after the search.
 */
export function safeBlockHosts(rules: readonly Rule[], profile: string, now: number): BlockHost[] {
  const active = inTierOrder(rules).filter((r) => ruleApplies(r, profile, now))
  const keeps: Array<{ host: string; subdomains: boolean }> = []
  for (const r of active) {
    if (r.action !== 'allow' && r.action !== 'pin') continue
    const parsed = parseMatch(r.match)
    if (!parsed.ok) continue
    const lit = literalHost(parsed.match)
    if (lit === null) return []
    keeps.push(lit)
  }
  const out: BlockHost[] = []
  const seen = new Set<string>()
  for (const r of active) {
    if (r.action !== 'block' || r.matchKind !== 'domain') continue
    const parsed = parseMatch(r.match)
    if (!parsed.ok) continue
    const lit = literalHost(parsed.match)
    if (lit === null || keeps.some((k) => scopesOverlap(k, lit))) continue
    if (seen.has(lit.host)) continue
    seen.add(lit.host)
    out.push({ host: lit.host, ruleId: r.id })
  }
  return out
}

/** Loads, caches and edits the user's rules. */
export class RulesService {
  private readonly files = new Map<
    string,
    { sha: string; loaded: LoadedRules | null; error?: SearchHoleError }
  >()
  private readonly compiled = new Map<string, CompiledRuleSet>()
  private readonly savedLastGood = new Set<string>()

  private readonly ctx: AppContext
  /** Bundled, starter, subscribed and imported lists (ADR-0022). */
  readonly lists: ListsService

  constructor(ctx: AppContext, lists: ListsService) {
    this.ctx = ctx
    this.lists = lists
  }

  /**
   * Source type for a URL: membership of an enforced typed list (`official`, `content-farm`,
   * `clone`), then URL patterns. Audit lists never type a source.
   */
  sourceTypeOf(rc: RuleContext, profile: string, now: number): (url: string) => SourceType {
    return (url) =>
      classifySource(url, {
        typedLists: () =>
          rc.ruleSet
            .listMemberships(url, { profile, now })
            .map((id) => rc.listKinds.get(id))
            .filter((k): k is ListKind => k !== undefined),
      })
  }

  get globalPath(): string {
    return this.ctx.layout.rules
  }

  /** `<dir>/.searchhole.yaml`, absolute. */
  projectFile(dir: string): string {
    return resolve(dir, PROJECT_FILE)
  }

  /**
   * The project directory (ADR-0005): the request's, else `CLAUDE_PROJECT_DIR`, else the
   * process cwd unless it is the home directory or the filesystem root.
   */
  projectDir(rctx?: RequestCtx): string | undefined {
    if (rctx?.projectDir !== undefined && rctx.projectDir.trim() !== '') return rctx.projectDir
    const fromEnv = this.ctx.env.CLAUDE_PROJECT_DIR?.trim()
    if (fromEnv && isAbsolute(fromEnv)) return fromEnv
    const cwd = resolve(this.ctx.cwd)
    if (cwd === resolve(this.ctx.homedir) || cwd === resolve('/')) return undefined
    return cwd
  }

  /** Strict load with a per-hash cache and the last-good fallback. */
  private loadFile(path: string, scope: 'global' | 'project', store: Store | null): FileState {
    let text: string | undefined
    try {
      text = readTextIfExists(path)
    } catch (cause) {
      const error = new SearchHoleError('rules_invalid', `Cannot read ${path}.`, {
        fix: 'Check the file permissions.',
        cause,
      })
      return { path, exists: true, loaded: this.lastGood(path, store), error, lastGood: true }
    }
    if (text === undefined) return { path, exists: false, loaded: null }
    const sha = sha256Hex(text)
    let entry = this.files.get(path)
    if (!entry || entry.sha !== sha) {
      try {
        entry = { sha, loaded: loadRulesYaml(text, { scope, file: path }) }
      } catch (e) {
        const error = isSearchHoleError(e)
          ? e
          : new SearchHoleError('rules_invalid', `${path} could not be loaded.`, { cause: e })
        entry = { sha, loaded: null, error }
      }
      this.files.set(path, entry)
    }
    if (entry.error) {
      const fallback = this.lastGood(path, store)
      return {
        path,
        exists: true,
        sha256: sha,
        loaded: fallback,
        error: entry.error,
        lastGood: fallback !== null,
      }
    }
    if (entry.loaded) this.saveLastGood(path, sha, entry.loaded, store)
    return { path, exists: true, sha256: sha, loaded: entry.loaded }
  }

  private lastGood(path: string, store: Store | null): LoadedRules | null {
    try {
      const row = store?.rulesLastGood.latest(path)
      return row ? lastGoodFrom(row.compiled) : null
    } catch {
      return null
    }
  }

  private saveLastGood(path: string, sha: string, loaded: LoadedRules, store: Store | null): void {
    const key = `${path}\u0000${sha}`
    if (!store || this.savedLastGood.has(key) || store.status().mode !== 'read-write') return
    try {
      const ok = store.rulesLastGood.put({
        sourcePath: path,
        sha256: sha,
        compilerVersion: RULES_COMPILER_VERSION,
        compiled: {
          rules: loaded.rules,
          profiles: loaded.profiles,
          defaults: loaded.defaults,
          ...(path === this.globalPath ? { subscriptions: loaded.subscriptions, lists: loaded.lists } : {}),
        },
      })
      if (ok) this.savedLastGood.add(key)
    } catch (e) {
      this.ctx.logger.warn({ err: e }, 'could not save the last good rules')
    }
  }

  /** The global rules file state. */
  global(store: Store | null): FileState {
    return this.loadFile(this.globalPath, 'global', store)
  }

  /** A project's rules file and its trust state. Untrusted files are never loaded. */
  project(dir: string, store: Store | null): ProjectState {
    const path = this.projectFile(dir)
    let text: string | undefined
    try {
      text = readTextIfExists(path)
    } catch {
      text = undefined
    }
    if (text === undefined) return { dir, path, exists: false, loaded: null, trust: 'absent' }
    const sha = sha256Hex(text)
    let trusted: string | undefined
    try {
      trusted = store?.projectTrust.get(path)?.sha256
    } catch {
      trusted = undefined
    }
    if (trusted !== sha) {
      return {
        dir,
        path,
        exists: true,
        sha256: sha,
        loaded: null,
        trust: trusted === undefined ? 'untrusted' : 'changed',
      }
    }
    return { ...this.loadFile(path, 'project', store), dir, trust: 'trusted' }
  }

  /** Unexpired session rules of one session, as engine rules. */
  sessionRules(sessionKey: string, store: Store | null): Rule[] {
    let rows: ReturnType<Store['sessionRules']['list']> = []
    try {
      rows = store?.sessionRules.list(sessionKey) ?? []
    } catch {
      rows = []
    }
    const out: Rule[] = []
    rows.forEach((row, order) => {
      const parsed = sessionRuleSchema.safeParse(row.rule)
      if (!parsed.success) return
      const r = parsed.data
      const match = parseMatch(r.match)
      if (!match.ok) return
      const weight = isWeighted(r.action) ? r.weight : 1
      const rule: Rule = {
        id: ruleIdBase({
          scope: 'session',
          match: match.match.canonical,
          action: r.action,
          weight,
          profiles: r.profiles,
          important: r.important,
        }),
        scope: 'session',
        match: r.match,
        matchKind: match.match.kind,
        action: r.action,
        weight,
        important: r.important,
        order,
        source: r.source ?? `session:${row.id}`,
      }
      if (r.profiles && r.profiles.length > 0) rule.profiles = r.profiles
      if (r.until !== undefined) rule.until = r.until
      else if (row.until !== null) rule.until = new Date(row.until).toISOString()
      if (r.note !== undefined) rule.note = r.note
      out.push(rule)
    })
    return out
  }

  /** Resolves the rules for one request and compiles (or reuses) the rule set. */
  context(rctx: RequestCtx | undefined, store: Store | null): RuleContext {
    const global = this.global(store)
    const dir = this.projectDir(rctx)
    const project = dir === undefined ? undefined : this.project(dir, store)
    const session = rctx?.session ? this.sessionRules(rctx.session.key, store) : []
    const projectLoaded = project?.trust === 'trusted' ? project.loaded : null
    const resolved = resolveProfiles({
      project: projectLoaded?.profiles ?? [],
      global: global.loaded?.profiles ?? [],
      ...(projectLoaded ? { projectDefaults: projectLoaded.defaults } : {}),
      ...(global.loaded ? { globalDefaults: global.loaded.defaults } : {}),
    })
    const userRules = [...session, ...(projectLoaded?.rules ?? []), ...(global.loaded?.rules ?? [])]
    const lists = this.lists.set(global)
    const key = JSON.stringify([
      global.sha256 ?? '-',
      global.lastGood === true,
      projectLoaded ? (project?.sha256 ?? '-') : '-',
      session.map((r) => `${r.id}:${r.until ?? ''}`),
      lists.key,
    ])
    let ruleSet = this.compiled.get(key)
    // The built-in default profile prefers official docs unless the user defines their own.
    const defaultName = this.ctx.settings.settings.profiles_default
    if (!resolved.profiles.some((p) => p.name === defaultName)) {
      resolved.profiles.push(builtinDefaultProfile(defaultName))
    }
    if (!ruleSet) {
      ruleSet = compileRuleSet({ rules: userRules, lists: lists.inputs, profiles: resolved.profiles })
      // Each compiled set holds every list rule: keep few of them when the lists are large.
      if (this.compiled.size >= (lists.totalRules > LARGE_LISTS ? 4 : 64)) this.compiled.clear()
      this.compiled.set(key, ruleSet)
    }
    const out: RuleContext = {
      ruleSet,
      userRules,
      profiles: resolved.profiles,
      defaults: resolved.defaults,
      global,
      sessionRules: session,
      listKinds: lists.kinds,
    }
    if (project) out.project = project
    return out
  }

  /** The profile a query runs under; `defaultName` is settings `profiles_default`. */
  resolveProfile(
    rc: RuleContext,
    query: string,
    explicit: string | undefined,
    defaultName: string,
  ): { name: string; profile: Omit<Profile, 'name'> } {
    const m = matchProfile(query, rc.profiles, explicit, defaultName)
    const named = m.profile ?? rc.profiles.find((p) => p.name === m.name)
    if (named) return { name: named.name, profile: named }
    return { name: m.name, profile: rc.defaults }
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  /** Rules by scope: global, the trusted project file, and every session's rules. */
  list(scope: 'session' | 'project' | 'global' | undefined, store: Store | null): RuleListing[] {
    const out: RuleListing[] = []
    if (scope === undefined || scope === 'session') {
      let rows: ReturnType<Store['sessionRules']['list']> = []
      try {
        rows = store?.sessionRules.list() ?? []
      } catch {
        rows = []
      }
      const sessions = [...new Set(rows.map((r) => r.sessionId))]
      for (const s of sessions) out.push(...this.sessionRules(s, store).map(listingOf))
    }
    if (scope === undefined || scope === 'project') {
      const dir = this.projectDir()
      const p = dir === undefined ? undefined : this.project(dir, store)
      if (p?.trust === 'trusted') out.push(...(p.loaded?.rules ?? []).map(listingOf))
    }
    if (scope === undefined || scope === 'global')
      out.push(...(this.global(store).loaded?.rules ?? []).map(listingOf))
    return out
  }

  /** Validates an AddRuleInput; throws `invalid_argument` naming the problem. */
  private validate(input: AddRuleInput): { parsed: ParsedMatch; weight: number } {
    const bad = (why: string, fix?: string): never => {
      throw new SearchHoleError('invalid_argument', why, fix === undefined ? {} : { fix })
    }
    if (!ACTIONS.includes(input.action))
      bad(`Unknown action "${String(input.action)}".`, `Use one of: ${ACTIONS.join(', ')}.`)
    const parsed = parseMatch(input.match)
    if (!parsed.ok)
      return bad(
        `Invalid match: ${parsed.error}.`,
        'Use a domain (example.com), =host, host/path, a |pattern| or /regex/.',
      )
    let weight = 1
    if (isWeighted(input.action)) {
      weight = input.weight ?? 1
      if (!Number.isInteger(weight) || weight < 1 || weight > 10)
        bad('weight must be an integer from 1 to 10.')
    }
    if (input.until !== undefined && untilToMs(input.until) === null)
      bad('until must be a date (2026-12-31) or a date-time with a zone.')
    if (input.profile !== undefined && !PROFILE_NAME.test(input.profile))
      bad('profile must be 1–64 letters, digits or _ . -.')
    return { parsed: parsed.match, weight }
  }

  /** Adds a rule to the chosen scope (default global). Returns the rule as now in force. */
  async add(
    input: AddRuleInput,
    rctx: RequestCtx | undefined,
    store: () => Promise<Store | null>,
  ): Promise<RuleListing> {
    const { parsed, weight } = this.validate(input)
    const scope = input.scope ?? 'global'
    if (scope === 'session') return this.addSession(input, parsed, weight, rctx, store)
    if (scope === 'project' && input.important === true) {
      throw new SearchHoleError('invalid_argument', 'important is not allowed in project rules.', {
        fix: 'A repository cannot outrank your own rules; add an important rule globally instead.',
      })
    }
    let file = this.globalPath
    let lock = this.ctx.layout.rulesLock
    let trustedBefore = false
    const st = await store()
    if (scope === 'project') {
      const dir = this.projectDir(rctx)
      if (dir === undefined) {
        throw new SearchHoleError('invalid_argument', 'No project directory is known for a project rule.', {
          fix: 'Run the command inside the project, or use a global rule.',
        })
      }
      file = this.projectFile(dir)
      lock = join(this.ctx.roots.run, 'project-rules.lock')
      const before = this.project(dir, st)
      trustedBefore = before.trust === 'trusted'
    }
    const identity = {
      scope,
      match: parsed.canonical,
      action: input.action,
      weight,
      profiles: input.profile === undefined ? undefined : [input.profile],
      important: input.important === true,
    } as const
    const wantedId = ruleIdBase(identity)
    let existing: Rule | undefined
    const edit = await editRulesFile(file, lock, scope, (doc, current) => {
      existing = current?.rules.find((r) => r.id === wantedId)
      if (existing) return
      const body: Record<string, unknown> = { match: input.match.trim(), action: input.action }
      if (isWeighted(input.action)) body.weight = weight
      if (input.profile !== undefined) body.profile = input.profile
      if (input.important === true) body.important = true
      if (input.until !== undefined) body.until = input.until
      if (input.note !== undefined) body.note = input.note
      const node = doc.createNode(body)
      if (isMap(node)) (node as YAMLMap).flow = true
      rulesSeq(doc).add(node)
    })
    if (scope === 'project' && trustedBefore && st) {
      // ADR-0008: search-hole writing an already trusted file keeps it trusted.
      try {
        st.projectTrust.set(file, edit.after)
      } catch (e) {
        this.ctx.logger.warn({ err: e }, 'could not re-trust the project rules file')
      }
    }
    this.files.delete(file)
    const rule = existing ?? edit.loaded.rules.find((r) => r.id === wantedId)
    if (!rule) throw new SearchHoleError('internal', 'The rule was written but could not be read back.')
    return listingOf(rule)
  }

  private async addSession(
    input: AddRuleInput,
    parsed: ParsedMatch,
    weight: number,
    rctx: RequestCtx | undefined,
    store: () => Promise<Store | null>,
  ): Promise<RuleListing> {
    const session = rctx?.session
    if (!session) {
      throw new SearchHoleError('invalid_argument', 'A session rule needs a chat session.', {
        fix: 'Use a global rule with `until:` from the terminal.',
      })
    }
    if (session.source === 'fallback') {
      throw new SearchHoleError('invalid_argument', FALLBACK_SESSION_REFUSAL, {
        fix: 'Add a global rule with an `until:` date instead.',
      })
    }
    return this.writeSessionRule(session.key, input, parsed, weight, await store())
  }

  /** Stores one session rule (also used when approving a suggestion from another process). */
  writeSessionRule(
    sessionKey: string,
    input: AddRuleInput,
    parsed: ParsedMatch,
    weight: number,
    st: Store | null,
  ): RuleListing {
    if (!st) {
      throw new SearchHoleError(
        'store_unavailable',
        'Session rules need the search-hole database, which is unavailable.',
        {
          fix: 'Run `searchhole doctor`.',
        },
      )
    }
    const profiles = input.profile === undefined ? undefined : [input.profile]
    const important = input.important === true
    const id = ruleIdBase({
      scope: 'session',
      match: parsed.canonical,
      action: input.action,
      weight,
      profiles,
      important,
    })
    const rowId = sessionRowId(id, sessionKey)
    const body: Record<string, unknown> = {
      match: input.match.trim(),
      action: input.action,
      weight,
      important,
    }
    if (profiles) body.profiles = profiles
    if (input.until !== undefined) body.until = input.until
    if (input.note !== undefined) body.note = input.note
    const untilMs = input.until === undefined ? null : untilToMs(input.until)
    const ok = st.sessionRules.add({
      id: rowId,
      sessionId: sessionKey,
      rule: body,
      ...(untilMs === null ? {} : { until: untilMs }),
    })
    if (!ok) {
      throw new SearchHoleError(
        'store_unavailable',
        `Could not save the session rule: ${st.status().message}`,
        {
          fix: 'Run `searchhole doctor`.',
        },
      )
    }
    const rule = this.sessionRules(sessionKey, st).find((r) => r.id === id)
    if (!rule) throw new SearchHoleError('internal', 'The session rule was saved but could not be read back.')
    return listingOf(rule)
  }

  /**
   * Re-keys session rules (ADR-0005): `resume` and `compact` carry them to the new key,
   * `clear` drops the old session's rules, `startup` leaves them alone.
   */
  rekey(
    previousKey: string,
    nextKey: string,
    source: 'startup' | 'resume' | 'clear' | 'compact',
    st: Store | null,
  ): number {
    if (!st || previousKey === nextKey) return 0
    if (source === 'clear') {
      st.sessionRules.clear(previousKey)
      return 0
    }
    if (source === 'startup') return 0
    let moved = 0
    for (const row of st.sessionRules.list(previousKey)) {
      const ruleId = row.id.split('@')[0] ?? row.id
      const ok = st.sessionRules.add({
        id: sessionRowId(ruleId, nextKey),
        sessionId: nextKey,
        rule: row.rule,
        ...(row.until === null ? {} : { until: row.until }),
      })
      if (ok && st.sessionRules.remove(row.id)) moved++
    }
    return moved
  }

  /** Validates a match for a suggestion (never applies anything). */
  parse(match: string): ParsedMatch | null {
    const p = parseMatch(match)
    return p.ok ? p.match : null
  }

  /** Removes rules by id or match text from the given scope (default: every user scope). */
  async remove(
    idOrMatch: string,
    scope: 'session' | 'project' | 'global' | undefined,
    store: () => Promise<Store | null>,
  ): Promise<RuleListing[]> {
    const wanted = idOrMatch.trim()
    if (wanted === '') throw new SearchHoleError('invalid_argument', 'Name a rule id or match to remove.')
    const canonical = parseMatch(wanted)
    const matches = (r: Rule): boolean => {
      if (r.id === wanted || r.match.trim() === wanted) return true
      const own = parseMatch(r.match)
      return canonical.ok && own.ok && own.match.canonical === canonical.match.canonical
    }
    const st = await store()
    const removed: RuleListing[] = []
    if (scope === undefined || scope === 'session') {
      let rows: ReturnType<Store['sessionRules']['list']> = []
      try {
        rows = st?.sessionRules.list() ?? []
      } catch {
        rows = []
      }
      for (const row of rows) {
        const rule = this.sessionRules(row.sessionId, st).find((r) => r.source === `session:${row.id}`)
        if (rule && matches(rule) && st?.sessionRules.remove(row.id)) removed.push(listingOf(rule))
      }
    }
    const fromFile = async (
      file: string,
      fileScope: 'global' | 'project',
      lock: string,
    ): Promise<boolean> => {
      if (readTextIfExists(file) === undefined) return false
      let any = false
      await editRulesFile(file, lock, fileScope, (doc, current) => {
        const targets = (current?.rules ?? []).filter(matches)
        if (targets.length === 0) return
        const seq = doc.get('rules', true)
        if (!isSeq(seq)) return
        for (const r of [...targets].sort((a, b) => b.order - a.order)) {
          seq.delete(r.order)
          removed.push(listingOf(r))
          any = true
        }
      })
      this.files.delete(file)
      return any
    }
    if (scope === undefined || scope === 'project') {
      const dir = this.projectDir()
      if (dir !== undefined) {
        const before = this.project(dir, st)
        if (before.exists) {
          const file = this.projectFile(dir)
          const changed = await fromFile(file, 'project', join(this.ctx.roots.run, 'project-rules.lock'))
          if (changed && before.trust === 'trusted' && st) {
            const text = readTextIfExists(file)
            if (text !== undefined) st.projectTrust.set(file, sha256Hex(text))
          }
        }
      }
    }
    if (scope === undefined || scope === 'global')
      await fromFile(this.globalPath, 'global', this.ctx.layout.rulesLock)
    return removed
  }

  /** Approves a project's rules file by content hash (ADR-0008). */
  trust(projectDir: string, st: Store | null): { path: string; sha256: string } {
    const path = this.projectFile(projectDir)
    const text = readTextIfExists(path)
    if (text === undefined) {
      throw new SearchHoleError('invalid_argument', `There is no ${PROJECT_FILE} in ${projectDir}.`, {
        fix: 'Create the file first, or run the command in the project directory.',
      })
    }
    loadRulesYaml(text, { scope: 'project', file: path })
    if (!st) {
      throw new SearchHoleError(
        'store_unavailable',
        'Trust is recorded in the search-hole database, which is unavailable.',
        {
          fix: 'Run `searchhole doctor`.',
        },
      )
    }
    const sha256 = sha256Hex(text)
    if (!st.projectTrust.set(path, sha256)) {
      throw new SearchHoleError('store_unavailable', `Could not record trust: ${st.status().message}`, {
        fix: 'Run `searchhole doctor`.',
      })
    }
    return { path, sha256 }
  }

  /**
   * Every match for a URL plus the decision, as lines for `searchhole explain <url>`. A bare
   * site (`example.com`) is checked as `https://example.com`; anything that is not a site or
   * an http(s) URL is refused, never answered with "kept".
   */
  explain(
    rc: RuleContext,
    input: string,
    profile: string,
    now: number,
  ): { decision: string; lines: string[] } {
    const url = explainTarget(input)
    const decision: RuleDecision = rc.ruleSet.decide(url, { profile, now })
    const byId = new Map(rc.userRules.map((r) => [r.id, r]))
    const lines: string[] = [`url: ${url}`, `profile: ${profile}`]
    const infos = rc.ruleSet.explainAll(url, { profile, now })
    if (infos.length === 0) lines.push('no rule matches')
    for (const info of infos) {
      const rule = byId.get(info.ref.ruleId)
      const where = rule?.source ?? info.ref.listId ?? ''
      const skipped = info.skipped === undefined ? '' : ` (skipped: ${info.skipped})`
      const winner =
        decision.visibilityRule?.ruleId === info.ref.ruleId ||
        decision.pin?.rule.ruleId === info.ref.ruleId ||
        decision.weight.rule?.ruleId === info.ref.ruleId
          ? ' ← decides'
          : ''
      lines.push(`${info.ref.tier} ${info.ref.text}${where ? `  [${where}]` : ''}${skipped}${winner}`)
    }
    let verdict: string
    if (decision.visibility === 'hidden') {
      verdict = decision.visibilityRule
        ? `hidden by ${decision.visibilityRule.text}`
        : `hidden (${decision.hiddenReason ?? 'rule'})`
    } else if (decision.pin) verdict = `pinned by ${decision.pin.rule.text}`
    else if (decision.weight.rule)
      verdict = `kept, weighted ×${decision.weight.factor.toFixed(2)} by ${decision.weight.rule.text}`
    else verdict = 'kept'
    // The profile's lift for sources on a preferred list (official docs by default) is part of the ranking.
    if (decision.visibility !== 'hidden' && decision.preferFactor !== 1) {
      verdict += `, lifted ×${decision.preferFactor.toFixed(2)} because profile "${profile}" prefers this source`
    }
    lines.push(`→ ${verdict}`)
    const short = decision.visibility === 'hidden' ? 'hidden' : decision.pin ? 'pinned' : 'kept'
    return { decision: short, lines }
  }

  /** Text snapshot of a rule (for suggestions and listings). */
  text(rule: Rule): string {
    return ruleText(rule)
  }
}

/**
 * The URL `explain` checks. A bare site or path (`example.com/blog`) gets `https://`; the
 * input is refused when it is not a site or an http(s) URL.
 */
export function explainTarget(input: string): string {
  const text = input.trim()
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let parsed: URL | undefined
  try {
    parsed = new URL(candidate)
  } catch {
    parsed = undefined
  }
  const host = parsed?.hostname ?? ''
  const web = parsed?.protocol === 'http:' || parsed?.protocol === 'https:'
  const named = host.includes('.') || host === 'localhost' || host.startsWith('[')
  if (!web || !named || /\s/.test(text)) {
    throw new SearchHoleError('invalid_argument', `"${text}" is not a site or a URL.`, {
      fix: 'Give a site (example.com) or a full URL (https://example.com/page).',
    })
  }
  return candidate
}

/** Kind of a match expression, for listings that need it without compiling. */
export function matchKindOf(match: string): MatchKind | null {
  const p = parseMatch(match)
  return p.ok ? p.match.kind : null
}
