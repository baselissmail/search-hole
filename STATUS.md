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

## P5 receipt panel + Claude Desktop extension (2026-10-31, v0.2.0)

ADR-0021.

**Receipt panel** (`apps/receipt-app`):
- A single-file MCP App, 64 KB gzipped against the 80 KB budget.
- `receipt` links `ui://search-hole/v<version>/receipt.html` on every host.
- Hosts that render apps get:
  - an inline card with 4–5 data points and two actions, "Full receipt" and "Block a site…";
  - a fullscreen receipt with per-site Block and per-suggestion Approve.
- Claude Code and other text hosts keep the text receipt.

**`apply_rule`:**
- App-only (`visibility: ["app"]`), on claude-desktop, vscode, cursor and claude-code (hidden).
- Requires the client's MCP Apps capability and a one-time HMAC token from the result's `_meta`, bound to the action and valid for 10 minutes.
- The model never sees the tokens.

**Claude Desktop:**
- `distribution/claude-desktop/manifest.json` (mcpb 0.3, keys sensitive and optional, so the system keychain).
- `pnpm -C packages/search-hole build:mcpb` packs `distribution/out/search-hole-<version>.mcpb`.

**Acceptance (MASTER_PLAN §11 P5):**
- [x] The panel is within budget, themed by the host (theme, variables, fonts, safe areas), has a fullscreen receipt, and calls `callServerTool`. Proven in Chrome through ext-apps' own AppBridge:
  - the card, axe in light and dark, the host theme winning over the OS;
  - token calls and `updateModelContext`;
  - hostile titles inert;
  - the fallback commands without `serverTools`.
- [x] Text fallback in Claude Code. `apply_rule` is refused without the UI capability, and refused for replayed or swapped tokens. Covered by gateway tests and by the legacy era over real stdio.
- [x] `.mcpb` built and validated with Anthropic's mcpb toolchain. Desktop's own substitution (`getMcpConfigForManifest`) is tested, including an unset key counting as unset.
- [ ] **Needs Basel's Claude Desktop** (ADR-0002/0021 "validate early"): install the `.mcpb`; confirm it starts on Desktop's Node with `node:sqlite`; confirm the receipt card renders and its buttons work. VS Code rendering is likewise unverified on a real host.
- [ ] Signing (`mcpb sign`) waits for a certificate (P8). claude.ai on the web needs the v2 remote connector.

Fixed along the way: Vite's CSS target polyfilled `light-dark()` from the OS preference, so the panel ignored the host theme and the dashboard ignored a theme chosen in Settings. Both now use native `light-dark()`, with a regression test each.

## P6 lists ecosystem (2026-11-01, v0.3.0)

ADR-0017 (starter set), ADR-0008 (import mapping), ADR-0022 (lists implementation).
- **Importers:** uBlacklist, Adblock Plus and AdGuard (domain rules only), hosts files, plain domain lists, Brave Goggles. Lines that can't be expressed are counted and reported, never guessed. Golden tests (10 fixtures plus hand-written scenarios) and a fuzz test.
- **Matcher:** host and n-gram prefilter buckets in front of the rule regexes (the P1 note: a 20k-regex set cost 130–250 ms per URL). A benchmark test runs at CI size; `SEARCHHOLE_BENCH=full` runs the full size against p95 < 1 ms.
- **First-party lists** (CC0, each entry with evidence): `official-docs` (96), `official-health` (111), `github-clones` (172), `ai-content-farms` (21, audit).
- **Catalog** of third-party lists with verified licences. Copyleft and unlicensed lists are link-only, Brave Goggles too.
- **Starter set**, vendored with sha256 and listed in THIRD_PARTY_NOTICES: `quenhus-dev-filter` (625), `arosh-stackoverflow-translation` (139), `arosh-github-translation` (35), `rjaus-pinterest` (50), `laylavish-huge-ai` (1,659, audit).
- **Subscriptions:** `searchhole lists add|remove|import|update`, `lists enforce|audit|disable`, `lists catalog`.
  - ETag/304, the private-address guard, an optional sha256 pin, and a shrink guard that keeps the old copy below half the rules.
  - Compiled artifacts, and a background refresh under a lease (`lists.autoUpdate`, on by default).
  - `doctor` reports list health.
- **Audit mode** records what a list would hide and never changes visible results.
- **Dashboard Lists page:** modes with Undo, each list's contribution over 7 days, errors with their fixes, the catalog, and subscribe.

**Acceptance (MASTER_PLAN §11 P6):**
- [x] Every seed list imports: the bundle test loads each vendored list from the built package with no network, and each has rules (counts above).
- [x] The dashboard shows each list's contribution (Lists page; e2e covers modes, Undo and the catalog).

Open, for Basel's review:
- **Starter breadth (ADR-0017 point 7):** `quenhus-dev-filter` blocks csdn.net and segmentfault.com. Those are copy-heavy, but they're also large Chinese developer sites. Keep it enforced, switch it to audit, or drop it from the starter set.
- **API gaps found while building the Lists page:**
  - The server has no re-import, so the page waits out the Undo window before it removes an import.
  - The page doesn't show when your own list shadows a starter list.
  - Fix strings are worded for the CLI.

## P7 more clients (2026-11-01, v0.3.0)

ADR-0023.
- **Codex plugin:** Agent Plugins 1.0, hookless, so it can go in the OpenAI directory, plus a local marketplace.
- **Cursor plugin:** `.cursor-plugin`, no hooks; it gets `apply_rule` because Cursor renders the panel.
- Both are built with `node scripts/build-plugin.mjs --target codex|cursor|all` into `distribution/out/`.
- **`searchhole setup <client>`** for vscode, cursor, windsurf, zed, goose, codex, claude-desktop and generic:
  - shows the change and asks first;
  - merges into the client's MCP config;
  - keeps a `.bak` copy.
- **`searchhole uninstall [--purge]`:**
  - Deletes keys, then known files by name, then empty roots.
  - Refuses `/`, a drive root and the home folder.
  - Names what other apps hold.
- Guides in `docs/clients/` for Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Zed, Goose and generic MCP clients.

**Acceptance (MASTER_PLAN §11 P7):**
- [x] Validators pass where the platform has one: `claude plugin validate --strict`, and the mcpb toolchain for the `.mcpb`. Codex and Cursor have no local validator, so tests check their manifests against the documented shapes (zod).
- [ ] **Needs Basel's machines:** on each client, a fresh install by the docs alone, one search, and that search in the dashboard. Nothing outside Claude Code has run on a real host yet.

## P8 release engineering (2026-11-01, v0.3.0)

ADR-0024.
- **CI** on Linux, macOS and Windows:
  - Biome, typecheck, layers, SPDX, unit tests, builds;
  - bundle-size budgets and the tool-description token budget;
  - Playwright e2e with axe;
  - `claude plugin validate --strict`, the `.mcpb` pack, and a bundle smoke test on the Node floor (22.19), Node 24 and Bun (Bun reports only).
  - A DCO check on pull requests.
- **Release (tag-driven):**
  - a signed-tag check, npm publish with provenance, a CycloneDX SBOM;
  - the plugin zip and `.mcpb` as assets, SHA-256 checksums, and build attestations.
- **Security:** CodeQL, OpenSSF Scorecard, and Renovate with a 14-day minimum release age. Actions are pinned by SHA.
- **Release tooling:** `pnpm release:bump <version>` updates every version source, including the Codex and Cursor manifests, and dates the changelog. `pnpm check:release v<version>` checks them.
- **Node floor 22.19**, because the bundled undici 8 needs zlib's zstd. Raised in `engines`, the plugin preflight, `doctor` and CI.
- LICENSE and THIRD_PARTY_NOTICES ship in the npm package, both plugins and the `.mcpb`.
- CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, `docs/release.md`, `docs/dogfood.md`, issue and PR templates.
- Launch drafts are in `docs/launch/`: Show HN, three Reddit posts, directories, and a write-up outline.
- **Fix:** the CLI entry had a top-level await that deadlocked lazily loaded chunks (`searchhole help setup` hung). The entry now loads the CLI from `main()`.

**Checked locally for v0.3.0 (2026-11-01):**
- Biome, typecheck, layers and SPDX clean.
- Tests: package 2,510 passed (2 skipped), dashboard 99, receipt panel 3.
- e2e: dashboard 12, panel 4.
- Bundle budgets all within limits; the largest are dashboard 94% and CLI 92%.
- `claude plugin validate --strict` passes. All three plugins and `search-hole-0.3.0.mcpb` are rebuilt. The smoke test and `check:release v0.3.0` pass.

**Acceptance (MASTER_PLAN §11 P8), open:**
- [x] CI passes on Linux, macOS and Windows: the private repo `baselissmail/search-hole`, run on 2026-11-01. The first Windows run found one real bug: the guard missed rooted paths without a drive letter. It also found 17 tests that assumed POSIX paths, and a check that still expected Node 22.13. All are fixed.
- [ ] Real Windows hardware is untested (CI covers the runner only). CodeQL and Scorecard need a public repo, or GitHub Advanced Security, so they fail while the repo is private.
- [ ] Plugin evals (`claude plugin eval`) don't exist yet and need an API key (docs/release.md, "Not automated yet").
- [ ] README hero GIF (needs a recording). Per-client quickstarts are in `docs/clients/`.
- [ ] Dogfood gate: two weeks of daily use with no open P0/P1 in `docs/dogfood.md`.
- [ ] A tagged release that installs cleanly from the marketplace, npm and the `.mcpb` on all three OSes. `uninstall --purge` removes a root it emptied (unit tests on macOS). It hasn't run against a real install.
- [ ] `.mcpb` signing waits for a certificate.
- [ ] pnpm's `minimumReleaseAge` can only be turned on from 2026-11-13, once the lockfile has aged (docs/release.md).
- [ ] Launch posts are Basel's.

## Waiting on Basel (for v0.3.0)

1. **Test on real apps:**
   - Claude Desktop: install `distribution/out/search-hole-0.3.0.mcpb`.
   - Codex, Cursor, VS Code, Windsurf, Zed and Goose: follow `docs/clients/`.
   - Claude Code: rebuild and reinstall the local plugin.
   - Windows, if you have a machine.
2. **Starter-set breadth** (quenhus and csdn.net/segmentfault.com): see P6.
3. **One-time GitHub and npm setup** before the first release: `docs/release.md` step 0. The private repo and its remote exist (2026-11-01). Still to do: the signing key, npm trusted publishing and the environments.
4. Publishing, release tags and launch posts are yours.

## Pre-launch review and fixes (2026-11-14)

The checklist is `docs/launch/prelaunch-review.md`; its "Status at the end of 2026-11-14" section is the summary.

- **Public:** `github.com/baselissmail/search-hole` since 2026-11-14. Nothing is released (no tag, no npm package, no marketplace file).
- **Fixed:** 16 defects from the review, including a path by which the model could sign in to the dashboard, plus what GitHub's scanners found once the repository was public (dependency alerts, missing licence texts of bundled libraries, file races).
- **New:** the review list and Opened / Seen marks (ADR-0025).
- **Docs:** README rewritten; every other user-facing document corrected; `docs/dogfood.md` holds the two weeks of use.
- **Checked locally:** lint, types, layers and SPDX clean; package 2,628 tests (2 skipped), dashboard 120, receipt panel 3; e2e dashboard 15, panel 4; bundle budgets within limits (dashboard 95%, CLI 94%); `claude plugin validate --strict` passes; smoke test passes; all three plugins and the `.mcpb` rebuilt.
- **CI:** passed on Linux, macOS and Windows at `9babc55`. See the Actions tab for later commits.

## Waiting on Basel (after the review)

1. Delete the stray `.searchhole.yaml` in the repository root (`rm .searchhole.yaml`; search-hole's own guard stops the assistant from doing it).
2. Restart Claude Code so the rebuilt plugin loads, then use it for a week with an engine on and act on the review list (`/search-hole:review`).
3. Try the other apps, or leave them labelled "not yet tried".
4. The owner-only steps of `docs/release.md` step 0, then the rehearsal, the tag and the launch posts.

