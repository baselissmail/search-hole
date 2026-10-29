# search-hole — Master Plan & Product Brief

> **Name: search-hole** ("Pi-hole for AI search"), decided 2026-10-29. It follows Pi-hole's convention: the project is written "Pi-hole" but the command is `pihole`.
> - **Written name** (README, docs, UI): **search-hole**
> - **npm package, GitHub repo, plugin and marketplace name:** `search-hole`, so slash commands are `/search-hole:…`
> - **Terminal command:** `searchhole`. Also ship `search-hole` as a second `bin` entry, so `npx search-hole …` works (npx runs the bin that matches the package name) and either spelling works once installed
> - **Config:** `~/.searchhole/` and the project file `.searchhole.yaml` follow the command name, as Pi-hole uses `/etc/pihole`
> - **Reserve `searchhole` on npm too:** a tiny package that points to `search-hole`, so nobody squats it
> - **Branding:** use our own logo and colours, and never "Pi-hole" in the branding itself (it's a trademark); describing the idea ("like Pi-hole, for AI search") is fine
>
> **Author:** Basel Issmail (personal open-source project). **Plan written:** 2026-10-29. **Status:** not started.
>
> **For the Claude session building this:** read this whole file before writing code. It sets direction, quality bar and known facts, not a frozen spec. Where you find a better approach, take it: record the decision in an ADR (`docs/adr/NNNN-title.md`) with the alternatives you considered and why. Versions and platform facts below were verified on 2026-10-29. Re-check anything load-bearing before you depend on it, because this ecosystem moves monthly.

---

## Table of contents

1. Product description
2. Principles
3. Verified platform facts (Oct 2026)
4. Architecture
5. The search pipeline in detail
6. Rules, lists and profiles
7. Source receipts
8. UI/UX: dashboard and in-chat panel
9. Distribution: plugin, desktop extension, other clients, connector
10. Phase 0: study the reference repos (clone and analyse)
11. Delivery phases with acceptance criteria
12. Engineering standards and quality bar
13. Decisions Basel must make early
14. Ground rules for the building session
15. Appendix: verified versions, reference repos, seed lists, sources

---

## 1. Product description

### One-liner
**search-hole is a local, open-source search gateway for AI assistants.** You choose the search engines and the sites, and you see every search your AI makes, what was hidden and why, and how fresh and trustworthy its sources were.

### The problem
AI assistants now search the web constantly (Claude, Claude Code, Cursor, Codex, ChatGPT), but the person using them has almost no say in that search and almost no view of it:

- **No control over sources.** You can't tell your assistant "never use Pinterest, content farms or AI-generated SEO pages", "prefer official docs", or "for prices, nothing older than 30 days". Perplexity and others have been caught citing AI-generated spam and error-filled pages.
- **No control over the engine.** You can't say "use Kagi for this" or "use my own SearXNG".
- **No visibility.** The searches are hidden or scattered. ChatGPT hides its query fan-out, which is why at least eight Chrome extensions exist just to reveal it. Nobody shows which results were dropped, or why a source was chosen.
- **No source hygiene.** Answers cite stale pages: docs for v2 when you use v4, three-year-old pricing, dead links. Nothing flags it.

### What search-hole is
A small local program (an MCP server, the "gateway") that AI tools send their web searches through. It:

1. **Routes searches** to engines you pick (self-hosted SearXNG with no key by default; Brave, Kagi, Tavily, Exa, Mojeek and others with your keys), with fallbacks.
2. **Applies your rules:** block, lower, raise or pin sites, per topic, with freshness limits. Blocked results never reach the AI.
3. **Subscribes to community lists,** the way Pi-hole and uBlock do: SEO spam, AI content farms, Stack Overflow and GitHub clones, official-docs lists.
4. **Logs everything locally** (SQLite) and shows it in a **local dashboard**: live search log, hidden results with the rule that hid them, top blocked sites, engines used, freshness of sources, and one-click block or trust.
5. **Writes a "source receipt"** for each piece of work: each search, each source the AI actually opened (the gateway sees searches and fetches, not the final answer's citations), its real publish or update date, whether it is official or primary, and warnings (stale, single source, dead link, no official source).
6. **Shows the receipt in the chat** (MCP Apps panel in Claude, ChatGPT and VS Code; text summary in Claude Code).

### Who it's for
| Persona | Situation | What they get |
|---|---|---|
| **Developer in Claude Code, Cursor or Codex** | Agents search docs all day and cite outdated or cloned pages | Official docs first, freshness rules per profile (version awareness later), clone-site blocking, a receipt after each task |
| **Researcher or analyst in Claude Desktop** | Needs trustworthy, current sources | Source receipts, freshness rules, engine choice |
| **Privacy-minded self-hoster** (r/selfhosted, Pi-hole users) | Doesn't want queries going to one company | Self-hosted SearXNG, local logs, no telemetry |
| **Team lead** (later) | Wants a shared policy for the team's AI tools | A project rules file committed to the repo (`.searchhole.yaml`) |

### Core user stories (v1)
- *As a user, I install it in under 2 minutes* (two commands in Claude Code, a drag-and-drop file in Claude Desktop). *On first run it either starts a bundled SearXNG (if Docker is present) or `searchhole doctor` walks me to a working engine in one step (e.g. paste a Brave key, or use a no-key option). My AI's built-in search keeps working until search-hole has a healthy engine.*
- *I run `/search-hole:block pinterest.com`, or click Block in the dashboard or the in-chat panel, and it never appears again in any of my AI tools. If I just tell the AI "block pinterest", it calls `suggest_rule` and I confirm with one click or command.*
- *I say "use Kagi for this" or set Kagi as the default for the coding profile.*
- *I open the dashboard and see every search from the last week, which tool made it, which results were hidden and why.*
- *After an answer, I see a receipt: "6 searches · 41 results · 9 hidden · sources: 3 official, 2 blogs · 1 stale (2022)".*
- *I subscribe to an "AI content farms" list and see how many results it removed this week.*
- *I import my Brave Goggles or uBlacklist rules.*

### Non-goals (v1)
- Not a search engine, crawler or browser.
- Not a chat UI. It plugs into the assistants people already use.
- **No LLM calls inside the gateway.** Every decision is deterministic, free and explainable. AI classification can come later as an opt-in.
- No cloud service and no telemetry by default. A hosted connector is a possible later paid option (§9.5).
- It cannot change the built-in search of ChatGPT, claude.ai or Perplexity. Those run on their servers. Be honest about this in the docs (§3).

### Why it can win (differentiation)
| Existing | What it does | What it lacks |
|---|---|---|
| Kagi (paid) | Block, raise and pin sites, plus an assistant | Closed and Kagi-only. A user report says blocked sites are ignored by Kagi Assistant v2 (unconfirmed) |
| Brave Goggles | Ranking rules language | Brave-only, no AI-tool integration, no log or receipts |
| mcp-omnisearch, one-search-mcp, agent-search | One MCP server, many engines | No user rules, lists, log, dashboard or receipts |
| Vane (Perplexica), Khoj, SurfSense | Open-source Perplexity alternatives | Each is its own chat app, so it doesn't govern the tools you already use |
| SearXNG | Self-hosted metasearch with a hostnames plugin | No AI integration, dashboard or receipts |
| ChatGPT fan-out extensions | Reveal ChatGPT's hidden queries | Read-only, no control, built for SEO people |
| Citation verifiers (RefSentry, webcite-mcp…) | Check academic claims | Not everyday web sources, no search control |

**Moat:** the community lists plus a polished dashboard plus receipts. The code alone can be cloned; a maintained list ecosystem and a trusted brand can't be.

### Success metrics
- Basel keeps it switched on for 2+ weeks of daily work (dogfood gate before launch).
- At launch: a working 2-minute install in Claude Code and Claude Desktop, a demo GIF, at least 3 seed lists.
- 3 months after launch: GitHub stars and installs (track but don't chase), at least 5 outside contributors to lists, at least 1 list maintained by someone else.

---

## 2. Principles

1. **Local-first and private.** Queries, logs and rules stay on the machine. No telemetry. Network calls go only to the engines and pages the user chose.
2. **Explain everything.** Every hidden result names the rule and list that hid it. Every receipt line can be traced back to the raw data.
3. **The user is in control, the model is not.** The AI can *suggest* a rule change but never apply one by itself (§12.4, prompt injection).
4. **Zero-config start, deep config later.** Works with no key out of the box, and every default can be overridden.
5. **Deterministic core.** Same input and rules give the same output, which is testable with no network.
6. **Honest limits.** Document clearly what it can't do (built-in search in consumer apps, Claude Code not rendering MCP Apps, and so on).
7. **Small surface for the model.** Few tools with short descriptions; the token cost is part of the product.
8. **Respect the web.** Polite fetching, robots.txt, per-engine terms of service, list licenses.

---

## 3. Verified platform facts (Oct 2026)

These drive the architecture. Re-verify before depending on them.

### MCP protocol and SDK
- **Latest MCP spec: `2026-07-28`** (released 2026-07-28; previous was `2025-11-25`). **It is stateless:**
  - no `initialize` handshake and no `Mcp-Session-Id`
  - every request carries `_meta` (`io.modelcontextprotocol/protocolVersion`, `clientCapabilities`, `clientInfo`)
  - servers MUST implement `server/discover`
  - every result needs `resultType`
  - list results need `ttlMs` and `cacheScope`
  - elicitation, sampling and roots are replaced by Multi Round-Trip Requests (`resultType: "input_required"`, then the client retries with `inputResponses`)
  - Streamable HTTP POSTs carry `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version` headers
  - DCR is deprecated in favour of CIMD (Client ID Metadata Documents)
- **TypeScript SDK v2 is the stable line:** `@modelcontextprotocol/server`, `client` and `core` are all **2.4.0**; adapters `@modelcontextprotocol/node`, `hono` and `express`. Use `registerTool(name, {title, description, inputSchema: z.object(...), outputSchema, annotations, _meta}, handler)`. Schemas follow Standard Schema (zod ≥ 4.2). **Serve with `serveStdio(factory)` or `createMcpHandler(factory)`.** The old `server.connect(new StdioServerTransport())` path only speaks to 2025-era clients. Node 20+ required. Claude Code negotiates `2026-07-28` by default.
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`), `outputSchema` plus `structuredContent`, and `resource_link` are all available.

### MCP Apps (in-chat UI)
- Stable extension `io.modelcontextprotocol/ui` (SEP-1865, 2026-01-26). Package `@modelcontextprotocol/ext-apps` **2.0.4** (needs SDK v2 and zod ^4.2).
- A tool declares `_meta.ui.resourceUri: "ui://…"`. The resource uses `mimeType: "text/html;profile=mcp-app"` and optional `_meta.ui.csp`. Helpers: `registerAppTool` and `registerAppResource`.
- The host sends theme, about 70 CSS variables and fonts (`applyDocumentTheme`, `applyHostStyleVariables`, `applyHostFonts`).
- **Default CSP blocks all network**, so render from tool-result data or call back with `app.callServerTool`.
- **Rendered by:** Claude web, Desktop and iOS, ChatGPT, VS Code Copilot, Cursor, Goose, M365 Copilot. **Not rendered by Claude Code**, so always return a text summary plus `structuredContent` too.
- Claude's in-chat card rules: auto height, no nested scroll, at most 2 actions and 4–5 data points, no menus or popovers, 44pt tap targets. Use `fullscreen` display mode for the full receipt. Tool results over ~150k characters are not delivered to the app on claude.ai.

### Claude Code plugins and hooks
- Layout: optional `.claude-plugin/plugin.json` (only `name` required), plus `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/`, `settings.json`.
- Variables: `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` (persists across updates, so **put SQLite here or in `~/.searchhole`**), plus `${user_config.KEY}`. `userConfig` values marked `sensitive: true` go to the OS secure store.
- Marketplace: `.claude-plugin/marketplace.json`. Install with `/plugin marketplace add <owner>/<repo>` then `/plugin install <plugin>@<marketplace>`. Check with `claude plugin validate --strict`. **Plugin evals exist:** `claude plugin eval init` / `claude plugin eval .`, with cases in `evals/<case>/`, MCP mocks, and scoring against a no-plugin baseline.
- **Hooks:** `PreToolUse` with matcher `WebSearch|WebFetch` can return `permissionDecision: "deny"` plus a reason that steers the model to our tool. `updatedInput` and `additionalContext` are available. `Stop` hooks can add `systemMessage` (shown to the user).
- **A plugin cannot ship permission deny rules** (plugin `settings.json` only applies `agent` and `subagentStatusLine`). Use the PreToolUse deny hook. Optionally offer a `/search-hole:enforce` command that, with consent, writes `"deny": ["WebSearch","WebFetch"]` to the user's settings.
- Plugin names starting with `claude-` or `anthropic-` are rejected.

### Other hosts
- **Claude Desktop extension (MCPB):** `@anthropic-ai/mcpb` 2.1.2, `manifest_version: "0.3"`, `mcpb pack`. `user_config` with `sensitive: true` is stored in the OS keychain. Desktop bundles its own Node. A plugin's `mcpServers` can reference the same `.mcpb`.
- **Codex:** prefers a root `plugin.json` (Agent Plugins 1.0 standard) plus root `mcp.json`. Codex specifics go under `extensions.com.openai`. **Plugins with hooks can't be listed in OpenAI's directory**, so ship a hookless variant.
- **Cursor:** `.cursor-plugin/plugin.json`, with `mcp.json` (no dot) and `hooks/hooks.json`. It expands `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}`, **not** `${PLUGIN_ROOT}`.
- **Skills:** the open standard is at agentskills.io. `name` ≤ 64 characters and must match the directory; `description` ≤ 1024 characters. Claude Code adds fields such as `when_to_use`, `allowed-tools` and `disable-model-invocation`.
- **claude.ai custom connectors** (v2): available on Free (one connector), Pro, Max, Team and Enterprise.
  - Needs public HTTPS and RFC 9728 Protected Resource Metadata whose `resource` equals the connector URL.
  - PKCE S256. CIMD is used if the authorization server advertises `client_id_metadata_document_supported` plus the `none` auth method; otherwise DCR.
  - Callback `https://claude.ai/api/mcp/auth_callback`. 10 s timeout on discovery, registration and token endpoints.
- **ChatGPT:** add a custom MCP server at chatgpt.com/plugins (public HTTPS or Secure MCP Tunnel). OAuth 2.1 with CIMD preferred. Implements MCP Apps.
- **Honest limitation:** neither claude.ai nor ChatGPT documents a way to force a connector instead of the built-in web search. Newer Claude UIs have no per-chat web search toggle. In consumer apps search-hole is *an additional* search tool, so the docs must say so.

---

## 4. Architecture

### Shape
A TypeScript monorepo with one deterministic core and thin adapters (ports and adapters, the same idea as smart-doctor's Run event bus).

```
apps/
  cli/            the `searchhole` command: search --explain, rules, lists, ui, doctor, export
  dashboard/      React app, built to static assets served by the CLI's `ui` command
  receipt-app/    MCP App panel (single-file HTML bundle)
packages/
  core/           pipeline, engines (adapters), rules engine, merging, receipts, date extraction
  store/          SQLite schema, migrations, queries, retention
  gateway/        MCP server (SDK v2): tool definitions, stdio + HTTP entry points
  lists/          list formats: parsers/importers (YAML, Goggles, uBlacklist, AdGuard/ABP, hosts) and compilers
  fetch/          safe fetcher: SSRF guard, robots, limits, readability extraction
  shared/         types, config loading, logging, errors
distribution/
  claude-plugin/  .claude-plugin/{plugin.json,marketplace.json}, hooks/, skills/, commands/, .mcp.json
  codex-plugin/   root plugin.json + mcp.json (hookless)
  cursor-plugin/  .cursor-plugin/plugin.json + mcp.json + hooks
  mcpb/           manifest.json for Claude Desktop
lists/            first-party curated lists (official docs per ecosystem, etc.) with LICENSE
docs/             guides, ARCHITECTURE.md, adr/, research/
```

(Final layout is the builder's call after Phase 0. If a single package is cleaner, take it and write an ADR. Keep the core free of I/O assumptions so it is unit-testable.)

### Runtime topology
```
 Claude Code ─┐  stdio (one gateway process per client session)
 Cursor ──────┤
 Codex ───────┤──► gateway ──► core pipeline ──► engines (SearXNG, Brave, Kagi, Tavily, Exa…)
 Claude Desktop (MCPB) ┘          │
                                  ▼
                         SQLite (WAL) at ~/.searchhole/ or ${CLAUDE_PLUGIN_DATA}
                                  ▲
                 `searchhole ui` ─┘  local dashboard (127.0.0.1, single instance, on demand)
```

Default design to evaluate in an ADR:
- Every gateway process writes directly to one SQLite database in WAL mode with `busy_timeout`.
- The dashboard is a separate on-demand process (`searchhole ui`, `/search-hole:dashboard`). A lockfile and fixed port make it a single instance.
- Live updates work by tailing new rows (`rowid > last`, every ~250 ms) and pushing them to the browser over SSE.
- No IPC between gateways and dashboard: simple and crash-safe.

Alternatives: a long-running daemon that gateways call over HTTP, or a gateway auto-starting the UI. Decide after studying Pi-hole FTL, AdGuard Home and Uptime Kuma in Phase 0.

**Storage location:** one shared home (`~/.searchhole/`, XDG-aware on Linux and the right app-data folder on Windows), so that Claude Code, Cursor, Codex and Desktop share rules and logs. Plugin data dirs are per plugin and get deleted on uninstall, so use them only if the ADR says so.

**Runtime availability (decide in P0 with an ADR):** a natively installed Claude Code may have **no `node` on the PATH**, so `.mcp.json` → `node gateway.js` can fail on first run. Options:
- (a) require Node and have `doctor` explain how to get it
- (b) ship standalone per-platform binaries (e.g. `bun build --compile`, as smart-doctor does) in the plugin's `bin/`
- (c) point the plugin's `mcpServers` at the `.mcpb` bundle where that works

Option (b) also gives you `bun:sqlite` with no native module. Whatever you choose, the first-run experience must be a clear message, not a silent MCP failure.

**SQLite driver:** compare:
- `node:sqlite`: built in with no native build, but a release candidate in Node 25.x and **experimental on Node 22/24**, so only viable if you raise the minimum Node or ship binaries
- `better-sqlite3` 13: native prebuilds, which add install friction for plugins
- `bun:sqlite`: if you go with option (b)

Prefer zero native dependencies for plugin and npx installs. Access via `kysely` or `drizzle-orm`, or plain SQL with a small typed layer. Create the DB file with mode `0600`.

**Bundling:** ship the gateway as a single bundled artifact (`tsdown`, or a compiled binary) so the plugin and `.mcpb` need no `npm install`. Check whether the Claude Code plugin marketplace's `npm` source type fits better than committing build output.

**"Session" must be defined explicitly (ADR in P0).** The 2026-07-28 MCP protocol has no sessions, and one gateway process is not one conversation in every host (Claude Desktop keeps one process for many chats). Define a session per host, for example:
- Claude Code: the `session_id` from hooks, passed to the gateway via a per-session marker or a receipt id in tool results that the hook reads from the transcript
- Desktop and others: process lifetime plus an idle gap

Everything else depends on this definition: receipts, session-scope rules, the `sessions` table and the Stop-hook line.

**Upgrades and multiple installs.** The plugin, `.mcpb` and npx installs can run *different versions* against the same DB, and auto-updates happen while old processes are still running. Required:
- schema migrations under a lock, backward-compatible for one minor version
- a process that finds a newer schema than it knows switches to read-only and logs a clear message
- exactly one owner for background jobs such as list refreshes (lock + lease, so five gateways don't all refresh the 418k-rule list)
- `searchhole uninstall --purge` removes data, and `:unenforce` removes any deny rules the user added (see §9.1)

**Precompiled matchers.** Large lists (one seed list has ~418k rules) must not be parsed at every process start (target startup < 300 ms). Compile lists into a fast matcher (domain hash set/trie plus a separate regex set) when the list updates. Store it once (in SQLite or a versioned binary file) and load it lazily.

**API keys: one resolution order.** Hosts inject keys differently (Claude Code `userConfig`, MCPB `user_config`, plain env vars), and the CLI and dashboard cannot read host-injected values. Resolve keys in this order: host-injected env var → process env → search-hole's own store. For its own store, pick an approach that doesn't break the zero-native-deps goal: OS CLI tools such as `security`/`secret-tool`, a native keyring module, or an encrypted file; ADR. Gateways write **per-engine health and quota** to the DB, so the dashboard can show engine status even for keys it cannot see. Never display or log key values.

### MCP tool surface (keep it small)
| Tool | Purpose | Annotations |
|---|---|---|
| `search` | `query`, optional `depth` (`quick`/`standard`/`deep`), `profile`, `engines`, `freshness`. Returns kept results (title, url, snippet, date, source type), a hidden-count summary and a receipt id | readOnly, openWorld |
| `fetch` | Fetches a URL safely and returns readable text plus metadata (dates, source type). Refuses blocked domains and explains why | readOnly, openWorld |
| `receipt` | Receipt for the given `receiptIds` (default: this session's recent searches, per the session ADR) as text plus `structuredContent`. MCP App UI attached | readOnly |
| `suggest_rule` | Lets the model **propose** a rule ("this site looks like a content farm", or the user said "block pinterest"). It is queued for the user to approve in the dashboard, the in-chat panel or via a command, **never applied directly** | not destructive |
| *(app-only)* `apply_rule` | Used only by the in-chat panel's buttons after a user click. Declared with `_meta.ui.visibility: ["app"]` so **the model cannot call it** | — |

Rule changes the user makes directly are carried out by slash commands that call the CLI (`${CLAUDE_PLUGIN_ROOT}/bin/searchhole block pinterest.com`), by the dashboard, or by the panel buttons, so they come from the user's own action. Desktop users have no slash commands, so the panel and the dashboard are their controls. The `receipt` text should include the dashboard URL, and the gateway should be able to start the dashboard on demand. Keep the combined tool descriptions under ~1.5k tokens and measure it in CI.

**Output size limits:**
- `search` returns ≤ ~2.5k tokens at `standard`.
- `fetch` returns ≤ ~8k tokens per page, with pagination (`cursor`) for longer pages.
- **Over-fetch** from engines (e.g. 2–3× the requested count), so blocking still leaves enough results.

**Teaching the model to use it:** MCP server `instructions` (for every host), tool descriptions, and the Claude Code skill. Those three are the only places the model learns when to choose `quick` vs `deep`, to read receipt warnings, and to propose rules rather than claim it changed them.

### Data model (starting point)
`sessions` (client, client version, project dir, started), `searches` (session, query, profile, depth, engines, latency, counts), `results` (search, engine, rank, url, normalized_url, domain, title, date fields, decision kept/hidden/pinned, rule_id, list_id), `fetches` (url, status, redirects, dates found, source type, bytes), `receipts`, `rules` (scope global/project/session, match, action, weight, source list, created_by, ttl), `lists` (url, format, license, last_update, rule_count, enabled), `suggestions`, `engine_health`. Retention settings per table; per-engine retention follows the engine's terms (§5.2).

---

## 5. The search pipeline in detail

1. **Resolve context:** client, project (`.searchhole.yaml` if present), session, profile. Profile comes from an explicit argument, otherwise deterministic keyword and intent matching (e.g. a query containing package names or "docs" maps to `coding`). No LLM.
2. **Plan:** the depth preset sets queries × engines × results.
   - `quick` = 1 engine, top 10
   - `standard` = 2 engines, merged
   - `deep` = multiple engines, more results, and flags gaps such as "no official source found". The receipt then tells the model to dig further.
   - An "ask first" mode returns the plan for approval (Multi Round-Trip `input_required` where the client supports it; otherwise as text for the model to show the user).
3. **Push rules down** where the engine supports them *per request*, to save quota and get better results:
   - Brave: compile rules into an inline Goggle
   - SearXNG: its hostnames plugin is **instance config** (`settings.yml`), not per request. Only global rules can be compiled into it, and only for an instance search-hole manages (the bundled container), with a restart. Everything else is filtered locally.
   - Mojeek: `fi`/`fe`
   - Tavily/Exa: include/exclude domain arrays
   - freshness: engine date parameters
4. **Fan out** with per-engine timeouts, concurrency limits, health tracking and automatic suspension of failing engines (SearXNG does this well), plus a fallback chain.
5. **Normalize and dedupe:** canonical URL (lowercase host, strip `www.` where safe, strip tracking params, trailing slash, AMP and mobile variants), then group duplicates.
6. **Merge:** reciprocal rank fusion across engines, then apply local rule weights (lower, raise), then pins on top, then blocks removed. Record the decision and rule id for every result, *including hidden ones*.
   - Default meaning of weights (tune in an ADR): `raise N` multiplies the fused score by `1 + 0.15·N`, and `lower N` divides by it.
   - Pins sort above everything, in rule order.
7. **Freshness:** check each result against the profile's `maxAgeDays`. Results with unknown dates are flagged, not dropped, unless the profile says `requireDate`.
8. **Annotate:** source type (official/primary, docs, forum, news, blog, content farm, unknown), never an LLM in v1. Default order:
   1. membership in a typed list (e.g. `official-docs`, content-farm lists)
   2. domain and path patterns (`docs.*`, `developer.*`, `*.gov`, `github.com/<org>/<repo>/releases`, known forums)
   3. otherwise `unknown`

   Profile matching in step 1: an explicit `profile` argument wins; otherwise keyword and regex match on the query with first-match-wins in file order; otherwise `defaults`.

### 5.1 Failure behaviour (error UX matrix)
Define and test the user-visible behaviour for each case:
- **No healthy engine:** return a clear tool error naming the cause and `searchhole doctor`, and keep the Claude Code hook passthrough (§9.1).
- **One engine down:** fall back and note it in the receipt.
- **429 or quota exhausted:** back off, suspend the engine for a while, show it in the dashboard.
- **Machine offline:** fail fast.
- **Docker or SearXNG stopped:** point to `doctor`.
- **List update failed:** keep the last good list.
- **DB locked or newer schema:** read-only mode and still serve searches.

Add **per-engine spend caps** (daily/monthly query limits) so a looping agent can't run up a bill.

**SearXNG at agent volume:** upstream engines may rate-limit or CAPTCHA a busy SearXNG. Document it, keep per-engine health, and recommend a keyed engine for heavy use.
9. **Return** compact results to the model (text plus `structuredContent`) and write everything to SQLite.

### 5.2 Engines
| Engine | Default? | Notes (verified Oct 2026, re-check) |
|---|---|---|
| **SearXNG** (self-hosted, Docker) | **Default, no key** | Must enable `json` in `search.formats` or requests get 403. AGPL, but calling it over HTTP is fine. Ship a `compose.yaml` and a `searchhole doctor` check |
| **Brave Search API** | **Default keyed** | Free tier removed Feb 2026; $5/month credit (~1k queries), then $5 per 1k. `goggles` parameter, `freshness`, `page_age`. Storing results may require a storage-rights plan, so cache briefly |
| Kagi Search API | Optional | About $12 per 1k; applies the account's personalization. Check whether it's still preview |
| Tavily | Optional | 1k free credits/month. **Its terms forbid storing or caching results**, so log only what the terms allow (or decisions plus counts) |
| Exa | Optional | Gives `publishedDate`; only temporary caching allowed |
| Mojeek | Optional | Independent index; `fi`/`fe`, date params; cache allowance depends on plan |
| Marginalia | Optional | Small-web, non-commercial key |
| Serper / SerpApi | Optional | Google results; check terms |
| DuckDuckGo (`ddgs`-style scraping) | **Off; experimental at most** | No official API; terms and breakage risk |

Every adapter declares capabilities (domain filters, date filters, Goggles, published dates) and a **retention policy** that the store respects.

---

## 6. Rules, lists and profiles

### Canonical format: YAML
```yaml
# ~/.searchhole/rules.yaml  (global)   |  .searchhole.yaml (project, committable)
version: 1
defaults:
  engines: [searxng, brave]
  depth: standard
profiles:
  coding:
    match: { keywords: [docs, api, error, npm, pip, typescript, react] }
    prefer: { lists: [official-docs] }
    freshness: { maxAgeDays: 730, requireDate: false }
  prices-news:
    freshness: { maxAgeDays: 30 }
rules:
  - { match: pinterest.com, action: block }
  - { match: "*.medium.com", action: lower, weight: 3 }
  - { match: developer.mozilla.org, action: pin, profile: coding }
  - { match: "/.*-tutorial-.*\\.xyz$/", action: block }
subscriptions:
  - { name: seo-spam, url: https://…, format: ublacklist, update: 7d }
```
- **Actions:** `block`, `lower`, `normal`, `raise`, `pin` (Kagi's five levels) plus `allow` (an exception that beats list blocks). Weights 1–10. `important` overrides scope precedence.
- **Precedence (default; finalize in an ADR):**
  - Within a scope: `allow` > `block` > `pin` > `raise`/`lower`.
  - Across scopes: session > project > global > subscribed lists.
  - `important` lifts a rule above scope order.
  - **A user's `allow` always beats any list rule**, including a list's `$important`.
  - Document it as a table and cover it with property tests.
- **Regex safety:** regex rules (especially from subscribed lists) run on a linear-time engine (RE2-style, e.g. a WASM build) or are rejected, so a list can't cause ReDoS. Cap per-rule length and per-list rule count.
- **Refuse secrets** in rules files (as smart-doctor's profiles do). Keys go in env vars or the OS keychain only.

### Importers and compilers
- **Import:** Brave Goggles (`$boost=N`, `$downrank`, `$discard`, `site=`, wildcards, precedence rules), uBlacklist (match patterns, regex, `@` unblock), AdGuard/ABP network rules (`||d^`, `@@`, `$important`; skip cosmetic filters), hosts and plain-domain files, Pi-hole lists.
- **Compile:** Brave inline Goggle, SearXNG hostnames config, Mojeek `fi`/`fe`, Tavily/Exa domain arrays. Whatever can't be pushed down is filtered locally.
- **Lists:** store the URL, format, license, update interval, ETag/Last-Modified and rule count. Updates are atomic, with rollback if a list shrinks by more than 50% (default; a guard against bad or hijacked lists). Show each list's contribution in the dashboard ("removed 312 results this week").

### Seed lists
Check every license before bundling; link anything unlicensed instead of shipping it. See the Appendix: CC0, MIT, BSD and Apache lists can be bundled; GPL lists should be subscribed by URL, not bundled; Brave's public Goggles have no license, so link only. **Don't ingest Kagi's leaderboard** (no license or export).

First-party lists to create and own (this is the moat): `official-docs` (per ecosystem: MDN, docs.python.org, nodejs.org, react.dev, AWS docs…), `official-health` (NIH, NHS, CDC, WHO, Mayo), `github-clones`, `ai-content-farms`. Accept contributions only with evidence (see CONTRIBUTING, §12.6).

---

## 7. Source receipts

### Content
- Searches run (engine, latency, kept/hidden counts).
- Sources the model actually opened (the `fetch` calls). The gateway never sees the final answer, so it can't know which sources were cited. Say "opened", not "cited".
- Per source: publish and update date with confidence (and which method found it), source type, HTTP status and redirects, freshness verdict against the profile.
- Warnings: stale source, single source, no official or primary source, dead link, date unknown, blocked-domain attempt.
- A one-line summary for Claude Code: `6 searches · 41 results · 9 hidden · sources: 3 official, 2 blogs · ⚠ 1 stale (2022)`.
- An optional grade (A–F) from a published, deterministic rubric. Default inputs: share of stale sources, share of official/primary sources, single-source answers, dead links, unknown dates. Keep the rubric in the docs so it can be challenged.

### Date extraction, best first
1. Engine-provided dates (Brave `page_age`, Exa `publishedDate`, Tavily `published_date`, Mojeek `date`).
2. Page metadata: JSON-LD `datePublished`/`dateModified`, OpenGraph `article:*_time`, `itemprop`, `<time datetime>` (`metascraper-date` 5.58.4, MIT; check its published-vs-modified rule options).
3. HTTP `Last-Modified` (low confidence; dynamic sites send "now").
4. Sitemap `<lastmod>`.
5. Wayback CDX first capture (an "existed no later than" bound), opt-in because it is a third-party network call.
6. Optional later: a Python sidecar using `htmldate` (F1 ≈ 0.95 on its own benchmark) for higher accuracy.

### Where it appears
- MCP App panel (Claude, ChatGPT, VS Code).
- Text plus `structuredContent` from the `receipt` tool, and a short summary appended to `search` results.
- **Claude Code:** a `Stop` hook prints the one-line receipt as `systemMessage`, **only for turns that actually searched** (silent otherwise), with a setting to turn it off. The mapping from `session_id` to gateway rows follows the session ADR (§4).
- Dashboard page per session.

---

## 8. UI/UX: dashboard and in-chat panel

### 8.1 Bar to hit
Linear, Vercel or Raycast-level polish for a dense data tool:
- keyboard-first
- light, dark and system themes
- **WCAG 2.2 AA**
- smooth with 100k+ log rows
- **RTL-ready** (CSS logical properties) so Arabic can come later
- respects `prefers-reduced-motion`

### 8.2 Stack (versions verified 2026-10-29 on npm; re-check at start)
This is a researched starting point, not a set of pins. The versions were current on that date. Swap any layer if Phase 0 or real use shows something better (ADR). Keep the *number* of UI dependencies small. For example, if uPlot covers the overview charts well, don't add Recharts too.
| Layer | Choice | Version | Runner-up |
|---|---|---|---|
| Framework | React + React Compiler | react 19.3.1, compiler 1.0 | Svelte 5 + SvelteKit 3 |
| Build | Vite 8 (Rolldown) + `@vitejs/plugin-react` (`reactCompilerPreset`) | vite 8.3.5, plugin 6.1.2 | — |
| Routing / URL state | TanStack Router (typed search params) | 1.170.46 | — |
| Server state | TanStack Query + SSE for the live tail | 5.105.0 | — |
| Table | TanStack Table v9 | 9.3.1 | v8 |
| Virtualization | TanStack Virtual | 3.14.23 | react-virtuoso |
| CSS | Tailwind CSS v4 (tokens as CSS variables) | 4.3.3 | — |
| Components | shadcn/ui on **Base UI** (Base UI has been shadcn's default since Jul 2026) | shadcn CLI 4.23.0, @base-ui/react 1.9.0 | React Aria Components 1.22 (strongest grid a11y) |
| Charts, aggregate | shadcn charts (Recharts 3, `accessibilityLayer`) | recharts 3.10.1 | visx |
| Charts, live | uPlot (canvas, ~21 KB gzipped) | 1.6.32 | — (ECharts is too heavy) |
| Motion | CSS + View Transitions (Baseline); `motion` only for springs and layout | motion 14.7.1 | — |
| Command palette / toasts | cmdk + sonner (**avoid vaul, it's unmaintained**; use the Base UI Drawer) | cmdk 1.1.1, sonner 2.0.8 | Base UI Autocomplete |
| Hotkeys | `@tanstack/react-hotkeys` (beta) or `react-hotkeys-hook` (stable) | 0.17.0 / 5.3.3 | — |
| Type | Geist Sans + Geist Mono (mono for domains, URLs, counts) | geist 1.8.2 | Inter 4.1 with `tnum` |
| Icons | Lucide v1 | lucide-react 1.63.0 | Tabler |
| Server for the UI | Hono + `@hono/node-server` (also matches the MCP Hono adapter for v2) | 4.13.14 / 2.1.5 | — |
| QA | Playwright + axe; Storybook 10 with addon-a11y | 1.64.1, @axe-core/playwright 4.14.0, storybook 10.6.5 | Ladle |

Open-source dashboards in the same class mostly converge on this stack: Langfuse, Infisical and Dokploy all use React with Tailwind 4, Radix or Base UI, TanStack and Recharts. Study them in Phase 0.

### 8.3 Dashboard information architecture
**v1 (P4)** ships only: Live log, Rules & lists, Engines, Settings, plus a small Overview header. The rest (Sessions/receipts, Sources, Clients, Suggestions inbox) comes in P4b, after dogfooding shows what matters. Until then, suggestions can be approved from the Rules page.
- **Overview:** this week's searches, results hidden, top blocked domains, engines used, share of stale sources, list contributions. Uptime Kuma and Pi-hole calm.
- **Live log:** streaming table of searches, expandable to show the results with kept/hidden status and the rule that applied. Pauses on hover or scroll, with a "23 new" pill and batched updates.
- **Sessions / receipts:** per assistant session, full receipt, sources and dates.
- **Sources:** domain view, how often each domain was seen, kept or hidden, average age; actions block, lower, raise, pin, trust.
- **Rules & lists:** editor (YAML view plus form view), import (Goggles, uBlacklist, AdGuard, hosts), subscriptions with update status, precedence explainer, a "test a query" sandbox showing what would be hidden.
- **Engines:** key status (set or missing, and where it comes from; never the value), health, latency, quota and spend caps, capability matrix.
- **Clients:** Claude Code, Cursor, Codex, Desktop: last seen, active profile, per-client overrides (Tailscale machine-table style).
- **Suggestions inbox:** rules the AI proposed, waiting for approval.
- **Settings:** retention, privacy, theme, export and import, "delete all data".

### 8.4 UX principles
1. **Keyboard-first.** ⌘K palette plus single-key verbs on the selected row (`b` block, `t` trust, `p` pin, `l` lower, `r` raise, `?` cheat sheet). Don't animate actions used 100+ times a day.
2. **Every row explains itself.** Status chip plus the rule or list that fired, a one-click inverse, and **Undo instead of confirm dialogs** (Pi-hole v6 and NextDNS logs).
3. **Rules from observations.** Turn a row into a rule, scoped global, project or session, permanent or for a set time (Little Snitch).
4. **The URL is the state.** Filters, time range and the selected row live in typed search params, so views are shareable and restorable.
5. **Live but calm.** Batch updates, no layout jumps, skeletons rather than spinners.
6. **Data typography.** Mono for domains and URLs, tabular numbers, middle-truncated URLs, right-aligned counts.
7. **Color only for state,** and always as color plus icon plus word. Neutral chrome.
8. **Empty states teach.** The first run shows "connect your first client" steps and a live demo query.

### 8.5 In-chat receipt panel (MCP App)
- Stack: **Preact 11 (or vanilla TS)** + `@modelcontextprotocol/ext-apps` 2.0.4 + Vite 8 + `vite-plugin-singlefile` 2.3.4. Measured: vanilla about 58 KB gzipped, Preact about 64 KB, React about 129 KB. Budget **≤ 80 KB gzipped**.
- Inline card: 4–5 data points (searches, hidden, official sources, stale count, a grade) and at most 2 actions (e.g. "Open full receipt" for fullscreen, "Block a site…").
- Follow the host theme: transparent body, `<meta name="color-scheme" content="light dark">`, host variables and fonts; add `https://assets.claude.ai` to `resourceDomains` for Claude's font.
- Render only from tool-result data; actions go through `app.callServerTool`. No fetches to localhost (CSP blocks them).
- Fallback text for Claude Code and any host that doesn't render apps.

### 8.6 Design skills and tools to install in the building session
| Skill | Install | Use |
|---|---|---|
| **Impeccable** (pbakaus, ~90k★) | `npx impeccable install` or `/plugin marketplace add pbakaus/impeccable`; CI: `npx impeccable detect --json apps/dashboard/src` | Primary design QA. Tune its rules: it flags Inter, and we use Geist anyway |
| **Vercel web-design-guidelines** | `npx skills add vercel-labs/agent-skills --skill web-design-guidelines` | 100+ rules on a11y, focus, URL state, numbers; audit every screen |
| **shadcn skill + MCP** | `npx skills add shadcn/ui`; `npx shadcn@latest mcp init --client claude` | Correct component usage and registry |
| **MCP Apps skills** | `/plugin marketplace add modelcontextprotocol/ext-apps` then `/plugin install mcp-apps@modelcontextprotocol-ext-apps` | Building the receipt panel |
| **Emil Kowalski skills** (~46k★) | `npx skills@latest add emilkowalski/skills` | Motion and interaction polish (`emil-design-eng`, `review-animations`) |
| **Anthropic frontend-design** | `/plugin install frontend-design@claude-plugins-official` | Landing page and README visuals (it leans toward marketing pages) |
| **Playwright plugin** | `/plugin install playwright@claude-plugins-official` | Screenshots, flows, visual checks |
| Hallmark / UI UX Pro Max | Optional | Overlap with Impeccable; UI UX Pro Max is a style catalog more than a rigor tool, so skip unless needed |

Verify each install command when you start; these change.

---

## 9. Distribution

### 9.1 Claude Code plugin (primary, v1)
- Two-command install from the GitHub marketplace (as `orwa-mahmoud/nightshift` does).
- Bundles:
  - the MCP gateway (`.mcp.json` → `node ${CLAUDE_PLUGIN_ROOT}/dist/gateway.js`)
  - a **PreToolUse hook that fails open:**
    - it denies `WebSearch` (and `WebFetch`, once our `fetch` matches it on PDFs and long pages) **only while the gateway heartbeat in the DB shows a healthy engine**
    - otherwise it allows the call and adds `additionalContext` explaining why
    - strict blocking even when nothing works is opt-in via `/search-hole:enforce` (which can also write deny rules to the user's settings, with consent) and reversible via `/search-hole:unenforce`
    - with a path containing spaces (e.g. `personal dev`), quote every hook path
  - a **Stop hook** for the one-line receipt
  - slash commands (`/search-hole:block`, `:allow`, `:pin`, `:engine`, `:profile`, `:deep`, `:dashboard`, `:status`, `:enforce`, `:doctor`)
  - a short **skill** teaching good research: when to use `deep`, cite with dates, prefer official sources, read the receipt warnings
- `userConfig` for API keys (`sensitive: true`).
- An escape hatch to turn the hook off.
- `claude plugin validate --strict` in CI, plus **plugin evals** (e.g. "asked for React docs → uses `search`, opens react.dev, no Pinterest"). Define a metric before claiming a win, for example:
  - share of cases where every opened source is official or primary
  - zero blocked domains reached
  - stale-source rate vs the no-plugin baseline

### 9.2 Claude Desktop extension (v1)
`.mcpb` built with `mcpb pack`; `user_config` for keys (keychain); the same gateway bundle; signed if possible.

### 9.3 Codex, Cursor, others (v1.x)
- Root `plugin.json` + `mcp.json` (Agent Plugins standard) for Codex: **hookless** so it can be listed in the directory.
- `.cursor-plugin/plugin.json` + `mcp.json` + hooks.
- `npx search-hole setup` to write MCP config for VS Code, Windsurf, Zed, Goose and any generic MCP client.

### 9.4 CLI and npm
`npx search-hole search "react 19 compiler" --explain` works with no AI tool and is the fastest way to demo and debug. Publish to npm with provenance.

### 9.5 Remote connector (v2) and hosted (v3, only if demand)
- **v2:** the same gateway over Streamable HTTP (`createMcpHandler` + `@modelcontextprotocol/hono`), a Docker image plus `compose.yaml` (with SearXNG), and docs for tunnels. OAuth per §3: PRM, CIMD with `none` auth method, `iss`, S256, a fast token endpoint (well under 10 s), DCR only as fallback. Basel's smart-doctor work covers this OAuth territory; consider a `searchhole doctor --connector` check.
- **v3:** hosted connector as a paid option. Needs a privacy policy, per-user isolation, abuse controls and cost limits. Out of scope until users ask.

### 9.6 Browser extension (later)
Reads citations on ChatGPT, claude.ai and Perplexity pages and builds a receipt from them, because those apps' built-in search can't be routed. Separate project phase.

---

## 10. Phase 0: study the reference repos (clone and analyse)

**Goal:** choose the architecture from evidence, not taste. Time-box 1–2 days.

1. `mkdir -p research/refs && echo research/refs >> .gitignore`
2. Shallow-clone each repo (`git clone --depth 1 <url> research/refs/<name>`). If cloning is blocked in a cloud session, run this step on Basel's Mac or ask him to attach the repos.
3. Run **parallel subagents**, one per group of repos. For each repo write `docs/research/<name>.md` using this template:
   - purpose; architecture sketch; key modules and data flow; data model and storage; config format; extension points (plugins, hooks); how rules or lists are parsed and compiled; testing strategy; UX patterns worth copying (screens, interactions); performance tricks; **license and what that means for us**; borrow / avoid.
4. Write `docs/research/SYNTHESIS.md`: the comparison table and the decisions it implies. Then write ADRs for at least:
   - monorepo shape
   - runtime and packaging (Node vs standalone binaries; §4)
   - SQLite driver and access layer
   - dashboard process model
   - **definition of "session" per host**
   - upgrades, migrations and multi-install
   - key storage and resolution
   - rule format and precedence
   - engine adapter interface
   - merge algorithm and weights
   - date-extraction chain
   - MCP tool surface and output limits
   - dual-protocol support

**License hygiene (non-negotiable):** never copy code from GPL, AGPL or EUPL repos (Pi-hole, AdGuard Home, uBlock, SearXNG, and agent-search's `mcp-server/`) into this project. Learn the ideas and write our own code. Note licenses in each research file.

### Repos to study
| Group | Repo | License | Study for |
|---|---|---|---|
| Blocklist + dashboard | `pi-hole/pi-hole`, `pi-hole/web`, `pi-hole/FTL` | **EUPL-1.2** | v6 embedded REST API (no lighttpd/PHP), "gravity" compiled list DB, query log UX, single TOML config |
| | `AdguardTeam/AdGuardHome` | **GPL-3.0** | per-client rules, "blocked by rule X" log, rule syntax, single binary, new Solid client_v2 |
| | `gorhill/uBlock` | **GPL-3.0** | filter compilation, list update intervals, `badfilter`, element-picker idea |
| | `iorate/ublacklist` | MIT | subscription and sync model, rule syntax |
| Search | `searxng/searxng` | **AGPL-3.0** | engine adapters, timeouts and suspension, result merging, hostnames plugin |
| | `brave/goggles-quickstart`, `brave/brave-search-skills` | none / MIT | Goggles syntax and precedence; skill design |
| | `ItzCrazyKns/Vane` (Perplexica) | MIT | bundled SearXNG, cited-source UI |
| Search MCPs | `spences10/mcp-omnisearch`, `yokingma/one-search-mcp`, `brcrusoe72/agent-search` | MIT (agent-search `mcp-server/` **AGPL**) | tool consolidation, key-less provider skipping, private-network guard, domain trust scoring |
| Gateways / policy / audit | `BerriAI/litellm` | MIT (except `enterprise/`) | fallback chains, per-request spend logs, callback hooks |
| | `agentgateway/agentgateway` | Apache-2.0 | policy engine (CEL), OpenTelemetry |
| | `IBM/mcp-context-forge` | Apache-2.0 | plugin and guardrail pipeline, log viewer |
| | `stacklok/toolhive` | Apache-2.0 | audit logs, registry with provenance |
| | `docker/mcp-gateway` | MIT | shareable profiles, call tracing |
| Observability UI | `langfuse/langfuse` | MIT (except `ee/`) | trace/span UI, table patterns |
| | `louislam/uptime-kuma` | MIT | live dashboard polish, one-command self-host |
| | `mitmproxy/mitmproxy` | MIT | flow inspector, replay, addon hooks |
| MCP tooling | `modelcontextprotocol/inspector`, `MCPJam/inspector` | MIT→Apache / Apache (check `server/services`) | shared core across UIs, token-protected local proxy, JSON-RPC log view |
| MCP Apps | `modelcontextprotocol/ext-apps` (examples) | check | panel patterns, theming, bundling |
| Plugin packaging | `orwa-mahmoud/nightshift` | MIT | multi-host manifests, no-server install, hooks as gates, file-based state |
| Modern dashboards (UI code) | `Infisical/infisical`, `Dokploy/dokploy`, `supabase/supabase` (studio) | check | React 19 + TanStack + Base UI/Radix + Recharts patterns |
| Basel's own | `smart-doctor` (local, `~/Documents/personal dev/smart-doctor`; not reachable from a cloud session unless attached) | MIT | **Local UI security:** binds 127.0.0.1, random session token in the URL, Host-header allowlist against DNS rebinding, strict CSP, SSE for live updates, fonts bundled. **Testing:** a mock server with named failure modes driven by end-to-end tests, no network in CI. **Explanations:** failures map to *ranked causes* with "why" and "fix" text kept as data. **Run event bus:** an `AsyncLocalStorage`-scoped emitter (`step:start/end`, `http`, `done`) that CLI, UI and JSON reporters all consume. **Redaction at source:** secrets are scrubbed before anything is recorded. **Standalone binaries** via `bun build --compile` |

**Design references** (closed source, study screenshots): Linear, Vercel dashboard (Geist), Raycast action panel, Pi-hole v6, NextDNS logs, Little Snitch, Tailscale admin, PostHog, Grafana.

---

## 11. Delivery phases with acceptance criteria

Commit after every meaningful step (conventional commits). Keep a `STATUS.md` checklist current.

### P0: research and decisions (§10)
- [ ] Name is decided (search-hole, see top of file). Check GitHub and domain availability, and reserve both `search-hole` and `searchhole` on npm.
- [ ] Research notes, SYNTHESIS and ADRs written; ARCHITECTURE.md drafted.

### P1: core engine + CLI (no AI needed)
- [ ] Rules engine with YAML loader, scopes, precedence, `allow`, `important`; property tests (fast-check) for precedence and idempotence.
- [ ] Engine adapters: SearXNG and Brave, with capability flags, pushdown compilers, timeouts, health and fallback.
- [ ] Normalize, dedupe, RRF merge, freshness, source typing.
- [ ] Safe fetcher (§12.4) and date-extraction chain.
- [ ] SQLite store with migrations, WAL, retention.
- [ ] `searchhole search "<q>" --explain` shows kept and hidden results with reasons; `searchhole doctor` checks engines and keys.
- **Accept:** works against a local mock-engine server with fixtures and **no network in CI**, and live against SearXNG in Docker.

### P2: MCP gateway
- [ ] SDK v2 (`serveStdio`), tools `search`, `fetch`, `receipt` with `outputSchema`, annotations, compact descriptions (token budget test).
- [ ] Session tracking and logging.
- [ ] **Spike first: dual-protocol support.** Claude Code speaks `2026-07-28`, but Claude Desktop, Cursor and Codex may still speak 2025-era MCP. Find out what each target host speaks today, and make the gateway serve both if needed (the SDK has a legacy path). This is a requirement, not either/or.
- **Accept:** end-to-end test with `@modelcontextprotocol/client` spawning the gateway; works in MCP Inspector and MCPJam; verified connection from each target host (or the gap is documented with a workaround).

### P3: Claude Code plugin
- [ ] Marketplace and plugin manifests, `.mcp.json`, PreToolUse deny hook, Stop-hook receipt line, slash commands, research skill, `userConfig` keys.
- **Accept:** clean `claude plugin validate --strict`; plugin evals pass and beat the no-plugin baseline on the defined metric; Basel installs from the local marketplace in under 2 minutes; the hook fails open when no engine is healthy.
- **Dogfooding starts here,** not at P8. Basel uses the CLI and plugin daily from now on. Log misses in `docs/dogfood.md` and let them drive P4–P6 priorities.

### P4: dashboard v1
- [ ] Live log, Rules & lists (including suggestion approval), Engines, Settings, plus a small Overview header (§8.3).
- [ ] P4b, after dogfooding: Sessions/receipts, Sources, Clients, Suggestions inbox, Storybook coverage, RTL pass.
- **Accept (v1 screens):**
  - axe has no serious or critical violations
  - full keyboard path
  - light and dark screenshots reviewed (RTL in P4b)
  - all web-sourced text (titles, snippets, URLs) is rendered as text, never as HTML (no `dangerouslySetInnerHTML`), with an XSS test using hostile titles
  - 100k-row log scrolls at 60 fps on a mid-range laptop
  - Impeccable detect and Vercel guidelines audit are clean or the exceptions documented
  - the dashboard is localhost-only, with session token, Host-header check and strict CSP (reuse smart-doctor's approach)

### P5: in-chat receipt panel + Claude Desktop extension
- [ ] MCP App panel within budget; theming from the host; fullscreen receipt; `callServerTool` actions.
- [ ] `.mcpb` build with keychain-backed keys.
- **Accept:** renders in Claude Desktop, and in VS Code if available; text fallback in Claude Code. claude.ai on the web can only use it through the v2 remote connector. The panel's buttons work only through the app-only `apply_rule` tool.

### P6: lists ecosystem
- [ ] Importers (Goggles, uBlacklist, AdGuard/ABP, hosts) with golden tests and fuzzing; subscriptions with update intervals, ETags and the shrink guard.
- [ ] First-party lists (`official-docs`, `official-health`, `github-clones`, `ai-content-farms`) plus a curated catalog of third-party lists with licenses.
- **Accept:** import of every seed list passes; dashboard shows each list's contribution.

### P7: more clients
- [ ] Codex (hookless) and Cursor manifests; `npx search-hole setup` for other MCP clients; docs per client.
- **Accept:** a fresh install on each listed client runs a search that shows up in the dashboard, following only the docs. Validators pass where the platform has one.

### P8: release engineering and launch
- [ ] CI (lint, typecheck, test, e2e, a11y, bundle-size, token-budget, plugin validate and evals), release automation, npm provenance, SBOM, signed tags, OpenSSF Scorecard, CodeQL, Renovate.
- [ ] README with a hero GIF and a 60-second quickstart per client; docs site optional.
- [ ] **Dogfood gate:** at least 2 weeks of daily use since P3, with no open P0/P1 issues in `docs/dogfood.md`.
- [ ] CI runs on Linux, macOS **and Windows** (hooks via `.cmd`/PowerShell shims or Node scripts; paths with spaces; keychain fallbacks).
- **Accept:** a tagged release installs cleanly from the public marketplace, npm and the `.mcpb` asset on all three OSes; uninstall with `--purge` leaves nothing behind; the README quickstart works for a newcomer exactly as written.
- [ ] Launch: Show HN, r/selfhosted, r/ClaudeAI, r/LocalLLaMA, the Claude/Cursor/Codex plugin directories (Codex = hookless variant), awesome-mcp lists, plus a Medium and LinkedIn write-up by Basel.

### Later
v2 remote connector + Docker (§9.5) · browser extension (§9.6) · prompt-injection flags in receipts (hidden text, Unicode tag characters, instruction-like content in fetched pages) · opt-in AI source classification · team policies · hosted option.

---

## 12. Engineering standards and quality bar

### 12.1 Tooling (verified 2026-10-29; re-check)
- **Runtime:**
  - Develop on Node 26 (LTS from late Oct 2026; check its exact status).
  - Support at least Node 22 and 24 (both still in security maintenance).
  - Desktop bundles its own Node.
- **Language and build:** TypeScript 7.0 (native compiler), `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Bundle with `tsdown` 0.23 (runner-up `tsup` 9).
- **Monorepo:** pnpm 12 workspaces.
- **Lint and format:** Biome 2.6 (or ESLint 10 if a needed rule is missing; ADR). Dead-code check with `knip`.
- **Tests:** Vitest 5, fast-check 4, Playwright 1.64 + `@axe-core/playwright`, Storybook 10 + addon-a11y.
- **Libraries:** zod 4.6 (Standard Schema, matching SDK v2), Hono 4.13, pino 10, undici 8, yaml 2.9.
- **Releases:** `@changesets/cli` 3 or release-please 17.

### 12.2 Code standards
- Ports and adapters: a pure core with I/O at the edges. Dependency injection through plain factories, not a DI framework.
- Typed errors with codes and user-facing explanations (as smart-doctor's ranked causes do).
- No `any`; validate all external input (MCP args, configs, lists, engine responses) with zod.
- Structured logs (pino) with redaction of keys, tokens and query parameters named like secrets. **Never log API keys.**
- Small modules with docs on public functions. ADRs for every non-obvious decision.

### 12.3 Testing strategy
- **Unit + property:** rules precedence, URL normalization, merging, freshness, importers (golden files plus fuzzing).
- **Contract tests per engine:** recorded fixtures plus schema checks; a nightly optional live check with keys.
- **Mock engine server** (like smart-doctor's mock EHR) with scenarios: slow engine, 429, quota exhausted, malformed JSON, empty results, duplicate-heavy results, pages without dates, redirect chains, SSRF attempts, hostile titles (XSS), ReDoS-style list rules, a list that suddenly shrinks, two gateway versions sharing one DB, offline mode.
- **MCP end-to-end:** spawn the gateway, call tools, assert `structuredContent` against `outputSchema`.
- **Plugin evals** (`claude plugin eval`).
- **UI:** Playwright flows, axe, visual snapshots in light, dark and RTL, keyboard-only runs.
- **Performance:** gateway overhead under 50 ms p95 on top of engine latency; dashboard with 100k rows; startup under 300 ms.
- **CI budgets:** token budget for tool descriptions (≤ ~1.5k tokens), MCP App bundle ≤ 80 KB gzipped, dashboard initial JS ≤ ~250 KB gzipped (revise in an ADR if needed).

### 12.4 Security
- **Safe fetching:**
  - block private, reserved and link-local IPs at DNS-lookup time on every redirect hop (`request-filtering-agent` with `got`, or an undici `connect.lookup` with `ipaddr.js`; Node's built-in `fetch` alone is not enough)
  - http/https only
  - size and time caps, 1–2 concurrent requests per host
  - `robots-parser`, with robots cached for at most 24 h
  - an honest user agent with the repo URL
- **Dashboard:** bind to 127.0.0.1 only, random session token, Host-header allowlist (stops DNS rebinding), strict CSP, no CORS.
- **Prompt injection:**
  - Fetched pages and results are untrusted.
  - The model can never change rules directly, only `suggest_rule` into the inbox.
  - Panel actions use an app-only tool the model can't see.
  - Mark external content clearly in tool output.
  - Later, flag hidden or instruction-like content in receipts.
- **Project config is untrusted.** A `.searchhole.yaml` arriving with a cloned repo applies only after the user approves its content hash (`searchhole trust`, re-prompted when it changes). It can never set engine endpoints, keys or subscription URLs, only rules and profiles. Otherwise a malicious repo could send your queries to an attacker's SearXNG or pin attacker sites.
- **Query hygiene:** agent queries can contain code, internal hostnames, ticket IDs or secrets.
  - Scan queries for secret-like patterns (tokens, keys, connection strings) and internal hostnames before sending them to any engine.
  - By default, block and explain, with a per-rule override.
  - Apply the same redaction before logging.
- **XSS:** titles, snippets and URLs from the web are rendered as text everywhere (dashboard and panel).
- **Files:** DB and config files are `0600`; the data dir is `0700`.
- **Lists:** HTTPS only, shrink guard, optional checksum pinning; a hijacked list must not be able to block everything silently.
- **Secrets:** env vars or the OS keychain only. Config files refuse secrets.
- Write SECURITY.md and a threat model in `docs/security/threat-model.md`.

### 12.5 Privacy and legal
- No telemetry. PRIVACY.md lists exactly what is stored and where, with retention controls and "delete all data".
- Per-engine terms enforced in code (retention policy per adapter).
- License: MIT or Apache-2.0 (Basel decides; Apache adds a patent grant). Keep NOTICE and third-party licenses for bundled lists.
- Trademarks: don't use the Pi-hole, Brave or Kagi names or logos in branding; describing compatibility ("imports Brave Goggles") is fine.

### 12.6 Docs and community
- README, ARCHITECTURE.md, `docs/adr/`, `docs/guides/` (one per client), CONTRIBUTING.md, SECURITY.md, PRIVACY.md, CHANGELOG.md, CODE_OF_CONDUCT.md, issue and PR templates.
- **List contributions** need evidence: a public link showing the site is spam, a clone or official, plus a license for the content. No NDA'd or private information.
- `good first issue` labels on list and importer work.

---

## 13. Decisions Basel must make early
1. **Name:** decided: **search-hole** (package, repo, plugin) with `searchhole` as the command (see top of file). Remaining: check GitHub and domain availability and reserve both npm names.
2. **License:** MIT (like smart-doctor) or Apache-2.0.
3. **Default engines and first run:** Docker is *not* guaranteed, so the first-run path must work without it:
   - SearXNG via Docker if Docker is present
   - otherwise `doctor` offers Brave (paste a key; $5 monthly credit) or a no-key, no-Docker fallback (e.g. Marginalia's shared public key for non-commercial use, or an explicitly experimental DuckDuckGo adapter)

   Basel decides which no-key fallback is acceptable.
4. **Where to host the repo** when it goes public (personal GitHub, as smart-doctor is).

Everything else, the builder decides through ADRs.

---

## 14. Ground rules for the building session
- Work in `~/Documents/personal dev/search-hole/`. `git init` on `main`, and commit after each meaningful step with conventional commits. **Local only: no remote and no push unless Basel asks.**
- Never read, print or commit secrets or keys. Engine keys come from env vars or the keychain.
- Keep it free of any employer code, data or endpoints.
- Verify versions and platform facts at the start of each phase; this plan's facts are from 2026-10-29.
- Prefer the simplest design that meets the bar. Deviate from this plan whenever you find a better path, and write the ADR.
- Ask Basel only for decisions in §13 or anything irreversible. Otherwise decide, note it in STATUS.md, and keep going.
- Show progress through working software: after P1 a CLI demo, after P3 a real Claude Code session, after P4 screenshots.

---

## 15. Appendix

### A. Versions verified on npm (2026-10-29)
`@modelcontextprotocol/server` 2.4.0 · `@modelcontextprotocol/ext-apps` 2.0.4 · `@anthropic-ai/mcpb` 2.1.2 · typescript 7.0.2 · @biomejs/biome 2.6.3 · eslint 10.13.0 · vitest 5.0.5 · @playwright/test 1.64.1 · @axe-core/playwright 4.14.0 · fast-check 4.10.2 · zod 4.6.7 · hono 4.13.14 · @hono/node-server 2.1.5 · pino 10.4.0 · undici 8.12.3 · ipaddr.js 2.5.0 · yaml 2.9.1 · pnpm 12.16.1 · tsdown 0.23.3 · tsup 9.0.0 · @changesets/cli 3.0.3 · release-please 17.11.2 · knip 6.43.0 · better-sqlite3 13.0.3 · drizzle-orm 0.45.4 · kysely 0.29.7 · metascraper-date 5.58.4 · robots-parser 3.0.1 · react 19.3.1 · vite 8.3.5 · @vitejs/plugin-react 6.1.2 · @tanstack/react-router 1.170.46 · @tanstack/react-query 5.105.0 · @tanstack/react-table 9.3.1 · @tanstack/react-virtual 3.14.23 · tailwindcss 4.3.3 · shadcn 4.23.0 · @base-ui/react 1.9.0 · recharts 3.10.1 · uplot 1.6.32 · motion 14.7.1 · cmdk 1.1.1 · sonner 2.0.8 · geist 1.8.2 · lucide-react 1.63.0 · storybook 10.6.5 · preact 11.1.0 · vite-plugin-singlefile 2.3.4.

### B. Seed lists (check licenses again before bundling)
| List | Rules | License | Updated | Use |
|---|---|---|---|---|
| NotaInutilis/Super-SEO-Spam-Suppressor | ~418k | WTFNMFPL (permissive) | 2026-10-28 | subscribe |
| laylavish/uBlockOrigin-HUGE-AI-Blocklist | ~1.7k | CC0 | 2025-10-02 | bundle or subscribe |
| alvi-se/ai-ublock-blacklist | ~2.8k | **GPL-3.0** | 2026-10-28 | subscribe only |
| popcar2/BadWebsiteBlocklist | ~420 | CC0 | 2026-10-10 | bundle or subscribe |
| quenhus/uBlock-Origin-dev-filter (SO/GitHub clones) | ~625 | Unlicense | 2025-04-24 | bundle or subscribe |
| arosh/ublacklist-stackoverflow-translation | ~139 | CC0 | 2025-07-26 | bundle |
| arosh/ublacklist-github-translation | ~35 | CC0 | 2025-07-26 | bundle |
| rjaus/ublacklist-pinterest | ~50 | CC0 | 2025-02-23 | bundle |
| elliotwutingfeng/SpamdexingSites | ~3.7k | BSD-3 | 2026-01-29 | subscribe |
| insomnimus/seo-garbage | ~260 | Apache-2.0 | 2026-10-27 | subscribe |
| ncaq/uBlacklistRule (JP tech spam) | ~7.8k | MIT | 2026-09-27 | subscribe |
| danny0838/content-farm-terminator | ? | repo GPL-3.0 / lists "mostly MIT" | 2026-07-27 | check before use |
| Brave public Goggles (copycats_removal, no_pinterest, tech_blogs…) | — | **none** | 2026-04-22 | link only |
More: ublacklist.github.io/rulesets. Avoid wdmpa/content-farm-list (no license, stale).

### C. Key sources
- MCP spec 2026-07-28 changelog and GA post: github.com/modelcontextprotocol/modelcontextprotocol
- TypeScript SDK v2: github.com/modelcontextprotocol/typescript-sdk (`docs/protocol-versions.md`, migration codemod)
- MCP Apps: github.com/modelcontextprotocol/ext-apps; claude.com/docs/connectors/building/mcp-apps/ (getting started, design guidelines, transparent theming)
- Claude Code: code.claude.com/docs/en/plugins-reference, marketplace-reference, plugin-evals, hooks, permissions, skills
- MCPB: github.com/modelcontextprotocol/mcpb
- Claude connectors: claude.com/docs/connectors/custom/remote-mcp, claude.com/docs/connectors/building/authentication, claude.com/docs/connectors/building/troubleshooting
- Codex plugins: developers.openai.com/codex/plugins/build; ChatGPT MCP Apps: developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- Cursor plugins: cursor.com/docs/reference/plugins · Agent Skills: agentskills.io
- Brave Search API pricing and Goggles: api-dashboard.search.brave.com, github.com/brave/goggles-quickstart
- Tavily terms: tavily.com/policy · Exa pricing and terms: exa.ai/docs · Mojeek API: mojeek.com/support/api · Kagi API: help.kagi.com/kagi/api/search.html
- AdGuard DNS filtering syntax: adguard-dns.io/kb/general/dns-filtering-syntax · uBlacklist: ublacklist.github.io/docs
- React 19.3: react.dev/blog · Vite 8: vite.dev/blog/announcing-vite8 · shadcn Base UI default: ui.shadcn.com/docs/changelog · TanStack Table v9: tanstack.com/blog
- Design skills: github.com/pbakaus/impeccable, github.com/vercel-labs/web-interface-guidelines, ui.shadcn.com/docs/skills, github.com/emilkowalski/skills, github.com/anthropics/skills
- Competitor context: help.kagi.com (personalized results), mcp-omnisearch, one-search-mcp, agent-search, Vane, SearXNG
