// SPDX-License-Identifier: Apache-2.0
/**
 * Shared contract between search-hole modules. Pure types only: no runtime code,
 * no I/O. Every name here is referenced by an ADR in docs/adr/.
 *
 * Stable string codes (decisions, reasons, flags, error classes) are persisted
 * in SQLite, so a code's meaning never changes and vocabularies only grow
 * (ADR-0006 point 12).
 */

// ── Engines ──────────────────────────────────────────────────────────────

export type EngineId = 'searxng' | 'brave' | 'tavily' | 'exa' | 'mojeek' | 'kagi' | 'marginalia'

/** Every EngineId, in default display order. */
export const ENGINE_ID_LIST = [
  'searxng',
  'brave',
  'tavily',
  'exa',
  'mojeek',
  'kagi',
  'marginalia',
] as const satisfies readonly EngineId[]

export type Depth = 'quick' | 'standard' | 'deep'

/** ADR-0009 error classes. Order is irrelevant; codes are persisted. */
export type ErrorClass =
  | 'offline'
  | 'unreachable'
  | 'timeout'
  | 'rate_limited'
  | 'quota'
  | 'auth'
  | 'forbidden'
  | 'json_disabled'
  | 'captcha'
  | 'server'
  | 'malformed'
  | 'bad_request'
  | 'cancelled'

export type InactiveReason =
  | 'missing_key'
  | 'no_endpoint'
  | 'disabled'
  | 'spend_cap'
  | 'suspended'
  | 'json_disabled'
  | 'unhealthy'

export type HealthState = 'healthy' | 'unhealthy' | 'unknown'

export interface EngineCapabilities {
  domainInclude: { max: number } | null
  domainExclude: { max: number } | null
  dateFilter: 'none' | 'range' | { buckets: ReadonlyArray<'day' | 'week' | 'month' | 'year'> }
  goggles: boolean
  dates: 'none' | 'published' | 'modified' | 'estimated' | 'mixed'
  maxPerCall: number
  paging: boolean
  requiresKey: boolean
  endpoint: 'fixed' | 'user'
  officialApi: boolean
  billed: boolean
  attribution: string | null
}

export interface EngineRetention {
  /** full: everything; metadata: payload with TTL; decisions-only: URL hash, domain, rank, decision, dates. */
  log: 'full' | 'metadata' | 'decisions-only'
  payloadTtlHours: number | null
}

export interface RetryPolicy {
  sameEngineRetries: number
  backoffMs: number
}

export interface EngineDefaults {
  timeoutMs: number
  concurrency: number
  overFetch: number
  retry: RetryPolicy
}

/** What the planner asks one engine for. Built by the core, consumed by adapters. */
export interface EnginePlan {
  query: string
  /** Results wanted from this engine after over-fetch, capped at maxPerCall. */
  count: number
  depth: Depth
  language: string
  safesearch: 0 | 1 | 2
  /** Inclusive lower bound for freshness pushdown, only set when the profile requires dates (ADR-0009 point 8). */
  sinceDate?: string
  includeDomains: readonly string[]
  excludeDomains: readonly string[]
  /** Hosts whose `block` rules are safe to push down (ADR-0009 point 8). Empty when pushdown is off. */
  pushdownBlockHosts: readonly string[]
  /** SearXNG only: explicit upstream engine names, validated against /config. */
  upstreamEngines?: readonly string[]
}

export interface AdapterCtx {
  endpoint: string | null
  apiKey: string | null
  timeoutMs: number
}

export interface HttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Readonly<Record<string, string>>
  body?: string
}

export interface HttpResponse {
  status: number
  /** Lower-cased header names. */
  headers: Readonly<Record<string, string>>
  text: string
  durationMs: number
}

export interface UpstreamDiag {
  /** e.g. a SearXNG upstream engine name. */
  name: string
  errorClass: ErrorClass | 'unknown'
  message: string
  suspended: boolean
}

export interface QuotaInfo {
  remaining?: number
  limit?: number
  resetAt?: string
}

export type ParseOutcome =
  | {
      kind: 'ok'
      results: RawResult[]
      upstream?: UpstreamDiag[]
      quota?: QuotaInfo
      alteredQuery?: string
      pushdownApplied?: boolean
    }
  | { kind: 'empty'; upstream?: UpstreamDiag[]; quota?: QuotaInfo }
  | { kind: 'error'; errorClass: ErrorClass; retryAfterMs?: number; detail: string }

export interface EngineAdapter {
  readonly id: EngineId
  readonly displayName: string
  readonly capabilities: EngineCapabilities
  readonly retention: EngineRetention
  readonly defaults: EngineDefaults
  /** Synchronous validation; never throws. */
  setup(ctx: AdapterCtx): { active: true } | { active: false; reason: InactiveReason; detail: string }
  /** Pure. */
  buildRequest(plan: EnginePlan, ctx: AdapterCtx): HttpRequest
  /** Pure; never throws. */
  parseResponse(res: HttpResponse, plan: EnginePlan, ctx: AdapterCtx): ParseOutcome
  /** Number of block rules this request pushes to the engine (ADR-0009 point 8). */
  pushedRuleCount?(plan: EnginePlan): number
}

// ── Results, dates, decisions ────────────────────────────────────────────

export type DateKind = 'published' | 'modified' | 'crawled' | 'existed_by'
export type Confidence = 'high' | 'medium' | 'low'

/** ADR-0011. */
export interface FoundDate {
  /** ISO 8601, UTC. */
  value: string
  kind: DateKind
  /** e.g. 'engine:brave.page_age', 'jsonld:datePublished', 'http:last-modified'. */
  method: string
  confidence: Confidence
  tzAssumed: boolean
}

/** One engine's result, exactly as ranked by that engine (1-based raw rank). */
export interface RawResult {
  engine: EngineId
  rank: number
  url: string
  title: string
  snippet: string
  dates: FoundDate[]
  /** SearXNG: upstream engines that returned it. */
  via?: string[]
}

export type SourceType =
  | 'official'
  | 'docs'
  | 'forum'
  | 'news'
  | 'blog'
  | 'repo'
  | 'reference'
  | 'content_farm'
  | 'unknown'

export type Visibility = 'kept' | 'hidden'

/** Why a result was hidden. Persisted codes. */
export type HiddenReason = 'rule' | 'list' | 'stale' | 'date_required' | 'allowlist_mode'

/** Persisted flag codes shown next to kept results. */
export type ResultFlag =
  | 'stale'
  | 'date_unknown'
  | 'updated'
  | 'pinned'
  | 'raised'
  | 'lowered'
  | 'coverage'
  | 'would_hide'
  | 'would_show'

export type Tier = 'T0s' | 'T0g' | 'T1' | 'T2' | 'T3' | 'T4'

export interface RuleRef {
  ruleId: string
  tier: Tier
  /** Set when the rule came from a subscribed or bundled list. */
  listId?: string
  /** Snapshot of the rule's source text, so explanations survive rule deletion. */
  text: string
  /** Where the rule was defined, e.g. 'rules.yaml:12'. */
  source?: string
}

/** Outcome of evaluating rules for one original URL (ADR-0008 three passes). */
export interface RuleDecision {
  visibility: Visibility
  /** Winning visibility rule, if any rule decided. */
  visibilityRule?: RuleRef
  hiddenReason?: Extract<HiddenReason, 'rule' | 'list' | 'allowlist_mode'>
  pin?: { rule: RuleRef; order: number }
  /** Multiplicative factor from pass 3 (1 = no change). */
  weight: { factor: number; rule?: RuleRef }
  /** Profile `prefer` multiplier (applied after the tier decision). */
  preferFactor: number
  /** Audit-mode difference (ADR-0008 Lists). */
  audit?: { wouldBe: Visibility; rule: RuleRef }
  /** All matching rules, for --explain. */
  matches: RuleRef[]
}

/** A deduplicated, fused result ready for output (ADR-0010). */
export interface MergedResult {
  canonicalKey: string
  /** Preferred display URL (https preferred). */
  url: string
  urls: string[]
  title: string
  snippet: string
  engines: EngineId[]
  /** Minimum raw rank per engine across the group. */
  positions: Partial<Record<EngineId, number>>
  dates: FoundDate[]
  effectiveDate?: FoundDate
  sourceType: SourceType
  registrableDomain: string
  fused: number
  adjusted: number
  decision: RuleDecision
  flags: ResultFlag[]
  keptReason?: 'coverage'
  /** Why it was hidden, for results in SearchOutcome.hidden (covers stale/date_required too). */
  hiddenReason?: HiddenReason
  /** Per-engine payloads, so the store can apply each engine's retention (ADR-0009 point 9). */
  hits?: Array<Pick<RawResult, 'engine' | 'url' | 'title' | 'snippet' | 'rank'>>
}

// ── Rules (ADR-0008) ─────────────────────────────────────────────────────

export type RuleAction = 'block' | 'allow' | 'pin' | 'raise' | 'lower' | 'normal'
export type RuleScope = 'session' | 'project' | 'global' | 'list'
export type MatchKind = 'domain' | 'exact_host' | 'host_path' | 'url_pattern' | 'regex'

export interface Rule {
  id: string
  scope: RuleScope
  /** Source text of the match expression, as written. */
  match: string
  matchKind: MatchKind
  action: RuleAction
  /** 1–10 for raise/lower, otherwise 1. */
  weight: number
  profiles?: string[]
  important: boolean
  /** ISO date; the rule stops applying after it. */
  until?: string
  note?: string
  /** e.g. 'suggestion:42' (provenance). */
  source?: string
  /** Original source line (e.g. ABP syntax) for explanations. */
  text?: string
  /** List rules only. */
  listId?: string
  /** ABP `$important` inside the list tier. */
  listImportant?: boolean
  /** Order within its file or list (session tier: by created_at, id). */
  order: number
}

export type ListKind = 'block' | 'allow' | 'official' | 'content-farm' | 'clone'
export type ListMode = 'enforce' | 'audit' | 'disabled'

export interface Freshness {
  maxAgeDays?: number
  requireDate?: boolean
  basis?: 'published' | 'modified' | 'newest'
}

export interface Profile {
  name: string
  match?: { keywords?: string[]; regex?: string[] }
  engines?: EngineId[]
  depth?: Depth
  freshness?: Freshness
  prefer?: { lists?: string[]; factor?: number }
  /** Allowlist mode (imported generic Goggles $discard). */
  defaultAction?: 'keep' | 'block'
}

// ── Search outcome (what the gateway and CLI render) ─────────────────────

export interface EngineRun {
  engine: EngineId
  status: 'ok' | 'empty' | 'error' | 'skipped'
  latencyMs?: number
  errorClass?: ErrorClass
  inactiveReason?: InactiveReason
  detail?: string
  returned: number
  upstream?: UpstreamDiag[]
  pushedRuleCount?: number
  attribution?: string
}

export interface HiddenSummary {
  count: number
  byReason: Partial<Record<HiddenReason, number>>
  topDomains: string[]
}

export type Warning =
  | { code: 'no_official_source' }
  | { code: 'single_source' }
  | { code: 'all_stale' }
  | { code: 'coverage_skipped' }
  | { code: 'receipt_expired'; previous: string }
  | { code: 'engine_fallback'; from: EngineId; to: EngineId }
  | { code: 'spend_cap_local'; engine: EngineId }
  | { code: 'logging_unavailable'; detail: string }
  | { code: 'list_compiling'; listId: string }
  /** Query hygiene removed something before the query was sent (ADR-0015 point 4). */
  | { code: 'query_redacted'; classes: string[] }

export interface FallbackHop {
  from: EngineId
  to: EngineId
  errorClass: ErrorClass | InactiveReason
}

export interface SearchOutcome {
  receiptId: string
  /** Resolved session key (ADR-0005), if any. */
  sessionId?: string
  /** Claude Code `claudecode/toolUseId` for transcript correlation (ADR-0012). */
  toolUseId?: string
  /** Rule ids pushed to engines; their hits are not observable (ADR-0009 point 8). */
  pushedRuleIds?: string[]
  fallbackTrail?: FallbackHop[]
  /** Engine-side spelling correction (e.g. Brave query.altered). */
  alteredQuery?: string
  query: string
  profile: string
  depth: Depth
  results: MergedResult[]
  hidden: MergedResult[]
  hiddenSummary: HiddenSummary
  engines: EngineRun[]
  warnings: Warning[]
  tookMs: number
}
