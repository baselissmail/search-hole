// SPDX-License-Identifier: Apache-2.0
/**
 * The dashboard's HTTP contract (ADR-0004, ADR-0020): routes, request and response shapes,
 * and the live-stream events. Types only (plus route constants), so `apps/dashboard` imports it
 * at compile time and nothing of the server ships in the browser bundle.
 *
 * Auth (ADR-0004 point 4): every `/api/*` route, the stream included, needs
 * `Authorization: Bearer <session token>`. The token comes from `POST /session` with the
 * single-use login code that `searchhole ui --open` puts in the URL fragment (`#c=<code>`).
 * The page keeps the token in `sessionStorage` and removes the fragment at once.
 *
 * Errors: non-2xx responses carry `ApiError`. Web-sourced strings (titles, URLs, queries) are
 * untrusted: render them as text, never as HTML.
 */
import type {
  AddRuleInput,
  DashboardOverview,
  DoctorReport,
  EngineStatus,
  LogDetail,
  LogEntry,
  LogPage,
  RuleListing,
  SearchMode,
  SettingsPatch,
  SettingsView,
  SuggestRuleInput,
} from '../app/types.ts'

export type {
  AddRuleInput,
  DoctorReport,
  EngineStatus,
  LogDetail,
  LogEntry,
  RuleListing,
  SearchMode,
  SuggestRuleInput,
}

/** Route paths. `:id` segments are filled by the helpers. */
export const ROUTES = {
  /** No auth. `{ nonce, version }`; the CLI compares the nonce with `ui.json`. */
  health: '/health',
  /** No auth (the code is the credential). Body `SessionRequest`, response `SessionResponse`. */
  session: '/session',
  /** GET `Overview`. Query: `days` (1..90, default 7). */
  overview: '/api/overview',
  /**
   * GET `SearchPage`, newest first. Query: `before` (id, exclusive) pages back in time;
   * `after` (id, exclusive) returns only newer searches (the polling fallback when the stream
   * fails, every 2 s); `limit` (1..200, default 100); `hidden=1` keeps searches that hid results.
   */
  searches: '/api/searches',
  /** GET `LogDetail`. */
  search: (id: number) => `/api/searches/${id}`,
  /** GET, `text/event-stream`. Query: `after` (id). See `StreamEvent`. */
  stream: '/api/stream',
  /** GET `RuleListing[]`; POST `AddRuleInput` → `RuleListing`. */
  rules: '/api/rules',
  /** POST `RemoveRuleRequest` → `RuleListing[]` (what was removed, for Undo). */
  removeRule: '/api/rules/remove',
  /** POST `ExplainRequest` → `ExplainResponse`. */
  explain: '/api/rules/explain',
  /** GET `SuggestionItem[]`. */
  suggestions: '/api/suggestions',
  /** POST → `RuleListing` (the rule it created). */
  approveSuggestion: (id: number) => `/api/suggestions/${id}/approve`,
  /** POST → `{ ok: true }`. */
  rejectSuggestion: (id: number) => `/api/suggestions/${id}/reject`,
  /** GET `EngineStatus[]`. */
  engines: '/api/engines',
  /** POST → `EngineStatus[]` after a bounded health probe (≤ 3 s). */
  probeEngines: '/api/engines/probe',
  /** GET `SettingsView`; POST `SettingsPatch` → `SettingsView`. */
  settings: '/api/settings',
  /** GET `DoctorReport`. */
  doctor: '/api/doctor',
} as const

export interface ApiError {
  error: {
    /** A stable code: `unauthorized`, `forbidden`, `not_found`, `bad_request`, `conflict`, or an app error code. */
    code: string
    message: string
    fix?: string
  }
}

export interface SessionRequest {
  code: string
}
export interface SessionResponse {
  token: string
  /** search-hole version, for the footer. */
  version: string
}

export type Overview = DashboardOverview

export type SearchPage = LogPage

/**
 * Stream events (SSE, one per `event:` line):
 * - `search`: data `LogEntry`, `id` = its search id (resume with `Last-Event-ID` or `after`);
 * - `reset`: data `{ reason }`: rows were pruned or deleted; refetch the first page;
 * - `stream-error`: data `{ message }`; the client reconnects with backoff.
 * Comments (`: ping`) arrive every 15 s.
 */
export type StreamEvent =
  | { event: 'search'; id: number; data: LogEntry }
  | { event: 'reset'; data: { reason: 'pruned' | 'epoch' } }
  | { event: 'stream-error'; data: { message: string } }

export interface RemoveRuleRequest {
  /** A rule id or its match text. */
  rule: string
  scope?: 'session' | 'project' | 'global'
}

export interface ExplainRequest {
  url: string
  profile?: string
}
export interface ExplainResponse {
  decision: string
  lines: string[]
}

export interface SuggestionItem {
  id: number
  input: SuggestRuleInput
  createdAt: string
  status: string
}

export type { SettingsPatch, SettingsView }
