# ADR-0013: Dual-protocol support (2026-07-28 and 2025-era MCP)

- **Status:** Accepted (2026-10-30)
- **Related:** [0005](0005-session-definition.md), [0012](0012-mcp-tool-surface-and-output-limits.md)

## Context

P2 asks for a spike first: find out what each target host speaks, and serve both eras if needed (a requirement, not an either/or). The research answers most of the spike ([platform-facts-mcp.md](../research/platform-facts-mcp.md) §7; spot-checked against source on 2026-10-30):

| Host (version checked) | Era today | Negotiation |
|---|---|---|
| Claude Code CLI 2.1.312 | **dual** | `server/discover` probe (stdio default since 2.1.292), legacy fallback; Anthropic can pin servers to legacy; `MCP_PROTOCOL_NEGOTIATION=legacy` opt-out |
| Claude Desktop (local stdio / `.mcpb`) | **dual** | discover probe in a disposable sibling process, else `initialize` [reports] |
| claude.ai connectors | **dual** | discover first, falls back to `initialize`; state-only MRTR broken [reports] |
| ChatGPT | **2026 only** (no `initialize` fallback, per 3 reports) | discover |
| Goose 1.57 | **dual** | rmcp `Auto{2026-07-28, 2025-11-25}` |
| Devin Desktop / Windsurf 3.11 | dual (since 3.10.67) | undocumented |
| Cursor 3.21 | **2025-11-25 only** | `initialize`; "No timeline" for 2026 |
| VS Code Copilot 1.144 | **2025-11-25 only** (`LATEST_PROTOCOL_VERSION`) | `initialize` |
| Codex 0.165 | **2025-06-18** by default (verified in `protocol_mode.rs`) | `initialize`; 2026 behind an off-by-default flag *and* a per-server env opt-in |
| Zed 1.26 | **2025-11-25 only** | `initialize` |
| MCP Inspector | **legacy by default** | `initialize` |

SDK v2 facts ([mcp-typescript-sdk.md](../research/mcp-typescript-sdk.md), verified in `docs/protocol-versions.md`):
- `serveStdio(factory)` defaults to `legacy: 'serve'`. The era is pinned **per connection** by the opening message, and a `server/discover` probe is answered without pinning.
- `createMcpHandler(factory)` defaults to `legacy: 'stateless'`.
- Hand-wiring `server.connect(new StdioServerTransport())` gives a 2025-only server.
- In legacy mode we lose nothing material for our surface: tools, `outputSchema`/`structuredContent`, annotations, `_meta` (Apps), `instructions`, and `input_required` asks (shimmed to `elicitation/create`).

## Decision

1. **Serve both eras from one binary, using the SDK defaults:**
   - `serveStdio(buildServer)` for stdio;
   - for the v2 HTTP connector, `createMcpHandler(buildServer)` mounted behind `@modelcontextprotocol/hono`'s app, with **explicit `allowedHosts`/`allowedOrigins`** (the adapter arms Host/Origin checks only on localhost binds).

   Never `legacy: 'reject'`. Never a hand-wired transport. The P2 spike shrinks to "log which era each real host opens with, and verify".
2. **Pin exact versions and upgrade on purpose:** `@modelcontextprotocol/server`, `client`, `core` 2.4.0; `node` 2.1.2; `hono` 2.0.2; `ext-apps` **2.0.4** (2.1.0 was published and reverted, so avoid it). Minor releases have changed wire behaviour before (2.1.0 added a 413 cap and a `-32020` rejection). Renovate opens SDK bumps as separate PRs that must pass the conformance suite.
3. **The factory is cheap and side-effect free.** Probe siblings and double factory calls are normal: no DB open, no lease, no `gateways` row, no heartbeat until a real `tools/call` (ADR-0006). `server/discover` must answer in under 100 ms from a cold process.
4. **One request-context helper** hides the era difference from tool code:
   ```ts
   requestContext(ctx) → { era, protocolVersion, clientInfo?, capabilities, vendorMeta, signal, progressToken? }
   ```
   - On modern requests it reads `ctx.mcpReq.envelope` (`clientCapabilities`, `clientInfo`) and vendor `_meta` keys.
   - On legacy connections it reads `getClientCapabilities()` / `getClientVersion()`, captured at `initialize`.

   MCP Apps capability detection (`getUiCapability`) uses this helper, because ext-apps' documented `oninitialized` pattern only works on legacy connections ([ext-apps.md](../research/ext-apps.md)).
5. **Wire hygiene, satisfying both eras:**
   - every `outputSchema` has an object root (ADR-0012);
   - cache hints are set on `tools/list`, `resources/list`, `resources/read` and `server/discover` (Claude Code 2.1.302 fixed failures when they were missing);
   - `resultType` is always present (the SDK handles it, and tests assert it);
   - nothing deprecated is used: no Roots, Sampling or Logging (the `logging/setLevel` capability isn't declared); logs go to stderr via pino.
6. **Escape hatch:** `SEARCHHOLE_MCP_PROTOCOL=auto|legacy|modern` (default `auto`). This passes `legacy: 'reject'` when set to `modern`, and forces 2025 behaviour when set to `legacy`, for diagnosing host bugs. `doctor` prints each connected host's era from the `sessions` table.
7. **Era-specific behaviour we deliberately accept:**
   - MRTR "ask first" works natively on 2026 clients that declare elicitation, through the elicitation shim on legacy ones, and as text everywhere else (ADR-0012).
   - Codex speaks **2025-06-18**, so we rely on no 2025-11-25-only feature (URL elicitation, icons) for core behaviour.
8. **Conformance suite (P2, in CI):**
   - **Host-emulation clients** built on `@modelcontextprotocol/client`:
     - (a) legacy 2025-06-18 (Codex);
     - (b) legacy 2025-11-25 (VS Code, Cursor, Zed, Inspector);
     - (c) `auto` with a stdio sibling probe (Claude Code, Desktop);
     - (d) modern-only with no fallback (ChatGPT).
   - **Assertions:**
     - `resultType` and cache hints present;
     - `isError !== true` and `structuredContent` valid against `outputSchema`;
     - identical `structuredContent` in both eras;
     - vendor `_meta` passthrough (`openai/session`, `vscode.conversationId`, `agent-session-id`);
     - a discover probe leaves no DB trace.
   - **agentgateway's validation matrix** as negative tests ([agentgateway.md](../research/agentgateway.md)):
     - removed methods under a modern header;
     - a missing `_meta.protocolVersion`;
     - a header/body version mismatch;
     - an unknown version returning `-32022` with `{supported, requested}`.
   - **`mcp-inspector --cli --protocol-era legacy|modern`** against the built gateway.

## Alternatives considered

- **Modern-only.** Rejected: it would lose Cursor, VS Code, Codex, Zed and the Inspector today.
- **Legacy-only.** Rejected: ChatGPT (for the v2 connector) appears modern-only, and Claude hosts prefer 2026. Legacy also misses per-request capabilities and vendor `_meta`.
- **Two separate binaries per era.** Rejected: the SDK already multiplexes per connection at no cost.

## Consequences

- Every feature must be tested in both eras. The emulation matrix is the gate for P2 acceptance.
- When all target hosts ship 2026-07-28 support, the legacy path can stay. The SDK treats dropping a protocol revision as a major version, so we won't be surprised.

## Validate early (P2)

- Run the built gateway against real Claude Code (default and `MCP_PROTOCOL_NEGOTIATION=legacy`), Claude Desktop, Cursor, VS Code, Codex and the Inspector. Record the era, `clientInfo` and the vendor `_meta` keys seen for each in `docs/research/host-matrix.md`.
