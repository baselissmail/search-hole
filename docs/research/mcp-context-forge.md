# IBM/mcp-context-forge
> Ref: `research/refs/mcp-context-forge` @ 1441ce8 (2026-10-28) · License: Apache-2.0 (`LICENSE`; `pyproject.toml` `license = "Apache-2.0"`; Rust workspace `Cargo.toml` `license = "Apache-2.0"`; all 519 files with an SPDX header under `mcpgateway/`, `plugins/`, `mcp-servers/` say Apache-2.0). No per-directory exceptions found. Note: the plugin *framework* itself now lives in the external PyPI package `cpex` (`pyproject.toml`: `cpex>=0.1.4`), which is **not** in the ref; only the gateway-side integration and the built-in plugins are.

## Purpose
"ContextForge AI Gateway" (package `mcp-contextforge-gateway` v1.1.0, Python 3.12/3.13, FastAPI): an enterprise registry + proxy + federation layer for MCP, A2A and REST/gRPC tools, with RBAC/teams/SSO, a plugin/guardrail pipeline, an admin UI, structured logs, metrics rollups and OTEL. For search-hole it is the most complete open example of (a) a pre/post-invoke guardrail pipeline with explicit failure modes, (b) a dual-era MCP server that speaks both 2025-11-25 and the stateless 2026-07-28 revision, and (c) Alembic-based upgrades with multi-process migration locking. It is far heavier than anything we should build.

## Architecture sketch
```
client ──HTTP(S)/SSE/WS/stdio-bridge──► FastAPI app (mcpgateway/main.py)
   middleware stack: protocol_version → auth/rbac → http_pre_request hooks → …
   └► transports/streamablehttp_transport.py  (MCP SDK v2 Server, per-era adapters)
        └► services/{tool,prompt,resource,gateway}_service.py
              ├─ plugin_manager.invoke_hook(TOOL_PRE_INVOKE) ─► cpex TenantPluginManager
              ├─ upstream MCP (UpstreamSessionRegistry, server/discover probe)
              └─ plugin_manager.invoke_hook(TOOL_POST_INVOKE)
   persistence: SQLAlchemy 2 + Alembic (SQLite or Postgres), optional Redis
   admin UI: Jinja templates + HTMX 2 + Alpine (CSP build) + Chart.js + Tailwind
```
- `mcpgateway/translate.py`: bridges stdio ↔ SSE ↔ streamable HTTP in both directions (expose a local stdio server over HTTP, or consume a remote endpoint as stdio).
- `crates/mcp_runtime`: an optional Rust MCP runtime (`docs/docs/architecture/rust-mcp-runtime.md`); `tool_service.py` has a `skip_pre_invoke` path "used by trusted Rust fallback path" (`mcpgateway/main.py:10597`).
- Multi-worker (gunicorn) is a first-class deployment, which drives much of the complexity (Redis-backed plugin invalidation, session affinity: `docs/docs/architecture/session-affinity-alternatives.md`).
- `docs/docs/overview/terminology.md`: the React admin UI lives in a separate repo (`contextforge-web-ui`); the in-repo UI is HTMX.

## Key modules and data flow
Tool call path (`mcpgateway/services/tool_service.py`, ~L5700–7100):
1. Resolve tool + RBAC (shared with dry-run preview via `ToolService._resolve_tool_for_invocation`).
2. Normalize `mcp-session-id` / `x-mcp-session-id` into `x-mcp-session-id` for upstream pool affinity (L5700–5711).
3. `plugin_manager.invoke_hook(ToolHookType.TOOL_PRE_INVOKE, payload=ToolPreInvokePayload(name, args, headers), global_context, local_contexts=context_table, violations_as_exceptions=True)` (L5722). If `pre_result.modified_payload` is set, name/args/headers are replaced.
4. Dispatch to REST/MCP/A2A/gRPC upstream.
5. `TOOL_POST_INVOKE` with `ToolPostInvokePayload(name, result)` (L7068); a modified result is rebuilt into a `ToolResult`, keeping `_meta` unless the plugin set its own.
6. `PluginViolationError` (deliberate denial) is caught, recorded with `_ctl_acc.add_violation(exc, hook="pre")`, and re-raised; `PluginError` (plugin crash/outage) deliberately bypasses that so dashboards can tell "policy denied" from "plugin broken" (comment at L5731–5736).

Hook taxonomy (`plugins/README.md`, `docs/docs/architecture/plugins.md`): HTTP hooks `http_pre_request`, `http_auth_resolve_user`, `http_auth_check_permission`, `http_post_request`; MCP hooks `prompt_pre_fetch`/`prompt_post_fetch`, `tool_pre_invoke`/`tool_post_invoke`, `resource_pre_fetch`/`resource_post_fetch`, `agent_pre_invoke`/`agent_post_invoke`. Planned: `server_pre_register`, `federation_pre_sync`.

Dry-run: `POST /tools/preview/{name}` (`mcpgateway/main.py:5895`, schema `ToolPreviewResponse` in `mcpgateway/schemas.py:2297`) validates args, reports the dispatch target, annotations, `pre_hooks_run[]` and `warnings[]` (code `hook_not_previewed`). Only plugins tagged `preview_safe` run during preview (`plugins/AGENTS.md:127`).

Log flow: Python logging → `services/log_storage_service.py: LogStorageService` (in-memory) and `services/structured_logger.py` → `StructuredLogEntry` rows; the admin UI reads `/api/logs/*` (`routers/log_search.py`) and an SSE stream `/admin/events` (`admin.py:14871`).

## Data model and storage
- `mcpgateway/db.py` is 7,160 lines; >60 tables. Relevant ones:
  - `tool_metrics` (`ToolMetric`, db.py:2580): one row per invocation `{tool_id, timestamp, response_time, is_success, error_message}`; aggregates computed with SQL.
  - `tool_metrics_hourly` (db.py:2721): `{tool_id, tool_name, hour_start, total/success/failure_count, min/max/avg, p50/p95/p99_response_time}` with `UniqueConstraint(tool_id, hour_start)`. Retention: raw metrics 7 days fallback, raw deleted 1 h after a rollup exists, rollups kept 365 days (`config.py:2430–2445`).
  - `structured_log_entries` (db.py:6197): `{id, timestamp, correlation_id, request_id, level, component, message, logger, user_id, user_email, client_ip, user_agent, request_path/method, duration_ms, operation_type, is_security_event, security_severity, threat_indicators JSON, context JSON, error_details JSON, performance_metrics JSON, hostname, process_id, thread_id, version, environment, trace_id, span_id}` with composite indexes `(correlation_id,timestamp)`, `(level,timestamp)`, `(component,timestamp)`, `(operation_type,timestamp)`, `(trace_id,timestamp)`. `log_retention_days = 30` (config.py:2488).
  - `observability_traces`/`observability_spans`/`observability_events` (db.py:2873–3067): a trace/span model with `attributes` JSON; trace retention 7 days (config.py:2193).
  - `tool_plugin_bindings` (db.py:7006): per-tool plugin overrides.
  - `audit_trails`, `security_events`, `permission_audit_log`, `mcp_sessions`, `mcp_messages`.
- SQLite connect pragmas (`db.py:410–431: set_sqlite_pragma`): `journal_mode=WAL`, `busy_timeout={db_sqlite_busy_timeout}` (default 5000 ms, allowed 1000–60000, config.py:3028), `synchronous=NORMAL`, `cache_size=-64000` (64 MB), `foreign_keys=ON`.
- **Migrations / upgrades** (`mcpgateway/bootstrap_db.py`):
  - 122 Alembic revisions in `mcpgateway/alembic/versions/`; 61 uses of `op.batch_alter_table` for SQLite-safe ALTERs.
  - `main()` fast path: `alembic_at_head(conn, cfg)` compares `ScriptDirectory.get_heads()` with the DB's current heads; if equal, skip locking and only run idempotent bootstrap helpers (admin user, roles, resource assignments).
  - Slow path: `advisory_lock(conn)` = Postgres `pg_try_advisory_lock(42424242424242)` with retries, else a `filelock.FileLock` at `tempfile.gettempdir()/mcpgateway_migration.lock` with 300 s timeout; then `command.upgrade(cfg, "head")` on the locked connection.
  - `MCPGATEWAY_SKIP_MIGRATIONS=true` → never migrate; fail fast with `_SchemaNotAtHeadError` if not at head (for init-container deployments).
  - Warns that SQLite + `GATEWAY_REPLICAS>1` gives no cross-container lock (tmp is per container).
  - **No "DB is newer than this binary" handling**: grep for `newer`/`ahead` in `bootstrap_db.py` and `alembic/env.py` finds nothing; an old binary meeting a newer DB will probably hit Alembic's `Can't locate revision` (inferred: `alembic_at_head` returns False when the DB head is unknown to the script directory, so it falls to `command.upgrade`; the `alembic/README.md:158` troubleshooting row documents that error for a deleted/renamed revision, not for a newer DB). Rollback is manual: `alembic downgrade -1`, then deploy the old image (`MIGRATION.md`, "Rollback").
- Background-job ownership (`services/leader_election.py`): `filelock` backend = one primary per host, held for process lifetime and released by the OS on exit; `redis` backend = `SET NX EX` lease + Lua compare-and-renew + if-owner release, follower loop re-acquires on expiry.

## Config format
- Settings: `pydantic-settings` (`mcpgateway/config.py`, 3,800+ lines), env vars / `.env`.
- Plugins: `plugins/config.yaml`:
  - `plugin_dirs`
  - `plugin_settings`: `parallel_execution_within_band`, `plugin_timeout` (120 in the shipped file, 30 in docs), `fail_on_plugin_error: false`, `enable_plugin_api`, `plugin_health_check_interval`, `include_user_info`
  - `plugins[]`: `{name, kind (import path), description, version, author, hooks[], tags[], mode, priority, conditions[], config{}}`
- Plugin manifests: `plugin-manifest.yaml` per plugin (`docs/docs/architecture/plugins.md:391`).

## Extension points (plugins, hooks)
- **Modes** (legacy names → cpex, `mcpgateway/plugins/gateway_plugin_manager.py: _LEGACY_MODE_TO_PLUGIN_MODE`; the semantics below are from `docs/docs/architecture/plugins.md:236-241`, and `resource_filter` confirms that in `TRANSFORM` mode a violation is logged but processing continues, since the cpex implementation is not in the ref):
  - `enforce` → `SEQUENTIAL`: violations *and* plugin errors block
  - `enforce_ignore_error` → `SEQUENTIAL` + `OnError.IGNORE`: violations block, technical errors pass
  - `permissive` → `TRANSFORM`: log violations and errors, continue
  - `disabled`
- **Ordering**: ascending `priority` (lower runs first). Recommended bands: 1–50 security, 51–100 filtering, 101–200 transforms, 201+ logging. Same-priority plugins may run in parallel (`parallel_execution_within_band`). The payload is chained: P1's `modified_payload` feeds P2 (`plugins.md`, "Payload Transformation Chain").
- **Failure modes**: per-plugin timeout wraps every execution, and a timeout is treated as an error according to the plugin's mode. The first blocking violation stops the chain and is returned to the client as an error. `PluginViolation{reason, description, code, details}`; codes map to HTTP statuses in `mcpgateway/plugins/violation_codes.py`, e.g. `DOMAIN_BLOCKED`→403, `CONTENT_TOO_LARGE`→413, `PII_DETECTED`→422, `RATE_LIMIT`→429, `EXECUTION_ERROR`→500.
- **Conditions** (`PluginCondition`: `server_ids, tenant_ids, tools, prompts, resources, user_patterns, content_types`): fields inside one object are ANDed and evaluation is fail-fast; multiple objects are ORed (`plugins.md:244–320`).
- **Writable-field policy** (`mcpgateway/plugins/policy.py: HOOK_PAYLOAD_POLICIES`): a hook may only modify whitelisted fields, e.g. `tool_pre_invoke` → `{name,args,headers}`, `tool_post_invoke` → `{result}`, `resource_pre_fetch` → `{uri,metadata}`. A hook with no policy is subject to `default_hook_policy=deny`.
- **Per-tool bindings**: the manager cache key is `"<team_id>::<tool_name>"`. Tools without bindings share `"<team_id>::*"`. TTL 300 s (`DEFAULT_CACHE_TTL`) bounds staleness if a Redis invalidation is missed (`gateway_plugin_manager.py` header docstring).
- **Implementation patterns** (`plugins.md:545–640`): a method named after the hook, an `@hook(HookType)` decorator, or a custom hook name with its own payload/result types. Lifecycle `initialize()`/`shutdown()`.
- **External plugins**: remote MCP servers that implement the hook tools, plus gRPC and unix-socket transports and mTLS (`docs/docs/using/plugins/{grpc-transport,unix-socket-transport,mtls}.md`).
- Built-ins relevant to us:
  - `plugins/resource_filter/resource_filter.py: _canonical_host`: canonicalizes both sides of a domain block comparison (percent-decoding, lowercase, trailing dot, IPv6 brackets, `host:port`, legacy integer IPs `2130706433`→`127.0.0.1`, IPv4-mapped IPv6, IDNA punycode). Blocks on `host == b or host.endswith("." + b)` (L195).
  - `plugins/citation_validator`: checks link reachability and adds `citation_results {ok,status}`; hooks `resource_post_fetch`, `tool_post_invoke`; `block_on_all_fail`/`block_on_any_fail`.
  - `plugins/robots_license_guard`, `deny_filter`, `regex_filter`, `safe_html_sanitizer`, `html_to_markdown`, `circuit_breaker`, `cached_tool_result`; cpex add-ons `cpex-url-reputation`, `cpex-output-length-guard`, `cpex-secrets-detection` (`pyproject.toml:288–295`; the `cpex` package source is not in the ref, so their behaviour is unverified).

## Rules / lists: parsing and compilation
n/a: no list or subscription format. The closest thing is `resource_filter`'s `blocked_domains` array, canonicalized once in `__init__` into `_blocked_hosts` and checked by linear scan (L136–138, L195), which is fine for tens of entries and unusable for our ~418k-rule lists.

## Testing strategy
- 801 `test_*.py` files across `tests/{unit,integration,e2e,fuzz,migration,security,playwright,load,performance,conformance}`.
- Heavy doctest use: almost every function carries `>>>` examples; `make doctest`, `doctest-coverage`.
- `tests/fuzz/`: JSON-RPC, JSONPath, schema and security fuzzers. `run_mutmut.py` for mutation testing.
- `tests/migration/README.md`: application-level upgrade tests under an **n-2 version policy**. Start the old container, seed data via REST, keep the volume, start the new container, let it auto-migrate, then validate through the API, for both SQLite and Postgres. Includes `test_migration_performance.py` and `test_cross_db_schema_consistency.py`.
- `tests/conformance/baselines/` for spec conformance; Makefile targets for plugin parity, multi-instance primary-worker E2E, and session isolation load tests.

## UX patterns worth copying
- **Log search panel** (`routers/log_search.py: LogSearchRequest`):
  - filters: `search_text, level[], component[], category[], correlation_id, user_id, start/end_time, min/max_duration_ms, has_error`
  - `limit ≤ 1000`, `offset`, `sort_by`, `sort_order`
  - a **correlation trace** view, `GET /api/logs/trace/{correlation_id}` (`admin_ui/logging.js: showCorrelationTrace`), that stitches every log line, span and audit row for one request. This maps directly to "receipt → every search → every result decision".
- **Separate tabs** for security events, audit trails (`requires_review=true`) and performance metrics with an aggregation selector (`admin_ui/logging.js:757–1115`).
- **Product-language translation server-side**: `log_search.py` turns wire `resource_type` values into UI terms (`terminology.md:62`). We should likewise map internal decision codes to human sentences in one place.
- **Dry-run preview with "what ran / what was skipped" warnings**: the model for `searchhole search --explain`.
- **Violation codes with a fixed HTTP-status mapping**: a stable, explainable vocabulary for "why was this hidden".

## Performance tricks
- In-memory log ring buffer (`log_storage_service.py`): a `deque` bounded by bytes (`log_buffer_size_mb = 1.0`, config.py:2180), with secondary indices `entity_key→ids` and `request_id→ids`. Subscribers get `queue.put_nowait`; a full queue (slow consumer) drops the message, a broken one is removed (L261–287).
- SSE fan-out: `/admin/events` merges several service streams into one `asyncio.Queue` and sends `": keepalive\n\n"` after `heartbeat_interval = 15.0` s of silence (`admin.py:14904, 15049`).
- Hourly metric rollups with percentiles plus deletion of raw rows keeps dashboards fast over long ranges.
- Migration fast path (skip lock at head) keeps N-replica restarts cheap.
- Plugin manager instances cached per context with in-flight build deduplication (`_inflight` dict of tasks).

## License and what it means for us
Apache-2.0: we may copy code with attribution and a NOTICE entry, and the patent grant comes with it. Nothing here is copyleft. Practically we would port *ideas* (Python → TypeScript), not code. Short snippets are allowed but unnecessary. The `cpex` framework is a separate package whose license we did not verify, so do not rely on reading it.

## Implications for search-hole
- [mcp-tool-surface] Model our pipeline as named stages with typed pre/post payloads (`search_pre` = query hygiene + profile resolution, `results_post` = rules/lists/annotation, `fetch_pre` = SSRF/robots/blocklist, `fetch_post` = date extraction). Borrow the **writable-field policy** idea (`plugins/policy.py`) so a stage can only change what it owns. Keep it internal in v1 with no third-party plugin loading.
- [rule-format-precedence] Adopt the three-way mode semantics for **lists**: `enforce` (hide), `permissive` (record "would hide" but keep), `disabled`. A newly subscribed list could start in `permissive` ("audit mode") so users see its effect in the dashboard before it hides anything. Evidence: `gateway_plugin_manager.py: _LEGACY_MODE_TO_PLUGIN_MODE`.
- [rule-format-precedence] Record *denial* separately from *rule/list failure*, as context-forge separates `PluginViolationError` from `PluginError` (`tool_service.py:5731`): "hidden by rule X" vs "list Y failed to load, fell back to last good".
- [dual-protocol] Concrete per-era adaptations to copy (`transports/streamablehttp_transport.py`):
  - `_structured_for_caller` drops a non-object `structuredContent` for 2025-era callers and appends its JSON as a text block
  - `_tools_for_caller` strips non-object `outputSchema` for 2025 callers, because the 2025 wire rejects the whole `tools/list`
  - `_relayed_upstream_code` maps retired `-32002` to `INVALID_PARAMS` for modern callers
  - `get_capabilities` omits `logging` for modern callers (SEP-2577)

  Our `search` outputSchema must be an **object** schema so one schema works on both eras.
- [dual-protocol] Validate `MCP-Protocol-Version` on HTTP only (`middleware/protocol_version.py`): a missing header is recorded in request state as the latest version (the handshake-era version in `legacy` mode), but era routing stays header-driven in the SDK, so a headerless request still takes the legacy `initialize` path (module doctest). An unsupported value gets HTTP 400 + JSON-RPC `-32022` with `data{supported[],requested}`. Context-forge also keeps `auto|legacy` kill-switches for inbound and outbound (`config.py:604–620: mcp_inbound_protocol_mode`, `mcp_client_connect_mode`). Ship a similar env escape hatch (`SEARCHHOLE_MCP_PROTOCOL=legacy`).
- [dual-protocol] `server/discover` and list results set `ttlMs` (shortest upstream refresh interval) and `cacheScope="private"` (`_adapt_discover_with_ttl_cache_scope`, L3667). For us: `ttlMs` = time until the next rules/list change could alter the tool set (effectively static, so large), with `cacheScope: "private"`.
- [upgrades-migrations] Copy the shape of `bootstrap_db.main`:
  1. fast "already at head?" probe with no lock
  2. otherwise take a file lock next to the DB (not in `/tmp`; context-forge's tmp lock is its stated multi-container weakness), migrate, run idempotent seeders

  Add what it lacks: an explicit "DB schema newer than me → read-only" branch. Its n-2 upgrade test suite (`tests/migration/`) is the model for our "two gateway versions sharing one DB" mock scenario.
- [sqlite-driver] Pragma set to reuse: WAL, `busy_timeout` 5000 ms, `synchronous=NORMAL`, `foreign_keys=ON` (`db.py:423–431`). A 64 MB cache is overkill per gateway process; use the default or a few MB.
- [other] Background jobs (list refresh): the passive `filelock` primary in `services/leader_election.py` is the simplest correct single-host owner, released by the OS on crash. For short-lived gateways prefer a DB lease row (see docker-mcp-gateway note), but the file lock is a good fallback.
- [dashboard-process-model] Their live log view reads a per-process in-memory buffer (`log_storage_service.py` has no Redis or cross-worker path; `/admin/logs/stream`, `admin.py` ~15471). Redis Pub/Sub is used by `EventService` for the separate `/admin/events` stream of gateway/tool events. A per-process buffer is blind to other workers, which is evidence for our "tail SQLite rows → SSE" design over in-memory buffers (inferred). Reuse the SSE details: a single merged queue, keepalive comments every 15 s, drop-on-slow-subscriber.
- [ui-ux] The correlation-trace view and log search filters are the right primitives for the dashboard's search log ("search → results → decisions → fetches").
- [ui-ux] Hourly rollup tables with p50/p95/p99 plus raw-row retention give the dashboard fast "engine latency over 30 days" charts (`db.py:2721`).
- [security] Port the `_canonical_host` normalization steps into our URL normalizer, applied to both list entries and result hosts (`plugins/resource_filter/resource_filter.py:43`).
- [key-storage] Context-forge encrypts stored credentials with an Argon2id-derived Fernet key from `AUTH_ENCRYPTION_SECRET` (`services/encryption_service.py`: `v2:`-prefixed JSON bundle with KDF params + salt; defaults t=3, m=65536 KiB, p=1). That only moves the problem to an env secret, so it is not a fit for a zero-config desktop tool. Reusable details: version-prefixed ciphertext envelopes and "never use `is_encrypted()` for security decisions".
- [testing] Doctest-style executable examples on public functions and fuzzers for JSON-RPC input are cheap and catch real bugs; in Vitest the equivalent is example-based tests next to the module plus fast-check.
- [mcp-tool-surface] "Virtual servers" (`server_tool_association`, db.py:2534) limit the tool surface by curating subsets per endpoint, and tool names are `gateway_slug + separator + custom_name_slug` (separator `-`, `--`, `_` or `.`, config.py:3304; max name length 128, config.py:3794). For us: no prefixing needed, since we expose our own 4 tools.

## Borrow / avoid
**Borrow**
- Mode triple (enforce / permissive / disabled), applied to rules and lists, with an `enforce_ignore_error` analogue: "block on match, but if the list fails to load, don't block everything".
- Typed decision/violation codes with one central mapping to user-facing text (`violation_codes.py`).
- Dry-run/preview endpoint that lists which stages ran and which were skipped, with warnings (`ToolPreviewResponse`).
- Era adapters for structuredContent/outputSchema/error codes; `MCP-Protocol-Version` validation and its error shape; `ttlMs` + `cacheScope` on discover/list.
- Migration fast path, lock, idempotent seeders; n-2 cross-version upgrade tests.
- `_canonical_host` normalization rules.
- Log schema ideas: correlation_id/trace_id indexes, `duration_ms`, `is_security_event`; the correlation trace view.
- Hourly rollup tables with percentiles and retention knobs.

**Avoid**
- A general plugin framework (external package, Redis invalidation, TTL caches, per-team bindings) in v1. It is the source of most of context-forge's complexity.
- Plugin timeouts of 30–120 s. Our whole gateway overhead budget is 50 ms p95.
- In-memory log buffers as the source for the live dashboard: per-process, lost on restart.
- Lock files in `/tmp` (not shared, cleaned by the OS) and relying on manual `alembic downgrade` for rollback.
- Giant modules (`db.py` 7.2k lines, `admin.py` 20.9k lines) and an HTMX/Alpine admin UI with 1,000+-line JS modules.
- A master-secret-in-env encryption scheme for API keys on a desktop tool.

## Verification
Date: 2026-10-29. Claims checked: 52 (LICENSE and `pyproject.toml`/Cargo license fields, SPDX header count, all 16 "Implications" bullets and the mechanisms behind them: plugin mode mapping, hook payload write policy, violation-code mapping, era adapters in `streamablehttp_transport.py`, protocol-version middleware, `ttlMs`/`cacheScope` derivation, bootstrap/migration lock and fast path, SQLite pragmas, retention defaults, leader election, SSE keepalive, `_canonical_host`, Argon2id envelope, cited line numbers and paths).
Corrections:
- Implication "dual-protocol" (`MCP-Protocol-Version`): "a missing header means the latest version" was incomplete. The middleware only records the latest version in request state; era routing stays header-driven in the SDK, so a headerless request still takes the legacy `initialize` path.
- Implication "dashboard-process-model": the live log view does not use Redis. It reads a per-process in-memory buffer; Redis Pub/Sub belongs to `EventService` for the separate `/admin/events` gateway/tool event stream. The conclusion (prefer tailing SQLite) is unchanged.
- "Newer DB than binary → `Can't locate revision`" is now marked inferred; the README row cited documents the deleted/renamed-revision cause.
- Plugin mode semantics are from docs (cpex source is not in the ref); `resource_filter` confirms the permissive/TRANSFORM behaviour for violations.
- cpex add-on citation fixed (`pyproject.toml:288-295`, not 20-28, which are uv pins); SPDX header count 521 -> 519 files; `admin.py` size 16k+ -> 20.9k lines.
No GPL/AGPL/EUPL code present or pasted (Apache-2.0 throughout; the external `cpex` license remains unverified, as the note already says).
