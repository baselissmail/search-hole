// SPDX-License-Identifier: Apache-2.0
/**
 * The HTTP client for `searchhole ui` (ADR-0004, ADR-0020). Same origin, JSON bodies, a bearer
 * token on every `/api/*` call, and never cookies. A 401 ends the session, which brings back the
 * sign-in screen.
 */
import {
  type AddListInput,
  type AddRuleInput,
  type ApiError,
  type DoctorReport,
  type EngineStatus,
  type ExplainRequest,
  type ExplainResponse,
  type ListCatalogEntry,
  type ListMode,
  type ListModeRequest,
  type ListStatus,
  type ListUpdateRequest,
  type ListUpdateResult,
  type LogDetail,
  type Overview,
  type RemoveListRequest,
  type RemoveRuleRequest,
  type ReviewList,
  type ReviewSiteRequest,
  type ReviewSiteResponse,
  ROUTES,
  type RuleListing,
  type SearchPage,
  type SessionResponse,
  type SettingsPatch,
  type SettingsView,
  type SuggestionItem,
} from './contract.ts'
import { endSession, readToken } from './session.ts'

/** A failed call. `status` is 0 when the server didn't answer at all. */
export class ApiFailure extends Error {
  readonly status: number
  readonly code: string
  readonly fix: string | undefined

  constructor(status: number, code: string, message: string, fix?: string) {
    super(message)
    this.name = 'ApiFailure'
    this.status = status
    this.code = code
    this.fix = fix
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** A message fit to show to the user for any thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof ApiFailure) return err.message
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong.'
}

type Query = Record<string, string | number | boolean | undefined>

export function withQuery(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === false) continue
    params.set(key, value === true ? '1' : String(value))
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

const UNREACHABLE = "search-hole isn't answering. Start it again with `searchhole ui --open`."

function authHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept }
  const token = readToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function failureFrom(res: Response): Promise<ApiFailure> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  const error = (body as Partial<ApiError> | undefined)?.error
  if (error && typeof error.message === 'string') {
    return new ApiFailure(
      res.status,
      typeof error.code === 'string' ? error.code : 'error',
      error.message,
      typeof error.fix === 'string' ? error.fix : undefined,
    )
  }
  return new ApiFailure(
    res.status,
    'http_error',
    `The server answered ${res.status} ${res.statusText}`.trim(),
  )
}

interface RequestOptions {
  query?: Query | undefined
  /** POST body; every POST sends JSON (`{}` when there is nothing to say). */
  body?: unknown
  signal?: AbortSignal | undefined
  /** Let the request outlive the page (a change committed while the tab closes). */
  keepalive?: boolean | undefined
}

async function request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
  const headers = authHeaders('application/json')
  const init: RequestInit = { method, headers, credentials: 'omit', cache: 'no-store' }
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body ?? {})
  }
  if (opts.signal) init.signal = opts.signal
  if (opts.keepalive) init.keepalive = true
  let res: Response
  try {
    res = await fetch(withQuery(path, opts.query), init)
  } catch (err) {
    if (isAbort(err)) throw err
    throw new ApiFailure(0, 'unreachable', UNREACHABLE)
  }
  if (res.status === 401 && path !== ROUTES.session) {
    endSession('expired')
    throw new ApiFailure(401, 'unauthorized', 'Your dashboard session has ended.')
  }
  if (!res.ok) throw await failureFrom(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) =>
  request<T>('GET', path, { query, signal })
const post = <T>(path: string, body?: unknown, keepalive?: boolean) =>
  request<T>('POST', path, { body, keepalive })

export interface SearchesQuery {
  before?: number | undefined
  after?: number | undefined
  limit?: number | undefined
  hidden?: boolean | undefined
}

export const api = {
  /** Exchange the single-use login code for a session token (no auth). */
  session: (code: string) => post<SessionResponse>(ROUTES.session, { code }),
  overview: (days: number, signal?: AbortSignal) => get<Overview>(ROUTES.overview, { days }, signal),
  searches: (q: SearchesQuery, signal?: AbortSignal) =>
    get<SearchPage>(
      ROUTES.searches,
      { before: q.before, after: q.after, limit: q.limit, hidden: q.hidden },
      signal,
    ),
  search: (id: number, signal?: AbortSignal) => get<LogDetail>(ROUTES.search(id), undefined, signal),
  rules: (signal?: AbortSignal) => get<RuleListing[]>(ROUTES.rules, undefined, signal),
  addRule: (input: AddRuleInput) => post<RuleListing>(ROUTES.rules, input),
  removeRule: (req: RemoveRuleRequest) => post<RuleListing[]>(ROUTES.removeRule, req),
  explain: (req: ExplainRequest) => post<ExplainResponse>(ROUTES.explain, req),
  suggestions: (signal?: AbortSignal) => get<SuggestionItem[]>(ROUTES.suggestions, undefined, signal),
  approveSuggestion: (id: number) => post<RuleListing>(ROUTES.approveSuggestion(id)),
  rejectSuggestion: (id: number) => post<{ ok: true }>(ROUTES.rejectSuggestion(id)),
  /** Sites seen in several searches and never opened (the last 30 days unless `days` says otherwise). */
  review: (signal?: AbortSignal, days?: number) => get<ReviewList>(ROUTES.review, { days }, signal),
  /** "This site is fine": stop listing it. */
  dismissReview: (domain: string) =>
    post<ReviewSiteResponse>(ROUTES.dismissReview, { domain } satisfies ReviewSiteRequest),
  /** List a dismissed site again (the Undo of a dismissal). */
  restoreReview: (domain: string) =>
    post<ReviewSiteResponse>(ROUTES.restoreReview, { domain } satisfies ReviewSiteRequest),
  engines: (signal?: AbortSignal) => get<EngineStatus[]>(ROUTES.engines, undefined, signal),
  probeEngines: () => post<EngineStatus[]>(ROUTES.probeEngines),
  settings: (signal?: AbortSignal) => get<SettingsView>(ROUTES.settings, undefined, signal),
  patchSettings: (patch: SettingsPatch) => post<SettingsView>(ROUTES.settings, patch),
  doctor: (signal?: AbortSignal) => get<DoctorReport>(ROUTES.doctor, undefined, signal),

  lists: (signal?: AbortSignal) => get<ListStatus[]>(ROUTES.lists, undefined, signal),
  listCatalog: (signal?: AbortSignal) => get<ListCatalogEntry[]>(ROUTES.listCatalog, undefined, signal),
  /** Subscribes and downloads; a failed download comes back in `lastError`, not as an error. */
  addList: (input: AddListInput) => post<ListStatus>(ROUTES.lists, input),
  setListMode: (id: string, mode: ListMode) =>
    post<ListStatus>(ROUTES.listMode(id), { mode } satisfies ListModeRequest),
  /** One list; can take up to a minute. `force` accepts a copy the shrink guard refused. */
  updateList: (id: string, force = false) =>
    post<ListUpdateResult[]>(ROUTES.updateList(id), (force ? { force } : {}) satisfies ListUpdateRequest),
  /** Every enabled list with an address. */
  updateLists: () => post<ListUpdateResult[]>(ROUTES.updateLists, {} satisfies ListUpdateRequest),
  /** Returns the list as it was (for Undo). Built-in lists answer 400: turn them off instead. */
  removeList: (id: string, opts?: { keepalive?: boolean }) =>
    post<ListStatus>(ROUTES.removeList, { id } satisfies RemoveListRequest, opts?.keepalive),

  /**
   * Open the live stream (ADR-0004 point 5). `fetch()` rather than EventSource, because
   * EventSource can't send the Authorization header. The caller reads and closes the body.
   */
  openStream(after: number, signal: AbortSignal): Promise<Response> {
    return fetch(withQuery(ROUTES.stream, { after }), {
      headers: authHeaders('text/event-stream'),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
  },
}
