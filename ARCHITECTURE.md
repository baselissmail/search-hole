# search-hole architecture

search-hole is a local search gateway for AI assistants. It works in two ways:

- **With an engine:** the assistant calls our MCP tools instead of its built-in web search. We send the query to engines the user chose, apply the user's rules and lists, and give the assistant compact results.
- **With no engine, in Claude Code only:** Claude's own WebSearch runs, and hooks apply the user's rules to it: blocked sites are left out of the search, and its results are filtered and reordered. This is the default.

Either way, every search is logged to a local SQLite file, and a **receipt** describes what was searched, hidden and opened.

This page is the map. The reasons behind each choice live in the [ADRs](docs/adr/README.md), and the evidence in [docs/research/](docs/research/SYNTHESIS.md).

## Processes

```text
 Claude Code ─┐                                  ┌─► SearXNG (local Docker, 127.0.0.1)
 Cursor ──────┤  stdio MCP, one gateway process  ├─► Tavily / Brave (HTTPS, user keys)
 Codex, Zed ──┤  per host connection             │
 VS Code ─────┤  (2025-era or 2026-07-28 MCP)    │
 Claude Desktop (.mcpb, Desktop's bundled Node) ─┘
        │                     │
        │ mcp_tool hooks      ▼
        │ (Claude Code) ──► gateway ──► core pipeline ──► engines
        │                     │
        │                     ▼
        │            SQLite (WAL) in the data root ◄──── searchhole CLI
        │                     ▲
        │                     │ rowid tail → SSE
        └──── /search-hole:dashboard ──► searchhole ui (127.0.0.1:7341, on demand)
```

- **No daemon.** Every gateway writes SQLite directly, and SQLite is the only shared medium. The dashboard is a separate, single-instance process that the user starts. It tails new rows and pushes them to the browser. → [ADR-0004](docs/adr/0004-dashboard-process-model.md)
- **Many gateways at once is normal.** A host may run several copies plus a probe. Startup has no side effects until the first real tool call. → [ADR-0006](docs/adr/0006-upgrades-migrations-multi-install.md), [ADR-0013](docs/adr/0013-dual-protocol-support.md)
- **One artifact.** `packages/search-hole/dist/` (a Node ≥ 22.19 bundle with no `node_modules` and no native modules) is the CLI, the stdio gateway (`searchhole mcp --host <profile>`) and the dashboard server. → [ADR-0002](docs/adr/0002-runtime-and-packaging.md)

## Code layout

```text
packages/search-hole/src/
  core/       pure: rules engine, canonical URLs, merge (RRF), freshness, source typing,
              query hygiene, date parsing. No I/O. Deterministic.
  lists/      pure parsers and compilers: YAML rules, uBlacklist, ABP/AdGuard, hosts, Goggles;
              the first-party lists and the catalog
  engines/    adapters: pure buildRequest / parseResponse per engine + capability tables
              (SearXNG, Brave, Tavily)
  store/      SQLite driver port (node:sqlite), migrations, typed queries, retention
  fetch/      safe fetcher: SSRF guard, robots, limits, readable text, page dates
  app/        the use cases, where the pure layers meet I/O: search, fetch, filtering of the
              built-in search, rules, lists, receipts (app/receipts.ts), suggestions, doctor
  gateway/    MCP server (SDK v2): tools, host profiles, hook bridge, rule-change guard
  ui/         Hono server for the dashboard: auth, REST, SSE tail
  cli/        commands: search --explain, doctor, rules, lists, keys, searxng, setup, ui, uninstall
  shared/     settings and paths, key storage, errors, logging (pino → stderr), types
apps/dashboard/     React SPA (copied into dist/ui/)
apps/receipt-app/   MCP App panel (a single HTML file, copied into dist/panel/)
distribution/       host manifests and plugin sources: claude-plugin, claude-desktop (.mcpb),
                    codex, cursor-plugin; the build assembles them into marketplace/ and out/
lists/              first-party lists as text (CC0-1.0); vendor/ holds the third-party starter lists
```

`core`, `lists` and `engines` are pure. They may import only themselves, `core`, `shared/types`, `shared/errors` and a short allowlist of pure packages. A CI check enforces it. → [ADR-0001](docs/adr/0001-monorepo-shape.md)

## A search, step by step

1. **Context.** The host profile, the session key (hook-reported, host `_meta`, spawn env, or a fallback label) and the project directory are resolved per request. The project directory locates `.searchhole.yaml`, which applies only after the user has trusted its content hash. → [ADR-0005](docs/adr/0005-session-definition.md), [ADR-0008](docs/adr/0008-rule-format-and-precedence.md)
2. **Hygiene.** A query that looks like it contains a secret is refused and explained, never sent. Private addresses and internal hostnames are cut out of the query by default (`queryHygiene.hosts: redact`), and the rest is searched. → [ADR-0015](docs/adr/0015-settings-data-locations-retention.md)
3. **Plan.** The profile is chosen from the argument or keywords, and the depth sets engines × results. Settings come from `settings.yaml`. A model argument can only *tighten* freshness.
4. **Fan-out.** Healthy engines are called concurrently, each through a pure request builder and an origin-pinned transport. Spend caps are reserved first. Engine errors become data (error classes), and health is shared in SQLite. Billed engines may receive only *block* rules (pushdown). → [ADR-0009](docs/adr/0009-engine-adapter-interface.md)
5. **Decide visibility per original URL.** The tier walk runs in this order: important rules → session → project → global → lists. User tiers beat every list. Each hidden result is recorded with its rule and its raw rank. → [ADR-0008](docs/adr/0008-rule-format-and-precedence.md)
6. **Merge.** Canonical-URL dedupe, then reciprocal rank fusion (k = 20) over raw ranks, then `raise`/`lower` multipliers, then pins on top, then freshness (hide stale results, flag unknown dates), then the deep-coverage rule. → [ADR-0010](docs/adr/0010-merge-algorithm-and-weights.md)
7. **Annotate.** Source type comes from typed lists and URL patterns. Dates come from engines, with method and confidence. → [ADR-0011](docs/adr/0011-date-extraction-chain.md)
8. **Respond and record.** The assistant gets compact text within a token budget plus object-root `structuredContent` with a `receiptId`. One `BEGIN IMMEDIATE` transaction logs the search, its results and its decisions; logging never blocks the response. Storage follows each engine's terms (for example, Brave stores decisions only). → [ADR-0012](docs/adr/0012-mcp-tool-surface-and-output-limits.md), [ADR-0003](docs/adr/0003-sqlite-driver-and-access-layer.md)

`fetch` follows the same shape. It applies the SSRF guard on every redirect hop, re-checks rules against the final URL, and extracts readable text with a cursor plus typed page dates.

## Model-facing surface

| Tool | Who sees it | What it does |
|---|---|---|
| `search` | model | the pipeline above |
| `fetch` | model | safe page fetch |
| `receipt` | model + MCP App panel | receipts; renders the panel where the host supports it |
| `suggest_rule` | model | queues a proposal; the **user** approves it |
| `apply_rule` | panel only (`visibility: ["app"]`, HMAC token) | panel buttons |
| `hook` | Claude Code hooks only (`visibility: ["app"]`) | turn bracketing, filtering of the built-in WebSearch and WebFetch, the rule-change guard, the Stop receipt line |

The server's instructions to the model depend on the host and on whether an engine is set up (a guess made once at start-up, from the environment and file names only). In Claude Code with no engine, the model is told to use its built-in web search, which the hooks filter, and not to call `search` first. In every other host it is told to use `search` and `fetch`, and to tell the user how to add an engine if none is set up; search-hole can't filter those hosts' own search and doesn't say it does. Only the engines that have adapters are offered: `searxng`, `brave` and `tavily`.

**No tool or command gives the model a way to change rules** (Principle 3):
- no model-visible tool writes rules;
- slash commands that change rules are user-only skills;
- in Claude Code, a PreToolUse guard denies Bash, Edit, Write and NotebookEdit calls that run our rule-changing CLI verbs, start the dashboard (`searchhole ui`), or write our files.

The guard is defence in depth, not a boundary. A model with a shell runs as the user: it can obfuscate a command, and it can read search-hole's files.

→ [ADR-0012](docs/adr/0012-mcp-tool-surface-and-output-limits.md), [ADR-0014](docs/adr/0014-claude-code-hook-integration.md)

## Claude Code integration

Today the plugin is built from a checkout: `scripts/build-plugin.mjs` assembles it into `distribution/marketplace/search-hole/`, the local marketplace `search-hole-local`. Nothing is released yet. The plan for releases is the marketplace `archive` source, a pinned GitHub Release zip, so that installing needs no build. The plugin contains:
- **`.mcp.json`**, which launches `node …/dist/searchhole.mjs mcp --host claude-code`.
- **Hooks on five events** (`hooks/hooks.json`). All but the preflight are `mcp_tool` hooks answered by the gateway itself, so no process starts per hook:
  - **SessionStart:** a shell-form preflight that tells the user if Node is missing, then a hook that keys the session (and re-keys it after `/clear`, a resume or a compaction).
  - **UserPromptSubmit** opens a turn.
  - **PreToolUse**, four matchers:
    - `WebSearch|WebFetch`: for a search, query hygiene and the loop limits run first. Then the mode decides. In the default setup (no engine) and in `builtin` mode, the search is rewritten, not denied: the user's blocked domains are added to its `blocked_domains`. When search-hole's engines are in use (`auto` with a healthy engine, or `engines` until every engine has failed), WebSearch is denied with a message that steers the model to `search`. A WebFetch of a blocked site is denied.
    - `Bash`, `Edit|Write|MultiEdit` and `NotebookEdit`: the rule-change guard.
  - **PostToolUse**, two matchers: `WebSearch` (the results are filtered and reordered by the user's rules, and the search is logged) and `WebFetch` (the opened page is recorded for the receipt).
  - **Stop** closes the turn and prints a one-line receipt if the turn searched.

  Every hook fails open: if the gateway doesn't answer, the tool call goes ahead unchanged and no receipt line appears.
- **Skills** for the slash commands and research guidance.

→ [ADR-0002](docs/adr/0002-runtime-and-packaging.md), [ADR-0014](docs/adr/0014-claude-code-hook-integration.md), [ADR-0017](docs/adr/0017-first-run-and-default-engines.md)

## Data

| Where | What |
|---|---|
| `<config>/rules.yaml` | the user's global rules, profiles and list subscriptions (comments preserved, atomic writes) |
| `<config>/settings.yaml` | engines, caps, fallback, retention, UI, hooks, query hygiene (never set by project files) |
| `.searchhole.yaml` (project) | project rules and profiles; applies only after `searchhole trust` |
| `<data>/searchhole.db` | SQLite WAL: searches, results, decisions, receipts, sessions, health, usage, jobs, suggestions |
| `<data>/lists/` | versioned, checksummed compiled list artifacts |
| `<data>/searxng/` | the settings overlay (`settings.yml`) of the managed SearXNG container |
| `<run>/ui.json` | dashboard discovery (port, nonce, login secret; `0600`) |
| OS keychain / Secret Service / DPAPI | engine API keys (or environment variables) |

**Roots:**
- macOS: `~/.searchhole/`
- Linux: XDG directories
- Windows: AppData
- anywhere: `SEARCHHOLE_HOME` overrides

Retention defaults to 90 days, with engine payloads kept per their terms. → [ADR-0015](docs/adr/0015-settings-data-locations-retention.md), [ADR-0007](docs/adr/0007-key-storage-and-resolution.md)

**Upgrades:**
- migrations are forward-only, run by one elected process as a background job;
- an older binary facing a newer schema switches to read-only and keeps serving searches;
- background jobs are owned through fenced leases.

→ [ADR-0006](docs/adr/0006-upgrades-migrations-multi-install.md)

## Trust boundaries

| Input | Treated as | Guard |
|---|---|---|
| Web pages, titles, snippets | untrusted data | rendered as text only; delimited in tool output; never instructions |
| Model tool calls | untrusted actor | can suggest, never apply; arguments validated; freshness only tightens |
| Subscribed lists | untrusted | HTTPS, shrink guard, caps, re2js, permissive parse, can't touch user tiers |
| `.searchhole.yaml` from a cloned repo | untrusted until trusted | content-hash approval; can't set endpoints, keys, subscriptions or `important` |
| Local network / other localhost ports | hostile | dashboard on 127.0.0.1, Host/Origin checks, bearer tokens (no cookies), strict CSP |
| Engine endpoints | semi-trusted | exact-origin allowlist; keys bound to origin; no secrets in logs |

## Testing at a glance

- **Unit and property tests** (vitest + fast-check): precedence, canonical URLs, merge, freshness, importers.
- **Contract fixtures per engine.**
- **A mock engine server** with named failure scenarios.
- **A host-emulation matrix** for both MCP eras.
- **Playwright + axe** for the UI.
- **CI budgets:** tool-description tokens, output caps and bundle sizes, including a size limit (115 kB gzipped) on what every CLI and gateway start loads.

The tests call no real search engine: the engines are a mock server on 127.0.0.1. CI runs on Linux, macOS and Windows. There are no checks against live engines and no plugin evals yet.
