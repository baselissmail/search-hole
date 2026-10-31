// SPDX-License-Identifier: Apache-2.0
/**
 * Public types of the store. Contract types (EngineId, MergedResult, ...) come from
 * shared/types.ts and are not redefined here. Row types returned by reads use `string` for
 * code columns (decision, tier, kind ...): vocabularies only grow (ADR-0006 point 12), so
 * a newer writer's codes must read back without throwing.
 */
import type {
  Depth,
  EngineId,
  EngineRetention,
  EngineRun,
  FoundDate,
  HealthState,
  HiddenReason,
  MergedResult,
  RawResult,
  ResultFlag,
  RuleRef,
  SourceType,
  Visibility,
  Warning,
} from '../shared/types.ts'
import type { ModeReason, StoreMode } from './compat.ts'
import type { Db } from './driver.ts'
import type { Migration } from './migrations/index.ts'

export type { ModeReason, StoreMode } from './compat.ts'

// ── Opening ──────────────────────────────────────────────────────────────

export interface OpenStoreOptions {
  /** The data folder (ADR-0015). The database is `<dataDir>/searchhole.db`. `:memory:` for tests. */
  dataDir: string
  /** This binary's app semver; compared with `meta.min_*_version`. */
  appVersion: string
  /** Epoch milliseconds. Injected so tests and replays are deterministic. */
  now: () => number
  /** 100 on the search path (default, ADR-0003 point 4); 5000 for CLI commands. */
  busyTimeoutMs?: number
  /**
   * `inline` (default) migrates before returning. `defer` returns a `no-history` store when a
   * migration is pending; call `store.runMigration()` later (the gateway runs it as a lease job).
   */
  migrate?: 'inline' | 'defer'
  /** Called for dropped log writes and mode changes. */
  onWarning?: (warning: Warning) => void
  /** Retry-queue flush interval (default 500 ms, jittered 0.5x-1.5x). */
  retryIntervalMs?: number
  /** Test seams. */
  migrations?: readonly Migration[]
  pid?: number
  random?: () => number
  /** Longest wait for another process's migration. Default 130 s. */
  migrationWaitMs?: number
}

export type MigrationState = 'current' | 'migrated' | 'waited' | 'pending' | 'blocked' | 'failed'

export interface StoreStatus {
  readonly mode: StoreMode
  readonly reason: ModeReason
  /** One line for receipts and `doctor`. */
  readonly message: string
  readonly migration: MigrationState
  readonly appVersion: string
  /** Highest schema version this binary knows. */
  readonly latestSchemaVersion: number
  /** From `meta`; undefined when the database has no usable meta. */
  readonly schemaVersion?: number
  readonly minReaderVersion?: string
  readonly minWriterVersion?: string
  readonly lastMigratedBy?: string
  readonly dbPath: string
}

export interface StoreStats {
  /** Searches written (directly or from the retry queue). */
  readonly recorded: number
  /** Searches that hit BUSY and entered the retry queue. */
  readonly queued: number
  /** Queued searches dropped after 10 s (or by queue overflow). */
  readonly dropped: number
  /** Log writes skipped because the store is read-only / has no history. */
  readonly skipped: number
  readonly pending: number
}

// ── Recording a search ───────────────────────────────────────────────────

/** One merged result plus what is needed to store it. */
export interface RecordedResult {
  readonly merged: MergedResult
  /**
   * What each engine returned for this group, exactly as returned. Payload rows are written
   * from these according to each engine's retention; the first hit per engine is kept.
   */
  readonly hits: ReadonlyArray<Pick<RawResult, 'engine' | 'url' | 'title' | 'snippet'>>
  /** Final visibility (after freshness), which can differ from `merged.decision.visibility`. */
  readonly visibility: Visibility
  /** Why it was hidden; omitted for kept results. */
  readonly reason?: HiddenReason
  /** 1-based output position for kept results. */
  readonly outRank?: number
}

export interface RecordSearchInput {
  readonly receiptId: string
  readonly sessionId?: string
  /** Already passed through the query redactor (ADR-0015 point 4); stored as given. */
  readonly queryRedacted: string
  readonly profile: string
  readonly depth: Depth
  readonly engines: readonly EngineRun[]
  readonly latencyMs: number
  readonly keptCount: number
  readonly hiddenCount: number
  readonly toolUseId?: string
  /** Block rules pushed to engines (ADR-0009 point 8); replay cannot restore their hits. */
  readonly pushedRuleIds?: readonly string[]
  /**
   * Each engine's retention policy. The store enforces it: `decisions-only` engines never get
   * title, snippet or URL stored. An engine missing here is treated as `decisions-only`.
   */
  readonly retention: Readonly<Partial<Record<EngineId, EngineRetention>>>
  /** Upper bound for payload lifetime in days (`retention.days`, default 90). */
  readonly retentionDays?: number
  readonly results: readonly RecordedResult[]
  /** Epoch ms; defaults to the store clock. */
  readonly createdAt?: number
}

export type SkipReason = 'read-only' | 'no-history' | 'closed' | 'error'

export type RecordSearchResult =
  | { readonly status: 'recorded'; readonly searchId: number }
  /** The database was busy; the search sits in the in-memory retry queue (dropped after 10 s). */
  | { readonly status: 'queued' }
  | { readonly status: 'skipped'; readonly reason: SkipReason; readonly warning: Warning }

export interface FlushReport {
  readonly written: number
  readonly dropped: number
  readonly remaining: number
}

// ── Reading searches ─────────────────────────────────────────────────────

export interface StoredEngineRun {
  readonly engine: string
  readonly status: string
  readonly returned: number
  readonly latencyMs?: number
  readonly errorClass?: string
  readonly inactiveReason?: string
  readonly detail?: string
  readonly pushedRuleCount?: number
}

export interface SearchSummary {
  /** The live-tail cursor (`searches.id`). */
  readonly id: number
  readonly receiptId: string
  readonly sessionId: string | null
  readonly queryRedacted: string
  readonly profile: string
  readonly depth: string
  readonly engines: readonly StoredEngineRun[]
  readonly latencyMs: number
  readonly keptCount: number
  readonly hiddenCount: number
  readonly pushedRuleIds: readonly string[]
  readonly toolUseId: string | null
  readonly createdAt: number
}

export interface StoredDate {
  readonly value: string
  readonly kind: string
  readonly method: string
  readonly confidence: string
  readonly tzAssumed: boolean
}

export interface StoredPayload {
  readonly engine: string
  readonly title: string
  readonly snippet: string
  readonly url: string
  readonly expiresAt: number
}

export interface StoredResult {
  readonly id: number
  readonly searchId: number
  /** Engine with the best raw rank. */
  readonly engine: string
  readonly rawRank: number
  readonly positions: Readonly<Record<string, number>>
  /** NULL when any engine in the group stores decisions only. */
  readonly canonicalKey: string | null
  readonly urlHash: string
  readonly registrableDomain: string
  readonly decision: string
  readonly reason: string | null
  readonly ruleId: string | null
  readonly tier: string | null
  readonly listId: string | null
  readonly ruleText: string | null
  readonly flags: readonly string[]
  readonly sourceType: string
  readonly dates: readonly StoredDate[]
  readonly effectiveDate: string | null
  readonly effectiveKind: string | null
  readonly effectiveConfidence: string | null
  readonly outRank: number | null
  readonly fused: number | null
  readonly adjusted: number | null
  readonly createdAt: number
  /** Unexpired payloads only. */
  readonly payloads: readonly StoredPayload[]
}

export interface TailState {
  /** `MAX(searches.id)`, or 0. A cursor above it means rows were deleted: send `reset`. */
  readonly maxId: number
  readonly epoch: number
}

// ── Engine health ────────────────────────────────────────────────────────

/** `keyFp` for key-independent state (timeouts, 5xx, IP-based rate limits): shared by all keys. */
export const SHARED_KEY_FP = ''

export interface EngineHealthRow {
  readonly engine: EngineId
  /** First 8 bytes of HMAC-SHA256(install secret, key), hex; `SHARED_KEY_FP` for shared state. */
  readonly keyFp: string
  /** SearXNG upstream engine; '' for the engine itself. */
  readonly subEngine: string
  readonly state: HealthState
  /** An ErrorClass or InactiveReason code; read tolerantly. */
  readonly reasonClass: string | null
  /** Epoch ms until which the state holds. */
  readonly until: number | null
  readonly consecutiveFailures: number
  readonly ewmaSuccess: number | null
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly lastSuccessAt: number | null
  /** Redacted, at most 200 characters. */
  readonly lastErrorRedacted: string | null
  readonly keyPresent: boolean
  readonly keySource: string | null
  readonly updatedAt: number
}

/** `put` stamps `updatedAt` from the store clock. */
export type EngineHealthWrite = Omit<EngineHealthRow, 'updatedAt'>

// ── Spend caps ───────────────────────────────────────────────────────────

/** Caps per period; omitted or null means uncapped (usage is still counted). */
export interface UsageCaps {
  readonly day?: number | null
  readonly month?: number | null
}

export interface UsageCounts {
  readonly day: number
  readonly month: number
}

/** Hand back to `refund`; remembers which periods were charged, even across midnight. */
export interface UsageReservation {
  readonly engine: EngineId
  readonly keyFp: string
  /** UTC `YYYY-MM-DD`. */
  readonly dayStart: string
  /** UTC `YYYY-MM`. */
  readonly monthStart: string
}

export type ReserveResult =
  | { readonly ok: true; readonly reservation: UsageReservation; readonly counts: UsageCounts }
  | { readonly ok: false; readonly reason: 'day_cap' | 'month_cap'; readonly counts: UsageCounts }
  /** The reservation could not be written (BUSY, read errors, no usable schema). ADR-0009 point 6 applies. */
  | { readonly ok: false; readonly reason: 'store_unavailable'; readonly detail: string }

// ── Job leases ───────────────────────────────────────────────────────────

export interface JobOwner {
  readonly gatewayId: string
  /** App semver; gated against `meta.last_migrated_by`. */
  readonly version: string
}

export interface Lease {
  readonly name: string
  /** Fencing token: incremented on every acquire. */
  readonly epoch: number
  readonly owner: JobOwner
  /** Epoch ms. */
  readonly until: number
}

export type LeaseFailure = 'lease_lost' | 'version_too_old' | 'read_only' | 'store_unavailable'

export type AcquireResult =
  | { readonly acquired: true; readonly lease: Lease; readonly tookOverFrom?: string }
  | {
      readonly acquired: false
      readonly reason: 'held' | 'version_too_old' | 'read_only' | 'store_unavailable'
      readonly heldBy?: string
      readonly until?: number
    }

export type LeaseWrite =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly reason: LeaseFailure }

export type FencedResult<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly reason: LeaseFailure }

export interface JobPatch {
  readonly status?: string
  readonly progress?: unknown
  readonly lastError?: string | null
}

export interface JobRow {
  readonly name: string
  readonly ownerGatewayId: string | null
  readonly ownerVersion: string | null
  readonly leaseUntil: number
  readonly heartbeatAt: number | null
  readonly status: string
  readonly progress: unknown
  readonly lastError: string | null
  readonly leaseEpoch: number
}

// ── Retention ────────────────────────────────────────────────────────────

export interface RetentionSettings {
  /** `retention.days`; 0 deletes everything (the "delete all data" job). */
  readonly days: number
  /** Default 400 (ADR-0015). */
  readonly dailyStatsDays?: number
  /** Resolved suggestions are kept this long. Default 30. */
  readonly resolvedSuggestionDays?: number
  /** Gateways rows are dropped this long after `last_seen_at`. Default 7. */
  readonly gatewayDays?: number
  /** Rows per delete statement. Default 10_000. */
  readonly batchSize?: number
}

export interface PruneReport {
  readonly skipped?: SkipReason
  /** Set when the run stopped early because the database stayed busy. */
  readonly interrupted?: 'busy'
  readonly deleted: Readonly<Record<string, number>>
  readonly totalDeleted: number
  readonly batches: number
  /** The new `data_epoch` when anything was deleted. */
  readonly epoch?: number
}

// ── Meta and maintenance ─────────────────────────────────────────────────

export interface MetaSnapshot {
  readonly schemaVersion: number
  readonly minReaderVersion: string
  readonly minWriterVersion: string
  readonly lastMigratedBy: string
  readonly dataEpoch: number
}

export type CheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'

// ── Built-in WebSearch searches (ADR-0018) ───────────────────────────────

/**
 * One result of Claude Code's built-in WebSearch. Anthropic's terms are treated like
 * decisions-only retention: only the URL hash, registrable domain, ranks and the decision
 * are stored, never the title or the URL.
 */
export interface BuiltinRecordedResult {
  readonly url: string
  /** Title as the built-in search returned it (stored for the user's own log, ADR-0018). */
  readonly title?: string
  /** 1-based position in the built-in result list. */
  readonly rank: number
  readonly visibility: Visibility
  readonly reason?: HiddenReason
  readonly rule?: RuleRef
  /** 1-based position after filtering and reordering, for kept results. */
  readonly outRank?: number
  readonly flags: readonly ResultFlag[]
  readonly sourceType: SourceType
}

export interface RecordBuiltinInput {
  readonly receiptId: string
  readonly sessionId?: string
  /** Already redacted (ADR-0015 point 4). */
  readonly queryRedacted: string
  readonly profile: string
  readonly latencyMs: number
  readonly toolUseId?: string
  readonly results: readonly BuiltinRecordedResult[]
  /** Days to keep titles and URLs (settings retention for result payloads); default 90. */
  readonly retentionDays?: number
  /** Epoch ms; defaults to the store clock. */
  readonly createdAt?: number
}

/** A search as the log shows it: the summary plus its mode and the session's client name. */
export interface SearchLogRow extends SearchSummary {
  readonly mode: 'engines' | 'builtin'
  readonly clientName: string | null
}

// ── Sessions, receipts, gateways (ADR-0004, ADR-0005) ────────────────────

export interface SessionWrite {
  readonly id: string
  readonly hostProfile: string
  readonly hostKey?: string
  /** 'hook' | 'meta' | 'env' | 'fallback' (read tolerantly). */
  readonly keySource: string
  readonly clientName?: string
  readonly clientVersion?: string
  readonly protocolEra?: string
  readonly projectDir?: string
  readonly gatewayId?: string
  /** Omitted means no open receipt. */
  readonly openReceiptId?: string
  readonly turnOpen: boolean
}

export interface SessionRow {
  readonly id: string
  readonly hostProfile: string
  readonly hostKey: string | null
  readonly keySource: string
  readonly clientName: string | null
  readonly clientVersion: string | null
  readonly protocolEra: string | null
  readonly projectDir: string | null
  readonly gatewayId: string | null
  readonly openReceiptId: string | null
  readonly turnOpen: boolean
  readonly startedAt: number
  readonly lastSeenAt: number
}

export interface ReceiptRow {
  readonly id: string
  readonly sessionId: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly closedAt: number | null
  readonly searchCount: number
  readonly fetchCount: number
  readonly duplicateOf: string | null
}

export interface GatewayWrite {
  readonly id: string
  readonly pid: number
  readonly hostProfile: string
  readonly clientName?: string
  readonly clientVersion?: string
  readonly appVersion: string
  readonly schemaVersionKnown?: number
  readonly startedAt: number
}

export interface GatewayRow {
  readonly id: string
  readonly pid: number
  readonly hostProfile: string
  readonly clientName: string | null
  readonly clientVersion: string | null
  readonly appVersion: string
  readonly schemaVersionKnown: number | null
  readonly startedAt: number
  readonly lastSeenAt: number
}

// ── Fetches ──────────────────────────────────────────────────────────────

/** One opened (or refused) page. URLs are stored only as hashes; page text never. */
export interface FetchWrite {
  readonly receiptId: string
  readonly sessionId?: string
  readonly toolUseId?: string
  readonly urlHash: string
  readonly finalUrlHash?: string
  readonly host?: string
  readonly registrableDomain?: string
  readonly status?: number
  readonly contentType?: string
  readonly bytes?: number
  readonly title?: string
  /** 'opened' | 'refused' (read tolerantly). */
  readonly decision: string
  /** Refusal reason, or 'builtin_webfetch' for pages Claude Code's WebFetch opened. */
  readonly reason?: string
  readonly ruleId?: string
  readonly dates?: readonly FoundDate[]
  readonly effectiveDate?: FoundDate
  readonly latencyMs?: number
}

export interface FetchRow {
  readonly id: number
  readonly receiptId: string
  readonly sessionId: string | null
  readonly toolUseId: string | null
  readonly urlHash: string
  readonly finalUrlHash: string | null
  readonly host: string | null
  readonly registrableDomain: string | null
  readonly status: number | null
  readonly contentType: string | null
  readonly bytes: number | null
  readonly title: string | null
  readonly decision: string | null
  readonly reason: string | null
  readonly ruleId: string | null
  readonly dates: readonly StoredDate[]
  readonly effectiveDate: string | null
  readonly latencyMs: number | null
  readonly createdAt: number
}

// ── Rule state (ADR-0008) ────────────────────────────────────────────────

export interface SessionRuleWrite {
  readonly id: string
  readonly sessionId: string
  /** JSON-serialisable rule body. */
  readonly rule: unknown
  /** Epoch ms after which the rule no longer applies. */
  readonly until?: number
}

export interface SessionRuleRow {
  readonly id: string
  readonly sessionId: string
  /** Parsed `rule_json`; null when unreadable. Validate before use. */
  readonly rule: unknown
  readonly createdAt: number
  readonly until: number | null
}

export interface TrustRow {
  /** Absolute path of the project rules file. */
  readonly path: string
  readonly sha256: string
  readonly trustedAt: number
}

export interface LastGoodWrite {
  readonly sourcePath: string
  readonly sha256: string
  readonly compilerVersion: string
  /** JSON-serialisable loaded rules. */
  readonly compiled: unknown
}

export interface LastGoodRow {
  readonly sourcePath: string
  readonly sha256: string
  readonly compilerVersion: string
  /** Parsed `compiled_json`; null when unreadable. Validate before use. */
  readonly compiled: unknown
  readonly savedAt: number
}

export interface SuggestionWrite {
  readonly sessionId?: string
  readonly receiptId?: string
  /** JSON-serialisable proposal; a `dedupeKey` field is used by `findPending`. */
  readonly rule: unknown
  readonly reason?: string
}

export interface SuggestionRow {
  readonly id: number
  readonly sessionId: string | null
  readonly receiptId: string | null
  /** 'pending' | 'approved' | 'rejected' (read tolerantly). */
  readonly status: string
  /** Parsed `rule_json`; null when unreadable. Validate before use. */
  readonly rule: unknown
  readonly reason: string | null
  readonly createdAt: number
  readonly resolvedAt: number | null
}

// ── The store ────────────────────────────────────────────────────────────

export interface EngineHealthApi {
  get(engine: EngineId, keyFp: string, subEngine?: string): EngineHealthRow | undefined
  /** All rows for one engine (every key_fp and sub_engine), or for every engine. */
  list(engine?: EngineId): EngineHealthRow[]
  /** Upserts. Returns false when the write was skipped (read-only) or the database was busy. */
  put(row: EngineHealthWrite): boolean
}

export interface EngineUsageApi {
  /**
   * Atomically checks both caps and, if neither is reached, increments the day and month
   * counters in one BEGIN IMMEDIATE. Works in `read-only` mode.
   * `now` defaults to the store clock; periods are UTC calendar days and months.
   */
  reserve(engine: EngineId, keyFp: string, caps: UsageCaps, now?: number): ReserveResult
  /** Undo a reservation (never below zero). Only for calls that failed before being sent. */
  refund(reservation: UsageReservation): boolean
  /** Current counters; zeros when unavailable. */
  counts(engine: EngineId, keyFp: string, now?: number): UsageCounts
}

export interface JobsApi {
  /**
   * Takes the lease when it is free, expired, or held by an older version, and the caller's
   * version is >= `meta.last_migrated_by`. Increments `lease_epoch`.
   */
  acquire(name: string, owner: JobOwner, leaseMs: number): AcquireResult
  /** Heartbeat: extends the lease. Fails with `lease_lost` when another owner has a newer epoch. */
  renew(lease: Lease, leaseMs: number): LeaseWrite
  /** Fenced update of status / progress / last_error. */
  update(lease: Lease, patch: JobPatch): LeaseWrite
  /** Gives the lease up (fenced). The epoch is kept so the next acquire increments it. */
  release(lease: Lease, final?: JobPatch): LeaseWrite
  /**
   * Runs `fn` in a write transaction that first verifies the lease epoch, so a stalled former
   * owner's writes abort (ADR-0006 point 7). Use it for every write a job makes to other tables.
   */
  fenced<R>(lease: Lease, fn: (db: Db) => R): FencedResult<R>
  get(name: string): JobRow | undefined
  list(): JobRow[]
}

export interface MetaApi {
  get(key: string): string | undefined
  /** False when skipped (read-only). */
  set(key: string, value: string): boolean
  /**
   * Returns the existing value, or atomically stores and returns `make()`. Also works in
   * read-only mode (inserting a missing key is additive). Undefined when the store has no usable schema.
   */
  getOrInit(key: string, make: () => string): string | undefined
  snapshot(): MetaSnapshot | undefined
}

export interface RetentionApi {
  /** Deletes expired rows in batches (each its own transaction) and bumps `data_epoch`. */
  prune(now: number, settings: RetentionSettings): PruneReport
}

export interface MaintenanceApi {
  checkpoint(mode?: CheckpointMode): void
  incrementalVacuum(pages: number): void
  optimize(): void
}

export interface SearchLogApi {
  /** Newest first; `limit` is clamped to 1..500. */
  recent(opts: { limit: number; hiddenOnly?: boolean }): SearchLogRow[]
  get(id: number): SearchLogRow | undefined
  byReceipt(receiptId: string): SearchLogRow[]
  /** Hidden-result counts by reason, per search id. */
  hiddenReasons(searchIds: readonly number[]): Map<number, Record<string, number>>
}

/** Write methods return false when the write was skipped (read-only, no history) or the database was busy. */
export interface SessionsApi {
  upsert(w: SessionWrite): boolean
  get(id: string): SessionRow | undefined
}

export interface ReceiptsApi {
  ensure(id: string, sessionId?: string): boolean
  get(id: string): ReceiptRow | undefined
  close(id: string): boolean
  reopen(id: string): boolean
  latestForSession(sessionId: string): ReceiptRow | undefined
}

export interface FetchesApi {
  /** Records a fetch and bumps its receipt in one transaction. */
  record(w: FetchWrite): boolean
  byReceipt(receiptId: string): FetchRow[]
}

export interface SuggestionsApi {
  /** Returns the new id, or undefined when the write was skipped. */
  add(w: SuggestionWrite): number | undefined
  get(id: number): SuggestionRow | undefined
  list(limit?: number): SuggestionRow[]
  findPending(dedupeKey: string): SuggestionRow | undefined
  resolve(id: number, status: 'approved' | 'rejected'): boolean
}

export interface SessionRulesApi {
  add(w: SessionRuleWrite): boolean
  /** Unexpired rules of one session, or of every session. */
  list(sessionId?: string): SessionRuleRow[]
  remove(id: string): boolean
  clear(sessionId: string): number
}

export interface ProjectTrustApi {
  get(path: string): TrustRow | undefined
  set(path: string, sha256: string): boolean
  remove(path: string): boolean
}

export interface LastGoodApi {
  put(w: LastGoodWrite): boolean
  latest(sourcePath: string): LastGoodRow | undefined
}

export interface GatewaysApi {
  heartbeat(w: GatewayWrite): boolean
  /** Gateways seen at or after `since` (epoch ms). */
  list(since: number): GatewayRow[]
}

export interface Store {
  readonly dbPath: string
  status(): StoreStatus
  stats(): StoreStats

  /**
   * Logs a search, its results and payloads in ONE BEGIN IMMEDIATE transaction. Never throws:
   * BUSY goes to the retry queue; read-only and errors become `skipped` with a warning.
   */
  recordSearch(input: RecordSearchInput): RecordSearchResult
  /** Logs a built-in WebSearch (decisions only), with the same write discipline as `recordSearch`. */
  recordBuiltinSearch(input: RecordBuiltinInput): RecordSearchResult
  /** Retries queued searches now (also runs on a jittered timer). Drops entries older than 10 s. */
  flushRetries(): FlushReport

  getSearch(id: number): SearchSummary | undefined
  /** The dashboard tail: searches with `id > afterId`, ascending. `limit` is clamped to 1..500. */
  listSearchesAfter(afterId: number, limit: number): SearchSummary[]
  listResults(searchId: number): StoredResult[]
  tailState(): TailState

  readonly engineHealth: EngineHealthApi
  readonly engineUsage: EngineUsageApi
  readonly jobs: JobsApi
  readonly meta: MetaApi
  readonly retention: RetentionApi
  readonly maintenance: MaintenanceApi
  readonly searchLog: SearchLogApi
  readonly sessions: SessionsApi
  readonly receipts: ReceiptsApi
  readonly fetches: FetchesApi
  readonly suggestions: SuggestionsApi
  readonly sessionRules: SessionRulesApi
  readonly projectTrust: ProjectTrustApi
  readonly rulesLastGood: LastGoodApi
  readonly gateways: GatewaysApi

  dataEpoch(): number
  /** Bumps `data_epoch` (any process that deletes in bulk). Undefined when skipped. */
  bumpDataEpoch(): number | undefined

  /** Runs a pending migration (for `migrate: 'defer'`) and updates the mode. */
  runMigration(): Promise<StoreStatus>
  /** Flushes the retry queue once, then closes the connection. Idempotent. */
  close(): void
}
