# agentgateway/agentgateway
> Ref: `research/refs/agentgateway` @ a94094d (2026-10-28) · License: **Apache-2.0** (root `LICENSE`; `Cargo.toml` line 52 `license = "Apache-2.0"`). No `NOTICE` file. Per-directory exceptions:
> - `crates/pool/LICENSE` is **MIT** ("Copyright (c) 2023-2025 Sean McArthur", a hyper-util pool fork), even though `crates/pool/Cargo.toml` inherits the workspace license
> - `crates/cel-fork/cel/Cargo.toml` declares `license = "MIT"` (a cel-rust fork; no LICENSE file in that dir)
> - `crates/htpasswd-verify-fork/Cargo.toml` is Apache-2.0
> - `crates/agentgateway/src/cel/mod.rs` header: "Portions ... heavily inspired from ... Kuadrant/wasm-shim ... Apache 2.0"
>
> Governance: Linux Foundation series project (`CHARTER.md`). Full checkout (2,916 files).

## Purpose
A Rust data-plane proxy for agent traffic: an **LLM gateway** (OpenAI-compatible, budgets, failover), an **MCP gateway** (federates many MCP servers behind one endpoint: stdio/SSE/Streamable HTTP/OpenAPI upstreams, OAuth, authorization), and an **A2A gateway**. It is configured from a local YAML file (hot-reloaded) or a Kubernetes control plane over xDS (`README.md`; `architecture/configuration.md`). It has a built-in admin UI on `localhost:15000` with request logs stored in SQLite or Postgres.

Why it matters to search-hole:
1. It is the most complete reference for **MCP protocol-version handling across the `2026-07-28` break**. It speaks both eras on one endpoint and documents *why* it does not translate between them (`crates/agentgateway/src/mcp/README.md`).
2. Its **CEL policy engine** shows how to compile user expressions once, extract what each needs, and explain decisions. These patterns carry over to our rules engine even though we won't use CEL.
3. It ships **SQLite (WAL) request logs + SSE live tail + budgets with an upsert-delta table**, the same local-first storage shape we plan.
4. Its **outlier detection** (EWMA health, eviction with multiplicative backoff, Retry-After parsing across vendor headers) maps one-to-one onto engine suspension.

## Architecture sketch
```text
config.yaml (watched, 250ms debounce) ─┐        xDS control plane (k8s) ─┐
                                        ▼                                 ▼
                       NormalizedLocalConfig ──► shared IR stores (binds, policies, backends, discovery)
                                                          │
 client ─► bind(port) ─► listener ─► route (match) ─► policies ─► backend
                                       │                 │          ├─ ai (LLM providers, groups, health/eviction)
                                       │                 │          ├─ mcp { targets[stdio|sse|mcp(streamable)|openapi] }
                                       │                 │          └─ a2a / http / tcp
                                       │                 └─ jwtAuth, apiKey(+budgets), mcpAuthentication, mcpAuthorization (CEL),
                                       │                    localRateLimit (CEL key), guardrails, extAuthz, extProc, cors, csrf
                                       └─ frontendPolicies: tracing (OTLP), accessLog (stdout/OTLP/database)
 RequestLog ──► stdout access log │ OTLP logs/traces │ request_logs DB (single writer thread, batched)
 admin server 127.0.0.1:15000 ─► /ui (embedded React app) + /api/{config,logs/*,cel,costs,budgets}
```
The MCP relay (`mcp/handler.rs` `Relay`) fans a request out to the selected targets and merges results with per-method merge functions (`merge_initialize`, `merge_discover`, `merge_prompts`, …). Tool and prompt names are prefixed `{target}_{name}` when multiplexing (`DELIMITER = "_"`, `handler.rs` lines 37, 69-71).

## Key modules and data flow
| Module | Role | Evidence |
|---|---|---|
| MCP version gate | `protocol_version_header`, `validate_request_protocol`: parse `MCP-Protocol-Version`, reject unknown versions, enforce modern-request rules | `crates/agentgateway/src/mcp/streamablehttp.rs` lines 444-530 |
| Modern/legacy split | `is_modern_version(v) = v >= ProtocolVersion::STANDARD_HEADERS`; `REMOVED_METHODS_2026_07_28 = [initialize, ping, logging/setLevel, resources/subscribe, resources/unsubscribe]` | `mcp/mod.rs` lines 111-127 |
| Merge on initialize / discover | Legacy: forward as-is (single target) or take the **lowest** protocol version across upstreams and merge instructions. Modern `server/discover`: forward untouched (single) or **intersect** `supportedVersions` (multiplexed) | `mcp/handler.rs: merge_initialize`, `merge_discover` (lines 853-975) |
| Upstream client | Gateway → upstream uses `ProtocolVersion::V_2025_11_25` as its client version | `mcp/session.rs: get_client_info` (line 1187) |
| Sessions | `SessionManager` (stateful, stateless, legacy SSE); stateless mode wraps `initialize; send` per request; session state can be AES-encrypted into the client-visible session id | `mcp/session.rs`, `http/sessionpersistence.rs: SessionState::encode` |
| MCP Apps | rewrites `ui://` URIs when multiplexing (`ui://{target}+{rest}`), rewrites both `_meta.ui.resourceUri` and the deprecated flat `ui/resourceUri` | `mcp/apps.rs` |
| MCP authN | PRM at `/.well-known/oauth-protected-resource{path}`, `WWW-Authenticate: Bearer resource_metadata=…`, modes `Strict|Optional|Permissive`, IdP quirk adapters | `mcp/auth.rs`; `types/agent.rs: McpAuthenticationMode` (line 3158) |
| MCP authZ | `McpAuthorizationSet.validate(resource, method, cel)` per tool/prompt/resource/task; list results filtered | `mcp/rbac.rs` |
| DNS rebinding | opt-in Host/Origin localhost check | `mcp/dns_rebinding.rs` |
| CEL | `Expression::new_strict` / `new_permissive`, attribute extraction, `ContextBuilder`, optimizer | `crates/policy-core/src/expression.rs`, `crates/agentgateway/src/cel/mod.rs`, `crates/celx/src/optimize.rs` |
| Authorization rules | `RuleSet{allow, deny, require}` evaluation order | `http/authorization.rs: validate` (lines 254-274) |
| Health/eviction | `Policy::eviction_decision`, EWMA health `ALPHA = 0.3`, `DEFAULT_EVICTION_SECS = 3` | `http/health.rs`, `types/loadbalancer.rs` (lines 1002-1180) |
| Retry-After parsing | `retry_after(status, headers)` only on 429 | `http/outlierdetection.rs` |
| Budgets | in-memory counters + pending deltas flushed every 5 s to `budget_usage` | `http/budget/{mod.rs,database.rs,sqlite_schema.sql,sqlite_upsert.sql}` |
| Request log DB | crossbeam channel → dedicated writer thread → batched insert; search/get/tail/analytics queries | `telemetry/log_store.rs`, `telemetry/log_store/sqlite.rs`, `sqlite_migrations/*.sql` |
| Access log fields | OTel semconv + `mcp.*` + `gen_ai.*` fields | `telemetry/log.rs` (lines 1800-2060), `telemetry/semconv.rs` |
| Agent session detection | `request.agent.session` from well-known headers | `http/session.rs: detect` |
| Hot reload | `watch_config_file` → `reload_config_after_change`; failure keeps previous state | `state_manager.rs` (lines 150-330), `util.rs: watch_files_with_options` (250 ms debouncer) |
| Admin UI/API | axum router; SSE tail; config read/write with generation check | `ui.rs` (lines 100-140, 1198-1260) |

**Request flow for an MCP `tools/call`:**
1. Version gate (`validate_request_protocol`). For a modern header version: removed or unknown methods → **404 MethodNotFound**. A missing `_meta.protocolVersion` → InvalidParams. Header ≠ body version → `VersionMismatch`. A body-only modern version without the header → `InvalidProtocolVersion` (`streamablehttp.rs` lines 470-530).
2. `mcpAuthentication` (JWT) → `mcpAuthorization` (CEL with `mcp.tool.name`, `jwt.*`, `apiKey.*`) → `localRateLimit` (token bucket keyed by CEL, for example `apiKey.client + "/" + mcp.tool.target + "/" + mcp.tool.name`, `examples/mcp-keyed-rate-limit/config.yaml`).
3. Resolve the target from the prefixed name (or list every target when `prefixMode: never`) → forward → guardrails per method phase (`mcp/guardrails/phase.rs`) → merge → log.
4. On rate limit (`Error::RateLimited`) the JSON-RPC error uses code `RESOURCE_EXHAUSTED` and carries `data: {limit, remaining, retryAfterSeconds}` (`mcp/mod.rs` lines 317-336). That is a good shape for our spend-cap and suspension tool errors.

## Data model and storage
- **SQLite connection** (`crates/agentgateway/src/database.rs`): `create_if_missing(true)`, `journal_mode(Wal)`, `synchronous(Normal)`, `busy_timeout(5s)`, pool `DEFAULT_MAX_CONNECTIONS = 5`. A `postgres://` URL switches to Postgres.
- **`request_logs`** (`telemetry/log_store/sqlite_migrations/0001_create_request_log_schema.sql`):
  - columns: `id TEXT PK, started_at, completed_at, duration_ms, trace_id, span_id, http_status, error, gen_ai_operation_name, gen_ai_provider_name, gen_ai_request_model, gen_ai_response_model, input_tokens, output_tokens, total_tokens, cost REAL, agentgateway_user, agentgateway_group, user_agent_name, has_payload INTEGER, attributes_json TEXT NOT NULL`
  - indexes are all `(<dimension>, completed_at DESC, id DESC)`
  - prompt/completion content lives in **`request_log_payloads(log_id PK REFERENCES request_logs(id) ON DELETE CASCADE, request_prompt_json, response_completion_json)`**
  - migration `0002` does `ALTER TABLE … ADD COLUMN` for five metrics, then **backfills them from `attributes_json` with `json_extract`**, which is how to promote a JSON attribute to a column later
  - migrations run via `sqlx::migrate!` with a custom table name (`sqlite.rs: SqliteLogStore::from_pool`)
- **Writer**: `RequestLogStore.emit` pushes onto an unbounded crossbeam channel. One thread (`request-log-db-writer`, current-thread tokio runtime) drains up to `DEFAULT_LOG_STORE_BATCH_SIZE = 16384` per batch ("Testing shows this to achieve a pretty good throughput for both postgres and sqlite") inside one transaction, chunked multi-row INSERTs, and drains on shutdown (`log_store.rs` lines 160-330, `sqlite.rs: insert_batch`).
- **Queries**: `search` (newest first, keyset cursor `(completed_at, id)` encoded as an opaque string), `get`, `tail` (`WHERE completed_at > c OR (completed_at = c AND id > i) ORDER BY completed_at ASC, id ASC LIMIT n`), `analytics_summary` (histogram buckets) (`sqlite.rs` lines 124-316).
- **No retention/pruning found** (`grep retention|prune|DELETE FROM` in `log_store.rs`/`sqlite.rs` → nothing).
- **Budgets** (`http/budget/sqlite_schema.sql`): `budget_usage(budget_id TEXT PK, window_start INTEGER, window_end INTEGER, unit TEXT, used_amount INTEGER CHECK (used_amount >= 0), updated_at INTEGER)`. Money is integer **nanodollars** (`NANODOLLARS_PER_USD = 1_000_000_000`, `http/budget/mod.rs`). The upsert adds deltas inside the same window, resets on a new window, and ignores stale older-window writes (`sqlite_upsert.sql`, Apache-2.0, ≤10 lines):
  ```sql
  ON CONFLICT(budget_id) DO UPDATE SET ...
      used_amount = CASE
          WHEN excluded.window_start = budget_usage.window_start
            AND excluded.window_end = budget_usage.window_end
            AND excluded.unit = budget_usage.unit
          THEN budget_usage.used_amount + excluded.used_amount
          ELSE excluded.used_amount END, ...
  WHERE excluded.window_end >= budget_usage.window_end OR <window length changed>;
  ```
- **Config store** "hybrid" mode materializes file config plus DB-stored resources. UI writes carry an expected **generation**, and a stale one returns HTTP 409 `GenerationConflict` (`ui.rs: ensure_expected_generation`, `with_generation_retry`; `config_store.rs`).

## Config format
- YAML or JSON with a schema header for editor completion: `# yaml-language-server: $schema=https://agentgateway.dev/schema/config` (every `examples/*/config.yaml`). The JSON Schema is generated from Rust types via a schemars fork (`Cargo.toml` line 2) into `schema/config.json`, plus a rendered field reference `schema/config.md` (10,126 lines), `schema/cel.json` / `cel.md` (CEL context) and `schema/metrics.md`.
- Two shapes:
  - Shorthand `mcp: {port, policies, targets[], prefixMode}` (`examples/mcp-basic/config.yaml`).
  - Full `binds[].listeners[].routes[].backends[]` with `policies` at each level and `frontendPolicies` (`examples/mcp-telemetry/config.yaml`).
- Tiers (`architecture/configuration.md`):
  - **static** (env/flags, once at startup: ports, logging)
  - **local** (file, hot-reloaded, full feature set, may fetch JWKS/files)
  - **xDS** (remote, no fetching, near 1:1 with the user API)

  Policies point *up* to the thing they attach to, and precedence/merging happens at runtime.
- Policy examples:
  - `mcpAuthorization.rules: ['mcp.tool.name == "echo"', 'jwt.sub == "test-user" && mcp.tool.name == "get-sum"']` (`examples/mcp-authorization/config.yaml`)
  - `localRateLimit.conditional[{condition, type: requests, maxTokens, tokensPerFill, fillInterval, key}]` (`examples/mcp-keyed-rate-limit/config.yaml`)
  - `apiKey.keys[].budgets[{name, limit{unit: USD|Tokens, amount}, window{rolling: "24h"}, onBudgetExceeded: Audit|Block}]` (`schema/config.md` lines 461-468)
  - `health{unhealthyExpression, eviction{duration, restoreHealth, consecutiveFailures, healthThreshold}}` (lines 824-830)
  - `config.logging{filter, fields{add, remove}, level, format, database{url, maxConnections}}` (lines 113-122)
  - `frontendPolicies.accessLog{preset: otel, filter, add, remove, otlp{…}, database{llm: metadata|full, add}}` (lines 1661-1681)
- Env expansion inside the file (`types/local.rs: expand_env`, called from `state_manager.rs: config_content`). Secrets serialize as `"<redacted>"` (`crates/core/src/serdes.rs: ser_redact`).
- **Hot reload** (`state_manager.rs: watch_config_file`):
  - `notify-debouncer-full` with **250 ms** (`util.rs` line 80)
  - re-watches when an editor replaces the file (test `reloads_when_vim_replaces_watched_file_before_debounce`)
  - on parse/apply error it **keeps the previous state**, sets gauge `agentgateway_config_synchronized=0` and records the error string (`reload_config_after_change`)

## Extension points (plugins, hooks)
- Envoy-protocol callouts: `extAuthz`, `extProc` (`http/ext_authz.rs`, `http/ext_proc.rs`). Remote rate limit (`remoteratelimit.rs`). Guardrail webhooks.
- **Custom CEL functions** registered from definitions (`cel/mod.rs: register_custom_functions`). Their transitive attribute needs are installed before compilation (`policy-core/src/expression.rs: install_custom_function_attributes`).
- **MCP guardrails per method** with phase `Off|Request|Response|Full`. Expression processors return `Pass | Reject(ErrorData) | Rewrite(Json)` (`mcp/guardrails/phase.rs`, `mcp/guardrails/expression.rs`).
- Target `condition` (CEL) chooses which upstream MCP servers participate in a request (`mcp/README.md` "Target conditions").
- OpenAPI → MCP tool upstream (`mcp/upstream/openapi/`).
- Debug tracer: a task-local `DebugTracer` that only records when active (`proxy/dtrace.rs`: `tokio::task_local! { static ACTIVE }`, `is_active()`, `trace(|t| …)`).

## Rules / lists: parsing and compilation
- **Compile once, at config time.** `Expression::new_strict` compiles with `agent_celx::DefaultOptimizer`, then derives an `attributes: FlagSet<Attributes>` from referenced paths. `request.body*` → `Request|RequestBody`, `llm.prompt` → `Llm|LlmPrompt`, `mcp.*` → `Mcp`, and so on (`policy-core/src/expression.rs: attributes_for`). Calling `variables()` marks *all* attributes. Local file config is parsed **strict**: a bad expression fails the load (`impl Deserialize for Expression`).
- **Permissive mode for remote config.** `new_permissive` replaces an uncompilable expression with `fail("the expression … could not be compiled")`, so it *fails at evaluation* instead of silently passing, and returns the compile error for reporting.
- **Pay only for what you use.** `ContextBuilder` unions the attributes of every registered expression. The request snapshot and body buffering happen only if some expression needs them (`cel/mod.rs: maybe_snapshot_request`, `maybe_buffer_request_body`). Log-only expressions can observe bodies lazily (`register_log_expression`). Documented false negative: `request["body"]` is not detected (`architecture/cel.md`).
- **Optimizer specializations** (`crates/celx/src/optimize.rs`):
  - `s.matches("<literal>")` → precompiled `regex::Regex` (`precompiled_matches`)
  - `cidr("<literal>")` → parsed once
  - `json(x).field` → `jsonField(x, "field")`

  Rust `regex` is linear-time, so CEL `matches` is ReDoS-safe here.
- **Authorization precedence** (`http/authorization.rs: RuleSets::validate`): **any deny → deny; any failing require → deny; any allow → allow; else default = allow if no allow rules exist (denylist semantics) or deny if allow rules exist (allowlist semantics)**. `Deny` mode is documented as "not recommended because expression failures fail to deny; prefer Allow or Require" (lines 132-139).
- **Explain mode.** When debug tracing is active, every rule is re-evaluated **without short-circuit** to produce `AuthorizationRuleResult{name: original_expression, matched, mode}` (lines 276-300). There is no cost when tracing is off.
- **Deterministic pattern precedence** for method patterns (`mcp/guardrails/phase.rs: resolve`): exact > prefix wildcard (`tools/*`) > suffix wildcard (`*/list`) > `*`; the longer pattern wins within a kind; ties are broken alphabetically "so resolution is deterministic".

## Testing strategy
- `mcp/mcp_tests.rs` (9,746 lines) covers the protocol matrix by name:
  - `modern_client_multiplex_mixed_servers_falls_back_to_legacy_initialize`
  - `old_client_multiplex_mixed_servers_uses_legacy_session_flow`
  - `modern_removed_and_unknown_methods_return_404`
  - `streamable_http_validates_protocol_version_header`
  - `legacy_meta_client_capabilities_are_stripped`
  - `modern_meta_tasks_capability_is_forwarded`
  - `mrtr_direct_server_request_fails_modern_call_cleanly`
  - `modern_stateful_streamable_http_does_not_use_sessions`
  - `stateless_multiplex_tool_call_initializes_only_target`
- Mocks for every external dependency: `src/test_helpers/{extmcpmock,ratelimitmock,oteltracemock,extauthmock,extprocmock,proxymock,credprovidermock}.rs`.
- `tests/validate_examples.rs` validates **every `examples/*/config.yaml`** with the `--validate-only` logic. Tests needing Keycloak are gated by `KEYCLOAK_AVAILABLE`.
- Fuzzing: `fuzz/fuzz_targets/{cel_expression,llm_request_conversions,proxy_protocol}.rs` with corpora (`fuzz/README.md`). Benchmarks with `divan` (`cel/benches.rs: bench_compile`, `bench_execute_snapshot`; `crates/celx/benches/cel_bench.rs`).
- UI (`ui/package.json`): `node --test 'src/**/*.test.ts'`, Playwright e2e (`ui/tests/e2e/ui.spec.ts`), and **visual regression** with a capture/compare/report harness (`ui/tests/visual-regression/`).
- Unit tests sit next to code (`dns_rebinding.rs` tests for `localhost:8080`, `[::1]`, `evil.com`; `health.rs` table tests of `eviction_decision`).

## UX patterns worth copying
- **Logs page** (`ui/src/pages/Logs.tsx`, 2,951 lines):
  - a **stream toggle** that opens `POST /api/logs/tail`, read as SSE via `fetch` + `ReadableStream` (not `EventSource`, so filters go in a JSON body and auth headers work) (`ui/src/api/logsApi.ts: streamLogs`)
  - prepends new rows and caps the list at 200
  - filters by analytics dimensions with option lists fetched from the server
  - an expandable row detail with usage, guardrail details and a collapsible conversation
  - a linked-log query param `?log=`
  - analytics timeline and breakdown charts (Recharts) on the same page
- **Server side of tail** (`ui.rs: tail_logs`):
  - polls the DB **every 1 s** from a cursor that starts at "now"
  - sends a `heartbeat` event every 15 s
  - `limit` clamped to 1-500
  - on DB error sends an `error` event and closes

  This is exactly the "tail rowid > last every ~250 ms, push over SSE" design in §4, already working.
- **Raw config editor** (`pages/RawConfig.tsx`, `configMonaco.ts`): Monaco + `monaco-yaml` with the generated schema, a `SchemaHelpPanel`, and **`ConfigDiffDrawer` showing the diff before save**. In hybrid mode file writes are read-only with "Copy this diff and update the configuration file directly" (`components/ConfigDiffDrawer.tsx`).
- **CEL playground**: `pages/Cel.tsx` + `celMonaco.ts` (syntax/completion) + `POST /api/cel` + `celSampleContext.json`. Users test an expression against a sample context. Our analog: a **"test a rule against a URL/result"** box.
- **Home page warnings**: a "UI is exposed without authentication" banner linking to settings (`pages/Home.tsx` lines 234-246) and a config-warnings banner. Also per-client **setup cards** with copy-paste snippets for Claude Code, Claude Desktop, Codex CLI, opencode, Cursor, VS Code Copilot and Windsurf (`pages/ClientSetup.tsx`).
- Stack: Vite 8, React 19.3, TanStack Router 1.170 + Query 5.104, Recharts 3.10, lucide, Geist Sans via `@fontsource` (bundled font), DOMPurify + marked, Biome, TypeScript 7, exact-pinned versions (`ui/package.json`). The UI is **embedded in the binary** and served at `/ui` (`ui.rs: router`, `assets_dir` / `serve_ui_asset`).

## Performance tricks
- Expression compilation and attribute extraction at config load. Request data is captured only when an expression needs it; body buffering is the expensive case (`architecture/cel.md`).
- Constant folding of regex/CIDR literals; precompiled regex objects stored inline in the AST (`celx/src/optimize.rs`).
- A single writer thread with large batches (16,384) and chunked multi-row INSERTs; queries go through the same worker via oneshot channels, so readers never contend with the writer in-process (`log_store.rs: LogStoreMsg::{Record,Search,Get,Tail,…}`).
- Budgets keep in-memory counters and **pending deltas**, flushed every `FLUSH_INTERVAL = 5s` with the additive upsert, so the DB is not touched on every request (`http/budget/database.rs` line 15).
- EWMA health in an `AtomicF64` (lock-free) (`types/loadbalancer.rs: Ewma`).
- Config uses pointer-up resources so a one-field change sends one small message, not the whole route list (`architecture/configuration.md`).

## License and what it means for us
Apache-2.0 (permissive, with patent grant). We **may copy code or short snippets with attribution** and must keep the license text. There is no NOTICE file to carry. Because we write TypeScript, the realistic reuse is **SQL** (the `budget_usage` schema and upsert), **schemas** (the `request_logs` column set), **algorithms** (eviction decision, Retry-After parsing, rule precedence, DNS-rebinding check) and **docs structure**. If we port `outlierdetection.rs` or `dns_rebinding.rs` logic closely, add an attribution line in the file header and `THIRD_PARTY_NOTICES`. `crates/pool` and `crates/cel-fork` are MIT (also fine); we have no reason to touch them. Choosing Apache-2.0 for search-hole (§13.2) would make this attribution the most natural.

## Implications for search-hole
- [dual-protocol] agentgateway proves the **one-endpoint, two-era** design. Legacy clients send `initialize` and get sessions; modern clients send `server/discover` plus per-request `_meta`. It **does not bridge** between eras ("we do not implement this mode", `mcp/README.md`). As a *server* we only need to serve both, which the SDK v2 `serveStdio`/`createMcpHandler` should do. Copy its **validation rules into our conformance tests**:
  - removed methods (`initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, `resources/unsubscribe`) → 404 under a modern header
  - modern request without `_meta.protocolVersion` → InvalidParams
  - header ≠ body version → mismatch error
  - modern version in the body but no `MCP-Protocol-Version` header → error
  - unknown version → `UNSUPPORTED_PROTOCOL_VERSION` with `data.supported`
- [dual-protocol] The test names in `mcp_tests.rs` are a ready-made matrix for our P2 MCP end-to-end suite: old client vs new client, × stdio vs HTTP, × capability stripping, × MRTR (`input_required`) failing cleanly for clients that can't do it.
- [mcp-tool-surface] agentgateway sets `ttlMs: 0` and `cacheScope: Private` on everything it presents, because its policies make responses non-cacheable (`handler.rs: merge_discover`; README "Caching"). Our `tools/list` is static per binary version. Unless descriptions vary by project config, we can advertise a real TTL; if they do vary (per-profile hints), follow agentgateway and use private/0.
- [mcp-tool-surface] MCP Apps: current SDKs emit **both `_meta.ui.resourceUri` and the deprecated flat `ui/resourceUri`**, and hosts fall back to the flat key. Some hosts reject `+` in `ui://` URIs (`mcp/apps.rs` header comments). Emit both keys and keep our `ui://` URIs to `[a-z0-9-/]`. Re-verify against `ext-apps` 2.0.4.
- [session-definition] For **HTTP** transports there is a de-facto header convention (`http/session.rs: detect`):
  1. any `x-<vendor>-session-id`, for example Claude Code's `x-claude-code-session-id`
  2. Codex's `session-id` / `session_id` / `thread-id` / `conversation_id`, only when `User-Agent` starts with `codex`
  3. `x-session-id` (opencode)

  Values must be ≥8 chars of `[A-Za-z0-9_-]`. Stdio has no headers, so this only helps our HTTP mode (dashboard-hosted or v2 remote). Whether Claude Code sends this header on *MCP* HTTP requests (not only LLM API calls) is **unverified**; test it in P2 before relying on it.
- [sqlite-driver] Concrete settings to start from: WAL, `synchronous=NORMAL`, `busy_timeout=5000`, small pool (`database.rs`). One writer queue per process with batched transactions (`log_store.rs`). With several gateway processes on one file we still need `BEGIN IMMEDIATE` plus retry, but batching keeps lock time tiny.
- [upgrades-migrations] Promote JSON attributes to columns with forward-only migrations: `ALTER TABLE ADD COLUMN` then a `json_extract` backfill (`0002_add_request_log_analytics_columns.sql`). Keep an `attributes_json` catch-all so older binaries ignore new fields and newer ones can backfill. Store migration history in a named table (`dangerous_set_table_name`).
- [sqlite-driver] Put large or sensitive content (snippets, page text) in a **child table with `ON DELETE CASCADE`** and a `has_payload` flag, so retention can drop content while keeping decisions and counts (`request_log_payloads`). This matches per-engine retention (Tavily). agentgateway has **no retention job**; we must add one.
- [dashboard-process-model] Copy the SSE tail exactly: cursor `(ts, id)` starting at now, a poll interval (1 s there, our target ≤250 ms), a 15 s heartbeat, limit clamp, and an `error` event then close. The client uses `fetch` streaming with a POST body for filters and keeps a 200-row ring buffer. This works with a separate on-demand `searchhole ui` process reading the shared DB, with no IPC.
- [engine-adapter] Engine suspension algorithm to port:
  - EWMA health (α = 0.3, success = 1, failure = 0)
  - `consecutiveFailures` and/or `healthThreshold` gates; if neither is set, one bad response evicts
  - eviction duration = `Retry-After`-derived value, else configured base, else 3 s, **× (timesEjected + 1)**
  - `timesEjected` resets on the first success
  - `restoreHealth` (e.g. 0.2) on return for gradual recovery
  - count an ejection only when a *new* window starts
  - if all engines are evicted, the load balancer "falls back to returning evicted endpoints" rather than hard-failing (`http/health.rs: eviction_decision` comment, `types/loadbalancer.rs: finish_request`)

  Persist `{health, consecutive_failures, times_ejected, evicted_until, last_error_class}` per engine in `engine_health`.
- [engine-adapter] Port `process_rate_limit_headers` for 429s:
  - `Retry-After` (seconds or HTTP-date)
  - `retry-after-ms`
  - `x-ratelimit-reset` (a value < 30 days is read as seconds, otherwise as a Unix epoch)
  - the smallest of `x-ratelimit-reset-requests|tokens|requests-day|tokens-minute` (durations like `1m30s`, or bare seconds)

  Add Brave/Tavily/Exa-specific headers as adapters reveal them (`http/outlierdetection.rs`).
- [other] Per-engine spend caps: reuse the **`budget_usage` table and upsert** (integer units: queries, or nano-dollars for cost). Check before the call (`used >= limit` → block with `retryAfter = window_end − now` rounded up) and settle after (`http/budget/mod.rs: check`, `settle`). Use `Audit` (soft: record and flag in the receipt) vs `Block` (hard). agentgateway's windows are **epoch-aligned fixed durations, not calendar months** (`budget_window`). Engines bill per calendar month, so we need a calendar-month window kind (UTC; verify per engine). Its check-then-settle allows concurrent overshoot of a few requests; acceptable for query caps, or use litellm's reserve step for strictness.
- [rule-format-precedence] Use the RuleSet ladder as a model for our block/allow semantics: **deny beats require beats allow**, with default denylist semantics when no allow rules exist. Use most-specific-wins pattern matching with a documented, total tie-break (exact > prefix > suffix > catch-all, longer wins, then lexical) for domain and path patterns, so outcomes are deterministic and explainable (`authorization.rs`, `guardrails/phase.rs`). Pins and raise/lower weights still follow §5 step 6.
- [rule-format-precedence] **Strict vs permissive compile.** The user's own `rules.yaml` / `.searchhole.yaml` is strict: a bad rule fails the load with a precise error, and we keep the last good config, per hot reload. A subscribed list is permissive: a bad line becomes a counted, reported no-op (never a silent pass and never a crash), mirroring `new_strict` / `new_permissive`.
- [rule-format-precedence] At compile time, record which *inputs* each rule needs (domain only, path, title/snippet text, date). Evaluate cheap domain rules first and only extract text or dates when some rule needs them (`ContextBuilder` attribute flags).
- [security] List regexes must be ReDoS-safe. agentgateway gets this free from Rust `regex`; in TS we need an RE2-class engine, or restrict list regex syntax and enforce a compile-time complexity limit (inferred from `celx/src/optimize.rs` using `regex::Regex`).
- [security] Borrow `dns_rebinding.rs` semantics for the dashboard:
  - Host must be `localhost`, `127.0.0.1` or `[::1]` (with any port)
  - Origin, if present, must be a bare localhost origin with no userinfo/path/query
  - **reject duplicate Origin headers**
  - reject `Origin: null`

  agentgateway's admin UI has no token by default (no Host/Origin/CSRF checks found in `ui.rs` / `management/admin.rs`); it only shows a warning banner. Our plan's random session token + Host allowlist is stricter.
- [security] Redact secrets by type: `SecretString` + `ser_redact` → `"<redacted>"` in any config dump, and CEL exposes `apiKey.key` / `jwt.rawToken` redacted unless `.unredacted()` is called (`schema/cel.md`). Our config/`doctor` output must never print key values.
- [ui-ux] Config UX: generate a JSON Schema for `rules.yaml` / `.searchhole.yaml` and put a `# yaml-language-server: $schema=` line in templates so VS Code autocompletes. Show a **diff drawer before saving** config from the dashboard. Add a "test rule" playground (`ConfigDiffDrawer.tsx`, `Cel.tsx`).
- [testing] Add a CI test that validates every example config in `docs/` and `lists/` with the same code path as `searchhole rules validate` (`tests/validate_examples.rs`). Fuzz the rule/list parsers (`fuzz/fuzz_targets/cel_expression.rs`). Run Playwright visual regression for the dashboard.
- [other] Observability field names: name log columns after OTel conventions where they exist (`mcp.method.name`, `mcp.session.id`, `gen_ai.tool.name`, `mcp.error.code`, `http.response.status_code`, `trace.id`) so an optional, off-by-default OTLP export later is a mapping, not a rewrite (`telemetry/log.rs`, `telemetry/semconv.rs`). Keep the `config_synchronized` and last-error status idea for rules and lists in the dashboard.
- [key-storage] The config file supports `${ENV}` expansion with secrets redacted on serialization. That is env-only, with no keychain; consistent with our "host env → process env → own store" order, and offers no better store design.
- [other] For a v2 remote connector:
  - PRM path `/.well-known/oauth-protected-resource{path}`
  - `WWW-Authenticate: Bearer resource_metadata="…"`
  - modes Strict/Optional/Permissive (Optional/Permissive never return 401, "which will not trigger clients to initiate an oauth flow")
  - IdP quirk shims: Okta/Keycloak audience query-param workaround, proxied `registration_endpoint` for CORS-less DCR, Entra `resource`-param stripping and injected `code_challenge_methods_supported` (`mcp/auth.rs` lines 440-540)

  **No CIMD support was found** (`grep client_id_metadata_document` → none); we would need it for claude.ai and ChatGPT (§3).

## Borrow / avoid
**Borrow**
- The protocol-version gate rules and the old/new test matrix (`streamablehttp.rs`, `mcp_tests.rs`).
- SQLite settings, a single batched writer, `(ts, id)` keyset cursors, a payload child table with cascade, and ADD COLUMN + `json_extract` backfill migrations.
- An SSE tail endpoint with heartbeat; a `fetch`-stream client with a capped ring buffer.
- The `budget_usage` schema and additive upsert with a stale-window guard; integer money units; Audit vs Block; Retry-After = remaining window.
- EWMA health + consecutive-failure eviction + uncapped multiplicative backoff (we should cap it, e.g. 1 h) + restore-health + "fall back to evicted if all evicted"; multi-vendor Retry-After parsing.
- Deny > require > allow precedence; deterministic most-specific-wins pattern resolution; strict vs permissive compilation; explain mode that re-evaluates without short-circuit only when tracing.
- Compile-time "which inputs does this rule need" flags; precompiled regex literals.
- The DNS-rebinding Host/Origin check (reject duplicate Origin and `null`).
- Hot reload with 250 ms debounce, re-watch on file replacement, keep last good state, expose sync status.
- A generated JSON Schema + `yaml-language-server` header; a config diff before save; a rule playground; a CI test that validates all examples; fuzz targets; visual regression.

**Avoid**
- CEL itself as our user-facing rule language. It is overkill for block/raise/pin rules, a large dependency in TS, and not what Goggles/uBlacklist users know. Keep YAML rules and borrow only the compile and explain ideas.
- An admin UI that is unauthenticated by default, relying on a warning banner.
- No retention on request logs.
- Epoch-aligned 30-day windows for monthly quotas (providers bill by calendar month).
- `ttlMs: 0` / private caching everywhere when our tool list is static (a needless re-list cost), unless descriptions really vary.
- Flattening multiple upstream tool lists with a `{target}_{name}` prefix. Not relevant to us, since we expose our own 4 tools, but a reminder never to proxy other MCP servers' tools into our surface.
- Kubernetes/xDS complexity: we are a single-user local tool.
