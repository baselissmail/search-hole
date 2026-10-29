# modelcontextprotocol/modelcontextprotocol
> Ref: `research/refs/mcp-spec` @ 9850cae (2026-10-28) · License: Apache-2.0 for the spec, schema and code, MIT for older contributions not yet relicensed, CC-BY-4.0 for documentation other than the specification. All of this is in the single root `LICENSE` (preamble, then the Apache-2.0 text, then an "MIT License" section, then the CC-BY-4.0 notice). `package.json` says `"license": "SEE LICENSE IN LICENSE"`. There are no per-directory LICENSE files.

## Purpose
This is the MCP specification repo. It holds the normative pages per revision (`docs/specification/<rev>/`), the TypeScript schema that is the source of truth (`schema/<rev>/schema.ts` → generated `schema.json` + `schema.mdx`), the SEPs (`seps/*.md`), the extension docs (`docs/extensions/`) and the blog (`blog/`, Hugo). The revision we target is **`2026-07-28`**: stateless, no `initialize`, a per-request `_meta` envelope, `server/discover`, `resultType`, MRTR, cache hints and HTTP header mirroring. The previous revision is `2025-11-25`. For search-hole this ref is the authority on what the gateway MUST do, and it answers the session question directly: **the protocol forbids treating a connection or process as a conversation**.

## Architecture sketch
```
schema/2026-07-28/schema.ts (3197 lines, source of truth)
   ├─ scripts/generate-schemas.ts ─► schema.json (3963 lines)          check: generate --check
   ├─ typedoc ─► docs/specification/2026-07-28/schema.mdx              check: cmp
   └─ schema/2026-07-28/examples/<Type>/*.json (88 dirs) ─► scripts/validate-examples.ts
docs/specification/2026-07-28/          (Mintlify site, docs/docs.json)
   basic/{index, versioning, transports/{stdio,streamable-http}, patterns/{mrtr,subscriptions,cancellation,progress},
          authorization/{index,client-registration,authorization-server-discovery,security-considerations}}
   server/{discover, tools, resources, prompts, utilities/{caching,pagination,logging,completion}}
   client/{elicitation, sampling, roots}   changelog.mdx   deprecated.mdx
seps/<num>-<slug>.md (46 SEPs)  ─► scripts/render-seps.ts ─► docs/seps/*.mdx
docs/extensions/{apps,tasks,skills,auth}/ + client-matrix.mdx
```
The protocol at `2026-07-28`, per request:
```
client ──request{ method, params{ …, _meta{ io.modelcontextprotocol/protocolVersion*, clientCapabilities*, clientInfo?, logLevel? }}}──► server
server ──result{ resultType:"complete"|"input_required", …, _meta{ io.modelcontextprotocol/serverInfo? }, [ttlMs, cacheScope] }──► client
          (* required; HTTP also mirrors MCP-Protocol-Version, Mcp-Method, Mcp-Name headers)
```

## Key modules and data flow
**Changelog** (`docs/specification/2026-07-28/changelog.mdx`), the major changes:
- (1) Sessions and the `Mcp-Session-Id` header are removed. Lists no longer vary per connection, and cross-call state uses **"explicit, server-minted handles passed as ordinary tool arguments"** (SEP-2567).
- (2) The `initialize`/`initialized` handshake is removed. Every request carries `protocolVersion` + `clientCapabilities` in `_meta`. Clients SHOULD send `clientInfo`; servers SHOULD send `serverInfo` in result `_meta`. A version mismatch returns `UnsupportedProtocolVersionError` (SEP-2575).
- (3) `server/discover`: servers **MUST** implement it.
- (4) `subscriptions/listen` replaces the HTTP GET stream and `resources/subscribe`.
- (5) `ping`, `logging/setLevel` and `notifications/roots/list_changed` are removed; the log level is now per request.
- (6) Tasks moved into the `io.modelcontextprotocol/tasks` extension.
- (7) MRTR replaces the server-initiated requests `roots/list`, `sampling/createMessage` and `elicitation/create`.
- (8) `resultType` is required on every result, and clients **MUST** treat an absent one as `"complete"`.
- (9) SSE resumability (`Last-Event-ID`) is removed.

The minor changes:
- `extensions` capability field
- OTel `traceparent`/`tracestate`/`baggage` in `_meta`
- deterministic `tools/list` order
- `Mcp-Method`/`Mcp-Name` headers + `x-mcp-header`
- `ttlMs`/`cacheScope` (SEP-2549)
- resource-not-found becomes `-32602`
- RFC 9207 `iss`
- DCR `application_type`
- issuer-bound credentials
- any JSON Schema 2020-12 in `inputSchema`/`outputSchema`, and `structuredContent` = **any JSON value** (SEP-2106)
- `elicitationId` / `notifications/elicitation/complete` removed
- error-code allocation policy

**Deprecated** (`deprecated.mdx`): Roots, Sampling and Logging (SEP-2577), DCR (PR #2858) — all with earliest removal at the "first revision released on or after **2027-07-28**". HTTP+SSE was already deprecated and is reclassified.

**Statelessness** (`basic/index.mdx` §"Statelessness", line 182). Servers **MUST NOT** rely on prior requests to establish context. They SHOULD be prepared to handle requests from many tasks, threads or conversations. *"State that needs to span multiple requests … **MUST** be referenced by an explicit identifier the client passes on each request."* The note reads: *"an open connection, such as a STDIO process, is not a conversation or session: clients may interleave unrelated requests on the same transport, and a server must not treat connection or process identity as a proxy for conversation or session continuity."* It also says: *"Clients **SHOULD NOT** use an individual task, thread, or conversation as the lifetime boundary for the stdio process."*

**`_meta`** (`basic/index.mdx` §"`_meta`", line 322). The reserved keys are:
- `progressToken`
- `io.modelcontextprotocol/{protocolVersion, clientInfo, clientCapabilities, logLevel, subscriptionId}`
- `traceparent`, `tracestate`, `baggage`

Required on every request: `protocolVersion` (string) and `clientCapabilities`. Optional: `clientInfo` and `logLevel`. If a required field is missing, the server returns `-32602`, plus HTTP 400. *"A server **MUST NOT** rely on capabilities the client has not declared"*; otherwise it returns `MissingRequiredClientCapabilityError -32021` with `data.requiredCapabilities`. `clientInfo`/`serverInfo` are *"self-reported … intended for display, logging, and debugging … **SHOULD NOT** rely on them for security decisions"*. Key format: an optional reverse-DNS `prefix/` plus a name. **Any prefix whose second label is `modelcontextprotocol` or `mcp` is reserved** (`dev.mcp/` and `com.mcp.tools/` are reserved; `com.example.mcp/` is not).

**Result and error rules** (`basic/index.mdx`, lines 51–155):
- Every result carries `resultType`. Unknown values are invalid; extensions may add more (e.g. Tasks `"task"`, `docs/extensions/tasks/overview.mdx`).
- Request ids must not repeat while a request is still in flight (SEP-2567 rescoping).
- Error codes: `-32000…-32019` is legacy, and new implementations SHOULD NOT use it. `-32020…-32099` is spec-reserved: `-32020 HeaderMismatch`, `-32021 MissingRequiredClientCapability`, `-32022 UnsupportedProtocolVersion`. Implementations **MUST NOT** emit undefined codes from that range. **Application errors SHOULD sit outside `-32768…-32000`.** `-32002` and `-32042` must not be emitted by 2026 implementations.

**Versioning and dual era** (`basic/versioning.mdx`). Terms: *Modern* (≥ 2026-07-28), *Legacy* (≤ 2025-11-25), *Dual-era*. There is no handshake. An unsupported version returns `-32022` with `data: {supported:[…], requested}`, and the client retries. Compatibility matrix:
- **Legacy client × Dual-era server = works.** *"The server answers `initialize` and serves the client according to the negotiated legacy revision."*
- Legacy × Modern-only = fails. Legacy clients have no fall-forward, so a modern-only server **SHOULD name its supported versions in any error to `initialize`**.
- Dual-era client × Legacy server = works, via probe/fallback.

*"A dual-era **server** selects its behavior from how the client opens"*: a request with modern `_meta` is stateless 2026; `initialize` selects legacy semantics *"scoped to the stdio process (stdio) or the session (HTTP)"*. *"A dual-era server **MAY** serve both eras concurrently on the same endpoint or process."* Clients SHOULD cache the era for the server process (stdio) or origin (HTTP).

**stdio** (`basic/transports/stdio.mdx`):
- Framing is **unchanged**: one JSON-RPC message per line, no embedded newlines, nothing but MCP messages on stdout, stderr for logs (clients SHOULD NOT treat stderr as errors).
- The server **MUST NOT write JSON-RPC requests to stdout**, because server→client calls now ride `InputRequiredResult`.
- All metadata is inline in `_meta`; there is no header layer.
- Cancellation: the client **MUST** send `notifications/cancelled`.
- Shutdown: the client closes stdin, waits, then SIGTERM→SIGKILL (TerminateProcess or Job Objects on Windows). Servers **SHOULD exit promptly on stdin EOF**.
- If the server dies unexpectedly, the client SHOULD restart it; *"Because the protocol is stateless, any in-flight requests are simply lost."*
- The same framing works over UDS or TCP.
- Backward compatibility: a dual-era client SHOULD probe with `server/discover` first. A `DiscoverResult` means modern. A recognised modern error means modern, and the client must not fall back. Any other error or a timeout means legacy, so it falls back to `initialize`. The fallback **MUST NOT** be keyed to one error code.

**Streamable HTTP** (`basic/transports/streamable-http.mdx`):
- Servers **MUST validate `Origin`**: `403` if present and invalid. They SHOULD bind 127.0.0.1 when local.
- Every message is a fresh POST. The `Accept` header lists both `application/json` and `text/event-stream`. A notification gets `202`. A request is answered with JSON or SSE.
- Cancellation means closing the SSE response stream; the core protocol defines no client→server notifications over HTTP.
- Required headers: `MCP-Protocol-Version` (must equal the `_meta` value), `Mcp-Method` (all requests) and `Mcp-Name` (`params.name`/`params.uri` for `tools/call`, `resources/read`, `prompts/get`), with Base64-sentinel encoding for non-ASCII values. A missing or mismatched header gets **400 + `-32020`**. An unknown method gets `404` + `-32601`. An unsupported version gets `400` + `-32022`.
- A server that only supports 2026 **SHOULD** answer GET/DELETE with `405`, ignore `Mcp-Session-Id` and ignore `Last-Event-ID` (§"Earlier Streamable HTTP Revisions", line 670).
- Optional `x-mcp-header` on `string`/`integer`/`boolean` tool parameters mirrors them as `Mcp-Param-{Name}`.

**`server/discover`** (`server/discover.mdx`): the request has only `_meta`. The result is `{resultType, supportedVersions, capabilities, instructions?, _meta.serverInfo?, ttlMs, cacheScope}` (`schema.ts: DiscoverResult extends CacheableResult`, line 678). Clients MAY call it, but are not required to. On stdio it is the backward-compatibility probe.

**Caching** (`server/utilities/caching.mdx`; `schema.ts: CacheableResult`, line 1081):
- Servers **MUST** include `ttlMs` (integer ≥ 0) and `cacheScope` (`"public"|"private"`) on complete results of `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` and `resources/read`.
- Interim `input_required` results carry no hints, and **retries carrying `inputResponses`/`requestState` MUST NOT be cached**.
- `ttlMs` works like `max-age`; absent or negative means 0. Clients SHOULD NOT poll on TTL. `list_changed` invalidates immediately.
- `public` may be shared across users and intermediaries; `private` only within one authorization context. All pages of a paginated list use the same scope.

**Tools** (`server/tools.mdx`):
- `tools/list` *"**MUST NOT** vary per-connection or as a side effect of other requests"*. It MAY vary by authorization. It SHOULD use a deterministic order.
- Names SHOULD be 1–128 characters from `[A-Za-z0-9_.-]`, case-sensitive.
- `inputSchema` is a JSON Schema object; for a tool with no parameters, `{type:'object', additionalProperties:false}` is recommended.
- `outputSchema` is optional. When present, servers **MUST** conform and clients SHOULD validate.
- `structuredContent` may be any JSON value (object, array, primitive, null). *"For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."*
- Content types: `text`, `image`, `audio`, `resource_link` (not guaranteed to be in `resources/list`) and embedded `resource`, each with optional `annotations{audience, priority, lastModified}`.
- Errors come in two kinds. Protocol errors (unknown tool, malformed request) are JSON-RPC errors. **Tool execution errors** (API failures, validation, business logic) are `isError:true` results, and clients SHOULD pass them to the model so it can correct itself.
- §"Stateful Tools" (line 683, non-normative) is the handle pattern: opaque handle, ≥ UUIDv4 entropy when unauthenticated, lifetime stated in the creation tool's description, and a clear error on expiry.
- Security: servers MUST validate inputs, rate-limit and sanitise outputs.

**Tool annotations** (`schema.ts: ToolAnnotations`, line 1912): `title`, `readOnlyHint` (default **false**), `destructiveHint` (default **true**, meaningful only if not read-only), `idempotentHint` (default false), `openWorldHint` (default **true**). The `Tool` warning: *"clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers."* The blog post `blog/content/posts/2026-03-16-tool-annotations.md` adds context: clients mainly use them to drive confirmation prompts, and "a tool with no annotations is assumed to be non-read-only, potentially destructive, non-idempotent, and open-world."

**MRTR** (`basic/patterns/mrtr.mdx`; `schema.ts: InputRequiredResult`, line 584; SEP-2322):
- Allowed only on `tools/call`, `prompts/get` and `resources/read`.
- `InputRequiredResult{ resultType:"input_required", inputRequests?: {key → ElicitRequest|CreateMessageRequest|ListRootsRequest}, requestState?: string }`, with at least one of the two.
- The client retries with a **new JSON-RPC id**, plus `inputResponses{key → result}` and a byte-exact `requestState`.
- Server MUSTs:
  - treat `requestState` as attacker-controlled, and protect its integrity (HMAC/AEAD) whenever it influences authorization, access or business logic
  - SHOULD bind the principal, a short TTL and the originating method/parameter digest
  - enforce single use server-side when it matters
  - **not include `inputRequests` the client did not declare capability for**
  - **not assume the client will fulfil or retry**
  - if responses are missing, re-ask with a new `InputRequiredResult` rather than erroring

**Elicitation** (`client/elicitation.mdx`) is **still Active**, not deprecated. Capability `elicitation: {form?:{}, url?:{}}`; an empty `{}` means form only. Form mode is a **flat object of primitives** (string with formats, number, boolean, enum, multi-select). Actions are `accept | decline | cancel`. Servers **MUST NOT request passwords, API keys or tokens via form mode** and must use URL mode for those. Clients MUST show which server is asking and offer decline. Clients MUST NOT pre-fetch or auto-open URLs.

**Authorization** (`basic/authorization/*`):
- Authorization is optional. HTTP implementations SHOULD conform. **stdio SHOULD NOT use it**: credentials come from the environment (`index.mdx` §"Protocol Requirements"; `basic/index.mdx` §"Auth").
- Standards: OAuth 2.1, RFC 8414, 8707, 9728 (PRM), 9207 (`iss`), CIMD draft, plus RFC 7591 (DCR, deprecated).
- Client registration priority (`client-registration.mdx`): pre-registered → **CIMD** if the AS metadata has `client_id_metadata_document_supported: true` → DCR fallback (with `application_type: "native"|"web"`) → prompt the user.
- CIMD `client_id` is an HTTPS URL with a path; the document must contain `client_id` (exact match), `client_name` and `redirect_uris`. The example uses `token_endpoint_auth_method: "none"`.
- Persisted DCR or pre-registered credentials **MUST be keyed by issuer** and never reused across authorization servers. CIMD IDs are portable.

**Extensions** (`basic/versioning.mdx` §"Extension Negotiation"; `docs/extensions/client-matrix.mdx`). Negotiation happens through `capabilities.extensions{id → settings}`. If one side lacks the extension, the other **MUST revert to core behaviour** or reject. The matrix shows:
- **MCP Apps** (`io.modelcontextprotocol/ui`): Claude web, Claude Desktop, VS Code Copilot, M365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor and others; **not Claude Code**, MCP Inspector or fast-agent
- **Tasks**: Claude web, **Claude Code**, MCPJam
- **Skills**: ChatGPT (partial), Inspector (partial), fast-agent (partial), mcpc

## Data model and storage
n/a: no storage is defined. The relevant shapes are wire types in `schema/2026-07-28/schema.ts`:
- `RequestMetaObject` (line 63)
- `ClientCapabilities{experimental, roots, sampling{context,tools}, elicitation{form,url}, extensions}` (line 716)
- `ServerCapabilities` (line 793)
- `CacheableResult` (1081)
- `CallToolResult` (1809)
- `ToolAnnotations` (1912)
- `Tool` (1973)
- `InputRequiredResult` / `InputResponseRequestParams` (584–609)

## Config format
n/a: the spec defines no config file. Hosts' MCP config files (`.mcp.json` etc.) are host-specific.

## Extension points (plugins, hooks)
- **Extensions framework**: reverse-DNS identifiers following the `_meta` naming rules; settings per extension; fallback behaviour SHOULD be documented. Official ones: Apps, Tasks, Skills, OAuth Client Credentials, Enterprise-Managed Auth (`docs/extensions/overview.mdx`).
- **`_meta`** on any request or result. Third parties use their own prefix.
- **`resultType`**: extensions may add values (Tasks adds `"task"`).
- `experimental` capability bags.

## Rules / lists: parsing and compilation
n/a: protocol spec. The nearest analogue is JSON Schema handling (`basic/index.mdx` §"JSON Schema Usage", line 247): the default dialect is 2020-12, `$ref` resolution is required, and composition keywords have resource bounds. Our zod-derived schemas should stay simple object schemas.

## Testing strategy
- The schema is TypeScript-first. `npm run check:schema` runs `tsc --noEmit` + eslint + prettier, regenerates `schema.json` with `--check`, validates every example under `schema/<rev>/examples/` (`scripts/validate-examples.ts`), and diffs the typedoc-rendered `schema.mdx` (`package.json` scripts). SEPs are rendered and checked (`check:seps`). Docs links are checked with `mint broken-links`.
- SEP-2484 (`seps/2484-conformance-tests-required-for-final-seps.md`) requires conformance tests before a SEP becomes Final, which is why the SDKs run `@modelcontextprotocol/conformance` per era.
- What we take from this: use `schema/2026-07-28/schema.json` and `examples/` (Apache-2.0/MIT) as golden fixtures. Validate raw wire frames from our gateway in an e2e test (e.g. that every result has `resultType`, that `tools/list` has `ttlMs`/`cacheScope`, and that the envelope round-trips) (inferred approach).

## UX patterns worth copying
- **Compatibility matrices as tables**: a client era × server era table with one sentence per outcome (`basic/versioning.mdx`). Our docs should have the same for host × era × feature (Apps panel, ask-first, hook).
- **A deprecation registry** with "earliest removal" dates (`deprecated.mdx`). Copy it for our own config and CLI deprecations.
- **Error messages that name the remedy**: `-32022` carries `supported[]`; modern-only servers name their versions in the `initialize` error because "this message may be the only diagnostic they can surface to users" (`versioning.mdx`).
- Server-instructions guidance (`blog/content/posts/2025-11-03-using-server-instructions.md`): say what the tools *don't* convey (sequencing, caching, rate limits). Don't repeat tool descriptions, make no marketing claims, include no general behaviour instructions, and don't rely on instructions for security-critical actions ("better implemented as deterministic rules or hooks").

## Performance tricks
- Cacheable `tools/list`/`server/discover` with long `ttlMs` + `public` means hosts skip re-listing, and deterministic order keeps the model's prompt cache stable (`changelog.mdx` minor 3, 5; SEP-2567 §"List endpoints cannot be cached across sessions": O(subagents × servers) → O(servers)).
- No resumability and no sessions: a broken stream simply means "re-issue the request" (`changelog.mdx` major 9). The gateway needs no event store.

## License and what it means for us
The license is permissive. We may implement the spec freely, vendor `schema.json` and examples as test fixtures, and quote short passages of spec text with attribution. Documentation prose (not the spec) is CC-BY-4.0, so attribute anything adapted from `docs/docs/**` or the blog. No copyleft concerns.

## Implications for search-hole
- [session-definition] **The spec settles it: "session" cannot be a process or connection.** *"a server must not treat connection or process identity as a proxy for conversation or session continuity"*, and hosts are told not to tie stdio process lifetime to conversations (`basic/index.mdx` §"Statelessness"). So the ADR should define a **search-hole session as an explicit, server-minted handle**. `search` mints a `receiptId`, a ≥128-bit opaque id such as `rcpt_<base64url 22 chars>`, the first time it is called without one. It accepts an optional `receiptId` argument so the model threads it through later searches and fetches. `receipt` takes `receiptIds`. This is exactly the SEP-2567 "explicit state handle" pattern (`seps/2567-sessionless-mcp.md` §"Explicit state handles"; `server/tools.mdx` §"Stateful Tools"). Process lifetime plus an idle gap can remain a **fallback grouping label** for hosts that never pass a handle (Desktop), but never as the source of truth. In Claude Code, the hook `session_id` stays the strongest correlation key for the Stop-hook line.
- [session-definition] Handle hygiene, from the SEP:
  - state the retention in the `search` description ("receipt ids last 7 days")
  - return an `isError` result such as "receipt rcpt_… expired; omit receiptId to start a new one" for unknown or expired ids
  - opaque, unguessable ids, because the local server has no auth context and the handle is a bearer token for reading receipts
  - since handles survive in chat transcripts, a reopened conversation can resume its receipt for free (SEP-2567 §"Resumption")
- [session-definition] Per-request correlation inputs we can log, but not trust for grouping:
  - `_meta.io.modelcontextprotocol/clientInfo` (optional, self-reported)
  - `traceparent` (W3C, if a host sends one)
  - any vendor-prefixed `_meta` keys a host adds

  Log the *keys* of unknown `_meta` per client in debug mode, so the P2 spike can find out whether Claude Code, Cursor or Codex pass a conversation id (inferred; nothing in the spec mandates one).
- [dual-protocol] **A dual-era server is explicitly allowed and is the only way to reach legacy hosts**: "Legacy client × Dual-era server = works"; "MAY serve both eras concurrently on the same endpoint or process" (`basic/versioning.mdx`). Legacy clients cannot fall forward, so the gateway must keep answering `initialize` for as long as any target host speaks 2025. That costs nothing with the TS SDK's `serveStdio` (see `mcp-typescript-sdk.md`). If we ever ship a modern-only mode, its `initialize` error must name `2026-07-28`.
- [dual-protocol] Do not use Logging, Sampling or Roots: they are deprecated, with earliest removal in the first revision on or after 2027-07-28 (`deprecated.mdx`). Log to stderr (pino → fd 2). Take the project directory from config or tool arguments, not Roots.
- [mcp-tool-surface] Set explicit annotations on **every** tool, because the defaults are pessimistic (`schema.ts: ToolAnnotations`):
  - `search`/`fetch`: `{readOnlyHint:true, openWorldHint:true}`
  - `receipt`: `{readOnlyHint:true, openWorldHint:false}`
  - `suggest_rule`: `{readOnlyHint:false, destructiveHint:false, idempotentHint:true, openWorldHint:false}`. It only *queues* a suggestion, so it is additive, and idempotent if we dedupe on (domain, action).
  - `apply_rule` (app-only): `{readOnlyHint:false, destructiveHint:true}`

  Annotations are untrusted hints to the host (they drive auto-approve UX), not security controls.
- [mcp-tool-surface] `tools/list` must be identical for every connection (`server/tools.mdx` §Capabilities). We cannot hide `apply_rule` for non-Apps clients or vary tools by profile; the per-client difference has to live in `_meta.ui.visibility` (host-enforced) and in argument handling. Use a deterministic order, and return `ttlMs` + `cacheScope:'public'` on `tools/list` and `server/discover` (`caching.mdx`). Tool names `search`, `fetch`, `receipt`, `suggest_rule`, `apply_rule` all satisfy the name rules. Hosts may prefix them when they aggregate servers (§"Tool Names" note).
- [mcp-tool-surface] **The text-vs-structured trade-off is deliberate.** The spec says a tool returning `structuredContent` SHOULD also return the *serialized JSON* as text, for backwards compatibility (`server/tools.mdx` §"Structured Content"). Our token budget (`search` ≤ ~2.5k tokens) argues for a **compact human-readable text block** (numbered results, dates, a hidden-count line) instead of a JSON dump, since the model mostly reads `content`. Record this as a conscious deviation from a SHOULD in the tool-surface ADR, and keep the text deterministic and complete enough that a host which drops `structuredContent` loses nothing material.
- [mcp-tool-surface] Error mapping. Engine down, blocked domain, expired receipt id, bad freshness value and the like are **tool execution errors** (`isError:true` + an actionable message such as "No healthy engine — run `searchhole doctor`"), so the model can recover (`server/tools.mdx` §"Error Handling"). Use JSON-RPC errors only for protocol faults. Never invent codes in `-32020…-32099`; app-specific codes, if any, go outside `-32768…-32000` (`basic/index.mdx` §"Error Codes").
- [ui-ux] **Ask-first via MRTR is spec-legal for `tools/call`**, with these constraints (`basic/patterns/mrtr.mdx`):
  - send an `elicitation/create` input request only if that request's `clientCapabilities.elicitation` declares form mode
  - the form must be flat primitives (e.g. `approve: boolean`, `engines: multi-select enum`, `depth: enum`)
  - handle `decline`/`cancel`, and never assume a retry will come; the search simply doesn't run, and the decision is logged
  - put only a plan hash, a step and an expiry in an HMAC-protected `requestState`
  - for clients without elicitation, fall back to "plan as text" (plan §5 step 2)

  Elicitation is Active, not deprecated (`client/elicitation.mdx`).
- [security] Elicitation form mode **must not ask for API keys** (`client/elicitation.mdx` §"User Interaction Model"). `doctor`/first-run cannot collect a Brave or Kagi key through an in-chat form. Use host `userConfig`/MCPB `user_config` (keychain), env vars, the CLI, or a URL-mode elicitation that opens the local dashboard's key page (the user enters the key out of band; the dashboard is token-protected, so it can verify the opener) (inferred design).
- [security] `requestState` and handles: integrity-protect anything that influences business logic, bind the TTL and the originating method, and enforce single-use server-side where needed (`mrtr.mdx` server requirements 4–5). Rule changes must never be authorised by `requestState` or by possessing a handle. They stay with the user-action paths (§12.4).
- [security] HTTP mode (v2 connector, or a local HTTP entry if ever used):
  - **validate `Origin` (403)**, bind 127.0.0.1 when local
  - require and verify `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` against the body (`-32020`, 400)
  - answer GET/DELETE with `405`, ignore `Mcp-Session-Id` and `Last-Event-ID`
  - cap body size (`basic/transports/streamable-http.mdx` §"Security & Endpoint", §"Server Validation")

  Avoid `x-mcp-header` on `query` (it would put user queries in HTTP headers seen by intermediaries; inferred privacy risk).
- [security] Auth for the v2 connector:
  - PRM (RFC 9728) whose `resource` is the canonical server URI
  - an AS that advertises `client_id_metadata_document_supported: true`, so claude.ai/ChatGPT use CIMD (HTTPS `client_id` URL, `token_endpoint_auth_method:"none"`)
  - DCR only as a deprecated fallback, with `application_type`
  - `iss` in authorization responses (RFC 9207)
  - issuer-bound client credentials (`basic/authorization/client-registration.mdx`, `changelog.mdx` minor 7–9)

  Over stdio, the spec says SHOULD NOT do OAuth: engine keys come from the environment, which matches plan §4's key-resolution order.
- [other] Our own `_meta` keys (e.g. a receipt id on results for the Stop hook or the Apps panel, `dev.searchhole/receiptId`) must use a **non-reserved reverse-DNS prefix**. The second label must not be `mcp` or `modelcontextprotocol` (`basic/index.mdx` §"`_meta`" key format). Put the receipt id in `structuredContent` too, because hosts may strip unknown `_meta` (inferred).
- [runtime-packaging] stdio duties (`basic/transports/stdio.mdx`): exit promptly on stdin EOF (otherwise orphaned gateways hold DB handles across host restarts); never write non-MCP bytes to stdout; expect to be restarted after a crash, with in-flight calls lost. Startup must therefore be fast and idempotent, consistent with the <300 ms target.
- [dual-protocol] Cancellation semantics differ by transport: stdio sends `notifications/cancelled`; HTTP closes the response stream (`basic/patterns/cancellation.mdx`). Either way, the gateway must abort engine fan-out and record the search as `cancelled` in the log, not as an error.
- [ui-ux] The extension matrix (`docs/extensions/client-matrix.mdx`) confirms the plan: the MCP Apps receipt panel renders in Claude web/Desktop, Cursor, VS Code, ChatGPT and Goose, but **not in Claude Code**. When the client doesn't declare `io.modelcontextprotocol/ui`, the server **MUST** revert to core behaviour (`versioning.mdx` §"Extension Negotiation"), so `receipt` always returns full text + `structuredContent`. Claude Code supports the **Tasks** extension: a later option for very long `deep` searches (a durable task handle plus polling) without blocking the turn (`docs/extensions/tasks/overview.mdx`).
- [testing] Our e2e tests should assert raw wire invariants from this spec:
  - every result carries `resultType`
  - `tools/list` and `server/discover` carry `ttlMs ≥ 0` + `cacheScope`
  - `serverInfo` is in result `_meta`
  - a modern request missing `_meta.protocolVersion` gets `-32602`
  - an `initialize` on a legacy-opened stdio connection succeeds with 2025 semantics
  - an unknown version gets `-32022` with `supported`
  - nothing but JSON lines appears on stdout

  Use `schema/2026-07-28/schema.json` to validate frames.
- [other] Plan §3 corrections:
  - `clientInfo` is optional (SHOULD), not always present
  - elicitation is not "replaced": it remains, delivered via MRTR, while sampling, roots and logging are deprecated
  - cache hints are required on `server/discover`, `resources/read` and `resources/templates/list` as well as lists
  - `Mcp-Name` is required only for `tools/call`, `resources/read` and `prompts/get`
  - DCR is deprecated with earliest removal after 2027-07-28
  - which hosts default to 2026-07-28 is **not documented in this repo**; the GA post lists SDKs, not hosts (`blog/content/posts/2026-07-28-spec-ga/index.md` §SDKs). So the P2 spike must measure it.

## Borrow / avoid
**Borrow**
- SEP-2567 explicit handles as our session primitive (`receiptId` minted by `search`, threaded by the model, lifetime in the description, clear expiry error).
- The dual-era server stance: answer `initialize` *and* per-request `_meta` from one process.
- `isError` tool execution errors with actionable text; deterministic, cacheable (`public`, long TTL) tool lists; static `instructions` that cover only what the tool descriptions don't.
- An MRTR elicitation for ask-first, gated on per-request capabilities, with HMAC `requestState`.
- Spec-style compatibility tables and a deprecation registry in our docs; golden-fixture validation against `schema.json`.

**Avoid**
- Treating a stdio process, connection or `clientInfo` as a conversation, user or security boundary.
- Tool lists that vary by connection, profile or client; side-effect-driven list changes.
- Logging, Sampling, Roots (deprecated); server→client requests on stdout; `ping`; SSE resumability assumptions.
- Asking for secrets via form elicitation; trusting `requestState` or handles for authorisation.
- Codes in `-32020…-32099` we didn't get from the spec; `x-mcp-header` on query text.
- DCR-first auth for the connector (CIMD first, DCR fallback only).
