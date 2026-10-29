# spences10/mcp-omnisearch
> Ref: `research/refs/mcp-omnisearch` @ 736fcc0 (2026-10-27) · License: **MIT** (`LICENSE`, "Copyright (c) 2025 Scott Spence"). One LICENSE file at the root; `package.json` `"license": "MIT"`; no per-directory exceptions (`find -iname 'LICENSE*'` returns only the root file). Short snippets with attribution are fine.

## Purpose
A single stdio MCP server (npm `mcp-omnisearch` 0.2.1, `package.json`) that puts **Tavily, Brave, Kagi, Exa, GitHub, Linkup and Firecrawl behind four tools**: `web_search`, `github_search`, `ai_search`, `web_extract` (`README.md` "Tools"; `src/server/tools/*.ts`). It is the most actively maintained of our three nearest competitors (last commit 2 days before this note; `CHANGELOG.md` shows a steady patch cadence). Why it matters to search-hole:
1. It is the reference for **tool consolidation** and **key-less provider skipping**, two things §4 "MCP tool surface" asks us to get right.
2. It is the first competitor that already speaks the **stateless MCP `2026-07-28` protocol** (`CHANGELOG.md` 0.0.29 "1b801ea"; `src/mcp-server.test.ts`).
3. It shows exactly what we differentiate on. It has **no rules, lists, merging across engines, logs, dashboard or receipts**. The model picks one provider per call and gets that provider's raw list back.

## Architecture sketch
```text
index.ts ─ validate_config() (logs which *_API_KEY env vars exist)
         └ create_mcp_server()  (src/mcp-server.ts)
              ├ McpServer from `tmcp` 1.20.1 + ValibotJsonSchemaAdapter
              ├ initialize_providers()  → 4 ProviderRegistry instances (one per tool)
              ├ register_tools()        → only tools whose registry.size > 0
              └ setup_handlers()        → 2 resources (provider status / info)
         └ new StdioTransport(server).listen()   (@tmcp/transport-stdio 0.5.1)
tool handler ─ registry.require(provider) → provider.search()/process_content()
             └ handle_tool_result() → handle_large_result() → JSON text content
provider     ─ parse operators → build request → http_json() (global fetch)
             └ valibot parse_provider_response() → normalized SearchResult[]
             └ wrapped in retry_with_backoff()
```
- Not built on the official SDK. It uses **`tmcp`** (`package.json` deps `tmcp ^1.20.1`, `@tmcp/adapter-valibot`, `@tmcp/transport-stdio`). `CHANGELOG.md` 0.0.x "0c1d3da: swap mcp/sdk with tmcp".
- Schemas use **valibot**, not zod (`src/server/tools/schemas.ts`).
- There is no HTTP transport in the repo: the code ships stdio only (`src/index.ts`; no HTTP transport package in `package.json`). `docs/large-results.md` and `docs/troubleshooting.md` do talk about "remote HTTP/container" clients, but `docs/deployment.md` is only about client config, secret handling and self-hosted Firecrawl.

## Key modules and data flow
| Module | Role |
|---|---|
| `src/config/env.ts` | Reads every key **at module import** (`export const TAVILY_API_KEY = process.env.TAVILY_API_KEY`, …) and holds a static `config` tree with per-provider `base_url` and `timeout` (Brave 10 s, Kagi 20 s, Tavily/Exa 30 s, Tavily crawl/map 150 s, Firecrawl 60–120 s). |
| `src/server/provider-definitions.ts` | A declarative table: `{id, name, category, api_key, api_key_name, tools, modes, capabilities, create}` for 4 web-search, 3 AI, 1 GitHub and 10 processing (provider × mode) entries. |
| `src/server/provider-registry.ts: ProviderRegistry` | Registers a definition only when it has a non-empty key. It always records a `ProviderStatus` (`available`/`unavailable`, `unavailable_reason: 'missing_api_key'`). |
| `src/server/tools/{web-search,ai-search,github-search,web-extract}.ts` | One tool each. The `provider` enum is built **at startup from the registered ids**. |
| `src/server/tools/responses.ts: handle_tool_result` | try/catch → `create_json_tool_response` (pretty JSON) or `create_error_tool_response` (`isError: true`). |
| `src/common/results.ts: handle_large_result` | Size gate: in the default `file` mode, a result whose pretty-printed JSON exceeds 80,000 chars goes to a temp file (`inline` mode returns it whole). |
| `src/common/search-operators.ts` | A regex operator parser (`site:`, `-site:`, `filetype:`, `before:`, `after:`, `"exact"`, `+term`, `-term`, `AND/OR/NOT`, …) plus `build_query_with_operators`. |
| `src/common/{http,errors,retry,provider-response}.ts` | `http_json` (fetch, then JSON parse with a raw-text fallback), HTTP-status-to-typed-error mapping, exponential backoff with jitter, and valibot response validation. |
| `src/server/handlers.ts` | Resources `omnisearch://providers/status` and the template `omnisearch://providers/{provider}/info`. |

Data flow for `web_search`: the args are validated by the valibot schema (domain regex, `limit` 1–50). Then `providers.require(provider)` runs and `provider.search(params)`, which parses operators out of `query`, merges the explicit `include_domains`/`exclude_domains` with the operator-derived ones, calls the API, validates the response shape, and maps it to `SearchResult[]`. `handle_large_result` then runs, and the result is returned as one `text` content item holding `JSON.stringify(payload, null, 2)`.

## Data model and storage
- **No persistence at all.** There is no DB, cache or log store. The only file I/O is the large-result temp file (`src/common/results.ts`: `writeFileSync(join(tmpdir(), \`mcp-${provider_name}-${file_id}.txt\`))`). It is written with the default mode, so on most systems the umask makes it world-readable (inferred).
- Normalized result (`src/common/types.ts: SearchResult`): `{title, url, snippet, score?, source_provider, metadata?: Record<string, unknown>}`. Provider-specific extras go into `metadata`: Exa `publishedDate`/`author`/`highlights`, and Tavily `favicon`/`request_id`/`usage.credits`/`auto_parameters`.
- Processing result (`ProcessingResult`): `{content, raw_contents?: [{url, content}], metadata: {title, author, date, word_count, failed_urls, urls_processed, successful_extractions, extract_depth}, source_provider}`.
- Errors (`ProviderError`): `type` is one of 8 `ErrorType` values (`API_ERROR, AUTH_ERROR, RATE_LIMIT, INVALID_INPUT, TIMEOUT, MALFORMED_RESPONSE, PROVIDER_ERROR, TRANSIENT_PROVIDER_ERROR`), plus `provider` and `details {status, code, reset_time, retryable, cause}`.

## Config format
- **Environment variables only**: `TAVILY_API_KEY, BRAVE_API_KEY, KAGI_API_KEY, GITHUB_API_KEY, EXA_API_KEY, LINKUP_API_KEY, FIRECRAWL_API_KEY`, optional `FIRECRAWL_BASE_URL` (self-hosted Firecrawl), and `OMNISEARCH_LARGE_RESULT_MODE=inline|file` (`src/config/env.ts`, `src/common/results.ts`).
- One key can light up several providers. For example, `TAVILY_API_KEY` enables `tavily` search, `tavily_research`, and `tavily:extract|crawl|map` (`provider-definitions.ts`).
- Keys are normalized by stripping whitespace and one pair of matching surrounding quotes (`src/common/validation.ts: normalize_api_key`, regex `^(['"])(.*)\1$`). That cheaply fixes the common `KEY="abc"` paste error.
- `server.json` (MCP Registry schema `2025-12-11`) declares every key with `"isRequired": false, "isSecret": true`, so registry-aware installers know the keys are optional secrets.
- `README.md` recommends `${VAR}` expansion in client configs. `docs/deployment.md` covers secret managers and the companion installer **MCPick** (`npx mcpick add … --client … --scope project`, with `--dry-run --json`).

## Extension points (plugins, hooks)
- Adding a provider means a class implementing `SearchProvider {name, description, search(params)}` or `ProcessingProvider {process_content(url|urls, depth, options)}` plus one entry in `provider-definitions.ts`. The registry, the status resource and the enum all derive from that table (`CHANGELOG.md` 0.0.26 "3490c8d: Centralize provider definitions…").
- `web_extract` routes on a composite key, `make_processing_provider_key(provider, mode)` → `"firecrawl:crawl"`. Each provider declares one `default_mode: true` entry (`provider-definitions.ts` lines 161–275).
- There are no runtime plugins or hooks. `AGENTS.md` even forbids new providers without maintainer approval.

## Rules / lists: parsing and compilation
There are no user rules or lists. The closest thing is the **query-operator layer** (`src/common/search-operators.ts`):
- `parse_search_operators` applies 16 regexes **in object-key order**, removing each match from the query. `exclude_site` is listed before `site` so `-site:` wins. `apply_search_operators` folds them into `SearchParams {include_domains, exclude_domains, file_type, date_before, date_after, exact_phrases, location, …}`.
- **Per-provider compilation** (matrix in `docs/search-operators.md`, summary in `docs/provider-selection.md`):
  - **Brave/Kagi: passthrough.** `build_query_with_operators` re-serializes everything into the query string. Includes become `site:a OR site:b`, excludes become `-site:x`, dates become `before:`/`after:`.
  - **Tavily: translate to API fields.** Domains become `include_domains`/`exclude_domains`. `after:`/`before:` become `start_date`/`end_date`, normalized `YYYY`→`YYYY-01-01` and `YYYY-MM`→`YYYY-MM-01` (`tavily/index.ts: normalize_tavily_date`). Quoted phrases set `exact_match: true` and are re-appended. `loc:` becomes `country`, with aliases `uk/us/usa` (`normalize_tavily_country`).
  - **Tavily silently drops the rest.** `parse_search_operators` removes every operator from the base query, and the Tavily adapter re-appends only the quoted phrases. So `filetype:`, `intitle:`, `inurl:`, `inbody:`, `inpage:`, `lang:`, `+term`, `-term` and `AND/OR/NOT` never reach Tavily, although `docs/search-operators.md` says they are "left in sanitized query". Nothing tells the model. Our push-down compiler must report dropped constraints in the receipt.
  - **Exa: no operator parsing.** Only `sanitize_query` (newlines to spaces) runs, plus the `includeDomains`/`excludeDomains` arrays.
- Quirks worth noting for our own parser: the `exclude_term` regex `-([^\s:]+)` and `force_include` regex `\+([^\s]+)` have no word-boundary guard. A hyphenated word like `state-of-the-art`, or `c++`, would plausibly be split into exclusions or forced terms (inferred; not covered by `src/common/search-operators.test.ts`).

## Testing strategy
- **Vitest 5** via `vite-plus` (`vp test`). There are 35 `*.test.ts` files with ~122 `it(` cases, co-located with the sources.
- **Network is mocked by stubbing global `fetch`**: `vi.stubGlobal('fetch', vi.fn(async () => json_response({...})))` (e.g. `src/providers/search/brave/index.test.ts`). Env keys are toggled with `vi.stubEnv` plus `vi.resetModules()` because config is read at import time.
- **Contract tests** (`src/server/tools/contract.test.ts`): a fake `server.tool` collector asserts that *no key ⇒ no tools*, and that a given key set yields exactly `['web_search','github_search','ai_search','web_extract']`. It also runs `v.safeParse` against the registered schema (an empty query, a bad domain, limit 51, an unknown depth, or an unconfigured provider `kagi` must all be rejected).
- **Protocol tests** (`src/mcp-server.test.ts`): `server.receive({jsonrpc, id, method, params: {_meta: {...2026-07-28...}}})` checks `server/discover` (`supportedVersions: ['2026-07-28']`, `resultType: 'complete'`, `_meta['io.modelcontextprotocol/serverInfo']`), `tools/list`, `resources/read`, an unknown tool returned as `isError` (not a JSON-RPC error), and an unsupported protocol version returned as JSON-RPC error **`-32022`**.
- Retry tests inject `random` so the jitter is deterministic (`src/common/retry.test.ts`).
- CI (`.github/workflows/ci.yml`): Node 24 only, then `pnpm run check` (lint plus `tools/check-advisories.ts`, which warns when non-test files exceed 300 lines), test and build.

## UX patterns worth copying
- **A status resource that is secret-safe and truthful** (`src/server/handlers.ts`). `omnisearch://providers/status` returns overall `operational | degraded | unavailable`, per-category available/unavailable counts, and per provider `{status, api_key_name, unavailable_reason, tools, modes, capabilities}`. It shows the *name* of the missing env var, never its value. This is a good model for our `doctor` output and the dashboard's engine panel.
- **Actionable error strings**: the `require()` failure lists what *is* available (`Provider "x" is not available. Available: brave, exa`), and `web_extract` lists the valid modes per provider (`web-extract.ts` line 125).
- **An async job handle in a normal result**: `tavily_research` returns a result whose snippet tells the model to call again with `research_id` (`src/providers/ai-response/tavily-research/index.ts: pending_result`). This is a cheap, host-agnostic "come back later" pattern, close to how our `receipt` tool takes `receiptIds`.
- **Docs split by operator concern**: `docs/provider-selection.md` (a "provider choice cheatsheet"), `docs/search-operators.md`, `docs/large-results.md`, and `docs/troubleshooting.md` (a symptom → cause → fix table).

## Performance tricks
- Startup is trivial because there is no I/O besides env reads, and providers are instantiated lazily via `create()` only when a key exists.
- `limit` is capped at 50 by the schema. Exa asks for `contents.text.maxCharacters: 3000`. There is no other output shaping.
- No concurrency control, caching or connection reuse beyond Node's global `fetch` defaults (inferred from `src/common/http.ts`).
- **Timeouts are inconsistent.** Brave and Kagi pass `AbortSignal.timeout(config…timeout)`, but **Tavily and Exa search pass no signal** (`src/providers/search/tavily/index.ts` lines 164–175; `exa/index.ts` lines 85–98), so their 30 s config values are dead (the GitHub, Exa-contents and Exa-similar adapters have none either). Combined with `retry_with_backoff` (3 retries with delays of 1 s, 2 s and 4 s, ±20 % jitter, `src/common/retry.ts`), one Brave call can block for up to ~4 × 10 s + 7 s.

## License and what it means for us
MIT with no carve-outs. We may copy code with attribution (keep the copyright line in NOTICE/third-party licenses). In practice we will only borrow small ideas: the registry/status shape, the error taxonomy, the operator-to-API mapping table and the protocol test style. Our stack is zod 4 plus the official SDK v2, not valibot plus tmcp, so verbatim reuse is unlikely anyway.

## Implications for search-hole
- [mcp-tool-surface] **Measured cost.** I reconstructed the JSON Schemas from the valibot definitions and measured compact JSON, estimating tokens as chars/4 (real tokenizers on JSON are closer to chars/3):

  | Tool | Description chars | Params (required) | `tools/list` JSON chars | ≈ tokens |
  |---|---|---|---|---|
  | `web_search` | 340 | 12 (`query`, `provider`) | 2,245 | 560 |
  | `web_extract` | 306 | 9 (`url`, `provider`) | 1,955 | 490 |
  | `ai_search` | 288 | 5 (`query`, `provider`) | 1,199 | 300 |
  | `github_search` | 203 | 5 (`query`) | 1,056 | 265 |
  | **Total** | 1,137 | | **≈ 6,455** (±5 %, depends on whether annotations are counted) | **≈ 1.6k (up to ~2.1k at chars/3)** |

  - The shared parameter descriptions in `schemas.ts` add up to ~950 chars.
  - The domain regex (`DOMAIN_PATTERN`, ~75 chars) appears twice per search schema.
  - **`large_result_mode`'s 187-char description is repeated in all 4 tools (~750 chars, ~190 tok)**.
  - Our ≤ 1.5k-token budget for 4–5 tools is achievable only if we keep the per-parameter descriptions short and push guidance into server `instructions` and the skill.
- [mcp-tool-surface] **The `provider` argument is *required*** in `web_search`/`ai_search`/`web_extract` (`v.picklist(provider_names)` with no `v.optional`). The model must pick an engine on every call, and there is no fan-out or fallback. Our `search` keeps `engines` optional, and routing is deterministic from the profile (§5 step 2). Copy the *dynamic enum* idea for `engines` (list only healthy, configured engines), not the required argument.
- [mcp-tool-surface] The tool descriptions mention all four providers **statically**, even when only one is configured (the string literal in `web-search.ts` line 50), while the enum is dynamic. If we mention engines at all, generate that text from the registry.
- [engine-adapter] **Key-less skipping is a registry concern, not a tool concern.** `ProviderRegistry.register` skips any definition with an empty or whitespace key, records `status:'unavailable', unavailable_reason:'missing_api_key'`, and logs each missing key once per `api_key_name`. A tool with zero providers is **not registered at all** (`if (providers.size === 0) return;`). For us: SearXNG is key-less but *URL-gated*, so the same registry needs a reason enum wider than `missing_api_key` (`no_endpoint`, `unhealthy`, `quota_exhausted`, `suspended`). Keep `search` registered even with zero healthy engines, so it can return the "run `searchhole doctor`" error (§5.1) instead of silently vanishing.
- [engine-adapter] Declarative `capabilities: ['domain_filters','operator_passthrough'|'operator_translation','semantic_search']` per definition (`provider-definitions.ts`) is a good start on the §5.2 "every adapter declares capabilities" requirement. We need it typed (booleans and enums), plus `dateFilter`, `goggles`, `publishedDates` and a `retention` policy.
- [engine-adapter] A push-down mapping we can reuse as a checklist:
  - **Brave** (`src/providers/search/brave/index.ts`): `GET /res/v1/web/search?q&count`, header `X-Subscription-Token`. Domains can only be expressed in the query (`site:`/`-site:`). Omnisearch **ignores `time_range` for Brave** (no `freshness` param is sent), even though the tool description says time range "applies when supported".
  - **Kagi v1** (`kagi/index.ts`): `POST https://kagi.com/api/v1/search {query, limit}`, Bearer auth. Results sit under `data.search[]` mixed with non-result rows (the `is_kagi_search_result` filter). Snippets are HTML-encoded with `<strong>` (`clean_snippet`). Date and domain operators are passed through in the query.
  - **Tavily** (`tavily/index.ts`): `POST /search` with `include_domains`/`exclude_domains` arrays, `time_range`, `start_date`/`end_date`, `exact_match`, `country`, `search_depth basic|advanced|fast|ultra-fast`, `topic general|news|finance`, and `include_usage` (credits). The default `max_results` is **5** even though the schema says "default: 10".
  - **Exa** (`exa/index.ts`): `POST /search` with `type:'auto'`, `includeDomains`/`excludeDomains`, and `contents.text.maxCharacters: 3000`. It sends both an `x-api-key` and a Bearer header. No date filter is used, although Exa supports one (inferred).
- [date-extraction] Among the `web_search` adapters, only Exa's `publishedDate` survives normalization (into `metadata`). The Brave adapter parses only `title/url/description` (`brave_search_response_schema`), so it **drops `age`/`page_age`**. Tavily's `published_date` is not mapped. Our adapters must treat engine-supplied dates as the first link of the §7 chain, so the response schemas must include them.
- [merge-algorithm] No cross-provider merge exists. The model sees one engine's ranking verbatim. This is the clearest gap our RRF + rules pipeline fills.
- [security] **No local fetching**: `web_extract` delegates to the Tavily/Firecrawl/Exa APIs, and URL validation is just `v.url()` + `^https?://` (`schemas.ts: http_url_schema`). So there is no SSRF guard, and **internal or private URLs a model passes are forwarded to a third-party API** (inferred privacy leak). Our `fetch` stays local behind the §12.4 guard.
- [security] Query hygiene is a newline strip only (`sanitize_query`). There is no secret or hostname scanning. Our §12.4 scanner is a real differentiator.
- [security] Large-result temp files go to `os.tmpdir()` with default permissions and are never cleaned up (`src/common/results.ts`). If we ever offload, write under `~/.searchhole` with `0600` and a TTL.
- [mcp-tool-surface] **Output limits**: the only guard is the 80,000-char threshold (`MAX_SAFE_TOKENS = 20000`, `CHARS_PER_TOKEN = 4`). Above it, the default `file` mode returns `{file_path, total_lines, estimated_tokens, sections[], read_hint}`, and the hint tells the model to use its Read tool with `offset`/`limit`. That only works for local stdio clients that share a filesystem (`docs/large-results.md`). Below 80k chars **nothing is trimmed**: an Exa call with `limit: 10` can return ~30k chars of `snippet` text (`maxCharacters: 3000` each), and pretty-printing adds whitespace. Our §4 limits (≤ ~2.5k tokens for `search`, ≤ ~8k plus a `cursor` for `fetch`) are an order of magnitude tighter, and the cursor design is portable to remote hosts, unlike file offload.
- [dual-protocol] tmcp 1.20.1 answers stateless `2026-07-28`: `server/discover` returns `supportedVersions: ['2026-07-28']` only, `resultType` is on results, and unknown versions get `-32022` (`src/mcp-server.test.ts`). I could not check whether it still accepts a 2025-style `initialize` (tmcp is not vendored in the refs), and its tests only exercise the 2026 `_meta` path. So this shows a competitor advertising 2026-only on `server/discover`, not that it dropped 2025 clients. Our dual-protocol ADR should test both paths explicitly, and copy the `-32022` unsupported-version case into our protocol suite.
- [testing] Copy the **contract test by key matrix** (which tools and enum values appear for which env), the **protocol tests through an in-process `receive()`** with 2026 `_meta`, and **injectable randomness for backoff**. Add what they lack: recorded fixtures per engine and a mock engine server (§12.3).
- [key-storage] Keys are read once at import time (`src/config/env.ts`), so changing a key needs a restart (`docs/troubleshooting.md` "Set the provider key and restart"). Our resolution order (host env → process env → own store) should be evaluated per call or on a watched change, so `doctor`'s "paste a key" works without restarting the host.
- [ui-ux] The status resource's `operational/degraded/unavailable` roll-up plus "missing env var NAME" is the minimum our dashboard engine panel and `doctor` should show.
- [distribution] `server.json` for the MCP Registry, with `environmentVariables[].isSecret`, plus a version-sync script (`package.json` `sync-server-json`). We should ship a `server.json` too and test that the versions match (one-search-mcp has such a test). The sync script alone is not enough: in this ref `server.json` still says `0.1.0` while `package.json` is `0.2.1`.
- [other] Error mapping (`src/common/errors.ts: normalize_provider_http_error`): 400/422 → `INVALID_INPUT`, 401 → "Invalid API key", 403 → "API key does not have access to this endpoint", 408 → `TIMEOUT`, 429 → `RATE_LIMIT`, 5xx → `TRANSIENT_PROVIDER_ERROR`. The tool error payload is `{error, type, provider, retryable}` with `isError: true`. **429 is retried up to 3× with 1 s / 2 s / 4 s backoff (±20 % jitter)**, because `retry_with_backoff` treats `RATE_LIMIT` as retryable. For paid engines with quotas, we should suspend the engine instead (§5.1).

## Borrow / avoid
**Borrow**
- The registry pattern: one declarative definitions table drives registration, status, enums and docs (`src/server/provider-definitions.ts`, `provider-registry.ts`).
- Secret-safe status reporting by env-var *name* with a reason code (`handlers.ts`).
- Key normalization that strips surrounding quotes (`validation.ts: normalize_api_key`).
- Valibot/zod validation of every engine response, failing as a typed `PROVIDER_ERROR` ("Malformed `<provider>` response"; `common/provider-response.ts`; the `MALFORMED_RESPONSE` enum value exists in `types.ts` but is never thrown), plus the `CHANGELOG` lesson to keep the schemas *lenient* (`nullish`, filter non-result rows), because providers change shapes often (0.0.27, 0.0.28, 0.2.1 entries).
- The operator-to-API translation table for Tavily (dates, `exact_match`, `country`), as test cases for our push-down compiler.
- A typed error taxonomy with a `retryable` flag in tool error output.
- Protocol tests that drive the server in-process with 2026 `_meta`, including the `-32022` unsupported-version case.

**Avoid**
- A required `provider` argument and model-chosen routing with no fallback.
- Static provider lists in descriptions, and the same long parameter description repeated across tools.
- File-path offload as the default large-result strategy (host-specific, world-readable `/tmp`, never cleaned). Use cursors.
- Pretty-printed JSON as the only content. Return compact text plus `structuredContent` and an `outputSchema` (omnisearch has neither, per `grep outputSchema|structuredContent src` → none).
- Retrying 429/quota errors on paid APIs, and missing timeouts on some adapters.
- Reading keys only at import time.

## Verification
- Date: 2026-10-29. Checked against `research/refs/mcp-omnisearch` @ 736fcc0. Claims checked: 112 (license header and section, every Implications bullet, and the mechanism claims they rely on: tool counts and sizes, registry behaviour, per-provider request shapes, operator parser, retry and timeout numbers, protocol tests, error mapping).
- License confirmed: one root `LICENSE` (MIT, "Copyright (c) 2025 Scott Spence"), `package.json` `"license": "MIT"`, no per-directory license files. No GPL/AGPL/EUPL code is pasted in this note.
- Tool-surface table re-measured from `src/server/tools/*.ts` and `schemas.ts`. Description lengths (340/306/288/203), parameter counts (12/9/5/5), required fields, the 187-char `large_result_mode` description and the ~953-char shared description total all match. My own JSON Schema reconstruction gives 6.3–6.7k chars (≈ 1.6–1.7k tokens), so the note's ≈ 6,455 / ≈ 1.6k holds within ±5 %.
- Corrections:
  1. `docs/deployment.md` does not cover remote use (it covers MCPick, secret handling and self-hosted Firecrawl); remote/HTTP caveats are in `docs/large-results.md` and `docs/troubleshooting.md`. Fixed.
  2. The operator matrix lives in `docs/search-operators.md`, not `docs/provider-selection.md`. Fixed.
  3. Added: Tavily silently drops unmapped operators (`filetype:`, `intitle:`, `lang:`, `±term`, `AND/OR/NOT`) because the parser strips them and only quoted phrases are re-appended, contradicting the docs. Matters for our push-down compiler and receipts.
  4. "429 is retried 3× immediately with backoff" was self-contradictory. Now: up to 3 retries at 1/2/4 s with ±20 % jitter.
  5. `parse_provider_response` throws `PROVIDER_ERROR`; the `MALFORMED_RESPONSE` enum value exists but is never thrown. Fixed in Borrow.
  6. "This is evidence that competitors are moving to 2026-only" overreached: the test only shows `server/discover` advertising `['2026-07-28']` and exercises only the 2026 path. Softened.
  7. Size gate row: the 80,000-char temp-file offload applies only in `file` mode (the default). Clarified.
  8. Timeout bullet: the missing `AbortSignal` also applies to the GitHub and Exa-contents/similar adapters. Added.
  9. "Only Exa's `publishedDate` survives" scoped to the `web_search` adapters (GitHub keeps `pushed_at` as `last_push`, `exa_answer` keeps citation dates).
  10. `server.json` is at version 0.1.0 while `package.json` is 0.2.1, so the sync script alone does not keep them aligned. Added to the distribution bullet.
