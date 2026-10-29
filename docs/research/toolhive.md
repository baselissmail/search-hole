# stacklok/toolhive
> Ref: `research/refs/toolhive` @ 20bc1a1 (2026-10-28) · License: Apache-2.0 (`LICENSE`; 2,094 `SPDX-License-Identifier: Apache-2.0` headers under `pkg/` and `cmd/`; `pkg/audit/event.go` additionally carries an Equinix Apache-2.0 notice, so it is still Apache). No per-directory exceptions. Much shared logic lives in the external module `github.com/stacklok/toolhive-core` v0.0.58 (`go.mod:71`), which is not in the ref: audit constants, registry types, the sigstore `verifier`, `mcpcompat`.

## Purpose
ToolHive (`thv`) runs, secures and manages MCP servers: it launches them in containers (Docker/Podman/Kubernetes operator), fronts each with an HTTP proxy that adds auth, authz (Cedar), audit, tool filtering and telemetry, and writes the client configs for ~27 AI clients. It also ships a registry with provenance (sigstore), an encrypted secrets store, vMCP (aggregating many servers into one endpoint, with an "optimizer" that shrinks the tool surface), and a skills/plugins distributor that materializes `.claude-plugin` bundles into Claude Code and Codex. For search-hole it is the best reference for **key storage**, **audit log shape**, **local-server discovery files**, **multi-install detection**, **client config writing**, and a careful **2025-11-25 vs 2026-07-28 request classifier**.

## Architecture sketch
```
thv CLI ──(HTTP client even locally)──► thv serve API (unix socket / TCP, pkg/api)
   │                                       └► discovery file (url,pid,nonce)  pkg/server/discovery
   ├─ thv run <server>  → pkg/runner (RunConfig) → pkg/container (Docker/Podman/K8s)
   │        └► per-workload proxy: pkg/transport/proxy/{streamable,httpsse,transparent}
   │              middleware chain (pkg/runner/middleware.go): audit→auth→…→tool filter→parser→authz→recovery
   ├─ pkg/secrets (encrypted|1password|environment) + OS keyring for the master password
   ├─ pkg/registry (built-in | local | remote JSON | MCP Registry API) + cache
   ├─ pkg/client (config writers for 27 clients)    pkg/storage/sqlite (skills/plugins state)
   └─ vMCP (pkg/vmcp): aggregator + conflict resolvers + optimizer(find_tool/call_tool)
```
Stdio servers: the container's stdio is attached by the proxy and exposed to clients as streamable HTTP or SSE. `pkg/client/config.go` maps `TransportTypeStdio → "http"` for Cursor and Claude Code, so clients always talk HTTP to ToolHive.

## Key modules and data flow
- `pkg/secrets/factory.go: CreateSecretProviderWithPassword` → primary provider, wrapped by default in `FallbackProvider` (env fallback). `CreateProvider(..., WithScope|WithUserFacing)` adds namespacing.
- `pkg/runner/config.go: RunConfig.WithSecrets(ctx, systemProvider, userProvider)` resolves `--secret name,target=ENV` references into `EnvVars`, OAuth client secrets and bearer tokens into non-serialized fields, and `HeaderForward.AddHeadersFromSecret` into `resolvedHeaders`. Comment: "Only the secret references are persisted to disk; actual values exist only in memory" (L728–731).
- `pkg/audit/auditor.go: Auditor.Middleware` wraps the HTTP handler and buffers the response (`responseWriter`). `logAuditEvent` determines type (from the parsed MCP method), outcome (from status + authz denial marker + JSON-RPC error sniffing), source, subjects and target, then logs via `slog` at `LevelAudit`.
- `pkg/mcp/revision.go: ClassifyRevision(method, meta, protoHeader)` decides Legacy vs Modern per request (details under Extension points).
- `pkg/transport/proxy/streamable/initialize_cache.go`: a stdio server is exactly one MCP session while the proxy multiplexes many HTTP clients onto it. The first `InitializeResult` is cached and later handshakes are answered locally, because go-sdk ≥1.7 rejects a second `initialize` on an initialized session (#5890, #1982).
- `pkg/transport/stdio.go`: re-attaches to a restarted container with exponential backoff (10 retries, 2 s → 30 s cap, about 5 min to survive a Docker Desktop restart).
- `pkg/transport/bridge.go: StdioBridge` is the reverse bridge: it exposes a remote HTTP/SSE MCP server on local stdin/stdout.

## Data model and storage
- **SQLite** (`pkg/storage/sqlite/db.go`):
  - driver `modernc.org/sqlite` v1.61.0, pure Go with no cgo (`go.mod:108`)
  - DSN `file:<path>?_txlock=immediate`, `SetMaxOpenConns(1)` ("SQLite only supports a single writer")
  - pragmas `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`, `cache_size=-2000`
  - path `xdg.StateHome/toolhive/toolhive.db`
  - migrations: goose v3, embedded SQL `001_create_entries_and_skills.sql` … `006_add_plugin_sigstore_bundle.sql`, applied with `provider.Up` on every open (`migrations.go`)
  - no "DB newer than binary" branch visible in `migrations.go` (inferred from reading it; goose's own behaviour not verified)
- **State files**: RunConfigs as JSON under `xdg.StateHome/toolhive/<store>` (`pkg/state/local.go:45`). `RunConfig.SchemaVersion = "v0.1.0"` (`runner/config.go:43`). On load, `ReadJSON` self-heals legacy content:
  - `migrateOAuthClientSecret` and `migrateBearerToken` turn plaintext secrets into secret references
  - `degradeNetworkIsolation` drops an unenforceable flag in memory and warns
- **App config**: `~/.config/toolhive/config.yaml` (`pkg/config/config.go`): `secrets{provider_type, setup_completed}`, `clients.registered_clients`, `registry_url`, `registry_api_url`, `local_registry_path`, `allow_private_registry_ip`, `otel{…}`, plus **one-shot migration flags**: `default_group_migration`, `telemetry_config_migration`, `middleware_telemetry_migration`, `secret_scope_migration`, `disable_usage_metrics`. `UpdateConfigAtPath` takes a separate `<config>.lock` (gofrs/flock via `pkg/lockfile`, `TryLockContext` with 100 ms polling), reloads, applies a closure, saves.
- **Encrypted secrets file** (`pkg/secrets/encrypted.go`): path `xdg.DataFile("toolhive/secrets_encrypted")`, mode 0600, written with `fileutils.AtomicWriteFile` (temp file in the same dir, fsync, chmod, rename: `pkg/fileutils/atomic.go`). Framing: `"THVSEC"` (6 B) | version `0x01` | salt (16 B) | `nonce|ciphertext|tag` (AES-256-GCM, `pkg/secrets/aes/aes.go`). Files without the magic are legacy (key = unsalted SHA-256 of the password) and are kept as-is until `thv secret upgrade-protection`, which rewrites atomically, re-reads to verify, and rolls back on mismatch (`verifyUpgradeOrRollback`, L234).
- **KDF** (`pkg/secrets/kdf.go`): Argon2id `time=2, memory=19456 KiB (OWASP minimum), parallelism=1`, 32-byte key. `deriveKeyCached` memoizes the last derivation per (path, salt, password) with `subtle.ConstantTimeCompare`.
- **Lock file for skills/plugins** (`pkg/skills/lockfile/lockfile.go`): `toolhive.lock.yaml` `{version: 1, skills[], plugins[]}`. Each entry is `{name, version, source, resolvedReference, digest, contentDigest, provenance{signerIdentity, certIssuer, repositoryUri, repositoryRef, runnerEnvironment, sigstoreUrl, publicKey, provisional}, unsigned, requiredBy, explicit}` plus `Extra map[string]any \`yaml:",inline"\``, so unknown future keys survive a rewrite by an older binary.

## Config format
- Per-run flags become a persisted `RunConfig` (JSON). Secrets are referenced as `<name>,target=<ENV>` (`pkg/secrets/types.go: ParseSecretParameter`); `<name>` is looked up in the provider.
- Provider selection order (`docs/arch/04-secrets-management.md`, "Provider Selection"): env `TOOLHIVE_SECRETS_PROVIDER` → `config.yaml` → default `encrypted`.
- Audit config (`pkg/audit/config.go`): `enabled, component, eventTypes[], excludeEventTypes[], includeRequestData, includeResponseData (both default off), detectApplicationErrors, maxDataSize, maxDelegationDepth, logFile`.
- Registry: upstream MCP registry JSON, ToolHive fields under `_meta["io.modelcontextprotocol.registry/publisher-provided"]["io.github.stacklok"][<image-or-url>] = {status, tier: Official|Community, tools[], tags[], permissions{network{outbound{allow_host[], allow_port[]}}}}` (`docs/registry/schema.md`). The legacy format is rejected, and `thv registry convert --in-place` migrates it losslessly.

## Extension points (plugins, hooks)
- **Middleware chain** (`docs/middleware.md:1055–1090`, `pkg/runner/middleware.go: PopulateMiddlewareConfigs`), outermost first:
  1. Audit
  2. Authentication
  3. Upstream token swap
  4. Token exchange
  5. Tool filter (list)
  6. Tool call filter
  7. MCP parser
  8. Telemetry
  9. Rate limit
  10. Mutating webhook
  11. Validating webhook
  12. Usage metrics
  13. Authorization (Cedar)
  14. Header forward
  15. Recovery

  Rules: audit wraps everything so *every rejection is audited*; the body-size limit and Origin check stay *outside* audit (oversized bodies are rejected before buffering); a body-rewriting middleware must republish the parsed request (`mcp.RepublishParsedMCPRequest`). A documented gap: the tool filter sees the pre-mutation body.
- **Webhooks**: `thv run --webhook-config` mutating and validating webhooks (`docs/middleware.md:25–66`).
- **Tool filter/override** (`pkg/mcp/tool_filter.go`): `WithToolsFilter(...)` allowlists and `WithToolsOverride(actual, name, description)` renames/re-describes. It applies to `tools/list` responses (JSON and SSE bodies are buffered and rewritten) and maps `tools/call` names back. A filtered tool answers exactly like a nonexistent one (`filteredToolNotFoundMessage = "tool not found"`), so the filter cannot be probed.
- **Revision classifier** (`pkg/mcp/revision.go: ClassifyRevision`):
  - `initialize` ⇒ Legacy, always
  - no Modern signal (header ≠ `2026-07-28` and no reserved `io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}` key in `_meta`) ⇒ Legacy
  - otherwise the request must carry `_meta.protocolVersion == "2026-07-28"`; it must match the header if present (`HeaderMismatchError`); `clientCapabilities` must be present (`MissingClientCapabilityError`)
  - special case (#6188): an explicit non-Modern header outranks a stray reserved key, "It broke every tools/call from the ChatGPT connector, which negotiates 2025-11-25 and sets reserved keys without a _meta protocolVersion"
  - `Mcp-Name` is required for `tools/call`, `resources/read`, `prompts/get` (`nameRequiredMethods`)

  The streamable proxy only enforces a version list (`2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28`) in strict mode; the default is permissive (`proxy/streamable/utils.go:180–200`). The transparent proxy uses "first HTTP-200 Modern request" as the readiness signal because Modern has no `initialize` (`proxy/transparent/transparent_proxy.go:786`, #5831).
- **vMCP** (`pkg/vmcp`):
  - conflict resolvers: `prefix` (`{workload}_`, `{workload}.`, or a static prefix), `priority`, `manual` (`aggregator/*_resolver.go`)
  - optimizer (`optimizer/optimizer.go`): exposes only `find_tool` + `call_tool`. Hybrid search uses SQLite FTS5/BM25 plus optional embeddings (`internal/toolstore/sqlite_store.go`); `MaxToolsToReturn` must be 1–50.
  - token metrics (`internal/tokencounter/counter.go`): estimate `len(json(tool))/4`, reporting `baseline_tokens`, `returned_tokens`, `savings_percent`
- **Policy gate**: `pkg/registry/policy_gate.go: PolicyGate` is called before registry mutations for external enforcement.

## Rules / lists: parsing and compilation
n/a for content rules: there are no domain/URL rule lists. Related machinery:
- the registry is fetched and cached (`pkg/registry/provider_cached.go`):
  - `defaultCacheTTL = 1h`, `maxCacheAge = 7d`
  - on transient failure (network, 5xx) it serves the stale cache; **auth errors always propagate** ("stale cache must never mask a changed authentication state", L124–137)
  - `ForceRefresh` invalidates the cache
- registry priority is API → remote JSON → local file → built-in; `thv config set-registry` auto-detects the type (URL without `.json` is probed for `/v0.1/servers`) (`docs/arch/06-registry-system.md:432–460`)
- `allow_private_registry_ip` (config) is an SSRF guard for registry URLs
- `docs/registry/heuristics.md` lists **inclusion heuristics** for registry entries: open-source license, CI, repo metrics, API compliance, tool stability, docs, release process, community health, security practices, acceptable licenses.

## Testing strategy
- 1,239 `_test.go` files. `go.uber.org/mock` mocks are generated into `mocks/` packages (e.g. `pkg/secrets/mocks`, `//go:generate mockgen` in `1password.go:16`). Benchmarks live next to hot paths (`sqlite_store_bench_test.go`, `cosine_bench_test.go`).
- `test/e2e/` (Ginkgo) covers API, clients, secrets, registry, workload lifecycle and the audit middleware (`audit_middleware_e2e_test.go`). `test/integration/`; Chainsaw tests for the operator.
- **MCP conformance** (`test/conformance/README.md`): runs the official `@modelcontextprotocol/conformance` suite at a pinned version against `thv run`. `expected-failures.yaml` is a baseline, and an entry that starts passing is a **stale entry and fails CI**. Flaky upstream scenarios are quarantined in the runner script, not the baseline.
- Secrets: `concurrency_test.go`, `integration_test.go`, `migration_test.go`; `pkg/lockfile/race_test.go`.

## UX patterns worth copying
- **`thv secret setup`** runs a provider-specific round-trip validation: write a test secret, read it back, compare, delete (`factory.go: validateEncryptedProvider`). It reports `SetupResult{ProviderType, Success, Message, Error}`. This is a template for `searchhole doctor` key checks.
- **First-run password prompt** is explained in plain words (`printPasswordPrompt`), never shown in detached mode, and the password is stored in the keyring **only after it successfully decrypted the store**, so a typo can be retried.
- **Discovery file for the local API** (`pkg/server/discovery/discovery.go`): `{url, pid, nonce, key_signing_capability?, started_at}`, file 0600 in a 0700 directory chain that is itself validated. `Discover()` returns `running | stale | unhealthy` by calling `/health` and checking the **nonce** (guards against PID reuse); `CleanupStale()` removes dead entries.
- **Install-source marker** (`pkg/desktop/types.go`): ToolHive Desktop writes `~/.toolhive/.cli-source` `{schema_version:1, source:"desktop", install_method: symlink|copy|flatpak, cli_version, symlink_target}`. `ValidateDesktopAlignment()` warns when a *different* CLI binary runs while a desktop-managed one exists. It fails open on any error and can be skipped by env.
- **Client config writers** (`pkg/client/config.go`, `config_editor.go`): a table of clients (settings file, JSON pointer prefix such as `/mcpServers`, per-OS relative paths, transport label maps, skills/plugins paths). Edits use `tailscale/hujson` (keeps comments and trailing commas) + JSON Patch `add` + `fileutils.WithFileLock` + atomic write 0600. YAML and TOML updaters cover the other formats.
- **Plugin materialization** (`docs/arch/14-plugins-system.md:80–81, 324–340`):
  - Claude Code: plugins go to `~/.claude/plugins/<name>/`; ToolHive maintains a shared `.claude-plugin/marketplace.json` plus `enabledPlugins` and `extraKnownMarketplaces.toolhive` in `settings.json`.
  - Codex: `~/.agents/plugins/toolhive/<name>/` plus `.agents/plugins/marketplace.json`; the user must still run `codex plugin install <name>@toolhive`.
- **Image verification modes** `warn | enabled | disabled` (`pkg/runner/retriever/retriever.go:29–34, 344–390`). In `warn`, even an unreachable sigstore TUF repo only warns, because an unreachable verifier "must not be stricter" than a failed verification.

## Performance tricks
- Single SQLite connection + `_txlock=immediate`: no lock-upgrade deadlocks (`BEGIN DEFERRED` → write) under concurrent writers.
- KDF memoization for the secrets file (`deriveKeyCached`) so Argon2id runs once per process.
- Tool filter rewrites SSE/JSON responses in a streaming buffer instead of reparsing whole sessions (`toolFilterWriter.drainBuffer`).
- `initializeCache` prevents N clients from re-handshaking a single stdio backend.
- Optimizer: precomputed baseline token counts; FTS5 for lexical recall before optional embeddings.

## License and what it means for us
Apache-2.0: code may be reused with attribution, the license text and NOTICE handling, and the patent grant applies. It is Go, so in practice we port designs to TypeScript. `toolhive-core` (verifier, audit constants) is a separate module whose license we did not inspect. Note the **privacy defaults we must not copy**:
- `pkg/updates/client.go` calls `https://updates.stacklok.com/api/v1/version` with an `X-Instance-ID` header (anonymous ID stored in `toolhive/updates.json`), throttled to once per `updateInterval = 30m` (`checker.go:80,177`)
- usage metrics are **enabled by default** and flushed every 15 min (`docs/middleware.md:318–358`)

## Implications for search-hole
- [key-storage] ToolHive's resolution order is a direct template:
  1. explicit provider, else env `TOOLHIVE_SECRETS_PROVIDER`, else config, else default `encrypted` (`docs/arch/04-secrets-management.md`)
  2. a `FallbackProvider` that on *not-found only* reads `TOOLHIVE_SECRET_<NAME>`, while writes always go to the primary (`pkg/secrets/fallback.go`)

  For us: host-injected env (`userConfig`/MCPB `user_config`) → process env `SEARCHHOLE_<ENGINE>_KEY` → own store. Not-found falls through; other errors surface.
- [key-storage] Own store design, recommended shape (evidence `pkg/secrets/encrypted.go`, `kdf.go`, `keyring/composite.go`):
  - an AES-256-GCM encrypted file with a versioned header (`magic|version|salt|nonce|ct|tag`), Argon2id key, 0600, atomic rename
  - the **master key** in the OS keychain
  - with zero native deps we can't use go-keyring; the TS equivalent is shelling out to `security` (macOS), `secret-tool` (libsecret, Linux) or PowerShell/`cmdkey`/DPAPI (Windows)
  - if no keychain is available (headless Linux), ToolHive refuses the encrypted provider (`ErrKeyringNotAvailable`); we should instead tell the user to use env vars, rather than invent a weaker store
- [key-storage] Persist **references, not values** (`runner/config.go:728–731`: values live only in non-serialized fields). Migrate any plaintext found in a config into a reference on load (`migrateOAuthClientSecret`), and namespace internal secrets (`__thv_<scope>_`) away from user-listed ones (`pkg/secrets/scoped.go`).
- [key-storage] A detached child can't prompt, so ToolHive passes the password via env to children (`TOOLHIVE_SECRETS_PASSWORD`, `docs/arch/04-secrets-management.md`, "Detached Processes"). Our gateway runs under a host with no TTY, so the gateway must **never prompt**. Only the CLI (`searchhole keys set`) writes; the gateway only reads.
- [security] Audit event shape to adapt for our `searches`/decision rows (`pkg/audit/event.go`, `auditor.go`): `{auditId, type, loggedAt(UTC), source{type,value,extra}, outcome ∈ success|denied|failure|error|application_error, subjects, component, target{type,name,method}, metadata.extra{duration_ms, transport, response_size, jsonrpc_error_code/message}, data?}`. Request/response bodies are **off by default** and capped by `maxDataSize`. A JSON-RPC error inside HTTP 200 counts as `application_error`.
- [security] Wrap the whole pipeline in the logger so every refusal (blocked domain, secret-in-query, SSRF) produces a row (`docs/middleware.md:1075`). A filtered tool or blocked thing answers like a nonexistent one only where probing is a risk. For blocked *domains* we want the opposite: explain the block.
- [dual-protocol] Port `ClassifyRevision` logic nearly verbatim (Apache, short enough to reimplement): Legacy by default, Modern only on an explicit signal, a hard error on header/body mismatch, and the ChatGPT #6188 exception. `Mcp-Name` validation applies to `tools/call`. A Modern-only client never sends `initialize`, so any "first initialize" readiness or session-start logic needs a Modern fallback (#5831).
- [session-definition] Lesson from `initialize_cache.go`: one stdio process is one MCP session no matter how many conversations ride on it. That confirms the plan's point that process ≠ conversation (Desktop) and that `clientInfo` from `initialize` (Legacy) or from `_meta.io.modelcontextprotocol/clientInfo` on *every* Modern request is the only per-request client identity. Record `client_name/version` per search row, not just per process.
- [dashboard-process-model] Copy the discovery-file pattern for `searchhole ui`: `~/.searchhole/run/ui.json {url, pid, nonce, token?, started_at}` 0600 in a 0700 dir. Gateways and `/search-hole:dashboard` read it, verify `/health` returns the same nonce, reuse a running UI or clean up the stale file and start one. Evidence `pkg/server/discovery/{discovery,discover}.go`.
- [upgrades-migrations] Multi-install detection: an install-source marker (`pkg/desktop/types.go`) lets one install notice another. Ours can be a row in the DB (`installs`: kind plugin|mcpb|npx, version, path, last_seen) so `doctor` can say "Desktop extension v1.3 and plugin v1.4 share this DB". Use one-shot data-migration flags in config (`secret_scope_migration`, …) for non-schema migrations.
- [upgrades-migrations] Preserve unknown keys on rewrite (`lockfile.go: Extra map[string]any yaml:",inline"`) for every file we rewrite (`rules.yaml`, list lock files), so an older binary doesn't delete a newer one's fields.
- [sqlite-driver] Pure-Go/no-native SQLite with a single connection, `_txlock=immediate`, WAL, `busy_timeout=5000` is ToolHive's choice (`pkg/storage/sqlite/db.go`). The TS analogue is `node:sqlite` or `bun:sqlite` (no native module) with `BEGIN IMMEDIATE` for writes.
- [lists-subscriptions] Registry cache semantics map onto list refresh: TTL plus "keep last good on transient failure, surface auth/HTTP-4xx-class problems" (`provider_cached.go`), and an explicit private-IP opt-in for subscription URLs (`allow_private_registry_ip`).
- [lists-subscriptions] Provenance + lock file for lists: pin `digest` and `contentDigest` (deterministic SHA-256 over normalized content) per subscribed list, with optional signer identity (sigstore) later. Cap attacker-controlled blobs (`maxSignatureBlobSize = 1 MiB`, `pluginsvc/verify.go`). Offer `warn | enforce | off` verification modes like `VerifyImage`.
- [mcp-tool-surface] The optimizer's token estimator (`len(json(tool))/4`, `tokencounter/counter.go`) is a cheap, dependency-free CI metric for our "≤ ~1.5k tokens" budget. Use a real tokenizer in CI if available and keep `/4` as the fallback.
- [mcp-tool-surface] ToolHive keeps model-visible surface small by tool allowlists, renames/description overrides, and `find_tool`/`call_tool` indirection. We expose only 4 tools, so none of this is needed for us; the description override is a nice escape hatch for power users to shorten descriptions (inferred).
- [distribution] The client table (`pkg/client/config.go`, ~27 clients with per-OS paths and JSON pointer prefixes) and hujson-preserving patching are the model for `npx search-hole setup`. Claude Code's user-level MCP config is `~/.claude.json` at `/mcpServers`; Cursor's is `~/.cursor/mcp.json`.
- [distribution] ToolHive materializes `.claude-plugin` bundles into Claude Code by editing `settings.json` `enabledPlugins`/`extraKnownMarketplaces`. It is useful to know this works, but we should install through the official `/plugin marketplace add` flow, not edit settings (`docs/arch/14-plugins-system.md:80`).
- [testing] Run the official MCP conformance suite against our gateway, at a pinned version, with an expected-failures baseline where stale entries fail CI (`test/conformance/`).
- [other] Never ship ToolHive's default-on update ping with an instance ID or default-on usage metrics. Our update check (if any) must be opt-in and ID-free.

## Borrow / avoid
**Borrow**
- Secrets provider interface with `Capabilities{CanRead,CanWrite,CanDelete,CanList}` and read-only providers for env (`pkg/secrets/types.go`).
- Fallback-on-not-found chain; references-not-values persistence; scoped internal keys.
- Encrypted file format (versioned magic header, salt, AES-GCM, Argon2id at the OWASP minimum, atomic write + verify-or-rollback upgrade).
- "Store master password only after successful decrypt"; "never prompt when detached".
- Audit event schema and outcome vocabulary; audit as the outermost wrapper; bodies off by default.
- `ClassifyRevision` rules and the ChatGPT quirk.
- Discovery file + nonce health check; install-source marker; config `.lock` + closure update; unknown-key preservation.
- hujson + JSON Patch config editing with file lock + atomic 0600 write.
- MCP conformance suite with a stale-failing baseline.
- Registry cache semantics (TTL, stale-on-transient, auth errors propagate).

**Avoid**
- Default-on telemetry, usage metrics and update pings with instance IDs (`pkg/updates`, `pkg/usagemetrics`).
- Requiring an OS keyring for the only secure option and hard-failing without one. Offer env vars as a first-class path instead.
- Containers per server, Kubernetes operator, Cedar, token exchange: irrelevant weight for a single-purpose local gateway.
- An HTTP API for local CLI operations ("The CLI is an HTTP client even for local operation"). For us the CLI talks to SQLite directly.
- Editing Claude Code `settings.json` to enable plugins behind the user's back.
