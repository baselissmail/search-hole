# docker/mcp-gateway
> Ref: `research/refs/docker-mcp-gateway` @ 7e0f342 (2026-10-26) · License: MIT (`LICENSE`, "Copyright (c) 2025 Docker"). Exceptions:
> - `vendor/` holds third-party Go modules with their own licenses (152 LICENSE files); never copy from there
> - `pkg/secretsscan/rules.go` says "Patterns copied from github.com/aquasecurity/trivy/pkg/fanal/secret/builtin-rules.go" (Trivy upstream is Apache-2.0, from general knowledge; not verifiable in this ref), so treat those regexes as Apache-derived and attribute Trivy if reused

## Purpose
The `docker mcp` CLI plugin and its **MCP Gateway**: one MCP endpoint (stdio by default) that aggregates many containerized (or remote) MCP servers from a catalog, with per-server secrets, tool allowlists, call logging, secret-leak blocking, interceptors, OTEL telemetry, policy/audit hooks, client config writers ("`docker mcp client connect`"), and **profiles**, shareable named sets of servers + tool selections pushed and pulled via OCI registries. For search-hole it is the most relevant reference for **SQLite migrations under concurrent processes (including "DB is ahead of this binary")**, **interceptor hook points**, **profile file format**, **data-driven client config writing**, **secret references instead of values**, and **tool-collision handling**.

## Architecture sketch
```
MCP client ──stdio (one gateway process per client)──► docker mcp gateway run [--profile P]
                     or --transport sse|streaming --port N (Bearer MCP_GATEWAY_AUTH_TOKEN)
   go-sdk mcp.Server  ◄── AddReceivingMiddleware(interceptors.Callbacks(...))   (pkg/gateway/run.go:313–321)
     handlers.go → clientpool.go → per-tool-call container (docker run --rm …) or long-lived/static/remote
   configuration: catalog(s) + registry.yaml + config.yaml + tools.yaml  (or profile from SQLite)
     └ optional fsnotify --watch, 300 ms debounce → reloadConfiguration()
   secrets: --secrets "docker-desktop:./.env" → se:// URIs resolved by Docker Desktop at container start
   state: ~/.docker/mcp/mcp-toolkit.db (SQLite: working_set, catalog, catalog_server, migration_status, pull_record)
```
- Upstream servers are started on demand per call unless `longLived`, `--long-lived` or `--static` (`docs/server-entry-spec.md`, `cmd/docker-mcp/commands/gateway.go:218,223`).
- The vendored `github.com/modelcontextprotocol/go-sdk v1.4.1` tops out at protocol `2025-06-18` (`vendor/.../mcp/shared.go:37`). Upstream clients initialize with `ProtocolVersion: "2024-11-05"` (`pkg/gateway/clientpool.go:564`). **No 2026-07-28 support.**

## Key modules and data flow
- `pkg/interceptors/interceptors.go: Callbacks(logCalls, blockSecrets, oauthInterceptorEnabled, interceptors)` builds the receiving-middleware list in this order:
  1. `TelemetryMiddleware()`, always on
  2. `GitHubUnauthorizedMiddleware()`, if the OAuth interceptor feature is enabled
  3. user `--interceptor` specs
  4. `BlockSecretsMiddleware()`, placed "before logging so request payloads are scanned before any built-in diagnostic logging observes the call"
  5. `LogCallsMiddleware()`
- **Custom interceptors** (`Parse`, `ToMiddleware`):
  - spec `when:type:argument` with `when ∈ {before, after}` and `type ∈ {exec, docker, http}`
  - only `tools/call` is intercepted
  - `before`: the request JSON goes to the interceptor's stdin/body; **non-empty output is parsed as a `CallToolResult` and short-circuits** the call
  - `after`: the response JSON goes in; non-empty output **replaces** the result
  - `exec` runs `/bin/sh -c <arg>`, `docker` runs `docker run --rm --init <image>`, `http` POSTs
  - the doc comment shows `around:http:…`, but `Parse` rejects anything except before/after (drift)
- `pkg/interceptors/log_calls.go`: logs `Calling tool <name> with arguments: <shape>` and the duration. `helpers.go: argumentsSummary` prints only the *shape* ("object with 3 field(s)", "string", "number"), never keys or values; `docs/security.md` makes that a stated boundary.
- `pkg/interceptors/block_secrets.go` + `pkg/secretsscan`: scan tool-call arguments (JSON-stringified) and text content of results. On a hit, return an error ("a secret is being passed to tool X"). 88 rules, each `{expression, keywords[]}`; a cheap lowercase keyword `strings.Contains` prefilter runs before the regex (`rules.go: rule.matches`).
- `pkg/gateway/reload.go: reloadConfiguration`: list capabilities of enabled servers, `filterInvalidCapabilities`, filter by policy, `validateExternalToolNameCollisions`, register. The dynamic tools (`mcp-find`, `mcp-add`, `mcp-remove`, `code-mode`, `mcp-exec`, `mcp-config-set`, profile tools) are added only when the `dynamic-tools` feature is on.
- `pkg/gateway/policy_audit.go`: policy decisions are queued on a `chan pendingAudit` with buffer 100, **dropped when full**, and submitted by a background worker whose "Errors intentionally ignored". The client identity comes from `session.InitializeParams().ClientInfo{Name,Version}`.

## Data model and storage
- **DB** `~/.docker/mcp/mcp-toolkit.db` (`pkg/db/db.go: DefaultDatabaseFilename`):
  - driver `modernc.org/sqlite` v1.39.1 (pure Go)
  - DSN `?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)`, **no WAL** (no `journal_mode` anywhere in `pkg/`)
  - `SetMaxOpenConns(1)`, `SetMaxIdleConns(1)`, `SetConnMaxLifetime(0)`; `sqlx`
- **Schema** (`pkg/db/migrations/*.up.sql`, golang-migrate, up-only):
  - `working_set(id pk, name, servers TEXT CHECK(json_valid), secrets TEXT CHECK(json_valid))`
  - `catalog(ref pk, digest, title, source, last_updated)`
  - `catalog_server(id, server_type CHECK IN ('registry','image','remote'), tools JSON, source, image, endpoint, snapshot JSON, catalog_ref FK ON DELETE CASCADE)`
  - `migration_status(id, status, logs, last_updated)`
  - `pull_record(id, ref UNIQUE, first_pulled)`
  - Migration `005_add_remote_support.up.sql` had to **recreate `catalog_server`** to widen a CHECK enum (SQLite can't alter CHECK constraints): a cost of enum CHECKs on growing vocabularies.
- **Migration runner** (`pkg/db/db.go: runMigrations`), documented in `docs/database/README.md`:
  1. take an OS file lock `~/.docker/mcp/.mcp-toolkit-migration.lock` (gofrs/flock, `TryLockContext` 5 s / 100 ms poll); the file persists by design
  2. read `mig.Version()`; if `dirty`, error "manual intervention required"
  3. if the DB version has no migration file in this binary (`migDriver.ReadUp(version)` → `os.ErrNotExist`), error: **"database version N (path) is ahead of the current application version. Please upgrade to the latest version"**
  4. `mig.Up()`

  Rationale: golang-migrate does not run all migrations in one transaction, so without the file lock concurrent starts produce "Dirty database version". Tested by spawning **100 concurrent processes** (`docs/database/testing/test_migration_race.go`) and by `pkg/db/migration_test.go: TestConcurrentMigration, TestDatabaseAheadOfMigrationFiles, TestDirtyDatabase, TestFreshDatabase`.
- **Data migration lease** (`pkg/migrate/migrate.go: MigrateConfig`, `pkg/db/migration_status.go: TryAcquireMigration`): legacy file config → DB. The process that *inserts* the single `migration_status` row in a `BEGIN IMMEDIATE` transaction (via the `ROLLBACK; BEGIN IMMEDIATE` workaround) owns the migration. Others retry 5× at 300 ms on `SQLITE_BUSY`. A row stuck in `pending` for more than 10 s is treated as abandoned and taken over. Logs are written into the row.

## Config format
- **Profile** (`docs/profiles.md`, "Profile File Format"), YAML or JSON:
  ```yaml
  version: 1
  id: my-profile
  name: My Profile
  servers:
    - type: image            # image | registry (| remote in DB schema)
      image: mcp/github:latest
    - type: registry
      source: https://registry.modelcontextprotocol.io/v0/servers/<uuid>
      config: { key: value }
      secrets: default       # reference into top-level secrets map
      tools: [tool1, tool2]  # allowlist; default = all tools
  secrets:
    default: { provider: docker-desktop-store }
  ```
  - Server references when creating a profile: `docker://image`, `catalog://…`, `file://server.yaml`, MCP Registry URLs.
  - CLI: `profile tools P --enable|--disable server.tool --enable-all|--disable-all server`.
  - Profiles are exported/imported as YAML/JSON or pushed/pulled to OCI with version tags. Documented limitation: "Secrets are scoped across all servers rather than for each profile".
- **Server entry** (`docs/server-entry-spec.md`):
  - core: `name, type (server|remote|poci), title, description, icon, readme`
  - container: `image` (digest recommended), `command, volumes, user, longLived`, `remote{…}`
  - `secrets[{name: "<server>.<key>", env, example}]`, `oauth{providers[{provider, secret, env}], scopes}`, `env[{name, value}]` with `{{server.key}}` templates
  - `disableNetwork`, `allowHosts[]`, `tools[{name, description, arguments, annotations{readOnlyHint, destructiveHint, idempotentHint, openWorldHint}}]`, a config JSON schema
- **Gateway flags** (`cmd/docker-mcp/commands/gateway.go:189–224`): `--servers`, `--profile`, `--tools server:tool|server:*`, `--catalog`, `--registry`, `--config`, `--tools-config`, `--secrets "docker-desktop:./.env"` (colon-separated search path), `--interceptor`, `--transport stdio|sse|streaming`, `--log-calls` (default true), `--block-secrets` (default true), `--block-network`, `--verify-signatures`, `--dry-run`, `--watch`, `--log <file>`.
- **Catalog pull policy** (`pkg/catalog_next/catalog.go: NewPullOptionEvaluator`): `missing | never | always | initial | exists`, optionally `@<duration>`, combined with `+`, e.g. `initial+exists@6h` or `always@1w`. A catalog absent from the DB is always pulled (except `never`/`exists`).
- **Client definitions** (`pkg/client/config.yml`): data-driven per client, `{displayName, source, icon, installCheckPaths[], paths{linux,darwin,windows}[], yq{list,set,del}}` for system scope and `{projectfile, yq}` for project scope. Example for Claude Code: paths `$CLAUDE_CONFIG_DIR/.claude.json`, `$HOME/.claude.json`; project file `.mcp.json` with `set: .mcpServers[$NAME] = $JSON+{"type":"stdio"}`.

## Extension points (plugins, hooks)
- Hook points: go-sdk receiving middleware around **every method**. Built-ins switch on the method: telemetry on `initialize` and the four `*/list`, everything else on `tools/call`. Custom interceptors run `before`/`after` on `tools/call` only, as external processes, containers or HTTP endpoints (no in-process plugins).
- **Policy provider** (`pkg/policy/*`, `pkg/gateway/policy_*.go`): filters tools and prompts at reload (`filterToolCapabilitiesByPolicy`) and authorizes calls. Audit events (`pkg/policy/audit.go`) carry `{actor_type/id/name, org_id/name, trigger, target_type, server_name, tool_name, prompt_name, catalog_name, working_set, server_type, server_source, transport, result, outcome_reason, reason, policy_id, policy_version, policy_source, client_name, client_version, session_id, trace_id, timestamp}`.
- **Dynamic tools** (`docs/feature-specs/dynamic_servers.md`): `mcp-find`, `mcp-add`, `mcp-remove`, `mcp-config-set`, `mcp-exec`, `code-mode` (JS via `goja`, `pkg/codemode/exec.go`), `find-tools` (embedding-based). Security boundary: the model may only (re)activate servers **already in the operator's active set** unless a non-noop policy provider explicitly allows `load`. Passing `--servers` disables dynamic tools entirely.
- OTEL (`docs/telemetry/README.md`, `pkg/telemetry`):
  - metrics include `mcp.gateway.starts`, `mcp.initialize`, `mcp.tools.discovered` per server, and `mcp.tool.schema_dialects{translated|relayed|unsupported_dialect}`
  - periodic export every 30 s (`DOCKER_MCP_METRICS_INTERVAL`); Docker Desktop's collector receives them
  - list metrics are tagged with the client name from `initialize`

## Rules / lists: parsing and compilation
n/a for search rules. Analogues:
- tool allowlists: `tools:` per profile server, or `--tools server:tool`
- catalogs pulled by OCI ref with `digest` + `last_updated` stored per catalog and the pull-policy grammar above
- `pull_record` remembers first pulls so `initial` means once per machine
- secret-detection rules compiled lazily once via `sync.OnceValue` (`rules.go:41`), though each `matches` call still runs `regexp.MustCompile` (anti-pattern, see Performance)

## Testing strategy
- 126 `_test.go` files. Root-level integration tests (`pkg/integration_test.go`, `long_lived_integration_test.go`, `proxy_integration_test.go`, `remote_headers_integration_test.go`, `toollist_notifications_integration_test.go`, `elicitation_integration_test.go`) need a Docker daemon.
- Mocks: `test/mocks/{oci,registryapi}.go`; fixture servers under `test/servers/`.
- DB: four migration-state tests (fresh, dirty, concurrent, ahead-of-binary) plus a 100-process race harness (`docs/database/testing/test_migration_race.go`).
- Telemetry: a local OTEL collector config and `test-telemetry.sh` (`docs/telemetry/testing/`).
- Tool-name collisions: `pkg/gateway/tool_names_test.go`; schema-dialect translation: `tool_schema_dialect_test.go`.

## UX patterns worth copying
- **Profiles as a portable unit**: `version`, `id`, `name`, and a list of sources with per-source tool allowlist and secret reference. Export, import, push and pull with versions (`docs/profiles.md`, "Versioning Profiles", "Team Collaboration").
- **One-line client hookup**: `docker mcp client connect <client> [-p profile]` writes `{command: "docker", args: ["mcp","gateway","run","--profile",P]}` into that client's config via the `config.yml` table (`pkg/client/config.go: newMCPGatewayServer`). On Windows it explicitly passes `LOCALAPPDATA`, `ProgramFiles`, `ProgramData` because "As of 0.9.3, Claude Desktop locks down environment variables" (`config.go:101–108`).
- **Explicit, actionable collision errors**: "tool name collision: X and Y both expose tool name "t"; enable tool-name-prefix or set unique catalog prefixes". Case-insensitive collisions and reserved gateway names are also caught (`pkg/gateway/tool_names.go:60–110`). Optional prefixing `prefix + "__" + tool` (`capabilitites.go:96`).
- **`--dry-run`**: start, load and validate the configuration, but don't listen.
- **Clear upgrade message** when the DB is newer than the binary (above).
- **Shape-only call logs**: diagnostics without leaking arguments.

## Performance tricks
- Upstream containers started on demand per call by default (no idle cost), with opt-in long-lived/static modes.
- fsnotify reloads debounced by draining events for 300 ms (`pkg/gateway/configuration.go:362–395`).
- Secret scan keyword prefilter before regex (but `regexp.MustCompile` inside `rule.matches` recompiles on every keyword hit, an avoidable cost; precompile instead).
- Async, bounded, lossy audit queue so policy auditing never blocks a call (`policy_audit.go:18–30`); appropriate for remote audit sinks, not for our local log of record.
- Tool-schema dialect translation is narrow and copy-on-write (`pkg/toolschema/dialect.go`).

## License and what it means for us
MIT: we may copy code with the copyright notice, but it is Go, so in practice we port ideas. Do not copy from `vendor/`. The secret regexes in `pkg/secretsscan/rules.go` derive from Trivy (Apache-2.0 upstream), so if we port them, attribute Trivy and add a NOTICE entry, or take them from gitleaks/Trivy directly under their license. Avoid the default-on telemetry model (always-on middleware feeding Docker Desktop's collector).

## Implications for search-hole
- [upgrades-migrations] Copy this migration protocol almost exactly, in TypeScript:
  1. a file lock next to the DB (`~/.searchhole/.migrate.lock`) around "read version → check dirty → check ahead → apply"
  2. on "ahead", **don't hard-fail** (Docker's choice): switch to read-only and keep serving searches, per our §5.1 matrix
  3. run each migration inside a transaction (SQLite DDL is transactional), so we avoid golang-migrate's "dirty" state entirely
  4. add a 100-process concurrent-start test like `test_migration_race.go`

  Evidence `pkg/db/db.go: runMigrations`, `docs/database/README.md`.
- [upgrades-migrations] One owner for background jobs: insert-or-read a lease row under `BEGIN IMMEDIATE`, treat a stale `pending/heartbeat` older than N seconds as abandoned, retry on `SQLITE_BUSY` (`pkg/db/migration_status.go: TryAcquireMigration`, `pkg/migrate/migrate.go: MigrateConfig`). For list refresh: `jobs(name pk, owner_pid, owner_install, heartbeat_at, status, logs)` with a heartbeat every few seconds and a takeover after 3× the interval.
- [upgrades-migrations] Avoid `CHECK (x IN (...))` enums on columns whose vocabulary will grow (engines, decision codes, source types), since widening needs a table rebuild (`005_add_remote_support.up.sql`). Validate in zod and keep the DB column TEXT. Keep `json_valid` CHECKs (they never need widening).
- [sqlite-driver] Docker runs **without WAL** and with a single connection. With multiple gateway processes plus a dashboard reader we need WAL, so prefer ToolHive's/context-forge's pragma set over Docker's. Both Go projects chose a pure (no-native) SQLite driver; our analogue is `node:sqlite` / `bun:sqlite`.
- [lists-subscriptions] Reuse the pull-policy grammar as the list `refresh:` field, e.g. `refresh: "initial+exists@24h"`, or simplify to `@24h` + `missing`, evaluated against `lists.last_update` (`pkg/catalog_next/catalog.go: PullOptionConfig.Evaluate`). Store `digest` + `last_updated` per list as Docker does per catalog, and keep `pull_record` semantics for "first fetched".
- [rule-format-precedence] Profile format as a template for our shareable rule/profile file: top-level `version: 1`, `id`, `name`, list of entries each with an optional allowlist, secrets referenced by name instead of inlined. A `.searchhole.yaml` likewise references engines and keys by name only, never values or endpoints (§12.4).
- [key-storage] **References, not values**: Docker's gateway hands containers `se://docker/mcp/<name>` URIs that Docker Desktop resolves at start, so in pure Desktop mode the gateway never holds the key (`pkg/gateway/secrets_uri.go`, `configuration.go:560–575`). The search path `--secrets docker-desktop:./.env` is an ordered resolver list, the same idea as our host env → process env → own store. Their OS-keychain path shells out to `docker pass` (`credstore.go`); for us that supports **shelling out to OS tools** (`security`, `secret-tool`) to keep zero native deps.
- [key-storage] Don't copy `maskSecret` (`clientpool.go:483–492`), which prints the first 4 characters of a secret (`ghp_`, `sk-a` are identifying prefixes). We show presence and source only ("Brave key: set (keychain)").
- [security] `--block-secrets` default-on is the closest prior art for our **query hygiene**: scan outgoing `search` queries (and `fetch` URLs) with keyword-prefiltered secret regexes before sending them to any engine, and before logging. Precompile the regexes; attribute Trivy if we reuse patterns (`pkg/secretsscan/rules.go`, `pkg/interceptors/block_secrets.go`).
- [security] Logging rule to adopt verbatim from `docs/security.md` ("Secrets and logs"): diagnostic call logs record tool name + argument shape only. Our *search log* necessarily stores queries, so that table goes through redaction first, and debug/stderr logs follow the shape-only rule.
- [security] HTTP transport defaults (`docs/security.md`, "HTTP transports"): bearer token required (env or generated), `Origin` accepted only from localhost if present, `--allow-unauthenticated` as the explicit opt-out, `/health` unauthenticated. Apply to `searchhole ui` and the v2 HTTP gateway.
- [security] Remote fetch rules (`docs/security.md`, "Remote URLs and untrusted fetches"): public HTTPS only by default; reject userinfo, loopback, private, link-local and metadata IPs; validate every redirect **and** the resolved address at dial time. This matches our §12.4 SSRF plan; the dev escape hatch is `DOCKER_MCP_ALLOW_INSECURE_REMOTE_URLS=1`.
- [mcp-tool-surface] The model can only *activate* what the operator already enabled (dynamic tools boundary, `docs/feature-specs/dynamic_servers.md`). Same principle as our `suggest_rule` → user approval. Keep a **reserved tool-name set** and collision checks even with only 4 tools, so a future "engines as MCP servers" feature can't shadow `search`.
- [mcp-tool-surface] Only `tools/call` gets interceptors; list operations get telemetry. For us: log `tools/list` and `server/discover` counts per client to measure description token cost in the wild (inferred).
- [session-definition] Client identity = `initialize` `clientInfo{name,version}` per session (`policy_audit.go: auditClientInfoFromSession`). The `session_id` field exists in the audit schema but is not filled in `buildAuditEvent` (L68–121), a sign that session is underdefined there too. With 2026-07-28 there is no `initialize`, so read `_meta["io.modelcontextprotocol/clientInfo"]` per request.
- [dual-protocol] A gateway pinned to go-sdk 1.4.1 negotiates at most 2025-06-18 and initializes upstreams as `2024-11-05` (`clientpool.go:564`). If we ever consume other MCP servers (engines as MCP servers), probe `server/discover` first and fall back (see the context-forge note).
- [testing] Schema-dialect gotcha: "Servers built on the MCP TypeScript SDK declare draft-07 for every tool, because its zod converter defaults to that target", and 2020-12-only clients reject them (`pkg/toolschema/dialect.go:5–17`). **Verify that our SDK v2 + zod 4 `inputSchema`/`outputSchema` serialize as 2020-12 or without `$schema`**, and add a CI assertion.
- [distribution] Use Docker's `config.yml` client table (per-OS paths, `installCheckPaths`, list/set/del expressions, system vs project scope) as the data model for `npx search-hole setup`. Note the Windows env lock-down in Claude Desktop: our MCPB/gateway must not rely on inherited env such as `APPDATA`/`LOCALAPPDATA` being present. Compute the data dir defensively, or pass it explicitly in `env` (`pkg/client/config.go:101–108`).
- [ui-ux] Collision and upgrade errors are complete sentences with the fix inside ("enable tool-name-prefix…", "Please upgrade to the latest version"), the tone to match in `doctor` and tool errors.

## Borrow / avoid
**Borrow**
- File-locked migration runner with "dirty" and "DB ahead of binary" detection, plus the 100-process race test.
- `BEGIN IMMEDIATE` lease row with stale takeover for single-owner background jobs.
- Pull/refresh policy grammar (`missing|never|always|initial|exists` + `@duration`, combined with `+`).
- Profile file shape (`version/id/name`, entries with allowlists, secrets by reference).
- Data-driven client config table with per-OS paths and list/set/del expressions; explicit Windows env passthrough.
- Shape-only call logging; secret scanning on requests and responses with keyword prefilter (precompiled); collision checks with reserved names and actionable messages.
- Localhost-only HTTP defaults (bearer token + Origin check) and the public-HTTPS-only fetch policy.

**Avoid**
- Hard-failing when the DB is ahead (we degrade to read-only); running SQLite without WAL when several processes write and a dashboard reads.
- `CHECK IN (...)` enums on growing vocabularies.
- Lossy, error-ignoring audit queues for the *primary* local log (fine only for best-effort sinks).
- Masking secrets by printing a prefix.
- Always-on telemetry middleware; AI-driven `find-tools` and `code-mode` (out of scope, against "no LLM calls in the gateway").
- External-process interceptors (`/bin/sh -c`) as an extension mechanism for v1. They add a large attack surface for little benefit.
