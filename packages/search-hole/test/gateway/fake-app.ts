// SPDX-License-Identifier: Apache-2.0
/**
 * A scriptable in-memory App for gateway tests. It implements the whole facade contract
 * (src/app/types.ts) and records every call with its RequestCtx.
 */
import type {
  App,
  AppOptions,
  BuiltinFilterResult,
  BuiltinResult,
  FetchArgs,
  FetchOutcome,
  HostProfile,
  Receipt,
  RequestCtx,
  SearchArgs,
  SearchMode,
  SuggestRuleInput,
  SuggestRuleResult,
} from '../../src/app/types.ts'
import { SearchHoleError } from '../../src/shared/errors.ts'
import type { MergedResult, SearchOutcome } from '../../src/shared/types.ts'

export interface Call {
  method: string
  args: unknown[]
  ctx?: RequestCtx
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/** A merged result with sensible defaults. */
export function mergedResult(i: number, over: Partial<MergedResult> = {}): MergedResult {
  const url = over.url ?? `https://docs.example${i}.com/page-${i}`
  return {
    canonicalKey: url,
    url,
    urls: [url],
    title: `Result ${i} title`,
    snippet: `Snippet for result ${i}: a short description of the page.`,
    engines: ['searxng'],
    positions: { searxng: i },
    dates: [],
    sourceType: 'docs',
    registrableDomain: `example${i}.com`,
    fused: 1 / (20 + i),
    adjusted: 1 / (20 + i),
    decision: { visibility: 'kept', weight: { factor: 1 }, preferFactor: 1, matches: [] },
    flags: [],
    ...over,
  }
}

/** A search outcome with `n` results. */
export function searchOutcome(n: number, over: Partial<SearchOutcome> = {}): SearchOutcome {
  return {
    receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA',
    query: 'react compiler',
    profile: 'standard',
    depth: 'standard',
    results: Array.from({ length: n }, (_, i) => mergedResult(i + 1)),
    hidden: [],
    hiddenSummary: { count: 0, byReason: {}, topDomains: [] },
    engines: [{ engine: 'searxng', status: 'ok', latencyMs: 412, returned: n }],
    warnings: [],
    tookMs: 450,
    ...over,
  }
}

/** Fake App options; everything has a default. */
export interface FakeAppOptions {
  mode?: { configured: SearchMode; effective: 'engines' | 'builtin' }
  /** A loop-guard refusal for every built-in WebSearch (ADR-0019). */
  overBudget?: string
  /** What `dashboardUrl` returns (undefined: the method is absent). */
  dashboardUrl?: string | null
  /** Domains the user blocks (used by builtinBlockedDomains, filterBuiltinResults, checkUrl). */
  blockedDomains?: string[]
  /** Domains blocked by a path/regex rule: hidden only after the search (removedPostSearch). */
  postSearchBlocked?: string[]
  /** Domains pinned to the top. */
  pinnedDomains?: string[]
  search?: (args: SearchArgs, ctx: RequestCtx) => Promise<SearchOutcome> | SearchOutcome
  fetch?: (args: FetchArgs, ctx: RequestCtx) => Promise<FetchOutcome> | FetchOutcome
  receipts?: Receipt[]
  suggestion?: SuggestRuleResult
  receiptLine?: string
  guard?: boolean
  /** Throw from these methods. */
  failing?: string[]
}

/** The scriptable fake. */
export class FakeApp implements App {
  readonly version = '0.1.0-test'
  readonly host: HostProfile
  readonly calls: Call[] = []
  closed = false
  opts: FakeAppOptions
  turnSearches = 0

  dashboardUrl?: () => Promise<string | null>

  constructor(appOpts: AppOptions, opts: FakeAppOptions = {}) {
    this.host = appOpts.host
    this.opts = opts
    const url = opts.dashboardUrl
    if (url !== undefined) this.dashboardUrl = async () => url
  }

  private record(method: string, args: unknown[], ctx?: RequestCtx): void {
    this.calls.push(ctx === undefined ? { method, args } : { method, args, ctx })
    if (this.opts.failing?.includes(method)) throw new Error(`fake ${method} failure`)
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method)
  }

  async search(args: SearchArgs, ctx: RequestCtx): Promise<SearchOutcome> {
    this.record('search', [args], ctx)
    this.turnSearches++
    if (this.opts.search !== undefined) return this.opts.search(args, ctx)
    if (args.query.includes('ghp_')) {
      throw new SearchHoleError(
        'query_blocked',
        'Query not sent: it looks like an API key or access token.',
        {
          fix: 'Remove it from the query and search again.',
        },
      )
    }
    return searchOutcome(3, { query: args.query, depth: args.depth ?? 'standard' })
  }

  async fetch(args: FetchArgs, ctx: RequestCtx): Promise<FetchOutcome> {
    this.record('fetch', [args], ctx)
    if (this.opts.fetch !== undefined) return this.opts.fetch(args, ctx)
    const host = hostOf(args.url)
    if ((this.opts.blockedDomains ?? []).some((d) => under(host, d))) {
      return {
        kind: 'refused',
        receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA',
        reason: 'rule',
        message: `${host} is blocked by your rule "block ${host}"`,
        rule: { ruleId: 'r1', tier: 'T1', text: `block ${host}` },
      }
    }
    const text = 'Readable page text. '.repeat(20)
    return {
      kind: 'page',
      receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA',
      requestedUrl: args.url,
      finalUrl: args.url,
      status: 200,
      redirects: [],
      contentType: 'text/html',
      bytes: 4096,
      truncated: false,
      dates: [
        {
          value: '2025-10-07T00:00:00.000Z',
          kind: 'modified',
          method: 'jsonld:dateModified',
          confidence: 'high',
          tzAssumed: false,
        },
      ],
      sourceTitle: 'A page',
      text,
      extraction: 'readability',
      chunk: { start: 0, end: text.length, total: text.length, tokens: 100 },
      sanitized: { invisibleChars: 0, hiddenTextBlocks: 0 },
      fetchedAt: '2026-10-30T00:00:00.000Z',
      untrusted: true,
    }
  }

  async receipt(ids: string[] | undefined, ctx: RequestCtx): Promise<Receipt[]> {
    this.record('receipt', [ids], ctx)
    const all = this.opts.receipts ?? []
    return ids === undefined ? all.slice(0, 1) : all.filter((r) => ids.includes(r.receiptId))
  }

  async suggestRule(input: SuggestRuleInput, ctx: RequestCtx): Promise<SuggestRuleResult> {
    this.record('suggestRule', [input], ctx)
    return (
      this.opts.suggestion ?? {
        suggestionId: 3,
        status: 'queued',
        howToApprove: 'Ask the user to type /search-hole:approve 3, or click Approve in the dashboard.',
      }
    )
  }

  async searchMode(): Promise<{ configured: SearchMode; effective: 'engines' | 'builtin' }> {
    this.record('searchMode', [])
    return this.opts.mode ?? { configured: 'auto', effective: 'builtin' }
  }

  async builtinBlockedDomains(ctx: RequestCtx, query: string): Promise<string[]> {
    this.record('builtinBlockedDomains', [query], ctx)
    return [...(this.opts.blockedDomains ?? [])]
  }

  async filterBuiltinResults(
    query: string,
    results: BuiltinResult[],
    ctx: RequestCtx,
  ): Promise<BuiltinFilterResult> {
    this.record('filterBuiltinResults', [query, results], ctx)
    const blocked = this.opts.blockedDomains ?? []
    const post = this.opts.postSearchBlocked ?? []
    const pins = this.opts.pinnedDomains ?? []
    const kept: BuiltinResult[] = []
    const hidden: BuiltinFilterResult['hidden'] = []
    let removedPostSearch = false
    for (const r of results) {
      const host = hostOf(r.url)
      if (blocked.some((d) => under(host, d))) {
        hidden.push({ ...r, reason: 'rule', rule: { ruleId: 'r1', tier: 'T1', text: `block ${host}` } })
      } else if (post.some((d) => under(host, d))) {
        hidden.push({ ...r, reason: 'list' })
        removedPostSearch = true
      } else {
        kept.push(r)
      }
    }
    const pinned = kept.filter((r) => pins.some((d) => under(hostOf(r.url), d)))
    const rest = kept.filter((r) => !pinned.includes(r))
    this.turnSearches++
    return {
      receiptId: 'rcpt_BBBBBBBBBBBBBBBBBBBBBB',
      kept: [...pinned, ...rest],
      hidden,
      removedPostSearch,
      pinned: pinned.length,
    }
  }

  async checkUrl(
    url: string,
    ctx: RequestCtx,
  ): Promise<{ allowed: true } | { allowed: false; message: string }> {
    this.record('checkUrl', [url], ctx)
    const host = hostOf(url)
    if ((this.opts.blockedDomains ?? []).some((d) => under(host, d))) {
      return { allowed: false, message: `${host} is blocked by your rule "block ${host}"` }
    }
    return { allowed: true }
  }

  async recordBuiltinFetch(url: string, ctx: RequestCtx): Promise<void> {
    this.record('recordBuiltinFetch', [url], ctx)
  }

  async searchBudget(
    query: string,
    ctx: RequestCtx,
  ): Promise<{ allowed: true } | { allowed: false; message: string }> {
    this.record('searchBudget', [query], ctx)
    return this.opts.overBudget === undefined
      ? { allowed: true }
      : { allowed: false, message: this.opts.overBudget }
  }

  checkQuery(query: string): { action: 'ok' | 'block' | 'redact'; query: string; classes: string[] } {
    this.record('checkQuery', [query])
    if (query.includes('ghp_')) return { action: 'block', query, classes: ['api_key'] }
    if (query.includes('10.0.0.'))
      return {
        action: 'redact',
        query: query.replace(/10\.0\.0\.\d+/g, '[redacted]'),
        classes: ['private_ip'],
      }
    return { action: 'ok', query, classes: [] }
  }

  async engineStatus() {
    return []
  }

  async probeEngines() {
    return []
  }

  async rekeySession(
    previousKey: string,
    ctx: RequestCtx,
    source: 'startup' | 'resume' | 'clear' | 'compact',
  ): Promise<{ movedRules: number }> {
    this.record('rekeySession', [previousKey, source], ctx)
    return { movedRules: 0 }
  }

  async openTurn(ctx: RequestCtx): Promise<{ receiptId: string }> {
    this.record('openTurn', [], ctx)
    this.turnSearches = 0
    return { receiptId: 'rcpt_TURNTURNTURNTURNTURNTU' }
  }

  async closeTurn(ctx: RequestCtx): Promise<{ receiptLine?: string; receiptId?: string }> {
    this.record('closeTurn', [], ctx)
    const searched = this.turnSearches > 0
    this.turnSearches = 0
    if (!searched) return { receiptId: 'rcpt_TURNTURNTURNTURNTURNTU' }
    return {
      receiptId: 'rcpt_TURNTURNTURNTURNTURNTU',
      receiptLine: this.opts.receiptLine ?? 'search-hole · 1 search · 3 results · 0 hidden',
    }
  }

  rules = {
    list: async () => [],
    add: async (): Promise<never> => {
      throw new Error('not in the fake')
    },
    remove: async () => [],
    explain: async () => ({ decision: 'kept', lines: [] }),
    trust: async (projectDir: string) => ({ path: projectDir, sha256: '0' }),
  }

  keys = {
    set: async () => ({ backend: 'fake' }),
    status: async () => [],
    remove: async () => {},
  }

  suggestions = {
    list: async () => [],
    approve: async (): Promise<never> => {
      throw new Error('not in the fake')
    },
    reject: async () => {},
  }

  log = {
    recent: async () => [],
    detail: async () => undefined,
  }

  settings = {
    get: async (): Promise<Record<string, unknown>> => {
      this.record('settings.get', [])
      return { hooks: { mode: 'steer', guard: this.opts.guard ?? true, receiptLine: true } }
    },
    setMode: async () => {},
  }

  async doctor() {
    return {
      version: this.version,
      checks: [],
      engines: [],
      paths: { config: '', data: '', run: '', source: '' },
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
