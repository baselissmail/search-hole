# BerriAI/litellm
> Ref: `research/refs/litellm` @ 96fe78f (2026-10-28) · License: **MIT** for everything outside `enterprise/` (root `LICENSE`: "Portions of this software are licensed as follows: All content that resides under the "enterprise/" directory ... is licensed under ... enterprise/LICENSE ... Content outside ... is available under the MIT license", "Copyright (c) 2023 Berri AI"). **`enterprise/` is proprietary** (`enterprise/LICENSE.md`, "BerriAI Enterprise license ... may only be used in production, if you ... have agreed to ... the BerriAI Subscription Terms"). No other LICENSE files in the checkout.
>
> **Checkout caveat.** This is a sparse, `blob:none` partial clone. Worktree contains only `litellm/router.py`, `litellm/router_utils/`, `litellm/proxy/{spend_tracking,hooks,guardrails}/`, `litellm/caching/`, `litellm/integrations/custom_logger.py`, `litellm/proxy/_types.py`, `litellm/proxy/schema.prisma`, `ui/litellm-dashboard/package.json`. The requested `docs/my-website/docs/proxy/` and `ui/.../view_logs/` paths **do not exist at this commit** (`git ls-tree HEAD docs/my-website` is empty; `view_logs` was renamed to `ui/litellm-dashboard/src/components/logs/`). The `logs/` UI blobs are present in the local object store and were read with `git show HEAD:<path>` (cited below as normal paths). `litellm/constants.py`, `litellm/utils.py`, `litellm/search/`, `litellm/llms/*/search/` and `tests/` are **tree-only** (file names visible via `git ls-tree`, contents not read). Constants such as `DEFAULT_COOLDOWN_TIME_SECONDS` are therefore cited by name, not value.

## Purpose
LiteLLM is a Python SDK plus an OpenAI-compatible proxy ("AI gateway") that routes calls to 100+ LLM providers. The `Router` (`litellm/router.py`, 17,064 lines) does load balancing, retries, cross-group fallbacks and per-deployment **cooldowns**. The proxy adds virtual keys, budgets, rpm/tpm limits, per-request **SpendLogs** in Postgres (Prisma), guardrails, a callback system and a Next.js admin UI.

Why it matters to search-hole:
1. It has the most battle-tested **failure semantics** we can study: which status codes suspend a backend, for how long, after how many failures, and how fallbacks avoid loops. This maps directly onto §5 step 4 (engine suspension, fallback chain) and §5.1.
2. Its **budget machinery** (reserve, then reconcile; calendar-period free-tier counters; per-session iteration caps) is the template for §5.1 "per-engine spend caps" and the looping-agent guard.
3. **It already routes web search.** `Router(search_tools=...)` plus `SearchAPIRouter` (`litellm/router_utils/search_api_router.py`) send `asearch` calls through the same retry/fallback machinery. The git tree has search adapters for `brave`, `searxng`, `tavily`, `exa_ai`, `serper`, `google_pse`, `duckduckgo`, `firecrawl`, `linkup`, `parallel_ai`, `perplexity`, `searchapi`, `dataforseo` (`git ls-tree HEAD litellm/llms/`; each has `search/transformation.py`, base class in `litellm/llms/base_llm/search/transformation.py`). It has no user rules, lists, receipts or freshness, so it is adjacent rather than competing. The search adapters' contents were not read (not in the worktree).
4. Its **SpendLogs schema, redaction rules and logs UI** are a good reference for our `searches`/`results` tables and the dashboard log view.

## Architecture sketch
```text
client ─► proxy (FastAPI) ─ auth (virtual key → UserAPIKeyAuth)
            ├─ CustomLogger.async_pre_call_hook chain   (rate limits, budgets, guardrails pre_call)
            ├─ reserve_budget_for_request()              (spend_tracking/budget_reservation.py)
            └─► Router.async_function_with_fallbacks()
                  ├─ async_function_with_retries()
                  │    ├─ _async_get_healthy_deployments() = all − cooldown set − blocked
                  │    ├─ routing strategy picks one (simple-shuffle | least-busy | usage | latency | cost)
                  │    ├─ CustomLogger.async_pre_call_deployment_hook
                  │    ├─ provider call ──► success: deployment_callback_on_success (+1 success/min)
                  │    │                └─► failure: +1 fail/min, set_cooldown_deployments(), sleep, retry
                  │    └─ should_retry_this_error() decides raise vs retry
                  └─ run_async_fallback() over fallback groups (depth ≤ max_fallbacks)
            ◄─ async_post_call_success_hook / failure_hook
            └─ success/failure logging → SpendLogs row (batched) + daily rollups + callbacks (OTel, Prometheus…)
UI (Next.js 16, React 19) ─► /spend/logs/ui (paginated) ─► logs table + detail drawer
```
State lives in `DualCache` (in-memory tier + optional Redis, `litellm/caching/dual_cache.py`), so cooldowns and counters can be fleet-wide across proxy workers.

## Key modules and data flow
| Module | Role | Evidence |
|---|---|---|
| Router config | `num_retries` (doc: default 2), `max_fallbacks` (comment: default 5), `retry_after` (min wait, default 0), `retry_policy`, `model_group_retry_policy`, `allowed_fails`, `allowed_fails_policy`, `cooldown_time`, `disable_cooldowns`, `fallbacks`, `default_fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`, `provider_budget_config`, `fallback_budget_check`, `enable_health_check_routing` | `litellm/router.py: Router.__init__` (lines 1228-1300) |
| Cooldown decision | `_is_cooldown_required`, `_should_run_cooldown_logic`, `_should_cooldown_deployment`, `should_cooldown_based_on_allowed_fails_policy` | `litellm/router_utils/cooldown_handlers.py` |
| Cooldown store | `CooldownCache` with key `deployment:{id}:cooldown`, TTL = cooldown time | `litellm/router_utils/cooldown_cache.py` |
| Per-minute health counters | `{deployment_id}:successes` / `:fails`, local-only, TTL 60 s | `litellm/router_utils/router_callbacks/track_deployment_metrics.py` |
| Background health | `DeploymentHealthCache`, one dict `deployment_id → {is_healthy, timestamp, reason}`; entries older than `staleness_threshold` read as healthy | `litellm/router_utils/health_state_cache.py` |
| Retry policy | `get_num_retries_from_retry_policy` walks exception MRO; 404 → `NotFoundErrorRetries` first | `litellm/router_utils/get_retry_from_policy.py` |
| Fallback walk | `run_async_fallback`, `AttemptedFallbackTargets`, budget/access check per hop | `litellm/router_utils/fallback_event_handlers.py` |
| No-capacity error | `async_raise_no_deployment_exception` → `RouterRateLimitError(cooldown_time=min remaining, cooldown_list, cooldown_deployments)` | `litellm/router_utils/handle_error.py` |
| Search routing | `SearchAPIRouter.async_search_with_fallbacks` reuses `async_function_with_fallbacks`; picks among same-name tools with `random.choice`; credentials only from tool `litellm_params` | `litellm/router_utils/search_api_router.py` |
| Budgets | `reserve_budget_for_request` / `reconcile_budget_reservation` / `release_budget_reservation` | `litellm/proxy/spend_tracking/budget_reservation.py` |
| Search free tier | per-provider calendar-period counter that zeroes cost under the allowance | `litellm/proxy/hooks/search_free_tier.py` |
| Loop guards | `max_iterations` per session (429), `max_budget_per_session` | `litellm/proxy/hooks/max_iterations_limiter.py`, `max_budget_per_session_limiter.py` |
| Rate limits | Envoy-style limiter in Redis Lua (window + counter + EXPIRE), parallel-slot acquire/release | `litellm/proxy/hooks/parallel_request_limiter_v3.py` (5,925 lines) |
| Spend log row | `get_logging_payload`, `_sanitize_request_body_for_spend_logs_payload`, `_redact_logged_api_key` | `litellm/proxy/spend_tracking/spend_tracking_utils.py` |
| Hooks | `CustomLogger` base class | `litellm/integrations/custom_logger.py` |
| Content filter | regex + keyword + YAML categories, BLOCK/MASK | `litellm/proxy/guardrails/guardrail_hooks/litellm_content_filter/` |

**Failure → cooldown data flow (the part that maps to engine suspension):**
1. `_should_run_cooldown_logic` exits early when cooldowns are disabled, `time_to_cooldown≈0`, the failure is caller-scoped (per-user credential, 401/403 from a token-exchange deployment), the request was rejected before reaching the provider (`MalformedRequestFieldError`, `UnsupportedEndpointError`), or the deployment is a provider default (`cooldown_handlers.py` lines 322-417).
2. `_is_cooldown_required(status)`: **429 → yes; 401, 402, 404, 408 → yes; every other 4xx → no; 5xx / non-HTTP → yes; any error whose string contains `APIConnectionError` → no; unparsable status → yes** (lines 261-307). A local connection failure does **not** suspend the backend.
3. `_should_cooldown_deployment` (v2 logic, lines 464-571). Deployment-level `model_info.allowed_fails_policy`/`allowed_fails` override router-level. Otherwise, with no `allowed_fails` set:
   - 429 on a multi-deployment group → cooldown at once.
   - 100% failures this minute with `total ≥ SINGLE_DEPLOYMENT_TRAFFIC_FAILURE_THRESHOLD` → cooldown.
   - fail rate `> DEFAULT_FAILURE_THRESHOLD_PERCENT` with `total ≥ DEFAULT_FAILURE_THRESHOLD_MINIMUM_REQUESTS` on a multi-deployment group → cooldown.
   - Non-retryable status (`litellm.should_retry(status) is False`) → cooldown.
   - **Single-deployment groups are protected.** No cooldown on 429 or on error rate, and none on 402, unless an explicit per-exception policy says so. Cooling down the only backend just converts errors into "no deployments".
4. Legacy v1 counting (`should_cooldown_based_on_allowed_fails_policy`, lines 742-790): `INCR deployment:{id}:allowed_fails[:{ExceptionType}|:generic]` with TTL = cooldown time; cooldown when count `> allowed_fails`. On a Redis outage it falls back to the worker's local count (`_increment_allowed_fails`).
5. `CooldownCache.add_deployment_to_cooldown` stores `{exception_received (masked to first 50 chars), status_code, timestamp, cooldown_time}` with TTL `cooldown_time` (per-deployment `cooldown_time` in `model_info`/`litellm_params`, else router `cooldown_time or DEFAULT_COOLDOWN_TIME_SECONDS`). The `Router` docstring says "Defaults to 1" but the code uses the constant (`router.py` line 1545); the constant's value is not in the checkout. A Prometheus/alert callback fires (`cooldown_callbacks.py: router_cooldown_event_callback`).
6. Readers compute `remaining = timestamp + cooldown_time − now` and treat ≤0 as expired, also correcting stale in-memory TTLs (`cooldown_cache.py: _corrected_active_cooldown`).

**Retry and fallback.**
- `should_retry_this_error` (`router.py` lines 9302-9361) raises at once for: context-window errors when context-window fallbacks exist; content-policy errors when content-policy fallbacks exist; non-retryable statuses except 401/403; `NotFoundError`; auth errors when there is only one deployment; and any error when no healthy deployments remain. A `RateLimitError` with no healthy deployment but with fallbacks jumps straight to fallbacks.
- `_time_to_sleep_before_retry` (lines 9397-9441) sleeps **0** when other healthy deployments exist. Otherwise it uses `litellm.calculate_retry_after(remaining_retries, max_retries, response_headers, min_timeout=retry_after)`, which honours provider headers (implementation in `litellm/utils.py`, not checked out).
- `run_async_fallback` (`fallback_event_handlers.py` lines 782-930):
  - stops at `fallback_depth ≥ max_fallbacks`
  - skips the failed group and already-attempted targets (`AttemptedFallbackTargets` shared by reference across hops, so cyclic fallback graphs cannot loop)
  - awaits `_is_fallback_target_authorized` and `_is_fallback_target_within_budget` before each hop
  - stamps `original_model_group`, `model_group` and `attempted_fallbacks` into metadata, and adds `x-litellm-attempted-fallbacks` / `x-litellm-attempted-retries` / `x-litellm-max-retries` / `x-litellm-fallback-errors` response headers (`add_retry_fallback_headers.py` lines 270-342)
  - raises the **last** error if every hop fails

## Data model and storage
Postgres via Prisma (`litellm/proxy/schema.prisma`, 2,133 lines, 103 models). Relevant models:

| Model | Key fields | Why we care |
|---|---|---|
| `LiteLLM_SpendLogs` | `request_id` PK, `call_type`, `api_key` (**hashed**, comment "Not the actual Virtual Key"), `spend`, token counts, `startTime`, `endTime`, `request_duration_ms`, `completionStartTime`, `model`, `model_id`, `model_group`, `custom_llm_provider`, `api_base`, `user`, `metadata Json`, `cache_hit`, `cache_key`, `request_tags Json`, `team_id`, `end_user`, `requester_ip_address`, `messages Json`, `response Json`, `session_id`, `status`, `mcp_namespaced_tool_name`, `agent_id`, `proxy_server_request Json`, `litellm_call_id`; indexes on `startTime`, `(startTime, request_id)`, `session_id`, `end_user`, `litellm_call_id`, `(api_key, startTime)` | Shape of our `searches` row: hot columns plus one JSON `metadata` blob; keyset index on `(startTime, id)`; session index |
| `SpendLogsMetadata` (TypedDict) | `applied_guardrails`, `guardrail_information[]`, `routing_decision`, `error_information`, `attempted_retries`, `max_retries`, `attempted_fallbacks`, `original_model_group`, `cost_breakdown`, `litellm_overhead_time_ms`, `status` | Same fields as our receipt needs: which engine served the search, fallbacks used, gateway overhead (`litellm/proxy/_types.py` line 3714) |
| `LiteLLM_ErrorLogs` | `startTime`, `endTime`, `api_base`, `model_group`, `model_id`, `request_kwargs Json`, `exception_type`, `exception_string`, `status_code` | Separate error table, so the dashboard's "engine errors" view does not scan the success log |
| `LiteLLM_DailyUserSpend` / `DailyGlobalSpend` / `DailyTeamSpend` / `DailyToolSpend`… | `date String`, dimension columns, `api_requests`, `successful_requests`, `failed_requests`, `total_response_time_ms`, `spend`; `@@unique([date, …dims])` | **Rollup tables**: dashboards read these, "never SpendLogs" (comment on `LiteLLM_DailyToolSpend`). For 100k-row dashboards (§12.3) |
| `LiteLLM_SpendLogGuardrailIndex` / `SpendLogToolIndex` | `(request_id, guardrail_id)` / `(request_id, tool_name)` PK + `(…, start_time)` index | Inverted index for "last N requests blocked by guardrail X", like our "last N results hidden by rule/list X" |
| `LiteLLM_BudgetTable` | `max_budget`, `soft_budget`, `max_parallel_requests`, `tpm_limit`, `rpm_limit`, `tpd_limit`, `model_max_budget Json`, `budget_duration`, `budget_reset_at`, `temp_budget_increase`, `temp_budget_expiry` | Budget fields; `soft_budget` = "Requests will NOT fail ... Will fire alerting" (`_types.py: BudgetNewRequest`) |
| `LiteLLM_BudgetWindowSpend` | PK `(entity_type, entity_id, window_duration)`, `window_start`, `spend` | Persistent window counter |
| `LiteLLM_HealthCheckTable` | `model_name`, `model_id`, `status`, `healthy_count`, `unhealthy_count`, `error_message`, `response_time_ms`, `details Json`, `checked_at` (index desc) | Maps to `engine_health` |
| `LiteLLM_SearchToolsTable` | `search_tool_name @unique`, `litellm_params Json`, `search_tool_info Json` | Engine registry row |
| `LiteLLM_AuditLog` | `changed_by`, `changed_by_api_key`, `action`, `table_name`, `object_id`, `before_value Json`, `updated_values Json` | Rule-change audit trail (who approved a `suggest_rule`) |
| `LiteLLM_CronJob` | `pod_id`, `status ACTIVE/INACTIVE`, `ttl DateTime` ("Only allow one pod to run the job at a time") | **Leader lease** for background jobs, i.e. our list-refresh owner |
| `LiteLLM_ProxyWorkerHeartbeat` | `worker_id`, `hostname`, `started_at`, `last_heartbeat_at` | List live gateway processes (and versions) in the dashboard |
| `LiteLLM_Config` | `param_name` PK, `param_value Json`, `reload_revision BigInt` | Config revision counter for reload detection |

`ProviderBudgetResponseObject` (`_types.py` line 4615) = `{budget_limit, time_period ('1d','30d','1mo'), spend, budget_reset_at}`, exactly the per-engine quota card we need.

## Config format
- YAML proxy config (`proxy_server_config.yaml` at repo root, tree-only). Router settings keys are the `Router.__init__` kwargs above. Fallbacks are a list of single-key maps, `[{"gpt-4": ["gpt-3.5-turbo"]}]`, plus a `"*"` key for default fallbacks (`router.py: _get_first_default_fallback`, `fallback_event_handlers.py: get_fallback_model_group`).
- `RetryPolicy` fields: `AuthenticationErrorRetries`, `TimeoutErrorRetries`, `RateLimitErrorRetries`, `ContentPolicyViolationErrorRetries`, `BadRequestErrorRetries`, `ServiceUnavailableErrorRetries`, `InternalServerErrorRetries`, `NotFoundErrorRetries`, `DefaultRetries` (`get_retry_from_policy.py`).
- `AllowedFailsPolicy` fields: `{BadRequest, Authentication, Timeout, RateLimit, ContentPolicyViolation, InternalServer, ServiceUnavailable, BadGateway, NotFound}ErrorAllowedFails` (`cooldown_handlers.py: _EXCEPTION_POLICY_FIELDS`).
- **Design lesson in a comment.** Router-internal settings (`allowed_fails_policy`) live in `model_info`, never in `litellm_params`, because `litellm_params` "gets copied wholesale into the actual provider call kwargs ... a new field placed there would leak into the outgoing LLM request" (`cooldown_handlers.py: _get_deployment_cooldown_policy` docstring).
- Durations: `budget_duration` "seconds ("30s"), minutes ("30m"), hours ("30h"), days ("30d"), months ("1mo")"; budgets reset at the end of the duration (`_types.py` line 4528).
- Search tool entry: `{search_tool_name, litellm_params: {search_provider, api_key, api_base, …}, search_tool_info}`. Protected keys `search_provider/api_key/api_base` are stripped from user kwargs before merging (`search_api_router.py: async_search_with_fallbacks_helper`).

## Extension points (plugins, hooks)
`CustomLogger` (`litellm/integrations/custom_logger.py`) is the single extension class. Lifecycle:

| Hook | When | Can |
|---|---|---|
| `async_pre_routing_hook` | before the deployment is chosen | rewrite request (auto-router) |
| `async_filter_deployments(model, healthy_deployments, …)` | candidate filtering | drop candidates |
| `async_pre_call_hook(user_api_key_dict, cache, data, call_type)` | proxy, per request | **raise** to reject, **return str** to answer the user, **return dict** to modify |
| `async_pre_call_deployment_hook` / `async_post_call_success_deployment_hook` / `async_post_call_failure_deployment_hook(…, fallback_depth)` | **per attempt** (first try, each retry, each fallback hop) | observe or modify one attempt; failure hook is "DEPLOYMENT-LEVEL ... distinct from the REQUEST-LEVEL `async_log_failure_event`, which fires once per logical client request behind a dedup gate" |
| `log_success_fallback_event` / `log_failure_fallback_event` / `log_model_group_rate_limit_error` | fallback events | metrics |
| `async_post_call_success_hook` / `async_post_call_failure_hook` | after the request | transform the response or error |
| `async_logging_hook` / `logging_hook` | before logging | "For masking logged request/response" |
| `async_log_success_event` / `async_log_failure_event` | logging sinks | export |
| `async_post_mcp_tool_call_hook` | after an MCP tool call | rewrite the MCP response |

Class flags: `enforces_request_content` (accounting hooks count a request once; content hooks run per record) and `turn_off_message_logging` / `redacts_messages_itself` (`redact_standard_logging_payload_from_model_call_details`). Router-level `fallback_access_check` and `fallback_budget_check` are awaited per hop. Guardrails run in modes `pre_call` / `during_call` / `post_call` (the content filter warns that "'during_call' mode with 'MASK' action is unstable due to race conditions. Use 'pre_call'", `content_filter.py` line ~307).

## Rules / lists: parsing and compilation
- **Content filter data as files.**
  - `patterns.json` entries are `{name, display_name, pattern, category, description, …extra}`. Extra keys are kept per pattern. Names become a `PrebuiltPatternName` enum at import (`litellm_content_filter/patterns.py`).
  - Credential patterns: `aws_access_key` `\b(AKIA[0-9A-Z]{16})\b`, `github_token` `\b(gh[ps]_[a-zA-Z0-9]{36})\b`, `slack_token`, `generic_api_key` (`api[-_]?key[\s:=]+…{20,}`). There is also `aws_secret_key` `\b([A-Za-z0-9/+=]{40})\b`, which **will false-positive on any 40-char token** (`patterns.json` lines 60-110).
- **Category YAML.** For example `content_filter_data/categories/prompt_injection_data_exfiltration.yaml` has `category_name`, `description`, `default_action: "BLOCK"`, `identifier_words[]` and `additional_block_words[]`. It blocks when an identifier word and a block word occur **in the same sentence**: a deterministic co-occurrence rule, not ML.
- Keyword map `keyword → (action, description)`; actions `BLOCK` (reject) or `MASK` (replace with `PATTERN_REDACTION_FORMAT = "[{pattern_name}_REDACTED]"` / `KEYWORD_REDACTION_STR = "[KEYWORD_REDACTED]"`) (`content_filter.py` lines 215-221, 314).
- **Labeled evals ship with the data.** `guardrail_benchmarks/evals/*.jsonl` lines look like `{"sentence": …, "expected": "BLOCK"|"ALLOW", "test": …}`. `results/BENCHMARKS.md` tables report precision, recall, F1, p50 latency and deps per approach (for example, ContentFilter YAML 100/100/100 at <0.1 ms vs ONNX MiniLM 95.3/96.5 at 2.4 ms).
- Fallback chains are validated (`Router.validate_fallbacks`) and resolved per lookup group (`fallback_lookup_groups`), and non-standard formats are tolerated (`check_non_standard_fallback_format`).

## Testing strategy
- Tree-only evidence (`git ls-tree HEAD tests/`):
  - `tests/VCR_TESTING.md`, `_vcr_conftest_common.py`, `_vcr_redis_persister.py`: record/replay HTTP cassettes
  - `_fake_openai_endpoint_server.py`, `fake_openai_endpoint.py`, `_openai_record_replay_proxy.py`: fake upstreams
  - `tests/unit`, `tests/integration`, `tests/e2e`, `tests/benchmarks`, `tests/code_coverage_tests`, `tests/documentation_tests`
- UI (`ui/litellm-dashboard/package.json`): vitest with projects `unit`, `component`, `integration`, `types`. Every component in `components/logs/` has a co-located `*.test.tsx`, for example `detail/LogDetailContent.integration.test.tsx` and `request/useLogFilterLogic.test.ts` (tree listing). Also `knip` for dead exports and `gen:api` (OpenAPI → typed client via `openapi-fetch`/`openapi-react-query`).
- Code is written for testability: `InMemoryCache(clock=…)` injectable clock (`in_memory_cache.py`); protocols such as `SharedCounter` and `_SearchToolsRouter` make hooks testable without Redis or Router (`search_free_tier.py`, `search_api_router.py`).
- Guardrail precision/recall evals (above) are a model for **list quality tests**.

## UX patterns worth copying
From `ui/litellm-dashboard/src/components/logs/` (object-store read):
- **Live tail on by default**, persisted per tab in `sessionStorage("isLiveTail")`. It refetches every `LIVE_TAIL_INTERVAL_MS = 15000` **only on page 0** (`getLiveTailRefetchInterval`, `request/useLogFilterLogic.ts`). Paging back freezes the view, so rows don't jump. We can go faster with SSE.
- Quick ranges: Last minute / 15 min / hour / 4 h / 24 h / 7 days (`constants.ts: QUICK_SELECT_OPTIONS`). Labels are computed from exact diffs to "prevent drift" (`request/timeRange.ts`).
- Filters as typed IDs: status, error code (with labelled list `"429 - Rate Limited"`, `"529 - Overloaded"`), error message, key, session, model id, **"Public model / search tool"**, request id, cache hit, credential type, plus a free-text search debounced with `@tanstack/react-pacer` (`useLogFilterLogic.ts: LOG_FILTER_IDS`). There is an **"exclude internal health checks"** toggle (`RequestLogsPanel.tsx`), which for us means hiding `doctor` probes.
- **Deep-linkable detail drawer** with `?log=<id>` / session routing. When the id is not on the current page it is fetched by id (`RequestLogsPanel.tsx: urlLogQueryOptions`, `request/logDetailRouting.ts`). Keyboard: **J/K** next/prev, **Esc** closes (`detail/useKeyboardNavigation.ts`).
- **Session grouping.** A row shows a badge with call count and LLM/agent/MCP icons, and cost/duration switch to "session total" with a subtitle (`request/RequestLogsTableColumns.tsx`). This is our receipt grouping.
- **Decision explanation card.** `RoutingDecisionCard.tsx` renders `cause` with human labels (`"Pinned to session"`, `"Heuristic scorer, classifier skipped"`). It renders the score against "the boundaries in effect when the decision was made ... it must use the snapshot rather than today's config". This is the key idea for "hidden by rule X": **store the rule text/version snapshot with the decision**, not just a rule id that may later change.
- **GuardrailViewer** per entry: `guardrail_name`, `guardrail_status`, `guardrail_mode`, `duration`, `masked_entity_count`, `match_details[{type, detection_method, action_taken, snippet, category, position}]`, `patterns_checked`, `risk_score` (`detail/sections/GuardrailViewer/GuardrailViewer.tsx`). This is the template for our hidden-result inspector: which rule, which list, which matched pattern, what action.
- Stack (`package.json`): Next 16.4.1, React 19.2.8, `@base-ui/react` ^1.6, TanStack Query 5.100 / Table 8.21 / Virtual 3.14, `nuqs` (URL state), lucide, date-fns. That is close to our §8.2 stack, minus Next.

## Performance tricks
- `InMemoryCache`: TTL dict plus expiration heap; defaults `max_size_in_memory=200`, `default_ttl=600`, `max_size_per_item=1024 KB` (`in_memory_cache.py`).
- Per-minute health counters are **local-only** with TTL 60 (no Redis round-trip on the hot path) (`track_deployment_metrics.py`). Cooldown reads are one batched `mget` for all deployment ids (`cooldown_cache.py: async_get_active_cooldowns`). `get_cooldown_cache_key` is `functools.lru_cache(1024)`.
- Atomic counters via Redis Lua: `INCR` + `EXPIRE` only on first increment (`max_iterations_limiter.py: MAX_ITERATIONS_INCREMENT_SCRIPT`), and `INCRBYFLOAT` for budgets. Our SQLite equivalent is a single `UPDATE … SET used = used + ? WHERE … RETURNING used` inside `BEGIN IMMEDIATE`.
- Budget **reservation pipeline**: when every counter has room, all are charged in one pipeline. As soon as one does not, it charges one at a time so a rejection charges nothing after it (`budget_reservation.py: _reservation_groups`).
- Rollup tables and inverted indexes so dashboards never scan the raw log (schema comments).
- Spend log truncation keeps the **35% head + 65% tail** of long strings with a "skipped N chars" marker (`spend_tracking_utils.py: _truncated_for_db`). This is useful for long snippets and page text.
- Cache keys are sha256 of normalized params, optional namespace prefix, with per-request `no-cache`/`s-maxage` controls (`caching/caching.py: get_cache_key`, `_get_hashed_cache_key`, lines 379-700).

## License and what it means for us
MIT outside `enterprise/`: we **may copy short snippets with attribution** (keep the MIT notice in `THIRD_PARTY_NOTICES`). In practice we are TypeScript and they are Python, so we take **algorithms and schemas**, not code. **Nothing from `enterprise/`** (proprietary, production use needs a subscription). Only its LICENSE is in our checkout; keep it that way. The content-filter YAML/JSON data are MIT too. Reusing the credential regexes (with attribution) for query hygiene is allowed, but test them; `aws_secret_key` is too broad.

## Implications for search-hole
- [engine-adapter] Classify engine errors into a fixed table, as in `_is_cooldown_required`: **suspend on 429, 401/403 (bad key), 402 (quota/payment), 404 (endpoint gone), 408/5xx; never suspend on local connection errors (offline) or on our own request-validation errors.** Offline → fail fast (§5.1) without poisoning engine health. Store this as data (`engine_error_class → {suspend, retry, userMessage, fix}`) per smart-doctor's ranked-causes idea.
- [engine-adapter] **Don't suspend the only healthy engine on error rate**, the single-deployment safety net (`_should_cooldown_deployment`). Suspend it only for explicit signals (429 with Retry-After, 401/402) and report "no healthy engine" with the reason and time remaining.
- [engine-adapter] Suspension record = `{engine, reason_class, status, masked_message(≤50 chars), started_at, until}`. Compute `remaining = until − now` on read (`CooldownCacheValue`). Write it to `engine_health` in SQLite so every gateway process and the dashboard see it (litellm needs Redis for this; we get it free from the shared DB).
- [engine-adapter] Per-error-class retry counts and allowed-fails thresholds (`RetryPolicy` / `AllowedFailsPolicy`) belong in the adapter manifest with sane defaults, overridable per engine in config. Retry **immediately on a different engine** when one exists; only back off (honouring `Retry-After`) when retrying the same engine (`_time_to_sleep_before_retry`).
- [merge-algorithm] Fallback walk: keep an `attemptedEngines` set shared across hops, a `maxFallbacks` bound, and a **budget check before each hop** (`run_async_fallback`). The receipt records `original_engine`, `attempted_fallbacks`, `attempted_retries` and per-hop errors (`x-litellm-*` headers / `SpendLogsMetadata`).
- [other] Spend caps: adopt **reserve → call → reconcile/release**. Before calling an engine, atomically reserve 1 query (or estimated cost) against each matching cap (engine/day, engine/month, session); release on failures the engine didn't bill (`budget_reservation.py`). Offer `soft` (warn/receipt flag) and `hard` (block) caps (`soft_budget` vs `max_budget`). Include a `failClosed` switch for when the counter store is unavailable (`fail_closed_budget_enforcement`).
- [other] Free-tier allowances (Brave $5 credit, Tavily 1k/month) use **calendar-period stamp keys** `engine:{id}:{YYYY-MM-DD|YYYY-MM}` with expiry at next reset + 1 h grace (`search_free_tier.py: search_free_tier_key`, `search_free_tier_ttl`). Compute "freed units" with `max(0, min(units, allowance − (total_after − units)))`. Calendar months, not rolling 30 days, match how providers reset (verify per engine).
- [session-definition] Per-session loop guard: count tool calls per session and return a clear 429-style tool error past `maxSearchesPerSession` (`max_iterations_limiter.py`, default TTL 3600 s). This needs the session ADR's definition; litellm uses an explicit `x-litellm-session-id` header or `metadata.session_id`.
- [sqlite-driver] Log schema: hot, filterable columns plus one JSON `metadata` column, keyset index on `(started_at, id)`, index on `session_id`, a separate `errors` table, and **daily rollup tables with composite unique keys** updated by upsert so the dashboard reads rollups, plus inverted index tables (`result_rule_index(rule_id, search_id, ts)`) for "what did this rule hide" (`LiteLLM_SpendLogs`, `LiteLLM_Daily*Spend`, `LiteLLM_SpendLogGuardrailIndex`).
- [upgrades-migrations] Use a **lease row** for background jobs (`LiteLLM_CronJob`: owner id, status, ttl) for list refresh, and a **process heartbeat table** (`LiteLLM_ProxyWorkerHeartbeat`) so the dashboard can show "3 gateways running: v0.4.1 ×2, v0.5.0 ×1". This feeds the multi-install ADR.
- [security] Redaction at the logging boundary:
  - never store raw keys; store a hash or alias (`_redact_logged_api_key` → `hash_token`)
  - drop `secret_fields` (raw headers) entirely
  - mask values under credential-like keys
  - truncate long strings
  - mask IPs in error text (`_without_ip_addresses`)
  - scrub echoed prompts from provider error strings (`_redact_prompt_leaks_in_error_string`)

  Do the same for engine error bodies, which often echo the query and sometimes the key.
- [security] Query hygiene: reuse the idea (and, with attribution, the specific regexes) of `patterns.json` credential patterns with BLOCK vs MASK actions in a pre-call stage. Avoid the 40-char `aws_secret_key` pattern; require context (prefix or key name).
- [security] Content storage is **opt-in** (`should_store_prompts_and_responses_in_spend_logs()` gate in `_get_messages_for_spend_logs_payload`; the same `store_prompts_in_spend_logs` flag also redacts prompt fields in guardrail and error info, `spend_tracking_utils.py` lines 1461, 1539). Our analog is per-engine retention (Tavily forbids storing results). Default to storing decisions, counts, URLs and domains, and gate titles and snippets per adapter `retentionPolicy`.
- [mcp-tool-surface] Pipeline hooks: model ours on litellm's two levels. **Request-level** events (`search:start`, `search:done`) and **attempt-level** events (`engine:attempt:start|success|failure` with `fallbackDepth`, `retry`) feed the AsyncLocalStorage event bus. Reporters (CLI `--explain`, SQLite writer, dashboard SSE, receipt builder) subscribe. Mark which hooks *count* (spend caps, run once) vs which *inspect content* (rules, run per result), per `enforces_request_content`.
- [ui-ux] Logs view: live tail on by default but only on page 0; quick time ranges; typed filter chips (engine, status/error class, hidden-by rule/list, session, profile, client); J/K/Esc; deep links `?search=<id>`; a session row that rolls up; a detail drawer with a "Decision" card that renders **the rule snapshot recorded at decision time**; "exclude doctor probes" toggle.
- [lists-subscriptions] Ship every first-party list with a **labelled eval file** (`url → expected category/action`) and report precision/recall in CI and in the list README, as `guardrail_benchmarks/` does. This also gives contributors an evidence format (§12.6).
- [testing] Record/replay fixtures per engine plus a fake engine server (`tests/VCR_TESTING.md`, `_fake_openai_endpoint_server.py`) match §12.3's contract tests and mock server. Inject the clock into caches and counters (`InMemoryCache(clock=…)`) so window and reset tests are deterministic.
- [engine-adapter] Keep **engine-internal settings out of the request-params object** (the `model_info` vs `litellm_params` lesson), so adapter config (retry policy, caps, retention) can never leak into the HTTP request sent to an engine.

## Borrow / avoid
**Borrow**
- The status-code → suspend/retry table from `_is_cooldown_required`, including "connection errors don't suspend".
- The single-backend safety net, and "retry elsewhere with 0 delay, back off only on the same backend".
- Suspension records with masked reason, timestamp and duration, plus a "no healthy engine" error carrying the minimum remaining cooldown and the suspended list (`handle_error.py`).
- `attempted_targets` loop protection, `max_fallbacks`, and per-hop budget checks.
- Reserve/reconcile/release spend caps; soft vs hard caps; calendar-period free-tier counters with a grace TTL; a per-session iteration cap.
- SpendLogs-style hot columns + JSON metadata, separate error table, daily rollups, inverted rule index, audit log with before/after, lease row, heartbeat table.
- Redaction pipeline: hash keys, drop raw headers, mask credential keys, 35/65 truncation, IP masking, prompt-echo scrubbing.
- Logs UI: live tail on page 0 only, J/K nav, deep-link drawer, session rollup, and a **decision card that renders the snapshot recorded at decision time**.
- Labelled evals + precision/recall table per deterministic list.

**Avoid**
- Redis-dependent correctness. Litellm needs Redis for fleet-wide cooldowns and counters; we have one SQLite file, so use it and skip an extra cache tier.
- A 17k-line `Router` god-object and many overlapping knobs (v1 `allowed_fails` vs v2 error-rate logic, deployment vs router vs model-group policies). Pick one model with few settings.
- Docstring/default drift (`cooldown_time` "Defaults to 1" vs `DEFAULT_COOLDOWN_TIME_SECONDS`). Define defaults in one typed place and render them into docs.
- Over-broad secret regexes (`aws_secret_key` 40 chars) that would block legitimate queries.
- `random.choice` among same-name search tools (`async_search_with_fallbacks_helper`). Our engine choice must be deterministic (Principle 5).
- Anything under `enterprise/`.
