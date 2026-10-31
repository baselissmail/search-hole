# search-hole — status

Checklist per MASTER_PLAN.md §11. Decisions taken without asking Basel are noted here (per §14).

## P0: research and decisions

- [x] Name decided: **search-hole** (command `searchhole`). See MASTER_PLAN.md header.
- [x] Name availability checked (2026-10-29):
  - npm `search-hole`: free · npm `searchhole`: free. **Not reserved yet.** Placeholder packages are ready in `distribution/npm-reserve/` (needs Basel's npm login; commands in its README).
  - GitHub `baselissmail/search-hole`: free. No `search-hole` or `searchhole` user/org exists.
  - Domains (not needed; recorded for reference): `searchhole.com` is **taken** (Namecheap, registered 2025-04-03; a live, unrelated site "Search Hole — research-backed guidance for everyday decisions"). Unregistered: `searchhole.dev`, `searchhole.app`, `searchhole.io`, `searchhole.org`, `search-hole.com`, `search-hole.dev`, `search-hole.app`, `search-hole.io`, `search-hole.org`.
- [x] Reference repos cloned to `research/refs/` (git-ignored). Commits pinned in `docs/research/_refs-table.md`.
- [x] Research notes in `docs/research/`: 31 reference repos plus smart-doctor, and 3 platform-fact checks. 25 are adversarially verified; the other 10 had their load-bearing claims spot-checked (see SYNTHESIS §1).
- [x] `docs/research/SYNTHESIS.md`
- [x] ADRs 0001–0017 in `docs/adr/` (index: `docs/adr/README.md`), revised after adversarial review
- [x] Early spikes (`docs/research/spikes-2026-10-30.md`):
  - Claude Code `mcp_tool` hooks, substitution, hidden app-only tools, deny steering, `alwaysLoad`: verified on 2.1.312.
  - Desktop's Node includes `node:sqlite` (symbol-level).
  - SearXNG in Docker with our overlay works.
  - Marginalia's shared key is exhausted.
- [x] §13 resolved where the builder can (Basel delegated on 2026-10-30):
  - licence → ADR-0016 (Apache-2.0 code, CC0 lists);
  - first run → ADR-0017;
  - hosting → personal GitHub, not pushed;
  - names/domain → prepared for Basel.
- [x] ARCHITECTURE.md drafted

## Decisions log

| Date | Decision | Where |
|---|---|---|
| 2026-10-29 | Repo initialised on `main`, local only, no remote | — |
| 2026-10-29 | Added `modelcontextprotocol/typescript-sdk`, `modelcontextprotocol/mcpb` and the spec repo to the reference set, to check the protocol facts against source | `docs/research/_refs-table.md` |
| 2026-10-29 | Sparse checkouts for litellm (router, spend tracking, hooks), Infisical (`frontend/`) and supabase (studio + ui packages) | `docs/research/_refs-table.md` |
| 2026-10-30 | Architecture decisions 0001–0015 (builder's call per §14; summary in SYNTHESIS §5) | `docs/adr/` |
| 2026-10-30 | Three-lens adversarial review of the ADRs (90 findings, 3 critical). All applied. Biggest changes: the plugin ships via the `archive` source, not `npm`; health-gated fail-open hooks with turn bracketing; a guard on model-reachable rule changes; block-only pushdown; decisions-only retention for Brave/Kagi/Exa; no dashboard cookies | ADRs 0002–0015 |
| 2026-10-30 | Added ADR-0014 (Claude Code hooks) and ADR-0015 (settings, data locations, retention, query hygiene) beyond the §10 list | `docs/adr/` |
| 2026-10-30 | Spikes: `hook` tool made app-only (hidden from the model; hooks can still call it); `apply_rule` also registered for Claude Code; `alwaysLoad` on `search` | ADR-0012, ADR-0014 |
| 2026-10-30 | §13 Q2: Apache-2.0 for code and docs, CC0-1.0 for first-party lists, DCO (Basel can still flip this before the first outside contribution) | ADR-0016, `LICENSE`, `lists/LICENSE` |
| 2026-10-30 | §13 Q3: no scraping and no shared keys; SearXNG via Docker (asks once), otherwise a guided free Tavily key (no card); Tavily joins P1 | ADR-0017 |
| 2026-10-30 | §13 Q4: personal GitHub `baselissmail/search-hole`; no remote until Basel says so | — |
| 2026-10-30 | No domain: not needed for a local tool | — |
| 2026-10-30 | Claude Code default is `builtin` mode: filter Claude's own WebSearch via hooks (spike verified); engines optional there, still required on Desktop, claude.ai, ChatGPT, VS Code and Zed | ADR-0018 |

## Dev environment to update before P1

- Node 24.14.1 → **26 LTS** for this repo (via `mise`, project-local; 24.14 prints the `node:sqlite` ExperimentalWarning)
- pnpm 10.33.2 → **12.x** (via `packageManager` + corepack, project-local)
- Claude Code on PATH is 2.1.97. The VS Code extension bundles **2.1.312**, which was used for the spikes. The CLI should be ≥ 2.1.296 for `plugin eval`, `validate --strict`, `onFailure` and `mcp_tool` hooks.

## Waiting on Basel

- Publish the two npm placeholders (`distribution/npm-reserve/README.md`). No domain is needed: search-hole is local, and docs can live on GitHub Pages as smart-doctor's do. Revisit only for a landing page or the v2/v3 hosted connector.
- Optional: a free Tavily key (no card) for the live adapter check in P1. Not needed for Claude Code use (ADR-0018 built-in mode).
- Say if you'd prefer MIT over Apache-2.0 (free to switch before outside contributions).

## v0.1 test build (target: Basel can install it in Claude Code and use it)

Scope, cut from P1–P3 for a first hands-on test (the rest follows in later releases):
- [x] P1 modules (wave 1, 2026-10-30): rules engine + YAML, URL/merge/freshness/source types, SearXNG/Brave/Tavily adapters + health + fan-out + mock engine, SQLite store + migrations, safe fetcher + page dates + engine transport, paths/settings/keys/logging/query hygiene. 1,484 tests pass; typecheck, layers and lint are clean.
  - Known for later: a 20k-regex `RE2Set` costs 130–250 ms per URL, so the P6 list matcher needs a host prefilter. AMP-cache URLs of a blocked domain aren't matched yet. Brave/Tavily fixtures are hand-written from docs and not yet checked live.
- [x] Pipeline wiring + CLI: `search --explain`, `block|allow|pin|raise|lower|normal|unrule`, `rules`, `log`, `explain <url>`, `doctor`, `searxng up|down|status`, `keys set|status`, `mcp`
- [x] MCP gateway (SDK v2, both protocol eras): `search`, `fetch`, `receipt`, `suggest_rule`, plus the app-only `hook`; Claude Code `auto` / `builtin` / `engines` modes (ADR-0018)
- [x] Claude Code plugin: manifest, local marketplace, `.mcp.json`, `mcp_tool` hooks (UserPromptSubmit, PreToolUse WebSearch/WebFetch/Bash/Edit/Write, PostToolUse WebSearch/WebFetch, Stop), node preflight, skills (slash commands), research skill
- [x] End-to-end check with a real Claude Code session; install instructions in README

**v0.1 verified 2026-10-30** (2,018 tests; `claude plugin validate --strict` passes; live sessions with Claude Code 2.1.312 and the built plugin from an isolated copy):
- built-in mode: blocked domains injected into WebSearch (no auto-approval), the model told the rules ran, pins first, search logged, Stop receipt line;
- engines mode (SearXNG via `searchhole searxng up`): WebSearch denied and steered to `search`, compact text (not JSON) reaches the model, `fetch` with receipt grouping, "opened 1" in the receipt;
- slash commands `/search-hole:block` and `/search-hole:log` run the CLI through skill injection;
- the guard refused a model Bash call to `searchhole block`; ordinary Bash and Write pass with 2–7 ms hook overhead.

Fixes from the live runs:
- Claude Code hands `structuredContent` to the model, so its profile is text-only;
- the PostToolUse note is always sent;
- the no-engine guidance points to the filtered built-in search;
- `suggest_rule` approval text has no runnable command;
- lean hook inputs for Bash and file tools.

## v0.1.1 (2026-10-31, 2,075 tests; local plugin rebuilt)

From dogfooding:
- The built-in log keeps titles and URLs (90-day retention).
- A bundled `official-docs` list types and lifts official documentation.
- `doctor` says plainly that no engine is needed.
- `docs/rules.md` is the rule reference.
- Fetch rows keep their URLs (migration 0002).
- The CLI migrates an older database on read, so `log` no longer looks empty after an upgrade.

From an adversarial review of the app and gateway (1 critical, 3 major, 7 minor, all fixed; ADR amendments in 0006, 0007, 0014 and 0018):
- `engines` mode falls back to filtered built-in when every engine has failed, and the deny-loop breaker counts only successful searches. Before, a down engine trapped the model in a deny loop.
- The plugin's `search_mode` option is gone: it silently pinned the mode. A running gateway now picks up `settings.yaml` changes, so `/search-hole:mode` works live.
- The key cache is stale-while-revalidate and is warmed at start, so hooks no longer spawn macOS `security` (90–110 ms) once a minute.
- Turns: a prompt in a new session (after an interrupt and `/clear`) replaces the open turn. Built-in search after a Stop reopens it. SessionStart re-keys move or drop session rules.
- Only domain blocks go into `blocked_domains`. The API covers subdomains, so exact-host blocks apply after the search.
- WebSearch results are parsed per item, and an empty `allowed_domains` is dropped (both lists together are a 400).
- The Bash guard scans shell words. Commit messages and grep patterns no longer trip it, while `pnpm -C … dev block`, `npx search-hole@x`, `xargs`, `sh -c`, `$(…)` and writes into search-hole files are caught.

New:
- Per-session loop guard (ADR-0019): 40 searches per turn, 120 per hour, and the third identical search in 10 minutes is refused. Configurable under `limits`.
- Duplicate-copy guard (ADR-0006 point 11): with two installed copies, one stays quiet each turn, and `doctor` warns.

Open question for Basel (product, not a defect): with the default `queryHygiene.mode: block`, searches that mention a private address such as "192.168.1.1 router admin page" are refused (ADR-0015). Switching the address classes to `redact` would trade a little privacy for fewer refusals.

Product decision 2026-10-31 (Basel: "as you recommend, for best usage and public"): private addresses are cut out of queries by default, and secrets still block (ADR-0015 amendment).

## P4 dashboard v1 (2026-10-31)

`searchhole ui [--open] [--detach] [--stay] [--port]`, or `/search-hole:dashboard`, runs it on `http://127.0.0.1:7341`. ADRs: 0004 (process model and security) and 0020 (stack, API, build).
- **Screens:**
  - Live log: virtualized, with expandable results showing the deciding rule, a live SSE tail and a polling fallback.
  - Rules & lists: add, remove with Undo, test a URL, approve or reject suggestions.
  - Engines: status, key source, probe and doctor checks.
  - Settings: mode, hygiene, loop limits, retention, receipt line and theme.
  - Plus the Overview header.
- **Interaction:** ⌘K palette, `?` cheat sheet, `j`/`k`/Enter, and `b`/`a`/`p`/`r`/`l` verbs with Undo.
- **Server:**
  - Host allowlist, Origin check, strict CSP and no CORS.
  - A single-use 60 s login code becomes a bearer token in sessionStorage.
  - `ui.json` (0600) has a nonce health check and a startup lock, and the process exits after 30 idle minutes.
  - The receipt tool points to the dashboard, but never shows a code.

**Acceptance (MASTER_PLAN §11 P4):**
- [x] axe: no serious or critical issue on every v1 page, light and dark (Playwright against the real server).
- [x] Full keyboard path (e2e).
- [x] Light and dark screenshots reviewed (`apps/dashboard/test-results/screens/`, regenerated by `pnpm -C apps/dashboard test:e2e`).
- [x] Web text rendered as text only: e2e with hostile titles and `javascript:` URLs, and no `dangerouslySetInnerHTML` anywhere.
- [x] 100k rows scroll at 60 fps on the production build, with 0 frames over 20 ms (measured in headless Chrome).
- [x] Localhost only, with session token, Host check and strict CSP (server tests, and e2e checks for zero CSP violations).
- [ ] Impeccable `detect` and the Vercel web-design-guidelines audit have not run yet. Both are third-party tools (§8.6) that would be fetched from npm or skills registries; vet them first, then run them. Covered meanwhile: WCAG via axe, focus rings, URL state, tabular numbers, color plus icon plus word.

Known for P4b:
- Sessions/receipts, Sources, Clients, Storybook and the RTL pass (the layout already uses logical properties).
- "Delete all data".
- The overview shows only headline numbers on phones.
- The bundle is 233 KB gzipped, against the ~250 KB budget.
- `contract.ts` pulls Node types into the dashboard's type program; a browser-only types module would fix it.

Next: dogfood the dashboard, then P5 (in-chat receipt panel as an MCP App, plus the Claude Desktop `.mcpb` extension).

Deferred past v0.1: dashboard (P4), MCP App panel and `.mcpb` (P5), list subscriptions and importers (P6), Cursor/Codex manifests (P7), release engineering (P8).
