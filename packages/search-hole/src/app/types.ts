// SPDX-License-Identifier: Apache-2.0
/**
 * The application facade: the one interface the CLI and the MCP gateway call.
 * `src/app/` implements it by wiring the P1 modules (rules, merge, engines,
 * fan-out, store, fetch, settings, keys, hygiene). Callers never import those
 * modules directly for search behaviour.
 *
 * Additive changes only: the CLI and gateway are built against this file.
 */
import type { PageFetcherConfig, PageFetchResult } from '../fetch/fetchPage.ts'
import type { ListFetcher } from '../fetch/list.ts'
import type { ListErrorCode, ListSource } from '../lists/registry.ts'
import type { ListFormat } from '../lists/yaml.ts'
import type { RunCommand, SecretStore } from '../shared/keys/types.ts'
import type {
  Depth,
  EngineId,
  ErrorClass,
  FoundDate,
  HealthState,
  HiddenReason,
  InactiveReason,
  ListKind,
  ListMode,
  RuleAction,
  RuleRef,
  SearchOutcome,
  SourceType,
} from '../shared/types.ts'

export type { ListErrorCode, ListFormat, ListKind, ListMode, ListSource }

/** Which host launched this process (ADR-0012 host profiles). `cli` = the terminal. */
export type HostProfile =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'codex'
  | 'vscode'
  | 'goose'
  | 'zed'
  | 'generic'
  | 'cli'

/** Claude Code search mode (ADR-0018). */
export type SearchMode = 'auto' | 'builtin' | 'engines'

export interface AppOptions {
  host: HostProfile
  /** search-hole version (also used for store compatibility, ADR-0006). */
  version: string
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  now?: () => number
  /** Test and embedding seams; production callers omit them. */
  seams?: AppSeams
}

/**
 * Replaceable dependencies of the app (additive). Production code passes none of these: the
 * defaults are the OS key store, the public-web SSRF guard and real child processes.
 */
export interface AppSeams {
  /** Key stores: `write` for `keys.set/remove`, `read` for resolution (default: OS store + insecure file). */
  keyStores?: { write: SecretStore; read: readonly SecretStore[] }
  /** Page-fetcher configuration (tests pass a loopback-allowing guard policy). */
  pageFetcher?: PageFetcherConfig
  /** Runs `docker info` for `doctor` (default: a real child process without a shell). */
  runCommand?: RunCommand
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Defaults to `os.homedir()`. */
  homedir?: string
  /** Store busy timeout in ms (default 100 for gateways, 5000 for the CLI, ADR-0003). */
  storeBusyTimeoutMs?: number
  /** Downloads list subscriptions (default: HTTPS-only, public hosts only; tests reach a local server). */
  listFetcher?: ListFetcher
  /** Where the shipped starter lists are looked up (default: next to the bundle, or `lists/vendor/`). */
  listVendorDirs?: readonly string[]
  /** Delay before a gateway's background list refresh starts, in ms (default 2000). */
  listRefreshDelayMs?: number
}

/** Per-request context resolved by the caller (gateway: from hooks/_meta/env, ADR-0005; CLI: fixed). */
export interface RequestCtx {
  session?: { key: string; source: 'hook' | 'meta' | 'env' | 'fallback' }
  projectDir?: string
  client?: { name: string; version?: string }
  protocolEra?: 'modern' | 'legacy'
  toolUseId?: string
  signal?: AbortSignal
}

export interface SearchArgs {
  query: string
  depth?: Depth
  profile?: string
  engines?: EngineId[]
  /** Can only tighten the profile's freshness (ADR-0012). */
  maxAgeDays?: number
  limit?: number
  receiptId?: string
}

export interface FetchArgs {
  url: string
  cursor?: string
  maxTokens?: number
  receiptId?: string
}

/** A fetch result, or a refusal explained with the deciding rule. */
export type FetchOutcome =
  | ({ kind: 'page'; receiptId: string } & PageFetchResult)
  | {
      kind: 'refused'
      receiptId: string
      reason: 'rule' | 'ssrf' | 'robots' | 'unsupported' | 'error'
      message: string
      rule?: RuleRef
    }

export interface EngineStatus {
  engine: EngineId
  configured: boolean
  active: boolean
  inactiveReason?: InactiveReason
  health: HealthState
  lastError?: ErrorClass
  /** Where the key came from, never the key (ADR-0007). */
  keySource?: string
  suspendedUntil?: string
  attribution?: string
  /** Doctor only: false when the engine's endpoint did not answer (e.g. SearXNG not running). */
  reachable?: boolean
}

/** One built-in WebSearch result as Claude Code returns it (spikes §6). */
export interface BuiltinResult {
  title: string
  url: string
}

export interface BuiltinFilterResult {
  receiptId: string
  kept: BuiltinResult[]
  hidden: Array<BuiltinResult & { reason: HiddenReason; rule?: RuleRef }>
  /** True when results were removed that the upstream `blocked_domains` didn't already exclude. */
  removedPostSearch: boolean
  pinned: number
}

export interface ReceiptSearchLine {
  query: string
  at: string
  mode: 'engines' | 'builtin'
  engines: EngineId[]
  kept: number
  hidden: number
  hiddenByReason: Partial<Record<HiddenReason, number>>
}

export interface ReceiptSource {
  url: string
  title?: string
  status?: number
  dates: FoundDate[]
  sourceType: SourceType
  freshness: 'fresh' | 'stale' | 'unknown'
}

export interface Receipt {
  receiptId: string
  sessionKey?: string
  startedAt: string
  closedAt?: string
  searches: ReceiptSearchLine[]
  /** Sources the model opened (fetch / WebFetch). Never "cited" (§7). */
  sources: ReceiptSource[]
  warnings: string[]
  /** e.g. "6 searches · 41 results · 9 hidden · sources: 3 official, 2 blogs · ⚠ 1 stale (2022)". */
  summaryLine: string
}

export interface SuggestRuleInput {
  match: string
  action: RuleAction
  weight?: number
  scope?: 'global' | 'session'
  profile?: string
  reason: string
  evidenceUrl?: string
}

export interface SuggestRuleResult {
  suggestionId: number
  status: 'queued' | 'duplicate' | 'rejected'
  howToApprove: string
  message?: string
}

/** A rule as the CLI lists it. */
export interface RuleListing {
  id: string
  scope: 'session' | 'project' | 'global'
  match: string
  action: RuleAction
  weight: number
  profiles?: string[]
  important: boolean
  until?: string
  note?: string
  source: string
}

export interface AddRuleInput {
  match: string
  action: RuleAction
  weight?: number
  profile?: string
  important?: boolean
  until?: string
  note?: string
  scope?: 'global' | 'project' | 'session'
}

export interface LogEntry {
  searchId: number
  receiptId: string
  at: string
  query: string
  profile: string
  depth: Depth
  mode: 'engines' | 'builtin'
  client?: string
  engines: EngineId[]
  kept: number
  hidden: number
  latencyMs: number
}

export interface LogDetail extends LogEntry {
  results: Array<{
    rank: number
    engine: EngineId | 'builtin'
    url?: string
    domain: string
    title?: string
    decision: 'kept' | 'hidden' | 'pinned'
    reason?: HiddenReason
    rule?: Pick<RuleRef, 'ruleId' | 'text' | 'tier'>
    sourceType?: SourceType
  }>
}

/** The dashboard header (ADR-0020). */
export interface DashboardOverview {
  days: number
  searches: number
  /** Built-in (Claude Code WebSearch) searches among `searches`. */
  builtin: number
  kept: number
  hidden: number
  /** Searches per engine (engine searches only). */
  engines: Array<{ engine: string; searches: number }>
  /** Most-hidden registrable domains. */
  topHidden: Array<{ domain: string; count: number }>
  /** Kept results by source type. */
  sourceTypes: Partial<Record<SourceType, number>>
  mode: { configured: SearchMode; effective: 'engines' | 'builtin' }
  version: string
}

/** One page of the live log, newest first. */
export interface LogPage {
  items: LogEntry[]
  /** Pass as `before` for the next (older) page; null at the end. */
  nextBefore: number | null
  /** The newest search id (0 when the log is empty). */
  maxId: number
}

/** What the Settings page shows. `locked` lists paths an env var pins (shown read-only). */
export interface SettingsView {
  mode: { configured: SearchMode; effective: 'engines' | 'builtin' }
  queryHygiene: { mode: 'block' | 'redact' | 'off'; hosts: 'block' | 'redact' | 'off' }
  limits: { searchesPerTurn: number; searchesPerHour: number; repeatQuery: number }
  retention: { days: number }
  hooks: { receiptLine: boolean; guard: boolean }
  /** Background refresh of subscribed and starter lists (ADR-0022). */
  lists: { autoUpdate: boolean }
  locked: string[]
  paths: { config: string; data: string }
}

/** The settings the dashboard may change; anything else is edited in settings.yaml. */
export type SettingsPatch =
  | { path: 'mode'; value: SearchMode }
  | { path: 'queryHygiene.mode' | 'queryHygiene.hosts'; value: 'block' | 'redact' | 'off' }
  | { path: 'limits.searchesPerTurn' | 'limits.searchesPerHour' | 'limits.repeatQuery'; value: number }
  | { path: 'retention.days'; value: number }
  | { path: 'hooks.receiptLine'; value: boolean }
  | { path: 'lists.autoUpdate'; value: boolean }

/** Dashboard reads and settings writes (ADR-0020); never model-reachable. */
export interface DashboardApi {
  page(opts: { before?: number; after?: number; limit?: number; hiddenOnly?: boolean }): Promise<LogPage>
  /** Searches with `id > after`, oldest first, plus the cursor checks for `reset` (ADR-0004 point 5). */
  tail(after: number, limit: number): Promise<{ items: LogEntry[]; maxId: number; epoch: number }>
  overview(days: number): Promise<DashboardOverview>
  settingsView(): Promise<SettingsView>
  /** Validates the patch and the resulting file before writing settings.yaml. */
  patchSettings(patch: SettingsPatch): Promise<SettingsView>
}

// ── Lists (ADR-0008 "Lists", ADR-0022) ─────────────────────────────────────

/** Why a list's last refresh or import failed. */
export interface ListError {
  code: ListErrorCode
  message: string
  /** ISO 8601. */
  at: string
}

/** One list as `searchhole lists` and the dashboard show it. */
export interface ListStatus {
  /** Stable id: the catalog id, the subscription name or the import name. */
  id: string
  name: string
  /** bundled: first-party, compiled in; vendored: a starter list shipped as a copy and refreshed from `url`; subscribed: `subscriptions:` in rules.yaml; local: an imported file. */
  source: ListSource
  url?: string
  homepage?: string
  /** The format it is read as (`auto` detects); see `detectedFormat`. */
  format: ListFormat
  /** What `auto` resolved to for the copy in force. */
  detectedFormat?: string
  kind: ListKind
  mode: ListMode
  /** The mode without the user's choice. */
  defaultMode: ListMode
  /** SPDX id from the catalog or the list's own header. */
  license?: string
  description?: string
  /** Rules in force from this list (0 when none is loaded yet). */
  ruleCount: number
  /** Lines the permissive importer could not use (counted, never silent). */
  skipped: number
  skipReasons: Record<string, number>
  /** built-in: compiled into search-hole; shipped: the copy that came with search-hole; downloaded; imported; none: nothing loaded yet. */
  copy: 'built-in' | 'shipped' | 'downloaded' | 'imported' | 'none'
  /** When the copy in force was fetched, shipped or imported (ISO 8601); null for built-in lists. */
  lastUpdate: string | null
  /** The last refresh attempt (ISO 8601). */
  lastCheck: string | null
  /** When the next background refresh is due (ISO 8601); null when the list is never refreshed. */
  nextUpdate: string | null
  /** The refresh interval as configured (`7d`). */
  update?: string
  /** The pinned SHA-256 of the list bytes, when set. */
  sha256?: string
  lastError: ListError | null
  /** Importer notes about the copy in force (caps, approximations). */
  warnings: string[]
  /** From the search log: results this list hid, and (audit mode) would have hidden, in the last 7 days. */
  contribution: { hidden7d: number; wouldHide7d: number }
}

/** A catalog list with its state here. */
export interface ListCatalogEntry {
  id: string
  name: string
  url: string
  homepage: string
  format: ListFormat
  kind: ListKind
  license: string
  licenseUrl: string | null
  /** The licence permits shipping a copy. */
  bundleable: boolean
  /** ADR-0017 starter set mode, or `off` (offered, never auto-enabled). */
  recommendedMode: ListMode | 'off'
  approxRules?: number
  notes: string
  /** Shipped with search-hole and enabled by default. */
  starter: boolean
  /** Present in your lists (any mode but disabled). */
  enabled: boolean
  /** Its mode here, when it is one of your lists. */
  mode?: ListMode
}

export interface AddListInput {
  /** A catalog id (`searchhole lists catalog`) or an https:// URL. */
  source: string
  /** The list id for a URL (default: from the file name). */
  name?: string
  format?: ListFormat
  kind?: ListKind
  /** Default `enforce` (ADR-0008); a starter list keeps its mode unless given. */
  mode?: ListMode
  /** Refresh interval, e.g. `1d` (default `7d`). */
  update?: string
  /** Pin the list bytes: an update with other bytes is refused. */
  sha256?: string
  /** Download it now (default true). */
  fetch?: boolean
}

export interface ImportListInput {
  /** The list id (lower-case letters, digits, `.`, `_`, `-`). */
  name: string
  kind: ListKind
  format?: ListFormat
  mode?: ListMode
}

export interface ListUpdateResult {
  id: string
  /** updated: a new copy is in force; unchanged: 304 or the same bytes; failed: the copy in force was kept; skipped: not refreshed (see message). */
  result: 'updated' | 'unchanged' | 'failed' | 'skipped'
  ruleCount: number
  previousRuleCount: number | null
  message: string
  error?: Omit<ListError, 'at'>
}

/** List management (CLI, dashboard, slash command; never model-reachable). */
export interface ListsApi {
  list(): Promise<ListStatus[]>
  catalog(): Promise<ListCatalogEntry[]>
  /** Subscribes (written to rules.yaml) and, unless `fetch: false`, downloads it now. */
  add(input: AddListInput): Promise<ListStatus>
  /** Unsubscribes or deletes an import; returns the list as it was. Built-in lists can only be disabled. */
  remove(id: string): Promise<ListStatus>
  setMode(id: string, mode: ListMode): Promise<ListStatus>
  /** Refreshes the named lists (default: every enabled list with a URL). `force` overrides the shrink guard. */
  update(ids?: string[], opts?: { force?: boolean }): Promise<ListUpdateResult[]>
  /** Imports a local file as a list (stored under `<data>/lists/local/`, never refreshed). */
  import(path: string, opts: ImportListInput): Promise<ListStatus>
}

export interface DoctorCheck {
  id: string
  status: 'ok' | 'warn' | 'fail' | 'info'
  title: string
  detail?: string
  fix?: string
}

export interface DoctorReport {
  version: string
  checks: DoctorCheck[]
  engines: EngineStatus[]
  paths: { config: string; data: string; run: string; source: string }
}

export interface App {
  readonly version: string
  readonly host: HostProfile

  /** Full pipeline (ADR-0009/0010). Throws SearchHoleError('query_blocked' | 'no_healthy_engine' | 'invalid_argument'). */
  search(args: SearchArgs, ctx: RequestCtx): Promise<SearchOutcome>
  /** Safe fetch (ADR-0011, §12.4). Refusals are returned, not thrown. */
  fetch(args: FetchArgs, ctx: RequestCtx): Promise<FetchOutcome>
  /** Receipts by id, or the session's most recent (ADR-0005). */
  receipt(ids: string[] | undefined, ctx: RequestCtx): Promise<Receipt[]>
  /** Queue a model-proposed rule; never applies it (Principle 3). */
  suggestRule(input: SuggestRuleInput, ctx: RequestCtx): Promise<SuggestRuleResult>

  // ── Claude Code built-in search mode (ADR-0018) ──
  /** Effective mode for this host and the current engine health. */
  searchMode(): Promise<{ configured: SearchMode; effective: 'engines' | 'builtin' }>
  /** Domains to inject into WebSearch `blocked_domains` (user + list domain blocks, user allows excluded). */
  builtinBlockedDomains(ctx: RequestCtx, query: string): Promise<string[]>
  /** Apply rules to built-in WebSearch results; logs a search row with mode 'builtin'. */
  filterBuiltinResults(query: string, results: BuiltinResult[], ctx: RequestCtx): Promise<BuiltinFilterResult>
  /** Rule check for a URL the model is about to open with WebFetch or our fetch. */
  checkUrl(
    url: string,
    ctx: RequestCtx,
  ): Promise<{ allowed: true } | { allowed: false; message: string; rule?: RuleRef }>
  /** Record a page the model opened with the built-in WebFetch (for the receipt). */
  recordBuiltinFetch(url: string, ctx: RequestCtx): Promise<void>
  /**
   * Whether one more built-in WebSearch fits the session's loop-guard limits (ADR-0019).
   * Optional so that existing fakes stay valid; `createApp` always provides it.
   */
  searchBudget?(
    query: string,
    ctx: RequestCtx,
  ): Promise<{ allowed: true } | { allowed: false; message: string }>
  /** Query hygiene verdict (ADR-0015 point 4) without searching. */
  checkQuery(query: string): { action: 'ok' | 'block' | 'redact'; query: string; classes: string[] }

  // ── Engines ──
  engineStatus(): Promise<EngineStatus[]>
  /** Bounded probe of `unknown` engines (≤ budgetMs), updating shared health (ADR-0014 point 2). */
  probeEngines(budgetMs: number): Promise<EngineStatus[]>

  // ── Turns and sessions (ADR-0005, ADR-0014 point 1) ──
  /** UserPromptSubmit / SessionStart: open a turn receipt for the session. */
  openTurn(ctx: RequestCtx): Promise<{ receiptId: string }>
  /** Stop: close the turn receipt; returns the one-line receipt if the turn searched. */
  closeTurn(ctx: RequestCtx): Promise<{ receiptLine?: string; receiptId?: string }>
  /**
   * After the gateway re-keys a hook session (SessionStart / UserPromptSubmit, ADR-0014 point 1):
   * `resume` and `compact` (same project) carry the session rules from `previousKey` to
   * `ctx.session.key`; `clear` drops them (ADR-0005); `startup` changes nothing. Optional so
   * that existing fakes stay valid; `createApp` always provides it.
   */
  rekeySession?(
    previousKey: string,
    ctx: RequestCtx,
    source: 'startup' | 'resume' | 'clear' | 'compact',
  ): Promise<{ movedRules: number }>

  // ── Admin (CLI, slash commands; never model-reachable) ──
  rules: {
    list(opts?: { scope?: 'session' | 'project' | 'global' }): Promise<RuleListing[]>
    add(input: AddRuleInput, ctx?: RequestCtx): Promise<RuleListing>
    remove(idOrMatch: string, opts?: { scope?: 'session' | 'project' | 'global' }): Promise<RuleListing[]>
    explain(url: string, opts?: { profile?: string }): Promise<{ decision: string; lines: string[] }>
    /** Approve a project's .searchhole.yaml by content hash (ADR-0008). */
    trust(projectDir: string): Promise<{ path: string; sha256: string }>
  }
  keys: {
    /** Store a key in search-hole's own store (OS keychain etc., ADR-0007). Never logged. */
    set(engine: EngineId, value: string): Promise<{ backend: string }>
    status(): Promise<Array<{ engine: EngineId; present: boolean; source: string }>>
    remove(engine: EngineId): Promise<void>
  }
  suggestions: {
    list(): Promise<Array<{ id: number; input: SuggestRuleInput; createdAt: string; status: string }>>
    approve(id: number): Promise<RuleListing>
    reject(id: number): Promise<void>
  }
  log: {
    recent(opts?: { limit?: number; hiddenOnly?: boolean }): Promise<LogEntry[]>
    detail(searchId: number): Promise<LogDetail | undefined>
  }
  settings: {
    get(): Promise<Record<string, unknown>>
    setMode(mode: SearchMode): Promise<void>
  }
  doctor(opts?: { probe?: boolean }): Promise<DoctorReport>
  /** Optional so that existing fakes stay valid; `createApp` always provides it. */
  dashboard?: DashboardApi
  /** List subscriptions, starter lists and imports (ADR-0022). Optional for the same reason as `dashboard`. */
  lists?: ListsApi
  /**
   * The running dashboard's bare URL (no code or token, ADR-0004 point 3), from `ui.json` and
   * a live pid; null when none runs. Optional for the same reason as `dashboard`.
   */
  dashboardUrl?(): Promise<string | null>
  close(): Promise<void>
}

export type CreateApp = (opts: AppOptions) => Promise<App>
