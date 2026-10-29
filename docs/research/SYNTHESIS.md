# Phase 0 synthesis

> **Date:** 2026-10-30. **Scope:** MASTER_PLAN.md §10 and §11 P0.
> **Inputs:** 31 shallow-cloned reference repos (commits pinned in [`_refs-table.md`](_refs-table.md)), Basel's own smart-doctor, and three platform-fact checks against live primary sources: [MCP and hosts](platform-facts-mcp.md), [Claude Code and runtime](platform-facts-claude-code-runtime.md), [engines, lists and versions](platform-facts-engines-lists-versions.md). Name and domain availability and the local toolchain versions were checked on 2026-10-29 and are recorded in [`STATUS.md`](../../STATUS.md).
> **Outputs:** this file and [ADRs 0001–0015](../adr/README.md).

## 1. Method and confidence

- One research agent per group of related repos wrote a note per repo using the §10 template. The notes record licenses from the actual LICENSE files and cite evidence as paths in the ref.
- **Adversarial verification:** a second agent re-checked every license claim, every "Implications" bullet and the mechanisms they rest on against the source, fixed errors in place, and appended a `## Verification` section. **25 of 35 notes** are verified this way.
- **Not second-pass verified** (the run hit the usage limit): `ext-apps`, `mcpb`, `mcpjam-inspector`, `docker-mcp-gateway`, `infisical`, `dokploy`, `supabase-studio`, and the three platform-fact files.
  - For those, I spot-checked the load-bearing claims directly against source or live docs on 2026-10-30:
    - SDK v2 `serveStdio` → `legacy:'serve'` and `createMcpHandler` → `legacy:'stateless'` defaults (`docs/protocol-versions.md`);
    - the spec's statelessness rule;
    - ext-apps `visibility`;
    - Codex's default 2025-06-18 (`protocol_mode.rs`);
    - VS Code's `LATEST_PROTOCOL_VERSION = "2025-11-25"`;
    - Claude Code's `CLAUDE_CODE_SESSION_ID`, `MCP_PROTOCOL_NEGOTIATION`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`;
    - `mcp_tool` hook semantics;
    - `onFailure` (v2.1.295).
  - The remaining unverified claims in those files are marked as such where an ADR depends on them.
- Facts marked **[report]** come from third-party issue logs, not vendor docs. They were mainly Desktop, claude.ai and ChatGPT era behaviour. They are treated as medium confidence and re-tested in P2.
- **ADR review:** three independent reviewers (facts, consistency, red team) produced 90 findings, including 3 critical. All were applied or answered on 2026-10-30: ADRs 0002–0014 were revised and ADR-0015 was added.

## 2. Headline findings that change the plan

1. **Hosts split into dual-era, 2026-only and 2025-only.**
   - **Dual-era (2026 with legacy fallback):** Claude Code, Claude Desktop, claude.ai, Goose, and Devin Desktop (fallback inferred).
   - **2026-only:** ChatGPT [report].
   - **2025-only:** Cursor, VS Code and Zed (all 2025-11-25), and Codex (2025-06-18).
   - The MCP Inspector can do both but defaults to legacy.

   **Dual-protocol is mandatory, and SDK v2 gives it for free** (`serveStdio`/`createMcpHandler` defaults). The P2 spike shrinks to "verify and log" → [ADR-0013](../adr/0013-dual-protocol-support.md).
2. **The MCP server learns its Claude Code session.** Stdio servers get `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR`. But the ID is frozen at spawn and stale after `/clear`, so hooks must re-key it. → [ADR-0005](../adr/0005-session-definition.md).
3. **Hooks can call the gateway directly** (`mcp_tool` hooks) and fail open when it's down.
   - PreToolUse "deny only while healthy" becomes exact. Health is three-state (healthy, unhealthy, unknown) with a bounded probe, plus a deny-loop breaker for agents that can't see our tool.
   - `UserPromptSubmit` and `Stop` bracket each turn, so receipts map to turns and forged model calls can't re-key sessions.

   → [ADR-0014](../adr/0014-claude-code-hook-integration.md).
4. **`apply_rule` with `visibility: ["app"]` is only hidden on hosts that render MCP Apps.** The Claude Code CLI, Codex and Zed would expose it to the model. Fix: register it only for Apps-rendering host profiles, and require a panel-only HMAC action token. → [ADR-0012](../adr/0012-mcp-tool-surface-and-output-limits.md).
5. **The protocol has no session, and the spec forbids treating a process as one.** One process per conversation is false in almost every host: Desktop runs separate copies plus probe siblings, and Claude Code servers outlive sessions. Sessions are resolved per request from host keys (`openai/session`, `vscode.conversationId`, `agent-session-id`, the hook `session_id`), and receipts are server-minted handles. → ADR-0005.
6. **Claude Code supplies no Node, and standalone binaries are impractical today:**
   - Bun binaries are about 90–110 MB per platform, so 8 targets come to about 0.8 GB.
   - A plugin manifest can't select a binary per platform.
   - A top-level `bin/` blocks claude.ai and Cowork installs.
   - The marketplace `npm` source itself runs the user's npm, so the plugin ships via the **`archive` source** (a sha256-pinned GitHub Release zip), which installs without Node.
   - Decision: require Node ≥ 22.13, ship one dependency-free bundle, and catch "no node" with a preflight hook. → [ADR-0002](../adr/0002-runtime-and-packaging.md).
7. **`node:sqlite` is viable now.** It is a release candidate from Node 24.15 and on Node 26 LTS, unflagged (with a warning) on Node 22.13, and **Bun 1.4.4 implements it too**. Zero native dependencies are achievable on every runtime we care about, pending the spike on Desktop's Electron Node (§8). → [ADR-0003](../adr/0003-sqlite-driver-and-access-layer.md).
8. **No reference project tails a database that many processes write.**
   - agentgateway tails a single-writer SQLite log over SSE (the closest precedent).
   - mitmweb and Dokploy push over WebSocket from the writer.
   - Pi-hole, Langfuse, Infisical and Supabase poll.

   Our cross-process rowid tail is new, so it needs a spike, plus a polling fallback on the same cursor contract. → [ADR-0004](../adr/0004-dashboard-process-model.md).
9. **Version skew is the normal state, not an edge case:**
   - old plugin versions run for up to 14 days after an update;
   - third-party marketplace auto-update is off by default;
   - Desktop updates `.mcpb` extensions independently;
   - Cursor also loads Claude plugins.

   Decision: an additive-or-read-only schema policy, and lease-owned jobs. → [ADR-0006](../adr/0006-upgrades-migrations-multi-install.md).
10. **"Sensitive" `userConfig` means the macOS Keychain only.** Claude Code stores plugin secrets in `~/.claude/.credentials.json` on Linux and Windows, so the docs mustn't promise "keychain" there. → [ADR-0007](../adr/0007-key-storage-and-resolution.md).
11. **`metascraper-date` is unsuitable as-is.** Its default is modified-first, and its helpers hard-depend on native `re2` and `jsdom`. We'll write our own extractor with typed dates. → [ADR-0011](../adr/0011-date-extraction-chain.md).
12. **Linear-time regex is solved by re2js** (pure JS, MIT, `RE2Set`). V8's linear engine can't be enabled via `NODE_OPTIONS`, and Bun lacks it. → [ADR-0008](../adr/0008-rule-format-and-precedence.md).
13. **Engine terms are stricter than the plan in two places and looser in one:**
   - stricter: Exa allows only browser-style temporary caching, and Brave's ToS forbids storing beyond transient use;
   - looser: Tavily's current ToS has **no** caching clause (the plan's link is dead).
   - Also: Kagi's API is still a public preview, and Brave's $5 credit needs a card and attribution.

   Decision: per-adapter retention that follows the evidence's own recommendations. Brave, Kagi and Exa default to **decisions-only**: a URL hash, domain, rank, decision and rule are stored, while titles, snippets and URLs stay in memory for the current receipt. A `storageRights` opt-in switches an engine to full storage. → [ADR-0009](../adr/0009-engine-adapter-interface.md).
14. **The Codex public directory won't list a local stdio plugin** ("local MCP submissions are limited to approved partners"), hookless or not. The Claude directory no longer accepts `.mcpb` submissions; a plugin is the route there. That changes the P7 and P8 launch plan (§7 below).
15. **SearXNG out of the box rejects JSON API clients.**
   - `json` is off by default (requests get 403);
   - public or limiter-enabled instances also cap JSON at 4 calls per hour per IP (the limiter is off by default, and inert without Valkey);
   - `engines=` and `categories=` are unioned;
   - unknown engine names are dropped silently;
   - `language` follows the client's `Accept-Language`.

   The bundled container needs our own settings overlay, and the adapter must validate engine names. → ADR-0009, [ADR-0015](../adr/0015-settings-data-locations-retention.md).
16. **In Claude Code the model can reach rule changes through Bash and Edit.** That is the review's top security finding. The boundaries are:
   - no MCP tool changes rules;
   - rule-changing slash commands are skills with `disable-model-invocation: true`;
   - `suggest_rule` returns approval *instructions for the user*;
   - a PreToolUse guard denies Bash calls to search-hole's rule-changing verbs and Edit/Write calls to its files.

   SECURITY.md states the honest limit: a model with shell access can still find a way, so every change is attributable and undoable. → ADR-0012, ADR-0014.

## 3. Reference comparison

**Can copy code** means code is copyable with attribution under the repo's license. Otherwise only ideas are used and our own code is written (§10 license hygiene).

| Repo | License (from files) | Can copy code? | What we take | ADRs |
|---|---|---|---|---|
| pi-hole/pi-hole · web · FTL | EUPL-1.2 (vendored parts vary) | **No** | 4-state list health, ETag+IMS, build-aside + atomic swap + rotated backups; row-level block reason; precedence user allow > user deny > list allow > list block; env-locked settings; cursor-paged log with restart detection | 0004, 0006, 0007, 0008 |
| AdguardTeam/AdGuardHome | GPL-3.0 | **No** | `migrateToN` + golden fixtures; tolerant log reader; list role defines meaning; matching semantics table; *avoid*: hard-fail on newer schema, list allowlist beating user `$important` | 0006, 0008 |
| gorhill/uBlock | GPL-3.0-or-later | **No** | Compiled "selfie" with magic-number invalidation; HNTrie idea; layered user > lists; `$badfilter` exact cancellation; deferred heavy work | 0006, 0008 |
| iorate/ublacklist | MIT | Yes | "Most-local tier with a match wins" + action priority; `Patch` model for suggestions; recompile on update | 0008, 0012 |
| searxng/searxng | AGPL-3.0-or-later | **No** (HTTP use fine) | Pure request/response adapter split; error-class suspension; `unresponsive_engines`; *avoid*: its score formula, unanchored host regex, per-process health | 0009, 0010 |
| brave/goggles-quickstart | **none** | **No (link only)** | Goggles syntax/semantics for importer and pushdown compiler; `^` definition; caps | 0008, 0009 |
| brave/brave-search-skills | MIT | Yes | Brave params (`page_age`, `text_decorations`, `mutated_by_goggles`); skill structure ("USE FOR…", depth table, error→action) | 0009, 0011 |
| ItzCrazyKns/Vane | MIT (Docker image builds AGPL SearXNG) | Yes | Bundled SearXNG shape (full/slim); *avoid*: unpinned clone, committed secret, 0.0.0.0, silent embedding drops | 0009 |
| spences10/mcp-omnisearch | MIT | Yes | Key-less registry skipping with reasons; *avoid*: required `provider`, no output caps | 0009, 0012 |
| yokingma/one-search-mcp | MIT | Yes | stdin-EOF cleanup; *avoid*: errors swallowed as empty, SDK v1 + `zod/v3`, no caps | 0006, 0009 |
| brcrusoe72/agent-search | MIT; `mcp-server/` **AGPL** | Root yes; `mcp-server/` **no** | Never-throw adapter contract; URL normalization baseline; label-boundary host matching + spoof fixtures; deep coverage guarantee | 0008, 0009, 0010 |
| BerriAI/litellm | MIT except `enterprise/` | Yes (outside `enterprise/`) | Error-class cooldown table; attempted-set fallback walk; budget check per hop; lease row and worker heartbeat | 0006, 0009 |
| agentgateway/agentgateway | Apache-2.0 | Yes (keep licence + headers) | Two-era validation matrix; EWMA eviction; rate-limit header parser; SSE tail shape; strict vs permissive compile | 0004, 0008, 0009, 0013 |
| IBM/mcp-context-forge | Apache-2.0 | Yes (keep licence + headers) | Per-era adaptations; enforce/permissive/disabled modes; pragma set; *avoid*: per-process log buffer, tmp-dir locks | 0003, 0008, 0013 |
| stacklok/toolhive | Apache-2.0 | Yes (keep licence + headers) | Discovery file + nonce; secrets resolution order and references-not-values; preserve unknown keys; `ClassifyRevision` | 0004, 0006, 0007, 0013 |
| docker/mcp-gateway | MIT (with exceptions) | Mostly | Migration lock + race test + lease; references-not-values secrets; *avoid*: `maskSecret` prefixes, no WAL | 0006, 0007 |
| langfuse/langfuse | MIT except `ee/` | Yes (outside `ee/`) | Rows/count/metrics split; peek panel; zod filter AST; migration byte-lock (one hash over all; we hash per file); virtualise bounded, paginate history | 0004, 0006, UI |
| louislam/uptime-kuma | MIT | Yes | Pragma baseline; paint first, then heavy data; important vs routine retention; *avoid*: three migration systems, lax newer-schema handling | 0003, 0004, 0006 |
| mitmproxy/mitmproxy | MIT | Yes | Snapshot + buffered deltas SSE protocol; filter expression language; replay / dry-run replay; typed event bus | 0004, 0010, UI |
| modelcontextprotocol/inspector | Apache-2.0 + MIT (transition) | Yes (keep licence + headers) | No-workspace bundling discipline; `fetch`-reader SSE with auth; legacy-era default (so we must answer `initialize`); CLI `--strict` schema lint | 0001, 0004, 0012, 0013 |
| MCPJam/inspector | Apache-2.0 except EE `server/services/**`, `evals.ts` | Yes (outside EE) | Host-compat matrix for MCP Apps; probe-captured `clientInfo` per host; embed panel HTML as a constant | 0005, 0012 |
| modelcontextprotocol/typescript-sdk | Apache-2.0 + MIT (transition) | Yes (dependency) | Dual-era serving; per-request factory semantics; object-root output schemas; cache hints; cancellation | 0005, 0012, 0013 |
| modelcontextprotocol spec | Apache-2.0 / MIT / CC-BY-4.0 docs | Yes | Statelessness rule; handles (SEP-2567); error-code rules; deprecated Roots/Sampling/Logging | 0005, 0012, 0013 |
| modelcontextprotocol/ext-apps | Apache-2.0 + MIT (transition) | Yes | `registerAppTool`/`registerAppResource`, `visibility`, CSP fields, theme helpers (76 vars), singlefile bundling | 0012 |
| modelcontextprotocol/mcpb | Apache-2.0 + MIT (transition) | Yes | Manifest 0.3 `node` type; `platform_overrides` by OS only; optional sensitive keys; unset placeholder quirk | 0002, 0007 |
| orwa-mahmoud/nightshift | MIT | Yes | Multi-host manifests; sh/PowerShell polyglot hook launcher; hooks as gates; state-version discipline; duplicate-copy detection | 0002, 0006, 0014 |
| Infisical/infisical (frontend) | MIT except `ee/` | Yes (outside `ee/`) | Virtualised `<table>` with `aria-rowcount`; "N new" pill and live states; decision chip table; typed URL search params | UI |
| Dokploy/dokploy | Apache-2.0 except `/proprietary` | Yes (outside `/proprietary`) | Pause-by-buffer live view; per-endpoint auth on WS/SSE | 0004, UI |
| supabase/supabase (studio) | Apache-2.0 | Yes (keep licence + headers) | Unified logs layout (facets, histogram brush, docked detail); shortcut registry → ⌘K + cheat sheet; custom search-param codec | UI |
| smart-doctor (Basel's) | MIT, same author | **Yes, directly** | Local UI security model; never-throw HTTP helper; ranked causes as data; ALS event bus; redaction at source; mock server with named scenarios; version-constant test | 0002, 0004, 0009, testing |

## 4. Decision matrix by dimension

| Dimension | What the field does | Our choice |
|---|---|---|
| **Process model** | Daemon owning DB, API and UI (Pi-hole, AGH, Kuma) | No daemon; many writers + on-demand single-instance UI (0004) |
| **Live updates** | Polling (Pi-hole 2 s, Langfuse, Supabase, Infisical); in-process emit (Kuma) | rowid tail at 250 ms over SSE, snapshot + deltas, polling fallback (0004) |
| **Storage** | better-sqlite3 (Kuma, Vane), pure drivers (ToolHive, Docker), memdb + export (FTL) | `node:sqlite` via a port, WAL, one connection per process (0003) |
| **Migrations** | Forward-only SQL (Pi-hole), `migrateToN` (AGH), knex (Kuma), golang-migrate + lock (Docker) | Forward-only SQL under `BEGIN EXCLUSIVE`, min reader/writer versions, read-only on newer (0006) |
| **Background jobs** | None, or one process (all) | Lease row + heartbeat + stdin-EOF release (0006) |
| **Secrets** | Plaintext config (Vane, SearXNG, uBlacklist); encrypted file + keychain password (ToolHive); native keyring (Inspector) | Host env → env → OS store via OS CLIs; refuse when no store (0007) |
| **Rule precedence** | AGH lists can beat user; Pi-hole user > lists; uBO layered; uBlacklist local tier wins | Visibility tier walk with user tiers above lists; separate pin and weight passes (0008) |
| **List compile** | uBO selfie + magic; Pi-hole gravity DB swap; uBlacklist recompile at start | Versioned artifacts by (list, sha, compiler version), lazy load (0006, 0008) |
| **Regex safety** | Unanchored `re.search` (SearXNG); TRE (Pi-hole) | re2js only; reject non-linear; caps (0008) |
| **Engine health** | Per-process memory (SearXNG, agent-search); Redis (litellm) | Shared `engine_health` rows in SQLite (0009) |
| **Merge** | n·Πw·Σ1/p (SearXNG); static authority (agent-search); embeddings (Vane); none (omnisearch) | Canonical-URL dedupe → RRF k = 20 on raw ranks → rule multipliers → pins → freshness (0010) |
| **Dates** | Dropped (most competitors); `metascraper` modified-first | Own extractor, typed dates + method + confidence (0011) |
| **Tool surface** | 4–16 tools, required provider args, no output caps | 4 model tools + host-scoped internal tools, hard budgets (0012) |
| **Protocol era** | SDK v1 / 2025-only (most competitors); agentgateway serves both | Both eras via SDK v2 defaults (0013) |
| **Hooks** | Bash gates with state files (nightshift) | `mcp_tool` hooks answered by the gateway; one shell preflight (0014) |

## 5. Decisions

| ADR | Decision |
|---|---|
| [0001](../adr/0001-monorepo-shape.md) | Three-package pnpm workspace: `packages/search-hole` (layers under `src/`, checked by a layer-graph test), `apps/dashboard`, `apps/receipt-app`; host manifests generated |
| [0002](../adr/0002-runtime-and-packaging.md) | Node ≥ 22.13 (raise to 24.15 after 2027-04-30); one dependency-free `dist/`; `.mcpb` on Desktop's Node; plugin via the marketplace **`archive`** source (installs without Node); npm for `npx` only; Bun binaries deferred |
| [0003](../adr/0003-sqlite-driver-and-access-layer.md) | `node:sqlite` behind a port (better-sqlite3 fallback); plain SQL + typed queries; WAL pragma set; term-restricted payloads in child tables |
| [0004](../adr/0004-dashboard-process-model.md) | No daemon; `searchhole ui` on 127.0.0.1:7341, single instance via a discovery file + nonce, started only by the user; single-use login code → bearer token in `sessionStorage` (no cookies, nothing in MCP output); SSE rowid tail |
| [0005](../adr/0005-session-definition.md) | Session = per-request key chain (hooks between turns → host `_meta` → spawn env → fallback label); receipt = `rcpt_…` handle: per turn on Claude Code, 10 min idle on `_meta` hosts, no auto-join on fallback hosts |
| [0006](../adr/0006-upgrades-migrations-multi-install.md) | Forward-only migrations by an elected migrator as a lease job; expand/contract window (semver); `user_version` check on every write; FK-safe; fenced leases; versioned list artifacts; `--purge` covers keys |
| [0007](../adr/0007-key-storage-and-resolution.md) | Host env → env (+ `*_FILE`) → OS store via `security` / `secret-tool` / DPAPI; refuse when no store; the gateway never prompts |
| [0008](../adr/0008-rule-format-and-precedence.md) | YAML; `*.d` = `d` (uBlacklist meaning); rules match original URLs; three passes (visibility tier walk, pins, weight); ABP semantics + audit lists resolved separately in the list tier; last-good rules persisted; re2js |
| [0009](../adr/0009-engine-adapter-interface.md) | Pure `buildRequest`/`parseResponse`; typed capabilities, attribution and retention; core owns transport, error classes, three-state health keyed by key fingerprint, fallback, spend caps (fail-closed for billed engines); block-only pushdown; decisions-only default for Brave/Kagi/Exa |
| [0010](../adr/0010-merge-algorithm-and-weights.md) | Strong canonical URL; RRF with k = 20 on raw ranks; ×/÷(1 + 0.15·N); pins; freshness hide/flag; deep coverage and gap flags |
| [0011](../adr/0011-date-extraction-chain.md) | Engine dates → JSON-LD / OG / meta / `<time>` / URL → `Last-Modified` (low); typed dates; no metascraper |
| [0012](../adr/0012-mcp-tool-surface-and-output-limits.md) | Host profiles refined from env; `search`/`fetch`/`receipt`/`suggest_rule` + `apply_rule` (Apps hosts with `serverTools`, HMAC token in `_meta`) + `hook` (Claude Code only); model-reachable write paths closed; render-measure-shrink budgets |
| [0013](../adr/0013-dual-protocol-support.md) | SDK v2 defaults, exact pins, side-effect-free factory, era-agnostic request context, host-emulation conformance suite |
| [0014](../adr/0014-claude-code-hook-integration.md) | `mcp_tool` hooks for SessionStart/UserPromptSubmit/PreToolUse/Stop; turn bracketing; health-gated deny + loop breaker; Bash/Edit guard; `.ps1` polyglot node preflight; `steer`/`strict`/`off`; Claude Code ≥ 2.1.296 |
| [0015](../adr/0015-settings-data-locations-retention.md) | `settings.yaml` separate from rules; XDG/AppData roots with `SEARCHHOLE_HOME` override; per-table retention (90 days default); query hygiene before any engine call; SearXNG container managed only by user commands |

## 6. Other implications (no dedicated ADR yet; feed P1 and the threat model)

### Security (feeds `docs/security/threat-model.md` in P1)

- **SSRF guard for `fetch`:**
  - an undici dispatcher with a custom `connect.lookup` that checks *every* resolved address with `ipaddr.js`;
  - only `unicast` passes, after unwrapping IPv4-mapped and NAT64 addresses;
  - **IP-literal hosts are rejected separately**, because Node skips `lookup` for them;
  - redirects are handled manually and every hop is re-checked;
  - http/https only, with size and time caps and 1–2 connections per host.

  `request-filtering-agent` pairs with `got`, not undici, so it isn't used.
- **Blocked-domain re-check on `fetch`:** rules are re-applied to the final URL after redirects and to `<link rel=canonical>`, so a redirector can't launder a blocked site (AdGuard Home's CNAME-uncloaking idea).
- **List hijack guard:**
  - HTTPS only, ETag / If-Modified-Since;
  - **reject an update that shrinks by more than 50%** or grows past caps, keeping the last good version (Pi-hole has no such guard);
  - optional `sha256` pinning;
  - per-list contribution visible in the dashboard;
  - a list can never touch user tiers (ADR-0008).
- **Project config trust:** `.searchhole.yaml` applies only after `searchhole trust` approves its content hash. It can't set endpoints, keys or subscriptions.
- **Query hygiene:** scan queries for secret-like patterns and internal hostnames before sending them to any engine. Block and explain by default, with a per-rule override. Apply the same redaction before logging (§12.4).
- **Prompt injection:**
  - search and fetch output delimit untrusted web content;
  - only `suggest_rule` is model-reachable;
  - `apply_rule` is host-scoped and token-gated;
  - flagging hidden or instruction-like content in receipts comes later.
- **The model-visible `hook` tool in Claude Code** isn't read-only: it opens and closes turn receipts and re-keys the session. Those effects are accepted only between turns and are logged (ADR-0014 point 1).
- **Model-reachable write paths** (finding 16): skills with `disable-model-invocation`, a Bash/Edit/Write guard, non-TTY changes attributed and undoable; the honest limit is stated in SECURITY.md.

### Lists ecosystem (P6)

- All seed-list licenses match the plan ([platform-facts-engines-lists-versions.md](platform-facts-engines-lists-versions.md) §4):
  - **bundle OK:** CC0 (laylavish HUGE-AI 1,674 rules, popcar2 423, arosh ×2, rjaus 54), Unlicense (quenhus 710), BSD-3 (SpamdexingSites 3,685, with notice), Apache-2.0 (seo-garbage 261, with its licence text), MIT (ncaq 7,786);
  - **subscribe only:** WTFNMFPL (Super-SEO ~418k, updated daily); **danny0838** (licence ambiguous; contains an RE2-incompatible lookahead); **alvi-se** (GPL-3.0);
  - **link only:** Brave Goggles (no licence).
- Store each list's licence string from its LICENSE file, not GitHub's `spdx_id` (two repos report `NOASSERTION`).
- arosh's `evidence.md` is the model for CONTRIBUTING's evidence rule.

### Dashboard stack (§8.2), validated against Infisical, Dokploy, Supabase Studio and Langfuse

- **Confirmed in real code:** React 19, Vite 8 (Rolldown; Infisical needs `manualChunks` for Recharts/d3), Tailwind 4, TanStack Query and Virtual, Recharts 3, cmdk 1.1.1, sonner 2.0.8.
- **Zero adopters among these refs:** React Compiler, TanStack Table v9, Lucide v1, uPlot. `@tanstack/react-hotkeys` has one (Supabase, 0.10); 0.17 is unverified. **Spike each before pinning.**
- **Base UI is rare:** Infisical imports Radix in 32 files and Base UI in 2. Use shadcn on Base UI as planned, but expect to fill gaps; React Aria remains the a11y fallback.
- **TanStack Router's default search serialisation is JSON-first and lossy** (Supabase wrote its own codec), so choose `parseSearch`/`stringifySearch` on day one.
- **Correction:** Langfuse uses d3 primitives, not Recharts.
- **Patterns to copy:**
  - Infisical's virtualised `<table>` with spacer rows and `aria-rowcount`/`aria-rowindex` (a11y at 100k rows);
  - Langfuse's peek panel (`?peek=<id>`) and zod filter AST;
  - Supabase's facets + histogram brush + shortcut registry;
  - mitmproxy's filter expressions (`~d pinterest.com ~hidden`) compiling into the same AST.

### Testing

The mock engine server implements each `ErrorClass` (ADR-0009) as a named scenario, plus the §12.3 list. Two further suites:
- the host-emulation matrix (ADR-0013);
- plugin evals with `evals/mocks/search-hole/<tool>.md` for deterministic cases, and a cost-capped real-server suite.

CI needs a **current** Claude Code (≥ 2.1.296) for `validate --strict --json` and `plugin eval`. The dev machine runs 2.1.97, which has neither.

### Engines and first run (input to the §13 question)

- **SearXNG** when Docker is present: our pinned image + overlay (`formats: [html, json]`, generated `secret_key`, limiter off, bound to 127.0.0.1).
- **Otherwise Marginalia `public`:** legitimate and no signup, but rate-limited and undated, with results under CC-BY-NC-SA.
- **DuckDuckGo:** no official API. `ddgs` is Python-only and "educational purposes only". Not recommended as a default.
- **Brave:** card required, and the $5 credit needs attribution.

## 7. Corrections to MASTER_PLAN.md (apply when the plan is next revised)

| § | Plan says | Verified 2026-10-29/30 |
|---|---|---|
| §3 MCP | `_meta` always carries `clientInfo` | `clientInfo` is optional (SHOULD); no session key exists |
| §3 MCP | `ttlMs`/`cacheScope` on lists | also on `resources/read` and `server/discover` |
| §3 MCP | MRTR replaces elicitation, sampling, roots | MRTR replaces server-initiated *requests*; elicitation stays; Roots, Sampling and Logging are deprecated (removal ≥ 2027-07-28) |
| §3 MCP | `Mcp-Name` on all POSTs | only on `tools/call`, `resources/read`, `prompts/get` |
| §3 MCP | Claude Code negotiates 2026-07-28 by default | probes and falls back; Anthropic can pin servers to legacy; `MCP_PROTOCOL_NEGOTIATION=legacy` |
| §3 Apps | renderers list; ~70 CSS variables | add Claude Android and the Desktop Code tab; Codex and Zed don't render; 76 variables; Claude restricts `frameDomains`; `ui.domain` unavailable for local stdio |
| §15.C | Claude Code doc URLs (`plugins-reference`, `marketplace-reference`) | moved to `/docs/en/plugins/{manifest-reference, marketplace-reference, cli-reference, loading}` |
| §3 Claude Code | `bin/` in plugin layout | `bin/` is only on the Bash tool's PATH, and blocks claude.ai and Cowork installs; `commands/` is legacy, so prefer `skills/` |
| §3 Claude Code | sensitive `userConfig` → OS secure store | macOS Keychain only; `~/.claude/.credentials.json` elsewhere |
| §3 Claude Code | `claude-`/`anthropic-` names rejected | wider list; validate errors but Claude Code still loads them |
| §3 Codex | ship hookless to get listed | local stdio plugins are partner-only in the directory anyway; Codex reads `.claude-plugin/marketplace.json` |
| §3 MCPB | `.mcpb` for the directory | the directory no longer accepts MCPB; distribute directly, list via a plugin; manifest 0.4 exists (adds `uv`); `@anthropic-ai/mcpb` 2.1.2 dates from 2025-12-04 |
| §4 | `node:sqlite` experimental on 22/24, RC on 25 | RC from 24.15 and on 26; Node 25 EOL 2026-06-01; Bun implements it |
| §4 | better-sqlite3 adds install friction | N-API, prebuilds in the tarball, no install script (far less friction, still native) |
| §5.2 | Tavily forbids storing or caching | current ToS (tavily.com/terms) has no caching clause; internal use, no redistribution |
| §5.2 | Exa: temporary caching | only browser-style temporary files unless permitted in writing |
| §5.2 | SearXNG: enable json | also the engines/categories union and silent engine-name drops; limiter-enabled instances cap JSON at 4/hour/IP |
| §7 | `metascraper-date` | modified-first default; native `re2` + `jsdom` dependencies |
| §8.2 | Langfuse uses Recharts | d3 primitives |
| §15.A | versions | biome 2.6.4, tsdown 0.23.4, react-virtual 3.14.24, motion 14.8.0, lucide-react 1.64.0; SDK adapters version separately (`node` 2.1.2, `hono`/`express` 2.0.2); ext-apps: pin 2.0.4 (2.1.0 published then reverted) |
| §15.C | Tavily terms tavily.com/policy; Exa terms and pricing at exa.ai/docs | Tavily: tavily.com/terms; Exa terms: exa.ai/terms; pricing: exa.ai/pricing; API docs: exa.ai/docs |

## 8. Risks and early spikes (ordered)

1. **`mcp_tool` hook substitution** of `${session_id}`, `${source}`, `${agent_type}`, `${tool_name}` and `${tool_input.*}`; UserPromptSubmit firing before any tool call; and whether a deny steers the model (ADR-0014). If it fails, fall back to Node command hooks plus a heartbeat file.
2. **`node:sqlite` inside Claude Desktop's Electron Node** (a test `.mcpb` printing `process.version`; ADR-0002/0003). If it's absent, the `.mcpb` gets better-sqlite3 prebuilds.
3. **The SSE rowid tail** under 8 writers (ADR-0004).
4. **Migration race and two-version tests** (ADR-0006).
5. **Host era matrix on real hosts** (ADR-0013); ChatGPT's no-fallback claim when the v2 connector arrives.
6. **Engine terms vs a local log** (Brave, Exa, Kagi): the decisions-only default is in place (no titles, snippets or URLs stored), but the legal questions stay open, including whether even the registrable domain may be stored, (Brave attribution for personal installs; storage-rights plans).
7. **`.mcpb` via plugin `mcpServers` on a machine with no Node** (does Claude Code supply a runtime?), and whether `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips the plugin's injected keys (ADR-0002, ADR-0007).
8. **Dev environment** (versions checked 2026-10-29, see STATUS.md): update the dev machine to Node 26 (it has 24.14.1, which prints the `node:sqlite` warning), pnpm 12 (it has 10.33.2) and a current Claude Code (it has 2.1.97; needs ≥ 2.1.296).

## 9. License hygiene summary

- **Never copy code from:** Pi-hole (EUPL-1.2), AdGuard Home (GPL-3.0), uBlock Origin (GPL-3.0+), SearXNG (AGPL-3.0+), agent-search `mcp-server/` (AGPL), Langfuse `ee/`, litellm `enterprise/`, Infisical `ee/`, Dokploy `/proprietary`, MCPJam EE paths, or Brave goggles-quickstart (no licence).
- **Permissive sources we may adapt with attribution:**
  - nightshift (MIT, polyglot launcher);
  - smart-doctor (MIT, same author);
  - toolhive, agentgateway, context-forge, the MCP SDK, ext-apps and the Inspector (Apache-2.0; none ships a NOTICE file, so keep the licence text and copyright headers and state changes; ToolHive's `pkg/audit/event.go` also carries an Equinix header);
  - uBlacklist (MIT);
  - mitmproxy (MIT);
  - Uptime Kuma (MIT).

  Record every adaptation in `THIRD_PARTY_NOTICES.md` as it happens.
- The research notes describe GPL, AGPL and EUPL mechanisms in prose only (checked by the verification pass).

## 10. Questions for Basel (MASTER_PLAN §13)

1. **Name follow-through.** Both npm names (`search-hole`, `searchhole`) and the GitHub repo `baselissmail/search-hole` are free.
   - **`searchhole.com` is taken** by an unrelated live site ("Search Hole — research-backed guidance for everyday decisions").
   - Unregistered: `search-hole.dev`, `search-hole.com`, `searchhole.dev`, `searchhole.app`, `searchhole.io`, `searchhole.org`, and the other `search-hole.*` variants.
   - Reserving npm names means publishing placeholder packages from your account. Do you want to do that now, and which domain (if any)? *Recommendation:* reserve both npm names now; register `search-hole.dev` (it matches the package name); skip `.com`.
2. **Code licence: MIT or Apache-2.0?** *Recommendation:* **Apache-2.0**. Reasons:
   - the explicit patent grant and contribution clause suit a tool companies may run;
   - the MCP SDK, spec, Inspector, ext-apps and mcpb are moving to Apache-2.0 (with MIT kept for older contributions whose authors haven't consented).

   MIT is fine if you prefer parity with smart-doctor. **Related:** a licence for *first-party lists*. *Recommendation:* **CC0-1.0**, so other blockers can reuse them, as most seed lists do.
3. **First run without Docker: which no-key fallback is acceptable?**
   - (a) **Marginalia `public` key:** legitimate and no signup, but rate-limited, small-web, undated, and results under CC-BY-NC-SA.
   - (b) **An experimental DuckDuckGo scraper:** no official API, terms and breakage risk.
   - (c) **None:** `doctor` asks for a Brave key (card required; the $5 monthly credit covers about 1k queries).

   *Recommendation:* (a) with honest "may be rate-limited" messaging, plus a one-step nudge to a Brave key or a free Marginalia non-commercial key. Not (b). Also: when Docker *is* present, should first run start SearXNG automatically, or only after `doctor` asks once? *Recommendation:* ask once.
4. **Repo hosting:** personal GitHub `baselissmail/search-hole`, as smart-doctor is? Nothing gets pushed until you say so.
