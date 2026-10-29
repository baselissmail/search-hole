# modelcontextprotocol/typescript-sdk
> Ref: `research/refs/mcp-typescript-sdk` @ 39ae8e6 (2026-10-27) · License: Apache-2.0 for new code, MIT for older contributions whose authors have not agreed to relicense, CC-BY-4.0 for docs other than specs. All of this is in the single root `LICENSE`, which holds four sections: the transition preamble, the Apache-2.0 text, "MIT License, Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC", and a short CC-BY-4.0 notice for documentation. There are no per-directory LICENSE files and no NOTICE file. Every published `package.json` (`packages/*`, `packages/middleware/*`) says `"license": "Apache-2.0"`; the private `examples/` and `test/*` manifests say `"MIT"`.

## Purpose
This is the official TypeScript SDK for MCP, v2 line, and the package search-hole's gateway is built on. It implements **both protocol eras** behind one API. Every revision from `2024-10-07` to `2025-11-25` is "legacy": the `initialize` handshake plus session state. `2026-07-28` is "modern": stateless, with a per-request `_meta` envelope, `server/discover`, `resultType`, MRTR and cache hints. The SDK serves both eras from **one server factory**. For search-hole it settles four ADRs: dual-protocol (can one gateway binary serve every host?), mcp-tool-surface (what `registerTool` can express and how results are validated), session-definition (what identity and state the SDK gives a handler), and runtime-packaging (Node floor, deps, ESM/CJS, bundling).

## Architecture sketch
```
packages/
  core-internal/  (private, bundled into server+client at build) wire codecs per era, protocol engine, envelope lift,
                  ReadBuffer (stdio framing), inbound classification, inputRequired builders
  core/           @modelcontextprotocol/core 2.4.0 — raw Zod wire schemas + public constants (only for proxies/log pipelines)
  server/         @modelcontextprotocol/server 2.4.0 — McpServer, Server, createMcpHandler, serveStdio (./stdio), codecs
  client/         @modelcontextprotocol/client 2.4.0 — Client, versionNegotiation, StdioClientTransport (./stdio), InMemoryTransport
  server-legacy/  2.4.0, deprecated — frozen v1 SSE transport + OAuth AS helpers
  codemod/        2.4.0 — `npx @modelcontextprotocol/codemod v1-to-v2 .`
  middleware/{node 2.1.2, express 2.0.2, hono 2.0.2, fastify 2.0.1} — thin adapters over createMcpHandler
```
Versions are from each `packages/*/package.json` and `packages/middleware/*/package.json`. `core`, `client`, `server`, `server-legacy` and `codemod` form a **fixed version group**; the adapters are versioned separately (`VERSIONING.md`). Per `VERSIONING.md`, dropping a protocol revision the SDK negotiated is a **major** bump.

Two serving entries own the era decision. The consumer only writes a factory:
```
host ──stdio──► serveStdio(factory)  ─ classify opening msg once ─► factory({era}) ─► ONE McpServer pinned for the connection
host ──HTTP───► createMcpHandler(factory).fetch(Request) ─ classify every POST ─► factory({era, authInfo, requestInfo}) ─► fresh McpServer per request
```

## Key modules and data flow
**Serving entries**
- `packages/server/src/server/serveStdio.ts: serveStdio(factory, options)` (line 375). It takes `ServeStdioOptions` (line 85): `legacy?: 'serve' | 'reject'` (default `'serve'`), `transport?: Transport` (default `new StdioServerTransport()`), `onerror`, and `maxSubscriptions` (default 1024). It returns `StdioServerHandle { close() }`. Opening rules are in `classifyOpeningMessage`:
  - an `initialize`, or any message with no envelope claim → **legacy**: the connection is pinned to `factory({era:'legacy'})` and served exactly as a v1 hand-wired stdio server would serve it
  - a request with a valid modern `_meta` envelope → **modern**: the connection is pinned to `factory({era:'modern'})`
  - a `server/discover` probe is answered by an optimistically built modern instance **without pinning**. If the client then sends `initialize`, the probe instance is discarded and the factory runs a second time.
  - Once modern is pinned, a later `initialize` is rejected with `-32022`
  - No per-message re-classification happens after pinning (module doc comment, lines 1–45)
- `packages/server/src/server/createMcpHandler.ts: createMcpHandler(factory, options)` (line 682). It returns `McpHttpHandler { fetch(Request, {authInfo?, parsedBody?}), close, notify, bus }`. `CreateMcpHandlerOptions` covers:
  - `legacy?: 'stateless' | 'reject'` (default `'stateless'`)
  - `responseMode: 'auto' | 'sse' | 'json'` (`json` drops mid-call notifications)
  - `bus` (`ServerEventBus` for `subscriptions/listen`)
  - `maxSubscriptions`, plus `keepAliveMs` (default 15000)
  - `maxRequestBodySize` (default 4 MiB, otherwise `413`)

  Each request is classified once, body-first (`classifyInboundRequest`). `isLegacyRequest(request)` and `legacyStatelessFallback(factory)` are exported so you can route an existing sessionful 2025 deployment in front of a `legacy:'reject'` handler.
- **What the factory receives** (`createMcpHandler.ts: McpRequestContext`, line 93): `{ era: 'legacy'|'modern'; authInfo?: AuthInfo; requestInfo?: Request }`. `authInfo` and `requestInfo` are HTTP only; *"`serveStdio` never sets it"*. **The factory gets no clientInfo, protocolVersion or capabilities.** Those arrive per request in the handler context (below). `McpServerFactory` may return `McpServer | Server | Promise<…>`. Factories must be cheap and free of side effects: the stdio probe-fallback path calls it twice, and HTTP calls it on every request. `assertNotServing` throws if the factory returns an instance that is already connected.

**Handler context** (`packages/core-internal/src/shared/protocol.ts: BaseContext`, line 334; `ServerContext`). The `ctx.mcpReq` fields are:
- `id`, `method`
- `_meta`, with reserved keys lifted out
- `envelope?: Partial<RequestMetaEnvelope>`, present only on modern requests
- `inputResponses?`, `droppedInputResponseKeys?`, `requestState<T>()`
- `signal: AbortSignal`, which aborts on `notifications/cancelled` **and** on connection close
- `send`, `notify`
- `log`, deprecated by SEP-2577

`ctx.http?.authInfo` and `ctx.sessionId?` are also available. `RequestMetaEnvelope` (`packages/core-internal/src/types/types.ts`, line 248) has these keys:
- `io.modelcontextprotocol/protocolVersion` (required)
- `io.modelcontextprotocol/clientCapabilities` (required)
- `io.modelcontextprotocol/clientInfo?`, which became **optional** with spec PR #3002 ("servers must not require it … and should not rely on it for behavior or security")
- `io.modelcontextprotocol/logLevel?`

The constants are in `packages/core/src/constants.ts` (also `SERVER_INFO_META_KEY`, `SUBSCRIPTION_ID_META_KEY`, and the unprefixed `traceparent`/`tracestate`/`baggage`).
- On a **legacy** connection the identity is session-scoped. `server.server.getClientVersion()` and `getClientCapabilities()` (`server.ts`, around lines 989–1003) are both marked `@deprecated` but still work. On a **modern stdio** connection they return `undefined` (`docs/migration/support-2026-07-28.md` §"Server over stdio"). Only `createMcpHandler` backfills them per request (`seedClientIdentityFromEnvelope`, `createMcpHandler.ts`, line 874). **Consequence:** search-hole needs a two-line helper, "era → envelope or initialize-scoped identity". The SDK's own private `_inputRequestCapabilityView` (`server.ts`, line 756) does exactly that.

**McpServer.registerTool** (`packages/server/src/server/mcp.ts`, lines 1058–1120). The signature is `registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, icons?, scopeChallenge?, _meta? }, cb)`. Schemas are any `StandardSchemaWithJSON` (zod v4, ArkType, or Valibot via `toStandardJsonSchema`; `docs/advanced/schema-libraries.md`). Raw shapes `{a: z.string()}` still work but are `@deprecated`. A duplicate name throws. In the `tools/call` handler (around lines 300–320):
- input validation runs first; a failure becomes an `isError:true` result: `"Input validation error: Invalid arguments for tool …"`
- then the handler runs
- then `validateToolOutput` (line 384), which checks two things. If the tool has an `outputSchema` and is neither `isError` nor input-required, `structuredContent === undefined` is an error. Otherwise the value is validated against the schema. Both failures are thrown inside the `try` and turned into an `isError` result by `createToolError` (only `UrlElicitationRequired` propagates as a protocol error)
- then `projectCallToolResult` (the era codec)

`tools/list` lists in **registration order** (comment at line 260: deterministic, per the spec SHOULD) and passes `_meta`, `annotations`, `icons` and `execution` through verbatim. `McpServerOptions.maxToolInputElements` caps the total array and object members in `arguments`. It is off by default; when exceeded, the result is `isError` before the schema runs.

**Era-specific encoding of structured output** (`packages/core-internal/src/wire/rev2025-11-25/legacyWrap.ts: wrapOutputSchemaForLegacy`, `wire/textFallback.ts: appendTextFallbackForNonObject`). In 2026 any JSON Schema root and any JSON `structuredContent` are allowed (SEP-2106). For 2025 clients, a **non-object** `outputSchema` root is rewritten to `{type:'object',properties:{result:…},required:['result']}` and `structuredContent` is wrapped as `{result: value}`. On both eras, a non-object `structuredContent` with no text block gets `JSON.stringify(value)` appended as text.

**Server options** (`packages/server/src/server/server.ts: ServerOptions`, line 77):
- `capabilities`
- `instructions` (returned in **both** `InitializeResult` (line 951) and `DiscoverResult` (line 967))
- `jsonSchemaValidator`
- `cacheHints: Partial<Record<'tools/list'|'prompts/list'|'resources/list'|'resources/templates/list'|'resources/read'|'server/discover', {ttlMs, cacheScope}>>`. Defaults are `ttlMs:0, cacheScope:'private'`. Modern responses only; invalid values throw `RangeError` at construction
- `inputRequired: { maxRounds=8, roundTimeoutMs=600_000, legacyShim=true }`
- `requestState: { verify(state, ctx) }`

**`server/discover`** is never hand-written. `installModernOnlyHandlers` installs it on modern instances only (`server.ts`, lines 234–284). `_ondiscover()` (line 961) returns `{ supportedVersions: modern subset, capabilities, instructions? }`. The serverInfo goes into result `_meta['io.modelcontextprotocol/serverInfo']` on **every** modern response, not in the body. Hand-constructed instances keep answering `-32601`.

**`resultType`** is wire-only. `types.ts: WireOnlyResultKey = 'resultType'` and `StripWireOnly<T>` remove it from every public result type. The encoder stamps `"complete"` or `"input_required"`, and the client consumes it. A handler **never** writes `resultType` (`support-2026-07-28.md` §"Wire-only members").

**MRTR, server side** (`docs/servers/input-required.md`; `server.ts`, lines 670–726). Only `tools/call`, `prompts/get` and `resources/read` may return input-required (`INPUT_REQUIRED_CAPABLE_METHODS`, line 76). The API is:
- `inputRequired({ inputRequests?, requestState? })`, which throws `TypeError` if both are missing
- builders `inputRequired.elicit({message, requestedSchema})`, `.elicitUrl`, `.createMessage`, `.listRoots()`
- readers `acceptedContent(ctx.mcpReq.inputResponses, key, zodSchema)`, which returns typed content or `undefined` for missing, declined or cancelled
- `inputResponse(responses, key)`, a discriminated `missing|elicit|sampling|roots` view
- `createRequestStateCodec({ key ≥32 bytes, ttlSeconds?, bind?(ctx) })`, an HMAC-SHA256 `{mint, verify}` pair. It is signed, not encrypted (`requestStateCodec.ts`, line 145)

Every embedded request is checked against the **request's own declared capabilities**. A missing one throws `MissingRequiredClientCapabilityError` **-32021** (HTTP 400) instead of degrading. The form schema must be **flat primitives**: strings with email/uri/date/date-time formats, numbers with inclusive bounds, booleans, enums, multi-select enum arrays, optional and default. Nested objects and `.regex()` throw `TypeError` at build time. `inputResponses` hold **only the latest round**. Multi-step flows thread their state through `requestState`.

**Legacy shim** (`server/legacyInputRequiredShim.ts`). On a 2025 **stdio** or sessionful-HTTP connection, the same `inputRequired` return is fulfilled server-side: the shim sends real `elicitation/create`, `sampling/createMessage` or `roots/list` requests, then re-enters the handler with the responses. Capability pre-checks use the `initialize` capabilities, so a client without them gets a clean refusal and never hangs. Rounds with only `requestState` are paced at 250 ms. On **stateless legacy HTTP** (`createMcpHandler` default) the shim cannot push anything, so it degrades to the capability refusal (`support-2026-07-28.md` §"Legacy shim … Inherited limits").

**Notifications and cancellation.** Modern clients receive `list_changed` only on a `subscriptions/listen` stream. `serveStdio` routes the instance's `send*ListChanged()` onto open subscriptions (`StdioListenRouter`). Legacy clients get unsolicited notifications as before. On a modern request, `ctx.mcpReq.log()` emits nothing unless the request carries `logLevel`, and the SDK client does not attach it by default.

## Data model and storage
n/a. The SDK keeps no persistent state. Per-connection state is: the negotiated version on the `Server` instance (`_negotiatedProtocolVersion`), the client identity scoped to `initialize` (legacy only), the listen-router subscriptions, and the client response cache (`InMemoryResponseCacheStore`, bounded at 512 entries; pluggable via the five-method `ResponseCacheStore`, `examples/caching/README.md`). `examples/shared/src/inMemoryEventStore.ts` is the only event-store reference, and it applies to legacy SSE resumability, which 2026 removed.

## Config format
n/a. Everything is configured in code (`ServerOptions`, `ServeStdioOptions`, `CreateMcpHandlerOptions`, `ClientOptions.versionNegotiation`). Client era selection (`docs/protocol-versions.md`):
- `mode` absent or `'legacy'` (the **default**, byte-for-byte 2025 `initialize`)
- `'auto'` (probe with `server/discover`, fall back)
- `{ pin: '2026-07-28' }` (never fall back; otherwise `SdkError ERA_NEGOTIATION_FAILED`)

## Extension points (plugins, hooks)
- **Factory**: the only composition point. It may vary by `era` and by `authInfo`.
- `Server.setRequestHandler(method, …)` for custom methods (`docs/advanced/custom-methods.md`). `PerRequestHTTPServerTransport` for hand-built hosting (`docs/advanced/low-level-server.md`).
- `ServerEventBus` (publish/subscribe) for listen fan-out across processes (`server/serverEventBus.ts`).
- Middleware: `requireBearerAuth`, `hostHeaderValidationResponse`, `originValidationResponse`, `oauthMetadata` (`server/middleware/*`). `@modelcontextprotocol/node`: `toNodeHandler`, `localhostHostValidation`, `localhostOriginValidation`, `toWebRequest`. `createMcpHonoApp`/`createMcpExpressApp`/`createMcpFastifyApp` turn on Host and Origin validation by default on localhost binds (`docs/serving/http.md`).
- **Skills extension** (new in 2.4.0, `CHANGELOG.md`): `@modelcontextprotocol/server/ext/skills` → `SkillsExtension.attach(server)` serves `skills/list`, `skills/get`, `resources/directory/read` and `skill://{+path}`. `attach` is `@experimental`; `ext/skills/node` provides `loadSkills(folder)`.
- Validators: `@modelcontextprotocol/server/validators/ajv` or `/cf-worker`, plus `fromJsonSchema(schema)` to use raw JSON Schema as a Standard Schema.

## Rules / lists: parsing and compilation
n/a. This is a protocol SDK with no rule or list concepts. The one related idea is that `requestState` needs **integrity protection whenever it influences business logic**, and search-hole's rule-approval flows will be exactly that (see Implications).

## Testing strategy
- **In-process modern-era test** (`docs/testing.md`): `new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (u, i) => handler.fetch(new Request(u, i)) })` with `new Client(…, { versionNegotiation: { mode: 'auto' } })`. No socket is opened, and the URL is never dialled. Tear down with `client.close()`, then `handler.close()`, which aborts hung calls.
- `InMemoryTransport.createLinkedPair()` connects **2025-era instances only**.
- **stdio** has "no in-process shortcut": you spawn the process with `StdioClientTransport` (`@modelcontextprotocol/client/stdio`). `test/e2e/scenarios/stdio-dual-era.test.ts` spawns `fixtures/dual-era-stdio-server.ts` twice, once with a plain 2025 client and once with an `'auto'` client. It asserts that `getNegotiatedProtocolVersion()` matches and that the session pipe never carried `initialize` or `server/discover` on the modern leg. Since `ServeStdioOptions.transport` accepts any `Transport`, a `StdioServerTransport(passThroughIn, passThroughOut)` (constructor at `server/stdio.ts`, line 40) should allow in-process stdio-entry tests (inferred).
- The e2e suite is driven by a **requirements manifest** (`test/e2e/requirements.ts`: `REQUIREMENTS` keyed by id, with `source` spec URL, `behavior`, `transports`, known failures). Tests register with `verifies('<req-id>', fn)` over a spec-version × transport matrix.
- Conformance: `@modelcontextprotocol/conformance` is pinned **exactly** at `0.2.0-alpha.12`. Each era has its own expected-failures file (`test/conformance/expected-failures*.yaml`). The server leg starts an HTTP server and points the referee at `http://localhost:$PORT/mcp` (`test/conformance/scripts/run-server-conformance.sh`).

## UX patterns worth copying
- **Every error message has a docs entry.** `docs/troubleshooting.md` headings are verbatim error strings (`SdkError: ERA_NEGOTIATION_FAILED`, `TS2589 …`). That matches our "ranked causes as data" approach for `searchhole doctor`.
- **The era matrix lives on one page only** (`docs/protocol-versions.md` §"Compare the eras"). Every other page links to it in one line. Good discipline for our dual-protocol ADR and client docs.
- **Typed, local errors that name the fix.** For example, `UnsupportedProtocolVersionError` carries `data: { supported, requested }`, and the push-API guard message tells you to "Return inputRequired({ ... })".

## Performance tricks
- Wire schemas are **built lazily per era** (`core-internal/src/wire/preload.ts`). `preloadSchemas()` exists for edge runtimes, and the doc says that on Node CLIs "prefer the lazy default — there, module-scope construction is pure added boot latency". That helps our startup target of under 300 ms.
- `toolInputSchemaJson` / `outputSchemaJson` memoise the JSON-Schema conversion per tool (`mcp.ts`, lines 125–145, 945–955).
- Root entries are runtime-neutral, and Node-only code sits behind `./stdio` (`docs/get-started/packages.md`). `tsdown` builds with `noExternal: ['@modelcontextprotocol/core-internal','ajv','ajv-formats','@cfworker/json-schema']` (`packages/server/tsdown.config.ts`), so the **server's only runtime dependencies are `@modelcontextprotocol/core` and `zod` (^4.2.0)** (`packages/server/package.json`, `pnpm-workspace.yaml` catalog `runtimeShared.zod: ^4.2.0`).
- The stdio `ReadBuffer` caps a single message at 10 MiB (`core-internal/src/shared/stdio.ts: STDIO_DEFAULT_MAX_BUFFER_SIZE`). It splits on `\n`, strips `\r`, and **skips non-JSON lines** instead of dying.

## License and what it means for us
The license is permissive: Apache-2.0, plus MIT for older parts. We may depend on it, bundle it into `gateway.js` or a compiled binary, and quote short snippets with attribution. Obligations when bundling: ship the Apache-2.0 text and the MIT notice ("Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC") in `THIRD_PARTY_LICENSES`. There is no NOTICE file to carry. Docs are CC-BY-4.0, so any doc prose we adapt must be attributed.

## Implications for search-hole
- [dual-protocol] **One gateway binary can serve both eras over stdio with no extra code.** `serveStdio(buildServer)` defaults to `legacy:'serve'`: a 2025 client that opens with `initialize` (protocolVersion `2025-06-18`/`2025-11-25`, for example) gets a legacy instance; an enveloped 2026-07-28 request gets a modern one. The decision is **per connection** (`serveStdio.ts: classifyOpeningMessage`). Never use `server.connect(new StdioServerTransport())`: that path speaks 2025 only (`support-2026-07-28.md` §"Server over stdio"). So the P2 "dual-protocol spike" turns into "log which era each host opens with", not "build a legacy path".
- [dual-protocol] **What legacy stdio loses for our surface: nothing material.** Tools, `outputSchema`/`structuredContent`, annotations, `_meta` (MCP Apps `ui.resourceUri`) and `instructions` all reach 2025 clients. `inputRequired` asks are fulfilled by the shim as real `elicitation/create` pushes. Change notifications arrive unsolicited instead of via `subscriptions/listen`, and our tool list is static anyway. The only differences are encoding ones: a non-object `outputSchema` gets wrapped as `{result}` (see next bullet), and capability/identity come from `initialize` rather than per request.
- [mcp-tool-surface] **Give every `outputSchema` an object root**: `search → {results:[…], hidden:{…}, receiptId}` and not a bare array. Then the 2025 wrap (`legacyWrap.ts: wrapOutputSchemaForLegacy`) is a no-op and both eras see identical `structuredContent`. The wrap keys on the advertised schema having `type !== 'object'` at the root (`isNonObjectJsonSchemaRoot`), so the root must be a literal `type:'object'` (which `z.object` emits), not an `anyOf` of objects. With an object root, `appendTextFallbackForNonObject` never fires either (it only fires for non-object values), so the SDK adds no JSON dump; the text block is ours to author.
- [mcp-tool-surface] Use `registerTool(name, {title, description, inputSchema: z.object(…), outputSchema: z.object(…), annotations, _meta}, cb)` exactly. The SDK fails a call whose `structuredContent` is missing or invalid as an `isError` result, so our **e2e tests must assert `isError !== true`** and not just `content` (`mcp.ts: validateToolOutput`). Tools are listed in registration order: register in a fixed order (`search`, `fetch`, `receipt`, `suggest_rule`, `apply_rule`) so list output stays stable for prompt caching.
- [mcp-tool-surface] Set `cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' }, 'server/discover': { ttlMs: 3_600_000, cacheScope: 'public' } }`. Our list is static per binary version. Leaving the defaults (`0`/`private`, `server.ts: ServerOptions.cacheHints`) marks the result immediately stale, so a host MAY re-fetch every time it needs the list (spec `server/utilities/caching.mdx`); how often real hosts actually re-fetch is unverified. Keep `instructions` **static** (no dashboard URL or port in it), because it is cached inside `DiscoverResult`.
- [session-definition] **On stdio, one `McpServer` instance lives for the whole connection**, so closure or module state does persist across calls in one process (`serveStdio.ts` module doc). **On HTTP every request gets a fresh instance**: state must live at module scope or in SQLite, never on the instance (`docs/serving/http.md` §"Understand the per-request factory"). The factory gets only `{era}` on stdio. Per-request client identity comes from `ctx.mcpReq.envelope['io.modelcontextprotocol/clientInfo']` (optional) on modern requests, or `server.server.getClientVersion()` on legacy ones. **Do not key sessions on clientInfo**: it is self-reported and optional (`core/src/constants.ts: CLIENT_INFO_META_KEY` doc). Record it in the `sessions` table only as a display label.
- [session-definition] **The SDK client's `'auto'` mode on stdio spawns a throw-away sibling process to probe `server/discover`** (`docs/protocol-versions.md` §"Understand the probe"). A host built on this SDK may therefore start our gateway twice per connection, and the factory may run twice. Gateway startup must have **no side effects**: open SQLite lazily, create no `sessions` row, take no list-refresh lease, start no dashboard and send no heartbeat until the first real `tools/call` (or `tools/list`). Otherwise the dashboard will show phantom sessions.
- [runtime-packaging] Constraints the SDK imposes: `engines.node >= 20` on every package; dual ESM/CJS exports (`.mjs`/`.cjs` via `fixedExtension: true`); runtime deps `@modelcontextprotocol/core` + `zod ^4.2.0` only, with ajv already bundled. Our Node 22+ floor and a `tsdown` single-file bundle (or `bun build --compile`) are both compatible (inferred for bun). **Exactly one zod copy** is required, or TypeScript fails with TS2589 (`docs/troubleshooting.md`); pin `zod` with pnpm `overrides`. Import `serveStdio` from `@modelcontextprotocol/server/stdio`, not the root.
- [runtime-packaging] Never write to stdout. The SDK's own docs list a stray `console.log` as the top stdio failure (`docs/serving/stdio.md`, `docs/troubleshooting.md`). pino must target fd 2. Handle stdin EOF: release timers and file watchers in `server.server.onclose` so the process exits (`docs/serving/stdio.md` §"Shut down cleanly"). Otherwise orphaned gateways keep holding the SQLite WAL.
- [ui-ux] **"Ask first" (plan §5 step 2) maps directly onto `inputRequired`.** Inside `search`: if `depth==='deep' && profile.askFirst`, return `inputRequired({ inputRequests: { plan: inputRequired.elicit({ message, requestedSchema: z.object({ approve: z.boolean(), engines: z.array(z.enum([...])).optional() }) }) }, requestState: await codec.mint({ q, planHash }) })`. On re-entry, `acceptedContent(…, 'plan', schema)` returns the answer. **Gate it first on the declared capability**: modern → `ctx.mcpReq.envelope[CLIENT_CAPABILITIES_META_KEY]?.elicitation`, legacy → `getClientCapabilities()?.elicitation`. If it is absent, fall back to returning the plan as text. Returning it anyway raises `-32021` on a modern request (`server.ts`, lines 708–722); on a legacy connection the shim's own pre-check turns it into an `isError` tool result ("Cannot request input …"), not `-32021` (`legacyInputRequiredShim.ts`). The legacy shim makes the same handler work on 2025 stdio clients that do declare elicitation.
- [security] Mint `requestState` with `createRequestStateCodec({ key, ttlSeconds: 600, bind: ctx => ctx.mcpReq.method + '\0' + toolName })`, pass `verify` as `ServerOptions.requestState.verify`, and keep the key at module scope (random per process is fine on stdio, where one process serves every round). It is **signed, not encrypted**: never put the query text or secrets in it, only a hash and a step (`docs/servers/input-required.md` §"Protect requestState").
- [security] **Do not let the MRTR elicitation approve rule changes.** An `apply_rule` confirmation via elicitation might look user-driven, but whether the host really shows the form to a human is the client's promise, not something we can verify. Keep rules flowing through the inbox, dashboard or panel per §12.4 (inferred from the threat model; the SDK provides no proof of user presence).
- [mcp-tool-surface] Cancellation: pass `ctx.mcpReq.signal` into every engine and fetch call (undici `signal`). It aborts on `notifications/cancelled` (stdio) and when the per-request SSE stream closes (HTTP) (`docs/servers/logging-progress-cancellation.md`). Progress for `deep` searches works via `ctx.mcpReq._meta?.progressToken` + `ctx.mcpReq.notify({method:'notifications/progress',…})`. Don't use `ctx.mcpReq.log`: it is deprecated and silent on modern requests without `logLevel`.
- [dual-protocol] For the HTTP connector (v2): `createMcpHandler(buildServer)` serves modern requests per request **and** 2025 clients statelessly by default. On legacy HTTP we lose GET (standalone SSE) and DELETE (`405`), server pushes (the shim refuses cleanly) and unsolicited notifications, none of which our tools need. Mount it behind `createMcpHonoApp()` (`@modelcontextprotocol/hono` 2.0.2) for the Host/Origin checks. The handler itself validates neither header (`docs/serving/http.md` §"Validate Host and Origin"). Note that `createMcpHonoApp` arms those checks by default **only on localhost binds** (`127.0.0.1`/`localhost`/`::1`); a public connector must pass `allowedHosts` and `allowedOrigins` explicitly, or it gets no Host/Origin validation (only a console warning on `0.0.0.0`/`::`) (`packages/middleware/hono/src/hono.ts`).
- [testing] Our MCP e2e plan:
  - (a) modern-era tests in-process via `createMcpHandler(buildServer).fetch`, with a `Client({versionNegotiation:{mode:{pin:'2026-07-28'}}})`
  - (b) a legacy leg with a default `Client` (2025 `initialize`) over the same handler
  - (c) one spawned-binary stdio test per era with `StdioClientTransport`, like `test/e2e/scenarios/stdio-dual-era.test.ts`
  - (d) assert `structuredContent` against our zod `outputSchema` and assert that `initialize`/`server/discover` never appear on the modern pipe

  Also copy the `verifies('<req-id>')` requirements-manifest idea to trace §5.1's error UX matrix to tests.
- [testing] Optionally run `@modelcontextprotocol/conformance` (pinned exactly, as the SDK does) against the v2 HTTP endpoint in CI, with an expected-failures file per era (`test/conformance/scripts/run-server-conformance.sh`).
- [upgrades-migrations] Pin `@modelcontextprotocol/server` exactly and move it on purpose, as the SDK does with conformance. Wire behaviour does change in minor releases: 2.1.0 added a 4 MiB request-body cap (`413`) and started rejecting a modern POST without `MCP-Protocol-Version` with `400`/`-32020` (`packages/server/CHANGELOG.md` §2.1.0). (The `-32021` 200→400 change was a v2 pre-release change, 2.0.0-beta.1, not a minor release.) The SDK treats dropping a protocol revision as major (`VERSIONING.md`), and v1.x gets fixes until at least about 2027-01-27 (`ROADMAP.md`, line 35). So the 2025 era will stay in v2.x and our dual-era support will not be pulled out from under us in a minor release.
- [distribution] `@modelcontextprotocol/server/ext/skills` could serve our research skill over MCP to hosts that lack Claude Code's skill system. `attach` is `@experimental` and client support is thin, so this is a v1.x nice-to-have only (`packages/server/CHANGELOG.md` 2.4.0; see the spec note's client matrix).
- [other] Plan §3 corrections from this ref:
  - `clientInfo` is optional (SHOULD), not carried "on every request"
  - cache fields are required on `server/discover`, `resources/read` and `resources/templates/list` too, and the SDK emits defaults automatically
  - elicitation is **not** deprecated: only the server→client *request channel* moved to MRTR, while sampling, roots and logging are deprecated (SEP-2577)
  - "Claude Code negotiates 2026-07-28 by default" cannot be verified from this ref, so check it in the P2 spike by logging `era` per connection

## Borrow / avoid
**Borrow**
- `serveStdio(factory)` with the default `legacy:'serve'` as the only stdio entry. Write one factory for both eras, and branch on `ctx.era` only for diagnostics (`examples/dual-era/server.ts`).
- A cheap, side-effect-free factory with expensive resources (SQLite handle, compiled matchers, engine clients) at module scope, closed over (`docs/serving/http.md`).
- `cacheHints` for `tools/list` and `server/discover`; static `instructions`.
- `inputRequired` + `acceptedContent(…, schema)` + `createRequestStateCodec` for ask-first, gated on the declared elicitation capability.
- The in-process `handler.fetch` test harness; the `verifies()` requirements manifest; exactly pinned conformance with per-era expected failures.
- Troubleshooting docs keyed by verbatim error text.

**Avoid**
- `server.connect(new StdioServerTransport())`, which is 2025 only; `InMemoryTransport` for anything 2026.
- Non-object `outputSchema` roots, and relying on the SDK's text auto-append (token cost).
- Side effects at process start or in the factory (probe sibling processes, double factory calls).
- Keying anything on `clientInfo`, `ctx.sessionId` or the instance itself; using `ctx.mcpReq.log`, sampling or roots.
- `responseMode:'json'` if we ever stream progress; `server-legacy/sse` (frozen, deprecated).
- Returning `inputRequired` without checking the request's declared capabilities (`-32021`, HTTP 400).

## Verification
- Date: 2026-10-29. Checked against `research/refs/mcp-typescript-sdk` @ 39ae8e6.
- Claims checked: 46 (license header and section; every "Implications for search-hole" bullet; the mechanisms they rely on: `serveStdio`/`createMcpHandler` options and defaults, `McpRequestContext`, `BaseContext`, `RequestMetaEnvelope`, `registerTool` and `validateToolOutput`, legacy wrap and text fallback, `cacheHints`, `server/discover`, MRTR builders, `createRequestStateCodec`, the legacy shim, the probe sibling process, package versions, `engines`, runtime deps, `tsdown` config, conformance pin, test paths, `VERSIONING.md`, `ROADMAP.md`).
- Corrections:
  1. License header: the root `LICENSE` has four sections, not three (it also has a CC-BY-4.0 notice). Also noted that the private `examples/` and `test/*` manifests declare MIT.
  2. [upgrades-migrations]: the `-32021` in-band-200→HTTP-400 change was a v2 pre-release change (2.0.0-beta.1), not a minor release. Replaced the example with a real minor-release wire change (2.1.0: 4 MiB body cap, and `400`/`-32020` for a missing `MCP-Protocol-Version`).
  3. [ui-ux] ask-first: `-32021` applies only to modern requests. On a legacy connection, the shim turns a missing capability into an `isError` tool result.
  4. [dual-protocol] HTTP connector: `createMcpHonoApp` arms Host/Origin validation by default only on localhost binds. A public connector must pass `allowedHosts`/`allowedOrigins`.
  5. [mcp-tool-surface] object root: the claim about `appendTextFallbackForNonObject` was tightened. With an object root it never fires, so the SDK adds no JSON dump anyway. Also noted that the wrap condition is a literal `type:'object'` root.
  6. [mcp-tool-surface] cacheHints: "hosts re-fetch on every turn" softened to the spec's "MAY re-fetch every time"; real host behaviour is unverified.
  7. Minor citation fixes: `BaseContext` is at line 334, not 333; the conformance script path is `test/conformance/scripts/run-server-conformance.sh`.
