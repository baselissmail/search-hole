// SPDX-License-Identifier: Apache-2.0
/**
 * The rules engine (ADR-0008 "Precedence: three passes per result").
 *
 * Tiers, walked in this order:
 *
 * | Tier | Contents                                               |
 * |------|--------------------------------------------------------|
 * | T0s  | session rules with `important: true`                   |
 * | T0g  | global rules with `important: true`                    |
 * | T1   | session rules (order = `(created_at, id)`)             |
 * | T2   | project rules (`important` is never allowed here)     |
 * | T3   | global rules                                           |
 * | T4   | lists in `enforce` mode (audit lists resolved separately) |
 *
 * 1. Visibility (`allow`, `block`, `pin`): the first tier with a matching rule
 *    decides. User tiers: allow > block > pin. T4 (ABP semantics): important
 *    allow > `$important` block > allow > block > pin, independent of list order.
 * 2. Pin: a kept result is pinned by the first matching user-tier `pin`
 *    (tier order, then file order). Lists never pin.
 * 3. Weight (`raise`, `lower`, `normal`): the first tier with a match decides.
 *    User tiers: most specific match wins (see `specificity`). T4: commutative
 *    Goggles semantics: the largest raise wins, else `normal`, else the weakest lower.
 *
 * Rules whose `profiles` exclude the active profile, and rules past `until`,
 * are skipped in every pass. Lists of kind `official` only annotate membership
 * (source typing and profile `prefer`); they never hide or weight.
 */
import type {
  ListKind,
  ListMode,
  Profile,
  Rule,
  RuleAction,
  RuleDecision,
  RuleRef,
  Tier,
  Visibility,
} from '../../shared/types.ts'
import { isWeighted, ruleText } from './ids.ts'
import { type ParsedMatch, parseMatch, pathHasPrefix, specificity, testMatch } from './match.ts'
import { type NormalizedUrl, normalizeUrl } from './normalize.ts'
import { PatternIndex, type PrefilterStats } from './prefilter.ts'
import { untilToMs } from './time.ts'

/** One compiled list as the engine consumes it (ADR-0008 Lists). */
export interface ListInput {
  id: string
  kind: ListKind
  mode: ListMode
  rules: readonly Rule[]
  /** `$badfilter` cancel set: rules that cancel the identical rule in every list. */
  cancel?: readonly CancelEntry[]
}

/** A `$badfilter` entry: the rule it cancels, without the `$badfilter` option. */
export interface CancelEntry {
  match: string
  action: RuleAction
  listImportant?: boolean
}

/** Everything the engine needs to decide; build once per rule change, reuse per search. */
export interface RuleSetInput {
  /** User rules with scope `session`, `project` or `global`. */
  rules?: readonly Rule[]
  lists?: readonly ListInput[]
  /** Effective profiles (see `resolveProfiles`), used for allowlist mode and `prefer`. */
  profiles?: readonly Profile[]
}

export interface DecideOptions {
  /** Active profile name. */
  profile: string
  /** Epoch ms, for `until`. */
  now: number
}

export type CompileIssueCode =
  | 'invalid_match'
  | 'invalid_until'
  | 'invalid_weight'
  | 'project_important_ignored'
  | 'list_rule_in_user_rules'
  | 'duplicate_list'
  | 'invalid_cancel'

/** A rule the engine skipped (lists are permissive; user files were validated by the loader). */
export interface CompileIssue {
  code: CompileIssueCode
  message: string
  ruleId?: string
  listId?: string
}

/** One matching rule, for `--explain` and `searchhole explain <url>`. */
export interface RuleMatchInfo {
  ref: RuleRef
  action: RuleAction
  weight: number
  /** Why this rule does not take part in the enforced decision; absent when it does. */
  skipped?: 'expired' | 'profile' | 'cancelled' | 'audit_list'
  /** Entry of an `official` list: annotates membership and feeds `prefer`, never hides or weights. */
  annotationOnly?: true
}

export interface CompiledRuleSet {
  /** Decides visibility, pin, weight and prefer for one original result URL. */
  decide(url: string, opts: DecideOptions): RuleDecision
  /** Every rule whose expression matches `url`, with the reason it is skipped, if any. */
  explainAll(url: string, opts?: Partial<DecideOptions>): RuleMatchInfo[]
  /** Ids of enforce-mode lists `url` belongs to (sorted), for source typing and `prefer`. */
  listMemberships(url: string, opts: DecideOptions): string[]
  /** Rules that could not be compiled and were skipped. */
  readonly issues: readonly CompileIssue[]
  readonly size: { user: number; list: number }
  /** How the URL-pattern and regex rules were bucketed by the prefilter (host / gram / linear rest). */
  readonly prefilter: PrefilterStats
}

/** Default profile `prefer` multiplier: the same as `raise 3` (ADR-0008, ADR-0010). */
export const DEFAULT_PREFER_FACTOR = 1.45

/** ADR-0010 point 4: `raise N` → ×(1 + 0.15·N), `lower N` → ÷(1 + 0.15·N), `normal` → ×1. */
export function weightFactor(action: RuleAction, weight: number): number {
  if (action === 'raise') return 1 + 0.15 * weight
  if (action === 'lower') return 1 / (1 + 0.15 * weight)
  return 1
}

const TIERS: readonly Tier[] = ['T0s', 'T0g', 'T1', 'T2', 'T3', 'T4']
const LIST_TIER = 5

interface Entry {
  rule: Rule
  tier: number
  ref: RuleRef
  match: ParsedMatch
  spec: readonly [number, number, number]
  /** Epoch ms from which the rule stops applying; null = never. */
  expiresAt: number | null
  profiles: ReadonlySet<string> | null
  listMode?: ListMode
  annotation: boolean
  cancelKey?: string
  /** Deterministic order: tier, list id, file order, rule id. */
  seq: number
  /** Index among user `pin` rules, or -1. */
  pinOrder: number
}

/** Code-unit string comparison: locale-independent, so ordering is the same on every machine. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const isVisibilityAction = (a: RuleAction): boolean => a === 'allow' || a === 'block' || a === 'pin'
const isWeightAction = (a: RuleAction): boolean => a === 'raise' || a === 'lower' || a === 'normal'

/** `$badfilter` key: one flag character, the action, a space, then the canonical match (unambiguous). */
const cancelKeyOf = (canonical: string, action: RuleAction, listImportant: boolean): string =>
  `${listImportant ? '1' : '0'}${action} ${canonical}`

function userTier(rule: Rule): { tier: number; ignoredImportant: boolean } {
  switch (rule.scope) {
    case 'session':
      return { tier: rule.important ? 0 : 2, ignoredImportant: false }
    case 'global':
      return { tier: rule.important ? 1 : 4, ignoredImportant: false }
    case 'project':
      return { tier: 3, ignoredImportant: rule.important }
    case 'list':
      return { tier: -1, ignoredImportant: false }
  }
}

/**
 * Host-label hash maps (exact host, domain suffix, host + path prefix) plus a
 * prefiltered pattern index for URL patterns and regex (ADR-0008 "Compiled
 * matcher"; see `prefilter.ts`). Lookups cost O(labels) for host rules and touch
 * only the pattern entries whose required host or literal occurs in the URL.
 */
class MatchIndex {
  private readonly domain = new Map<string, Entry[]>()
  private readonly exact = new Map<string, Entry[]>()
  private readonly hostPath = new Map<string, Entry[]>()
  private readonly patterns = new PatternIndex<Entry>()

  get patternStats(): PrefilterStats {
    return this.patterns.stats
  }

  add(e: Entry): void {
    const m = e.match
    const put = (map: Map<string, Entry[]>, key: string): void => {
      const list = map.get(key)
      if (list) list.push(e)
      else map.set(key, [e])
    }
    if (m.kind === 'domain') put(this.domain, m.host)
    else if (m.kind === 'exact_host') put(this.exact, m.host)
    else if (m.kind === 'host_path') put(this.hostPath, m.host)
    else this.patterns.add(e)
  }

  /** All entries whose expression matches, sorted by `seq`. */
  lookup(url: NormalizedUrl): Entry[] {
    const out: Entry[] = []
    const host = url.host
    for (const e of this.exact.get(host) ?? []) out.push(e)
    let suffix: string | null = host
    while (suffix !== null) {
      for (const e of this.domain.get(suffix) ?? []) out.push(e)
      for (const e of this.hostPath.get(suffix) ?? []) {
        const m = e.match
        if (m.kind !== 'host_path') continue
        if (m.exactHost && suffix !== host) continue
        if (pathHasPrefix(url.pathQuery, m.path)) out.push(e)
      }
      if (url.ip) break
      const dot = suffix.indexOf('.')
      suffix = dot === -1 ? null : suffix.slice(dot + 1)
    }
    if (this.patterns.size > 0) {
      const lower = url.href.toLowerCase()
      this.patterns.collect(url, lower, (e) => testMatch(e.match, url, lower), out)
    }
    return out.sort((a, b) => a.seq - b.seq)
  }
}

interface VisibilityOutcome {
  visibility: Visibility
  entry?: Entry
  hiddenReason?: 'rule' | 'list' | 'allowlist_mode'
}

/** User-tier visibility rank: allow > block > pin. */
const userVisibilityRank = (r: Rule): number => (r.action === 'allow' ? 2 : r.action === 'block' ? 1 : 0)

/** T4 visibility rank (ABP/AdGuard): important allow > important block > allow > block > pin. */
function listVisibilityRank(r: Rule): number {
  const imp = r.listImportant === true
  if (r.action === 'allow') return imp ? 4 : 2
  if (r.action === 'block') return imp ? 3 : 1
  return 0
}

/** T4 weight strength: the largest wins (any raise > normal > the weakest lower). */
const listWeightStrength = (r: Rule): number =>
  r.action === 'raise' ? r.weight : r.action === 'lower' ? -r.weight : 0

const compareSpec = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < a.length; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function resolveVisibility(entries: readonly Entry[], defaultAction: 'keep' | 'block'): VisibilityOutcome {
  for (let t = 0; t <= LIST_TIER; t++) {
    let best: Entry | undefined
    for (const e of entries) {
      if (e.tier !== t || e.annotation || !isVisibilityAction(e.rule.action)) continue
      if (!best) {
        best = e
        continue
      }
      if (t < LIST_TIER) {
        if (userVisibilityRank(e.rule) > userVisibilityRank(best.rule)) best = e
      } else if (listVisibilityRank(e.rule) > listVisibilityRank(best.rule)) best = e
    }
    if (best) {
      return {
        visibility: best.rule.action === 'block' ? 'hidden' : 'kept',
        entry: best,
        ...(best.rule.action === 'block' && { hiddenReason: t < LIST_TIER ? 'rule' : 'list' }),
      }
    }
  }
  return defaultAction === 'block'
    ? { visibility: 'hidden', hiddenReason: 'allowlist_mode' }
    : { visibility: 'kept' }
}

function resolveWeight(entries: readonly Entry[]): Entry | undefined {
  for (let t = 0; t <= LIST_TIER; t++) {
    let best: Entry | undefined
    for (const e of entries) {
      if (e.tier !== t || e.annotation || !isWeightAction(e.rule.action)) continue
      if (!best) best = e
      else if (
        t < LIST_TIER
          ? compareSpec(e.spec, best.spec) < 0
          : listWeightStrength(e.rule) > listWeightStrength(best.rule)
      )
        best = e
    }
    if (best) return best
  }
  return undefined
}

/**
 * Compiles user rules and lists into a reusable rule set. Never throws: rules
 * that cannot be compiled are skipped and reported in `issues` (user files are
 * validated strictly by the YAML loader before they get here).
 */
export function compileRuleSet(input: RuleSetInput): CompiledRuleSet {
  const issues: CompileIssue[] = []
  const entries: Entry[] = []
  const profiles = new Map<string, Profile>()
  for (const p of input.profiles ?? []) if (!profiles.has(p.name)) profiles.set(p.name, p)

  const build = (rule: Rule, tier: number, list?: ListInput): Entry | null => {
    const where = { ruleId: rule.id, ...(list && { listId: list.id }) }
    const parsed = parseMatch(rule.match, rule.matchKind)
    if (!parsed.ok) {
      issues.push({ code: 'invalid_match', message: parsed.error, ...where })
      return null
    }
    let expiresAt: number | null = null
    if (rule.until !== undefined) {
      expiresAt = untilToMs(rule.until)
      if (expiresAt === null) {
        issues.push({ code: 'invalid_until', message: `invalid until '${rule.until}'`, ...where })
        return null
      }
    }
    if (
      isWeighted(rule.action) &&
      !(Number.isInteger(rule.weight) && rule.weight >= 1 && rule.weight <= 10)
    ) {
      issues.push({ code: 'invalid_weight', message: `weight must be an integer 1–10`, ...where })
      return null
    }
    const ref: RuleRef = { ruleId: rule.id, tier: TIERS[tier] ?? 'T4', text: ruleText(rule) }
    if (list) ref.listId = list.id
    const e: Entry = {
      rule,
      tier,
      ref: Object.freeze(ref),
      match: parsed.match,
      spec: specificity(parsed.match),
      expiresAt,
      profiles: rule.profiles && rule.profiles.length > 0 ? new Set(rule.profiles) : null,
      annotation: list?.kind === 'official',
      seq: 0,
      pinOrder: -1,
    }
    if (list) {
      e.listMode = list.mode
      e.cancelKey = cancelKeyOf(parsed.match.canonical, rule.action, rule.listImportant === true)
    }
    return e
  }

  let userCount = 0
  for (const rule of input.rules ?? []) {
    const { tier, ignoredImportant } = userTier(rule)
    if (tier < 0) {
      issues.push({
        code: 'list_rule_in_user_rules',
        message: 'list rules belong in a ListInput',
        ruleId: rule.id,
      })
      continue
    }
    if (ignoredImportant) {
      issues.push({
        code: 'project_important_ignored',
        message: 'important is not allowed in project rules; treated as a normal project rule',
        ruleId: rule.id,
      })
    }
    const e = build(rule, tier)
    if (e) {
      entries.push(e)
      userCount++
    }
  }

  const enforceCancel = new Set<string>()
  const auditCancel = new Set<string>()
  const seenLists = new Set<string>()
  let listCount = 0
  let hasAudit = false
  for (const list of input.lists ?? []) {
    if (list.mode === 'disabled') continue
    if (seenLists.has(list.id)) {
      issues.push({
        code: 'duplicate_list',
        message: `list '${list.id}' given twice; later copy ignored`,
        listId: list.id,
      })
      continue
    }
    seenLists.add(list.id)
    if (list.mode === 'audit') hasAudit = true
    for (const c of list.cancel ?? []) {
      const parsed = parseMatch(c.match)
      if (!parsed.ok) {
        issues.push({ code: 'invalid_cancel', message: parsed.error, listId: list.id })
        continue
      }
      const key = cancelKeyOf(parsed.match.canonical, c.action, c.listImportant === true)
      auditCancel.add(key)
      if (list.mode === 'enforce') enforceCancel.add(key)
    }
    for (const rule of list.rules) {
      const e = build(rule, LIST_TIER, list)
      if (e) {
        entries.push(e)
        listCount++
      }
    }
  }

  entries.sort(
    (a, b) =>
      a.tier - b.tier ||
      cmp(a.ref.listId ?? '', b.ref.listId ?? '') ||
      a.rule.order - b.rule.order ||
      cmp(a.rule.id, b.rule.id),
  )
  let pins = 0
  const index = new MatchIndex()
  entries.forEach((e, i) => {
    e.seq = i
    if (e.tier < LIST_TIER && e.rule.action === 'pin') e.pinOrder = pins++
    index.add(e)
  })

  const applies = (e: Entry, opts: DecideOptions): boolean =>
    (e.expiresAt === null || opts.now < e.expiresAt) && (e.profiles === null || e.profiles.has(opts.profile))
  const inEnforced = (e: Entry): boolean =>
    e.tier < LIST_TIER || (e.listMode === 'enforce' && !enforceCancel.has(e.cancelKey ?? ''))
  const inAudit = (e: Entry): boolean =>
    e.tier < LIST_TIER || (e.listMode !== 'disabled' && !auditCancel.has(e.cancelKey ?? ''))

  const lookup = (url: string): Entry[] => {
    const n = normalizeUrl(url)
    return n ? index.lookup(n) : []
  }

  const memberships = (enforced: readonly Entry[]): string[] => {
    const ids = new Set<string>()
    for (const e of enforced) if (e.tier === LIST_TIER && e.ref.listId !== undefined) ids.add(e.ref.listId)
    return [...ids].sort()
  }

  return {
    issues,
    size: { user: userCount, list: listCount },
    prefilter: index.patternStats,

    decide(url, opts) {
      const active = lookup(url).filter((e) => applies(e, opts))
      const enforced = active.filter(inEnforced)
      const profile = profiles.get(opts.profile)
      const defaultAction = profile?.defaultAction ?? 'keep'

      const vis = resolveVisibility(enforced, defaultAction)
      const decision: RuleDecision = {
        visibility: vis.visibility,
        weight: { factor: 1 },
        preferFactor: 1,
        matches: enforced.map((e) => e.ref),
      }
      if (vis.entry) decision.visibilityRule = vis.entry.ref
      if (vis.hiddenReason) decision.hiddenReason = vis.hiddenReason

      if (vis.visibility === 'kept') {
        const pin = enforced.find((e) => e.pinOrder >= 0)
        if (pin) decision.pin = { rule: pin.ref, order: pin.pinOrder }
      }

      const w = resolveWeight(enforced)
      if (w) decision.weight = { factor: weightFactor(w.rule.action, w.rule.weight), rule: w.ref }

      const prefer = profile?.prefer
      if (prefer?.lists && prefer.lists.length > 0) {
        const member = new Set(memberships(enforced))
        if (prefer.lists.some((id) => member.has(id)))
          decision.preferFactor = prefer.factor ?? DEFAULT_PREFER_FACTOR
      }

      if (hasAudit) {
        const audit = resolveVisibility(active.filter(inAudit), defaultAction)
        const rule = audit.entry ?? vis.entry
        if (audit.visibility !== vis.visibility && rule) {
          decision.audit = { wouldBe: audit.visibility, rule: rule.ref }
        }
      }
      return decision
    },

    explainAll(url, opts = {}) {
      return lookup(url).map((e) => {
        const info: RuleMatchInfo = { ref: e.ref, action: e.rule.action, weight: e.rule.weight }
        if (opts.now !== undefined && e.expiresAt !== null && opts.now >= e.expiresAt)
          info.skipped = 'expired'
        else if (opts.profile !== undefined && e.profiles !== null && !e.profiles.has(opts.profile))
          info.skipped = 'profile'
        else if (e.tier === LIST_TIER && e.listMode === 'audit') info.skipped = 'audit_list'
        else if (e.tier === LIST_TIER && enforceCancel.has(e.cancelKey ?? '')) info.skipped = 'cancelled'
        if (e.annotation) info.annotationOnly = true
        return info
      })
    },

    listMemberships(url, opts) {
      return memberships(lookup(url).filter((e) => applies(e, opts) && inEnforced(e)))
    },
  }
}
