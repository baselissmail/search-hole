# ADR-0009: Engine adapter interface

- **Status:** Accepted (2026-10-30)
- **Related:** [0007](0007-key-storage-and-resolution.md), [0008](0008-rule-format-and-precedence.md), [0010](0010-merge-algorithm-and-weights.md), [0011](0011-date-extraction-chain.md)

## Context

§5.2 requires every adapter to declare its capabilities and a retention policy. §5 step 3 pushes rules down where an engine supports it per request. §5.1 defines the failure matrix and per-engine spend caps. Patterns found:

- **SearXNG** splits pure `request(query, params)` from `response(resp)`, and its suspension is per process and in memory. It increments `continuous_errors` but never uses it. SearXNG-the-service: `json` is off by default (403); the limiter allows 4 API calls per hour per IP; `engines=` and `categories=` are **unioned**; unknown engine names are dropped silently; `language` defaults to the client's `Accept-Language` ([searxng.md](../research/searxng.md)).
- **agent-search** uses a never-throw adapter contract (`{results, upstream_status, upstream_errors, unresponsive_engines, response_time_ms}`) ([agent-search.md](../research/agent-search.md)).
- **agentgateway** evicts with EWMA health, × (timesEjected + 1) backoff and gradual restore, plus a complete rate-limit header parser ([agentgateway.md](../research/agentgateway.md)).
- **litellm** has an error-class → cooldown table, never cools the only deployment on soft signals, keeps an attempted-set across fallbacks, and checks the budget before each hop ([litellm.md](../research/litellm.md)).
- **mcp-omnisearch** skips key-less providers in the registry, with reasons ([mcp-omnisearch.md](../research/mcp-omnisearch.md)).
- **one-search-mcp** swallows errors into `success: true, results: []`, so "empty" can't be told from "broken". It also uses a vendor SDK, so cancellation doesn't work ([one-search-mcp.md](../research/one-search-mcp.md)).
- **Verified engine facts** ([platform-facts-engines-lists-versions.md](../research/platform-facts-engines-lists-versions.md)):

| Engine | Facts |
|---|---|
| Brave | $5 per 1k after a $5 monthly credit (card plus attribution needed); `goggles` inline or as a URL; `freshness` as `pd`/`pw`/`pm`/`py` or a date range; `page_age`; ToS forbids storing beyond transient use |
| Kagi | still public preview; $12 per 1k; transient caching only |
| Tavily | 1k free credits a month; the current ToS has no caching clause |
| Exa | `publishedDate` is an estimate; only browser-style temporary caching |
| Mojeek | `fi`/`fe` ≤ 25 domains; `since`/`before`; `date` is last-modified; Startup plan allows 1-hour caching |
| Marginalia | `public` key works but is rate-limited; non-commercial keys under CC-BY-NC-SA 4.0; no dates |
| DuckDuckGo | no official API |

## Decision

### The port

```ts
interface EngineAdapter {
  id: EngineId                                  // 'searxng' | 'brave' | 'tavily' | 'exa' | 'mojeek' | 'kagi' | 'marginalia'
  capabilities: {
    domainInclude: { max: number } | null       // e.g. Tavily 300, Mojeek 25
    domainExclude: { max: number } | null
    dateFilter: 'none' | { buckets: ('day'|'week'|'month'|'year')[] } | 'range'
    goggles: boolean
    dates: 'none' | 'published' | 'modified' | 'estimated' | 'mixed'
    maxPerCall: number; paging: boolean
    requiresKey: boolean; endpoint: 'fixed' | 'user'   // SearXNG: user-supplied URL
    officialApi: boolean; billed: boolean
    attribution: string | null                  // e.g. "Results from Marginalia Search (CC-BY-NC-SA 4.0)", rendered in receipts
  }
  retention: { log: 'full' | 'metadata' | 'decisions-only', payloadTtlHours: number | null }   // enforced by the store
  defaults: { timeoutMs: number; concurrency: number; retry: RetryPolicy; suspend: SuspendPolicy; overFetch: number }
  setup(cfg: EngineConfig, key: ResolvedKey | null): { active: true } | { active: false; reason: InactiveReason }
  buildRequest(plan: EnginePlan, ctx: AdapterCtx): HttpRequest                 // pure
  parseResponse(res: HttpResponse, ctx: AdapterCtx): ParseOutcome              // pure, never throws
  compilePushdown?(rules: ResolvedRule[], budget: PushdownBudget): Pushdown   // pure; reports pushed + skipped rule ids
}
type ParseOutcome =
  | { kind: 'ok'; results: RawResult[]; upstream?: UpstreamDiag[]; quota?: QuotaInfo; altered?: { query: string } }
  | { kind: 'empty'; upstream?: UpstreamDiag[] }
  | { kind: 'error'; errorClass: ErrorClass; retryAfterMs?: number; detail: string }   // detail ≤ 200 chars, redacted
```

`InactiveReason` = `missing_key | no_endpoint | disabled | spend_cap | suspended | json_disabled | unhealthy`. **`search` stays registered even with zero active engines**, so it can return the "no healthy engine → `searchhole doctor`" error rather than vanishing.

### What the core owns, not the adapter

1. **Transport:**
   - undici, per-engine origin-pinned dispatchers;
   - the key attached only to that origin, and stripped on a cross-origin redirect (ADR-0007);
   - `AbortSignal.any([mcpRequest.signal, timeout])`, so cancellation from the host aborts the fan-out (§ MCP cancellation);
   - redaction;
   - tracing into the event bus (smart-doctor's never-throw HTTP helper: `{ok, status, headers(allowlisted), text, json, durationMs}` or `{ok:false, networkError}`).

   Engine endpoints don't go through the public-web SSRF guard, which would block a local SearXNG. They go through an **exact-origin allowlist** built from config.
2. **Plain HTTP only.** No vendor SDKs, so cancellation, spend caps and redaction always apply.
3. **Error classes as data** (smart-doctor's ranked causes):

| `ErrorClass` | Suspend | Retry | User-facing fix |
|---|---|---|---|
| `offline` (no route, DNS fail for all) | **no** (fail fast, don't poison health) | no | "You appear to be offline" |
| `unreachable` (ECONNREFUSED/ECONNRESET/EHOSTUNREACH to a configured origin while others resolve) | 30 s, no backoff growth | other engine now | "SearXNG isn't running → `searchhole searxng up` or `doctor`" |
| `timeout` | 5 s × backoff | other engine now | — |
| `rate_limited` (429) | `Retry-After` / reset headers, else 180 s | other engine now | "Brave rate-limited; resumes 14:05" |
| `quota` (402, quota body) | until reset or 24 h | other engine | "Monthly quota used" |
| `auth` (401) | until the key changes | no | "Key invalid → `searchhole keys set brave`" |
| `forbidden` (403) | 1 h; **SearXNG 403 → `json_disabled`** (until config changes) | no | "Enable `json` in `search.formats`" |
| `captcha` (SearXNG upstream, HTML challenge) | 1 h | other engine | "Upstream CAPTCHA; consider a keyed engine" |
| `server` (5xx) | 30 s × backoff | once, then other engine | — |
| `malformed` (parse failed) | **no**; flag `adapter_broken` | other engine | "Adapter needs update; please report" |

   - Backoff is `base × 2^(consecutive−1)`, capped at 1 h, and resets on the first success.
   - A **lone** engine is suspended only for explicit signals (429 with reset, auth, quota, json_disabled). Error rate alone never suspends the last engine standing.
   - The rate-limit header parser follows agentgateway's: `Retry-After` in seconds or as a date, `retry-after-ms`, `x-ratelimit-reset*`.
4. **Health is shared, with three states:**
   - **`healthy`:** a successful call (`ok` or `empty`) or explicit probe within the last 10 minutes, and not suspended or capped.
   - **`unhealthy`:** suspended, capped, inactive, or the last attempt failed.
   - **`unknown`:** no attempt yet, or none recent.

   The PreToolUse hook relies on this distinction (ADR-0014).
   - **Storage:** `engine_health(engine, key_fp, sub_engine, state, reason_class, until, consecutive_failures, ewma_success, p50/p95_ms, last_success_at, last_error_redacted, key_present, key_source, updated_at)` lives in SQLite. Every gateway and the dashboard see one truth.
   - **`key_fp`** is the first 8 bytes of HMAC-SHA256(install secret in `meta`, key), so gateways holding *different* keys for one engine (ADR-0007 resolves keys per process) don't poison each other. `auth`, `quota` and `spend_cap` states are per `key_fp`. Key-independent classes (`timeout`, `server`, `unreachable`, `captcha`, IP-based `rate_limited`) are shared across fingerprints. The key and its prefix are never stored.
   - **SearXNG upstream problems** (`unresponsive_engines`, the `Suspended:` prefix, `Server-Timing`) become `sub_engine` rows.
5. **Fallback walk:**
   - the plan's engine list, then the configured fallback chain;
   - an `attemptedEngines` set shared across hops, with `maxFallbacks` = 2;
   - before each hop, a spend-cap and suspension check;
   - retry the *same* engine only with backoff, and fall back to a *different* engine immediately.

   The receipt records `original`, `attempted` and per-hop error classes.
6. **Spend caps:** `engine_usage(engine, period_kind, period_start, count)` is incremented in the same `BEGIN IMMEDIATE` as a reservation *before* the call. Defaults:
   - Brave 900/month (inside the $5 credit), Kagi 200/month, Exa 500/month, Tavily 900/month;
   - every engine 300/day;
   - all user-configurable.

   Hitting a cap makes the engine inactive (`spend_cap`) with a receipt warning. Caps are the guard against a looping agent.
   - Usage is keyed by `(engine, key_fp, period)`.
   - **`engine_usage`'s schema never takes a writer-breaking change**, so even read-only processes (ADR-0006) can reserve.
   - **If the reservation can't be written** (BUSY after the short logging timeout, or any DB error), billed engines get only an **in-memory hard allowance of 20 calls per process per day**, after which they fail closed with `spend_cap`. Free engines proceed. The receipt warns "spend cap not shared (DB unavailable)".
   - Reservations are not refunded on `timeout`, since the call may have been billed. They are refunded only when the connection failed before the request was sent.
7. **Over-fetch:** request `overFetch × wanted`, at most `maxPerCall`: ×2 at standard, ×3 at deep. Brave `count=20` is one billed call.
8. **Pushdown: blocks only, and only when safe.** Pushed rules remove results engine-side, so they are invisible to our log, our raw ranks and replay (ADR-0010). The point is to save quota on billed engines, not to filter.
   - **Setting:** `pushdown: blocks | off` per engine (ADR-0015). The default is `blocks` for billed engines and `off` for SearXNG and other free engines.
   - **Only `block` is pushed, never `raise`, `lower` or `pin`.** Ranks stay raw, and local multipliers are the only weighting, so nothing is applied twice.
   - **Computed per request from the session's resolved tiers:**
     - A block is pushed only if no keep rule (`allow`/`pin`) in any user tier or profile, and no `kind: allow` list, could match a URL in that block's host scope.
     - Any keep rule whose host set isn't literal (regex, wildcard host) disables block pushdown for that request.
     - **Audit-mode lists are never pushed.**
   - **Brave:**
     - `block` → `$discard,site=`, with a budget of 2,000 instructions, user rules first; the 418k-rule list is never pushed;
     - a generic `$discard` is never emitted outside allowlist mode;
     - large goggles go by POST;
     - `web.mutated_by_goggles` is checked and recorded.
   - **Tavily / Exa / Mojeek:** domain exclude arrays within their caps (Mojeek `fe` ≤ 25).
   - **Recording:** each search stores `pushed_rule_ids`. The receipt and `--explain` say "N block rules applied upstream (their hits aren't observable)".
   - **SearXNG:** no hostnames-plugin pushdown in v1. Per request we send `engines=` (without `categories=`, so it doesn't union), `language` always explicit, `time_range`, `safesearch`, and `timeout_limit` (our client timeout is `timeout_limit + 1.5 s`). Engine names are validated against `/config`, and skipped names are reported. Gateways never touch Docker (ADR-0015).
   - **Freshness pushdown only when the profile sets `requireDate: true`**, because engine date filters drop undated results, which conflicts with "flag, don't drop" (§5 step 7). Otherwise we over-fetch and filter locally.
   - **`site:` and `-site:` from the query** (ADR-0012) become include/exclude parameters where supported, and are always enforced locally.
   - **Query hygiene** (ADR-0015 point 4) runs before `buildRequest`.
9. **Retention is enforced by the store, not by trust.** Each adapter's `retention` drives what is written. It follows the evidence's own recommendations ([platform-facts-engines-lists-versions.md](../research/platform-facts-engines-lists-versions.md) §3):
   - **SearXNG, Tavily, Mojeek (Business), Marginalia:** `full`. Marginalia's CC-BY-NC-SA attribution is stored and rendered with its results.
   - **Brave, Kagi, Exa:** `decisions-only`, the default:
     - stored: a URL hash, the registrable domain, rank, decision, rule ids, engine dates and counts;
     - **titles, snippets and full URLs live only in process memory**, for the current turn's receipt and the `search` response;
     - the dashboard shows "details not stored (engine terms)".
     - Whether storing the registrable domain is allowed is an open legal question ([SYNTHESIS §8](../research/SYNTHESIS.md)).
   - **Mojeek (Startup):** `metadata` with a 1 h payload TTL.
   - **Opt-in:** `engines.<id>.storageRights: true` (ADR-0015) switches an engine to `full` for users with a storage-rights plan.
   - **Payloads are stored per engine** (`result_payloads(result_id, engine, title, snippet, url, expires_at)`), each row with its own engine's TTL. The merged "longest title and snippet" (ADR-0010) is picked at read time from rows that haven't expired.

### v1 adapters

- **P1:** SearXNG and Brave.
- **P1.x:** Tavily, Exa, Mojeek, Kagi (marked "preview"; personalization double-applies with our rules, which the receipt notes), and Marginalia.
- **Not shipped:** DuckDuckGo and SerpApi (no official API or terms risk).
- **Per-engine quirks are documented in each adapter's header and covered by fixtures:**
  - Brave: `X-Subscription-Token`, `text_decorations=false`, record `query.altered`;
  - Tavily: always send `include_published_date: true`;
  - Mojeek: always send `date=1`;
  - Marginalia: `api2.marginalia-search.com`, the `API-Key` header, 503 means quota;
  - SearXNG: rank by `score`, store `engines[]` per result.

## Alternatives considered

- **Adapters that do their own HTTP.** Rejected. Cancellation, redaction, caps and SSRF policy would be re-implemented per engine, and some would be forgotten.
- **Per-process in-memory health** (SearXNG, agent-search). Rejected because we have many processes.
- **Throwing adapters.** Rejected. Errors as data give uniform receipts and health.
- **Pushing freshness down by default.** Rejected (point 8).

## Consequences

- Adapters are a pure `buildRequest`/`parseResponse` pair plus fixtures. Contract tests need no network (§12.3), and a nightly optional live job checks real responses.
- The mock engine server (§12.3) implements every error class above as a named scenario.

## Validate early (P1)

- Fixture set: a Brave response with `page_age` and with `mutated_by_goggles: false`; SearXNG 403 (json off) and 429 (limiter); SearXNG `unresponsive_engines` with a CAPTCHA; Marginalia 503; Mojeek `date=1`; a Tavily result with and without `published_date`.
- Spend-cap race: 8 processes, a cap of 100, 200 attempts. Exactly 100 calls go out.
