# modelcontextprotocol/inspector
> Ref: `research/refs/mcp-inspector` @ e321738 (2026-10-28) · License: **Apache-2.0 AND MIT (relicensing transition)**. One root `LICENSE`, no per-directory licenses (`find -iname 'LICENSE*'` returns only `./LICENSE`). Its preamble says the MCP project is moving from MIT to Apache-2.0: new code is Apache-2.0, documentation (excluding specs) is CC-BY-4.0, and contributions whose authors have not consented to relicensing stay MIT. The root `package.json` has `"license": "SEE LICENSE IN LICENSE"`, and the private client manifests point at `../../LICENSE`, except `clients/mcpdo/package.json` (private, shipped inside the fat package), which says `"MIT"`. Both licenses are permissive, so short snippets with attribution are fine. Package version `2.13.0`.

## Purpose
This is the official MCP debugging tool, v2 line. One npm package (`@modelcontextprotocol/inspector`) ships four clients over one shared core: **web** (Hono backend plus React/Mantine SPA), **CLI** (one-shot `--method …`), **TUI** (Ink) and **mcpdo** (an experimental, connection-first CLI with an ssh-agent-style daemon). See `package.json` `bin` (`mcp-inspector`, `inspector`, `mcpdo`) and `docs/architecture.md`.

Why it matters to search-hole:
1. **Reference for a shared core under many UIs.** This is the same shape as our `core` + `cli` + `dashboard` + `gateway` split.
2. **Reference for a token-protected local HTTP server** that can spawn processes. Our dashboard is the same threat class.
3. **It already speaks 2026-07-28 and 2025-11-25** through the "era" model, and it documents what SDK v2 does and does not handle. This is primary evidence for our dual-protocol ADR.
4. P2's acceptance criterion says "works in MCP Inspector", so its defaults (legacy era, env allowlist, schema lint) become our test constraints.

## Architecture sketch
```text
clients/launcher  ── `mcp-inspector [--web|--cli|--tui]` → dynamic import of ../{web,cli,tui}/build/index.js
clients/web       ── server/ (Hono, tsdown "runner") + src/ (React 19, Mantine 8, Vite 8, 123 Storybook stories)
clients/cli       ── tsdown bundle, one-shot connect → method → disconnect
clients/tui       ── Ink React tree over the same hooks
clients/mcpdo     ── mcp-bin.js + mcpdod.js daemon over a Unix socket + token
core/             ── NO package.json; consumed via alias "@inspector/core" and bundled into each client
  mcp/            InspectorClient (6.5k lines), MessageTrackingTransport, state stores, era/version types
  mcp/node/       createTransportNode (stdio | sse | streamable-http), fetchGuard (SSRF), config resolution
  mcp/remote/     browser↔backend protocol: remoteClientTransport (browser), remote/node/server.ts (Hono API, 3.5k lines)
  react/          useSyncExternalStore hooks over the stores (shared by web + TUI)
  auth/           isomorphic OAuth + browser/node/remote backends; secret store (keyring | file | memory)
  json/schemaLint pure tool-schema portability lint shared by all clients
test-servers/     composable real MCP servers (presets + JSON configs), stdio + HTTP, legacy + modern legs
```
Runtime topology (web mode): browser SPA → `/api/*` on `127.0.0.1:6274` (token header) → backend `RemoteSession` → SDK `Client` → stdio child or remote MCP server. The MCP Apps sandbox runs on a **separate listener**, `:6275`, and apps that declare `_meta.ui.domain` get a dedicated app-origin listener on `:6278` (`clients/web/server/server.ts: startHonoServer`; `docs/environment-variables.md`).

## Key modules and data flow
- **Connect.** `InspectorClient` (`core/mcp/inspectorClient.ts`) builds a transport with `createTransportNode` (`core/mcp/node/transport.ts`) and wraps it in `MessageTrackingTransport` (`core/mcp/messageTrackingTransport.ts`). That wrapper intercepts `send` and `onmessage` and calls `trackRequest`, `trackResponse`, `trackNotification` and `trackSendFailure`, each tagged with origin `client` or `server`.
- **Message log.** `messageLogState` (`core/mcp/state/messageLogState.ts`) keeps a ring buffer, `maxMessages` defaulting to **1000** (`shift()` on overflow). Responses are folded into their request entry by JSON-RPC id, and `duration` is computed. Entry shape is `MessageEntry` (`core/mcp/types.ts`): `{id, timestamp, direction: request|response|notification, origin?, message, response?, duration?, clientError?}`. `clientError` marks results the *client* refused, for example a 2026 `tools/list` missing `ttlMs`, so they don't render as clean success.
- **Typed event bus.** `inspectorClientEventTarget.ts` defines the events: `statusChange`, `toolsChange`, `protocolVersionChange`, `protocolEraChange`, `discoverResultChange`, `message`, `stderrLog`, `fetchRequest`, `connectionDiagnosticsChange` and more. The React hooks in `core/react/*` (`useMessageLog`, `useStderrLog`, `useFetchRequestLog`…) read store snapshots **during render** via `useSyncExternalStore`, so no event is lost between render and subscribe (`docs/architecture.md`, #1955).
- **Browser path.** `remoteClientTransport.ts` POSTs `/api/mcp/connect`, `/api/mcp/send` and `/api/mcp/disconnect`. It reads `/api/mcp/events?sessionId=` as SSE through **`fetch()` plus a `ReadableStream` reader, not `EventSource`**, so it can send the `x-mcp-remote-auth` header (`core/mcp/remote/remoteClientTransport.ts` around line 520).
- **Backend routes** (`core/mcp/remote/node/server.ts`):
  - `/api/config`, `/api/mcp/{connect,send,disconnect,events,auth-state}`
  - `/api/fetch`: the OAuth proxy, run through the destination guard
  - `/api/log`, `/api/storage/:storeId`
  - `/api/servers[/:id|/order|/events]`: catalog CRUD plus SSE "change" pings driven by a chokidar watch on `mcp.json`

## Data model and storage
- **Catalog** `~/.mcp-inspector/mcp.json` (`MCP_CATALOG_PATH`): `{ mcpServers: { <id>: {type: stdio|sse|streamable-http, command, args, env, cwd | url, headers, protocolEra, modernLogLevel, roots, metadata, connectionTimeout(30000), requestTimeout, taskTtl(60000) …} } }` (`docs/mcp-server-configuration.md` "File format"). `--catalog` is writable and seeded on first use. `--config` is read-only and is never written or migrated. The difference is "who owns the file".
- **Storage dir** `~/.mcp-inspector/storage/` holds `oauth.json` (non-secret OAuth state, with a `secretsNamespace` UUID) and `client.json`.
- **Secret store** (`docs/secret-storage.md`), selected once per process:
  1. `MCP_INSPECTOR_SECRET_STORE` (`keyring|file|memory`)
  2. otherwise probe the OS keychain through **`@napi-rs/keyring`** (a native module; service `mcp-inspector`). The probe must read *and* enumerate.
  3. otherwise fall back to `memory` in a container without a volume, or to a `file` store elsewhere

  The file store is `~/.mcp-inspector/secrets.json`, mode `0600`. It is plaintext unless `MCP_INSPECTOR_SECRET_KEY[_FILE]` is set, which gives AES-256-GCM with a scrypt-derived key and a fresh salt on every write. **Stdio `env` values and OAuth client secrets are moved out of `mcp.json` into the store; each key is left with an empty value.** `headers` are not moved.
- **Cross-process writes** use `proper-lockfile` on `<file>.lock` (10 s stale), then read-modify-write-verify with up to 5 retries. The lock-directory inode is checked before removal to survive a stale-lock takeover (`docs/secret-storage.md` "Two Inspectors, one file").
- No database. Logs are in memory only (the ring buffer); export is a client-side download.

## Config format
- Everything is env-driven; the full table is in `docs/environment-variables.md`.
  - Ports: `CLIENT_PORT`=6274 (must be fixed, 0 is rejected), `MCP_SANDBOX_PORT`=6275, `MCP_APP_ORIGIN_PORT`=6278, OAuth callback `127.0.0.1:6276`.
  - `HOST` (default `127.0.0.1`), `ALLOWED_ORIGINS`, `MCP_INSPECTOR_ALLOWED_HOSTS`, `MCP_INSPECTOR_API_TOKEN`.
  - `DANGEROUSLY_OMIT_AUTH` and `DANGEROUSLY_BIND_ALL_INTERFACES` accept only `true` or `1`. The `isEnvFlagEnabled` helper exists because `=false` once turned auth *off* (#2331; `clients/web/server/resolve-bind-host.ts`).
- Per-server fields such as `protocolEra` are orthogonal to transport `type`. CLI flag: `--protocol-era legacy|auto|modern`.

## Extension points (plugins, hooks)
- There are no third-party plugins. "Extensions" here means MCP protocol extensions:
  - `core/extension/tasks` (SEP-2663 tasks, which SDK v2 removed)
  - `core/extension/skills` (`skills/list`, SEP-2640)
  - MCP Apps via `@modelcontextprotocol/ext-apps` `AppBridge` (`clients/web/src/components/elements/AppRenderer/createAppBridgeFactory.ts`)
- `client.fallbackRequestHandler` (SDK v2) is noted as the hook for catching arbitrary inbound requests in a debugger (`specification/v2_new_spec_impact.md` §8.1).

## Rules / lists: parsing and compilation
n/a. There is no rules or list concept. The closest analogue is `core/json/schemaLint.ts`: a pure, dependency-free rule set (`boolean-schema`, `type-union`, `untyped-schema`, `remote-ref`) with `error` and `warning` severities. Each finding carries `path`, `issue` and `suggestion`, and all three clients share one verdict. It was motivated by a census of 617 public servers (14,804 tool schemas): 0 failed the SDK's own parse, but real clients such as Claude Code reject narrower constructs (`schemaLint.ts` header).

## Testing strategy
- **602 test files** (`*.test.ts[x]` under `clients/` and `core/`) plus **123 Storybook stories** whose play functions run headless in CI (`test:storybook`). Vitest 4.1 runs with explicit timeout tiers (`vitest.shared.mts`: 15 s / 30 s).
- **Real servers, not mocks.** `test-servers/` builds composable servers from presets (`preset-registry.ts`) driven by JSON configs (`test-servers/configs/*.json`, 45 files). Examples: `modern-http.json`, `mrtr-showcase-http.json`, `subscriptions-listen-refused-http.json`, `oauth-stalled-token-http.json`, `unportable-schemas-many-http.json`. The stdio server runs as a real subprocess (`test-server-stdio.ts`), and `--crashable` adds a `crash_server` tool for mid-session crash tests.
- **The modern leg of the test HTTP server** is `createMcpHandler(() => createMcpServer(cfg), { legacy: "stateless" | "reject" })` (`test-servers/src/test-server-http.ts: startModernHttp`). One factory backs both eras. Message interception is *not* available on that leg ("the modern handler … exposes no `onmessage` seam").
- **Smoke scripts** cover every client (`scripts/smoke-*.mjs`) plus Playwright engine smokes across chromium, firefox and webkit (`npm run smoke:web:{chromium,firefox,webkit}`).
- **Repo guards** include `verify-bundle-externals`, `verify-dep-lockstep`, `verify-test-timeouts`, `verify-action-pins` and a DCO check (`package.json` scripts).

## UX patterns worth copying
- **Protocol (history) screen** (`clients/web/src/components/groups/ProtocolEntry/ProtocolEntry.tsx`, `ProtocolListPanel.tsx`, `ProtocolControls.tsx`):
  - Free-text search over `method + id + JSON(message) + JSON(response)`, a method select ("All methods"), and per-direction toggles client→server / server→client (`MessageDirectionFilter`).
  - A sort-direction toggle, and a **Pinned** section above **History**, each with its own Clear and Export.
  - Rows are cards. The header shows an ISO timestamp, a direction badge, a method badge, the target (`params.name` or `params.uri`, with a copy button for URIs), duration in ms, and a status badge (OK / Error / Pending, or `complete` / `input required` for 2026 results).
  - Expanding a row (`Collapse`) shows "Parameters" and "Response" in a `ContentViewer` with copy.
  - Spec errors (-32020/-32021/-32022) get a red alert, and a "View the HTTP request in the Network tab →" link correlates to the HTTP log.
  - **Replay** and **Edit & replay** re-issue a request.
  - A compact two-line variant fits a 320 px sidebar (`embedded`).
- **MRTR grouping.** `groupProtocolEntries` (`clients/web/src/components/groups/protocolUtils.ts`) folds a chain of rounds linked by `requestState` into one expandable "MRTR conversation" row. The equivalent for us: group one `search` call's engine fan-out into one row.
- **Era / version badges** (`EraBadge`, `VersionBadge`) and Connection Info showing the `server/discover` result.
- **The startup banner prints facts, not marketing.** It shows the URL (with token), the sandbox URL, `Auth token: …`, a non-loopback exposure warning, and `Secrets: <which store, encrypted or not>` (`web-server-config.ts: printServerBanner`). The line about where secrets went is printed even when nothing is wrong, "so it can be used to confirm that nothing is".
- **Error text names the fix.** For example, the Host-reject 403 says which env var admits the host (`host-allow-list.ts: hostAllowListMiddleware`), and the bind refusal explains the DNS-rebinding risk (`resolve-bind-host.ts`).

## Performance tricks
- **Ring buffers** cap the message log at 1000 entries and the fetch log at 1000 (`DEFAULT_MAX_FETCH_REQUESTS`, `core/mcp/types.ts`).
- **One keychain pass for the whole catalog** (`core/mcp/node/server-secrets.ts: rehydrateMcpConfigFromKeychain` → `secretStoreGetMany`). A 20-server catalog used to pay 20 serialized scrypt derivations.
- **Bundle hygiene.** tsdown `deps.alwaysBundle: [/^@inspector\/core/]` plus an explicit `neverBundle` list with subpath regexes (`clients/cli/tsdown.config.ts`). Inlining CJS deps (`undici`, `proper-lockfile`) into an ESM bundle produced a `require("assert")` shim that crashed at import (#2067). JSDoc comments are stripped (`comments: { jsdoc: false }`) because they "nearly double" the bundle.
- **SSE priming.** The backend writes the `":\n\n"` SSE comment immediately. Otherwise Firefox's `fetch()` never resolves on a silent stream, and the UI hangs on "Connecting…" (`core/mcp/remote/node/server.ts: SSE_PRIMING_COMMENT`, #1858).

## License and what it means for us
Apache-2.0 for new code and MIT for older, unconsented contributions. Both are permissive. We may copy or adapt code (for example the Host allow-list, the fetch guard, the SSE priming helper) if we keep the copyright notice and the license text. To be safe, cite both licenses in `THIRD_PARTY_NOTICES` and mark adapted files. Documentation is CC-BY-4.0, so quoting docs needs attribution.

## Implications for search-hole
- [monorepo-shape] The Inspector deliberately avoids workspaces:
  - `core/` has no `package.json` and is consumed by bundling: an alias plus tsdown `alwaysBundle` for Node clients, and a Vite alias for the browser.
  - It publishes one fat package with several bins (`specification/v2_cli_tui_launcher.md` "Why not workspaces"). Workspace symlinking "does not apply" when every consumer bundles, and per-client `node_modules` avoid dual React/SDK instances.

  For us: keep pnpm workspaces for dev ergonomics (plan §12.1), but **publish only bundled artifacts** (gateway, CLI, dashboard static) and keep internal packages `private`. That matches the plugin and `.mcpb` "no npm install" goal.
- [monorepo-shape] The Inspector's discipline: every runtime dep that `core/` imports is declared in the root manifest and listed as external in *every* bundle config, guarded by `scripts/verify-bundle-externals.mjs`. If we bundle to one file (plan §4 "Bundling"), the reverse rule applies: inline everything except native or optional modules. Add a CI guard that greps the bundle for stray `require(` shims.
- [dual-protocol] **The Inspector's default per-server era is `"legacy"`**, a plain 2025-11-25 `initialize` (`core/mcp/types.ts: DEFAULT_PROTOCOL_ERA`). SDK guidance says "a debugging tool must not auto-probe (a probe stalls on silent stdio legacy servers and pollutes recorded transcripts)". So "works in MCP Inspector" (P2) means **our stdio gateway must answer a legacy `initialize`**. Test both eras in CI with `mcp-inspector --cli --protocol-era legacy|modern node dist/gateway.js --method tools/list`.
- [dual-protocol] SDK v2 maps the modes as follows (`specification/v2_new_spec_impact.md` §8.2; `core/mcp/types.ts: eraToVersionNegotiation`):
  - `versionNegotiation: {mode:"auto"}` probes `server/discover` and falls back to `initialize`
  - `{pin:"2026-07-28"}` forces modern
  - the default is legacy

  Server side, the Inspector's HTTP test server serves both eras from **one factory** via `createMcpHandler(factory, {legacy:"stateless"})` (`test-servers/src/test-server-http.ts`). Its stdio test server still uses `new StdioServerTransport()` plus `server.connect()` (`test-servers/src/test-server-stdio.ts`), the legacy-only path. Whether `serveStdio` serves both eras over stdio is not evidenced in this ref. It **is** confirmed in the SDK ref: `serveStdio` defaults to `legacy:'serve'` and pins each connection to the era it opens with (`packages/server/src/server/serveStdio.ts`; see `mcp-typescript-sdk.md`).
- [dual-protocol] What changes on a modern connection (spec-impact §7–8): no session id, `resultType` on every result, `ttlMs`/`cacheScope` on lists, per-request log opt-in via `_meta["io.modelcontextprotocol/logLevel"]` (`logging/setLevel` is gone), and `-32020/-32021/-32022` errors. A modern Inspector client **rejects** a list result missing `ttlMs` (`MessageEntry.clientError` doc), so our modern responses must set them. Cache hints matter for our `tools/list`: set a long `ttlMs`, since the tools are static.
- [session-definition] The modern era has no session id, and even in the Inspector a "connection" no longer implies a server-side session (`v2_new_spec_impact.md` §9.1). This confirms that session identity cannot come from MCP connection or transport state. It does not rule out MCP-level handles: the spec recommends a server-minted handle passed as a tool argument (SEP-2567; see `mcp-spec.md`). Host signals (hook `session_id`) can correlate, and process lifetime plus an idle gap is at most a fallback grouping label, because the spec forbids treating a process as a session (`basic/index.mdx` §"Statelessness").
- [security] **Bind.** Default `127.0.0.1`, not `localhost`. Since Node 17, `listen(port,"localhost")` binds only the first resolved family (often `::1` on glibc Linux), which breaks IPv4-pinned clients (#1951). Refuse any all-interfaces host unless `DANGEROUSLY_BIND_ALL_INTERFACES=true`, and fail fast with an explanation (`clients/web/server/resolve-bind-host.ts`). Copy this exactly.
- [security] **Host allow-list as global middleware**, registered before every route except `/health` (`clients/web/server/host-allow-list.ts`, `server.ts`):
  - Allow `localhost`, `*.localhost`, any dotted-quad IPv4, any bracketed IPv6, the bind host, the hosts from allowed origins, and the extra hosts env var.
  - Reject a missing `Host`, and reject comma-joined duplicate `Host` headers through a `^[a-z0-9._-]+$` check.
  - Ignore the port.

  This matches our planned Host check. Adopt its edge cases: trailing dot, IDN to punycode, shorthand IPv4 such as `127.1` treated as a name.
- [security] **Origin check** (`core/mcp/remote/node/server.ts: createOriginMiddleware`):
  - The default list is all three loopback spellings × the exact port (`localhost`, `127.0.0.1`, `[::1]`; `web-server-config.ts: defaultAllowedOrigins`).
  - Preflight is answered only for listed origins (methods GET/POST/DELETE/OPTIONS, headers `Content-Type, x-mcp-remote-auth`, max-age 86400).
  - A request with no `Origin` is allowed.

  For us ("no CORS"): never emit `Access-Control-Allow-Origin` and reject any non-loopback `Origin`. Our SPA is same-origin, so CORS is never needed.
- [security] **Token.** `randomBytes(32).toString("hex")` per start, or `MCP_INSPECTOR_API_TOKEN`. It is checked with `timingSafeEqual` after a length check, from the `x-mcp-remote-auth: Bearer` header (`createAuthMiddleware`). It is delivered to the browser in three ways:
  - `?MCP_INSPECTOR_API_TOKEN=` in the printed URL
  - injected into **every** served `index.html` as `window.__INSPECTOR_API_TOKEN__`, with `Cache-Control: no-store` (`inject-auth-token.ts`)
  - persisted in `sessionStorage` (`clients/web/src/lib/authToken.ts`)

  Injection means the token protects only against cross-origin pages. **Any local process that can pass the Host check can `GET /` and read it.** It also puts the token in an inline `<script>`, which forces `script-src 'unsafe-inline'` or a nonce. MCPJam's fragment approach is stricter (see mcpjam-inspector.md). Pick that one, and add a test that served HTML never contains the token.
- [security] **CSP.** The Inspector's main page sends **no CSP** and loads Google Fonts from the network (`clients/web/index.html`). Only the sandbox proxy (`frame-ancestors` only) and app documents get policies. Do not copy this. Our plan (strict CSP, bundled fonts) is stricter.
- [security] **SSRF guard pattern** (`core/mcp/node/fetchGuard.ts`):
  - http/https on every hop
  - `redirect:"manual"` with re-validation per hop, `MAX_FETCH_REDIRECTS = 5`
  - the address check runs **inside undici's `connect.lookup`**, so the validated IP is the one connected to (no TOCTOU / DNS rebinding)
  - IP literals are checked before the request, because `net.connect` skips lookup for them
  - under `HTTPS_PROXY`, `EnvHttpProxyAgent` is built with the same pinning lookup

  It blocks only link-local and metadata ranges, because LAN MCP servers are legitimate there. Our `fetch` package should reuse the mechanism with a wider deny set (RFC 1918, loopback, CGNAT, ULA). This validates the undici `connect.lookup` half of plan §12.4's "undici `connect.lookup` + ipaddr.js". The Inspector itself uses `node:net` `isIP` with hand-written range checks, not ipaddr.js.
- [dashboard-process-model] Browser-side SSE must send auth. The Inspector uses `fetch()` with a reader, not `EventSource` (which cannot set headers), and it primes each stream with `":\n\n"` (a Firefox deadlock fix). For our tail-and-push SSE: either do the same, or exchange the URL fragment token for an `HttpOnly; SameSite=Strict` cookie so `EventSource` works. Always prime the stream.
- [dashboard-process-model] Inspector ports are fixed (6274, refuses 0), because the origin allow-list and sandbox CSP derive from the port. When the fixed sandbox port 6275 is taken it falls back to an OS-assigned port *with a loud warning*. Our single-instance dashboard on a fixed port has the same constraint, so pick a port and handle `EADDRINUSE`. Their policy: print `portInUseMessage`, then exit 1.
- [dashboard-process-model] mcpdo's daemon is reached over a Unix socket plus a token (`clients/mcpdo/src/daemon/ensure.ts`: probe the socket with a 500 ms timeout, spawn, poll every 50 ms up to 10 s). **It reuses a running daemon without checking its code version**, and their README warns that stale daemons keep running old code. If we ever add a daemon, put a version/schema handshake in the ping (this feeds our upgrades ADR).
- [key-storage] The Inspector solved the same problem we have: keychain if reachable, otherwise a file at `0600` (optionally AES-256-GCM via a key file), otherwise memory. Store selection is reported in the banner and UI footer. It depends on **`@napi-rs/keyring` (native)**, which conflicts with our zero-native-deps goal. Borrow the selection order, the honest reporting and the "secrets moved out of config, empty placeholder left" convention. Implement keychain access via OS CLIs (`security`, `secret-tool`, PowerShell CredMan) or Bun, per our ADR.
- [key-storage] **Stdio env allowlist.** The Inspector does not pass its own env to the servers it spawns. Children get `HOME, LOGNAME, PATH, SHELL, TERM, USER` plus the configured `env:` (`docs/secret-storage.md`; `core/mcp/node/transport.ts` passes `env: stdioConfig.env` to `StdioClientTransport`). So **when tested from the Inspector, our gateway will not see `BRAVE_API_KEY` etc. unless it is in the server's `env`**. Our key resolution (host-injected env → process env → own store) must fall through to our own store, and `doctor` should say where each key came from.
- [mcp-tool-surface] Run `mcp-inspector --cli <gateway> --method tools/list --strict` in CI:
  - It exits 6 on error-severity portability findings (`clients/cli/README.md` "`--strict`").
  - Only `boolean-schema` (a bare `true`/`false` subschema) is error severity and fails the gate. `type-union` (`type: [..]`), `untyped-schema` and `remote-ref` are warnings only (`core/json/schemaLint.ts`). Our zod 4 → JSON Schema output should avoid all four, but CI must parse the stderr report (or treat warnings as failures itself) to enforce the last three.
  - Add `--app-info` plus `--advertise-apps` to assert our `receipt` tool's `_meta.ui` (resourceUri, csp) in CI.
- [ui-ux] Copy the log-row anatomy for our live search log:
  - timestamp, direction/client badge, method/engine badge, target (query), duration, status
  - expand to JSON with copy, pin, Replay / "re-run search"
  - a Pinned section with per-section Clear/Export
  - free-text search plus a method filter
- [ui-ux] **The MCP Apps CSP the Inspector applies as a host** (one host's policy; others may differ) (`clients/web/src/utils/sandbox-csp.ts: buildSandboxCspPolicy`): `default-src 'none'; connect-src <connectDomains|'none'>; script-src 'unsafe-inline' <resourceDomains>; style-src` likewise, `img/font/media-src <resourceDomains|'none'>`, `frame-src <frameDomains|'none'>`, `form-action 'none'`, `object-src 'none'`, `worker-src 'none'`. By default the inner iframe is sandboxed **without** `allow-same-origin`, so it gets an opaque origin. The exception is an app whose UI resource declares `_meta.ui.domain`: that app is served from the dedicated app-origin listener and granted a real origin (`clients/web/static/sandbox_proxy.html`). If we declare no `_meta.ui.csp` domains and no `ui.domain`, our receipt panel must be one inline HTML file, with no `fetch`, no web fonts unless inlined, no workers and no `localStorage`. Interact only through `app.callServerTool`.
- [testing] Mirror their test-server design for our mock engine server: presets plus JSON scenario configs (one config per failure mode), real subprocess for stdio, and a "crashable" flag. Add an era matrix (legacy vs modern) to the MCP e2e suite.
- [distribution] Their fat-package model ships Vite as a runtime dependency so `--web --dev` works (`v2_cli_tui_launcher.md` "Published runtime deps — Vite"), at the cost of install footprint. We should ship prebuilt static dashboard assets only and keep Vite out of the runtime deps.

## Borrow / avoid
**Borrow**
- The bind policy: `127.0.0.1` default, refuse wildcard without an explicit `DANGEROUSLY_*` flag that accepts only `true`/`1`, and an explanatory fail-fast (`resolve-bind-host.ts`).
- The Host allow-list middleware and its parsing edge cases, registered before every route, with a 403 that names the fix (`host-allow-list.ts`).
- Default origins = the three loopback spellings × the exact port (`web-server-config.ts: defaultAllowedOrigins`).
- `timingSafeEqual` after a length check, and `Cache-Control: no-store` on any document tied to a token.
- The SSE `":\n\n"` priming comment and `fetch()`-reader SSE with auth headers (`server.ts: SSE_PRIMING_COMMENT`, `remoteClientTransport.ts`).
- The fetch-guard design: undici `connect.lookup` pinning, manual redirects with per-hop re-validation, max 5 hops (`core/mcp/node/fetchGuard.ts`).
- Secret-store selection order and honest reporting, and secrets out of config files with empty placeholders (`docs/secret-storage.md`).
- `proper-lockfile` plus read-back verify for cross-process file writes (rules files, the `.searchhole.yaml` trust store).
- One shared core with typed events and `useSyncExternalStore` hooks, so CLI, TUI and web agree.
- Log-row UX: badges, duration, expand-to-JSON with copy, pin, replay, MRTR-style grouping of related rows.
- The schema-portability lint idea and the CLI `--strict` gate, and composable JSON-configured test servers.

**Avoid**
- Injecting the API token into every served `index.html`: it is readable by any local process passing the Host check, and it forces inline script.
- No CSP on the main UI, and remote Google Fonts.
- Default-allowing requests with no `Origin` *without* a token, and emitting CORS headers at all for a same-origin SPA.
- A native keychain module (`@napi-rs/keyring`) in a zero-native-deps plugin.
- Reusing a long-lived daemon without a version handshake (mcpdo).
- Vite and other dev toolchains as runtime dependencies of the published package.

## Verification
- Date: 2026-10-29. Checked against `research/refs/mcp-inspector` @ e321738.
- Claims checked: 41 (license header and section; every "Implications for search-hole" bullet; the mechanisms they rely on: `core/` without a `package.json`, the tsdown `alwaysBundle`/`neverBundle`/`comments` config, the AGENTS.md externals rule, `DEFAULT_PROTOCOL_ERA` and `eraToVersionNegotiation`, the test-server era wiring, `MessageEntry.clientError`, the bind-host, Host allow-list and Origin middleware, token generation, comparison and injection, the missing main-page CSP, the fetch guard, SSE priming, fixed ports and the sandbox fallback, mcpdo daemon timings, the secret store, the stdio env allowlist, `--strict`/`--app-info`/`--advertise-apps`, schema-lint severities, the sandbox CSP and iframe sandboxing, test-server configs, the Vite runtime dependency, file and story counts).
- Corrections:
  1. [dual-protocol]: the open question "does `serveStdio` serve both eras?" is resolved by the SDK ref. It does, with a default of `legacy:'serve'` and per-connection pinning.
  2. [session-definition]: "never from MCP" contradicted the spec note. The bullet now says: not from MCP connection or transport state; a server-minted handle (SEP-2567) is the recommended mechanism; process lifetime is at most a fallback label.
  3. [mcp-tool-surface] `--strict`: only `boolean-schema` is error severity (exit 6). `type-union`, `untyped-schema` and `remote-ref` are warnings and do not fail the gate.
  4. [ui-ux] Apps CSP: this is the Inspector's own host policy, and `frame-src` comes from `frameDomains`. Apps that declare `_meta.ui.domain` get a real origin, so the "single inline file" conclusion holds only when we declare no CSP domains and no `ui.domain`.
  5. [security] SSRF: the Inspector validates the `connect.lookup` approach but uses `node:net` `isIP`, not ipaddr.js.
  6. License header: `clients/mcpdo/package.json` (private) declares `"MIT"`; the other client manifests point at the root LICENSE.
