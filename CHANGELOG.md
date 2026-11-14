# Changelog

All notable changes to search-hole are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may change behaviour; the notes say when it does.

Versions 0.1.0 to 0.3.0 were local test builds. They were never published to npm or tagged, so they have no compare links. The entries below were reconstructed from the git history and STATUS.md.

## [Unreleased]

Fixes and corrections from a pre-launch review (`docs/launch/prelaunch-review.md`), after two weeks of real use.

### Changed

- **A new list subscription starts in audit mode**, in the CLI as in the dashboard: it records what it would hide and hides nothing until you run `searchhole lists enforce <id>`. `--mode enforce` skips the trial. Imports of your own files still start enforced.
- **With no engine set up, Claude Code is told to use its built-in search** (which search-hole filters) and no longer tries search-hole's `search` first. Before, every session began with a failed call. Other apps are told to ask you for an engine, and are no longer told that search-hole filters their built-in search (ADR-0012 amendment).
- **Only engines that exist are offered:** `searxng`, `brave` and `tavily`. `exa`, `mojeek`, `kagi` and `marginalia` were listed in the `search` tool, `keys status` and help, but have no adapter.
- **The dashboard adds global rules only.** Its "Project" scope wrote into whichever folder the dashboard was started from. Add a project rule with `searchhole block <site> --project` inside the project.
- `searchhole setup <app>` shows the lines it will change before it asks, and `--dry-run` shows them too. `setup generic` prints the snippet alone on stdout and the next steps on stderr.
- `searchhole lists` names where a list comes from as the docs do: built in, starter, subscribed, imported. `--json` keeps the codes.
- `doctor` calls an optional engine with no key "not set up", not "unhealthy", and reports a private SearXNG that isn't started once, not twice.
- The no-engine error of `searchhole search` says how to add an engine.

### Added

- `searchhole unblock <id|match>` in a terminal, the same as `unrule` and as the slash command.
- `explain` names the lift a profile gives a preferred source (×1.45 for official documentation by default).

### Fixed

- **Claude could sign in to the dashboard and change rules.** `searchhole ui` was not a guarded command and printed its sign-in link wherever it ran. It is now guarded, and the link is printed only to a terminal (ADR-0004 amendment).
- **`explain` gave the wrong answer without `https://`:** `searchhole explain csdn.net` said "kept" for a blocked site. A bare site is now checked as `https://`, and input that is not a site or URL is refused.
- **A list named `local` deleted every imported list when it was removed,** and one named `generation` broke list updates. Both names are reserved.
- **`uninstall --purge` could delete folders it never made.** With `SEARCHHOLE_HOME` set to a shared folder, a `backups/` or `secrets/` folder of your own went too. It now deletes only files search-hole wrote and lists what it left. The home-folder check ignores case on macOS and Windows and follows symlinks.
- **A rule added with `--project` to an untrusted file looked applied.** It now says "Saved, not applied yet" with the trust command, and `rules` marks it "not trusted yet".
- **Imported lists could carry a match-everything rule** written as `*://*/*`, `/.*/` or `://`. As an allow, one such line un-hid what every other list blocks. Such lines are skipped.
- **Lists in search-hole's own format applied scoped and expired rules everywhere, forever.** A rule with `profile:` or `until:` is now skipped.
- A dashboard that was slow to answer once could no longer be found: later `searchhole ui` calls said its port was taken by another program.
- `setup codex --env NAME` replaced an existing `env_vars` list; it now adds to it. A one-line JSON config no longer loses precision in large numbers that belong to other keys.
- The dashboard API answers 400, not 500, to a body that is not a JSON object, and a settings path such as `constructor` no longer passes the allowlist.
- On Windows, the guard that keeps Claude from editing search-hole's files now covers paths written without a drive letter.

## [0.3.0] - 2026-11-01

### Added

- **Block lists** (MASTER_PLAN P6, ADR-0017):
  - Importers for uBlacklist, Adblock Plus and AdGuard (domain rules only), hosts files, plain domain lists and Brave Goggles. Lines that can't be expressed are counted and reported, never guessed.
  - A prefilter matcher that buckets rules by host and n-gram, so large lists cost little per result.
  - First-party CC0 lists, each entry with evidence, and a catalog of third-party lists with verified licences. A small starter set is vendored, so it works offline.
  - Subscriptions and local imports: `searchhole lists`, `lists catalog`, `lists add|remove|import|update`, and `lists enforce|audit|disable`. Fetches use ETag and 304, the private-address guard, an optional SHA-256 pin, and a shrink guard that keeps the old copy when a list loses more than half its rules. Lists refresh in the background under a lease (`lists.autoUpdate`, on by default).
  - Audit mode, which records what a list would hide without changing results.
  - The dashboard's Lists page: modes with Undo, each list's contribution, errors with their fixes, the catalog, and subscribe.
  - `doctor` reports list health, and the plugin has a `lists` skill.
- **More clients** (MASTER_PLAN P7, ADR-0023):
  - A Codex plugin (Agent Plugins, no hooks) and a Cursor plugin (`.cursor-plugin`, no hooks), built with `node scripts/build-plugin.mjs --target codex|cursor|all`.
  - `searchhole setup <client>` for VS Code, Cursor, Windsurf, Zed, Goose, Codex and Claude Desktop. It shows the change, asks, merges into the client's MCP config and keeps a `.bak` copy.
  - `searchhole uninstall` lists everything search-hole stored. `--purge` deletes its keys and files by name, and refuses a root that is `/`, a drive root or your home folder.
  - Per-client guides under `docs/clients/`.
- Release engineering (MASTER_PLAN P8, ADR-0024):
  - CI on Linux, macOS and Windows: Biome, typecheck, layer check, SPDX headers, unit tests, builds, bundle-size budgets, Playwright e2e with axe, `claude plugin validate --strict`, the `.mcpb` pack, and a bundle smoke test on the Node floor (22.19), Node 24 and Bun.
  - A DCO sign-off check on pull requests.
  - CodeQL, OpenSSF Scorecard and Renovate, with a 14-day minimum release age.
  - A tag-driven release workflow: signed-tag check, npm publish with provenance, a CycloneDX SBOM, the plugin zip and `.mcpb` as release assets, SHA-256 checksums, and build attestations.
- `scripts/check-bundle-size.mjs` (`pnpm check:size`), `scripts/sbom.mjs` (`pnpm build:sbom`), and the release helpers `pnpm release:bump` and `pnpm check:release`.
- CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, docs/release.md, docs/dogfood.md, and issue and pull request templates.

- The npm package, the plugins and the `.mcpb` ship `LICENSE` and `THIRD_PARTY_NOTICES`.

### Changed

- **Node 22.19 or later is required** (was 22.13). The bundled undici 8 needs zlib's zstd support (ADR-0002 amendment). The plugin's preflight and `doctor` say so.
- The Playwright e2e configs use the `E2E_CHANNEL` environment variable (CI sets `chromium`). Local runs still use the installed Google Chrome.

### Fixed

- `searchhole help setup` and other lazily loaded commands no longer hang. The CLI entry has no top-level await and loads the CLI on demand.

## [0.2.0] - 2026-10-31

### Added

- **Dashboard** (`searchhole ui`, `/search-hole:dashboard`) on `http://127.0.0.1:7341` (ADR-0004, ADR-0020):
  - Live log: virtualized, with expandable results showing the rule that decided each one, a live SSE tail and a polling fallback.
  - Rules & lists: add, remove with Undo, test a URL, approve or reject suggestions.
  - Engines (status, key source, probe, doctor checks) and Settings (mode, hygiene, loop limits, retention, receipt line, theme).
  - Keyboard: ⌘K palette, `?` cheat sheet, `j`/`k`/Enter, and `b`/`a`/`p`/`r`/`l` verbs with Undo.
  - Security: 127.0.0.1 only, Host allowlist, Origin check on writes, strict CSP, no CORS, and a single-use 60-second login code that becomes a bearer token. The server exits after 30 idle minutes.
- **Receipt panel**, an MCP App (`ui://search-hole/v<version>/receipt.html`, ADR-0021): an inline card with searches, kept, hidden, opened and stale sources, plus a fullscreen receipt with per-site Block and per-suggestion Approve. It takes the host's theme. Hosts without apps keep the text receipt.
- `apply_rule`, an app-only tool behind single-use HMAC tokens that are bound to the action and expire after 10 minutes. The model never sees the tokens.
- **Claude Desktop extension**: `pnpm -C packages/search-hole build:mcpb` packs `search-hole-<version>.mcpb` (manifest 0.3, optional keys kept in the system keychain).
- The receipt tool points to the dashboard when one is running. It never shows a login code.

### Changed

- Query hygiene cuts private addresses (such as `192.168.1.1`) out of queries by default (`queryHygiene.hosts: redact`). Secrets in a query still block the search. `search` returns a `query_redacted` warning (ADR-0015 amendment).

### Fixed

- Built-in mode: `raise` and `lower` are graduated by weight, as in engines mode, instead of any raise jumping to the top.
- The `?after` polling cursor returns the oldest newer searches, so polling never skips a gap.
- `pnpm dev` runs from source: no TypeScript parameter properties, which Node's type stripping rejects.
- The panel and the dashboard use native `light-dark()`. Before, the host theme (panel) and the Settings theme (dashboard) were ignored.
- An open dialog in the dashboard keeps focus after an Undo toast.

## [0.1.1] - 2026-10-31

### Added

- Per-session loop guard (ADR-0019): 40 searches per turn, 120 per hour, and the third identical search in 10 minutes is refused. Configurable under `limits`.
- Duplicate-copy guard (ADR-0006 point 11): with two installed copies of the plugin, one stays quiet each turn, and `doctor` warns.
- A bundled `official-docs` list that marks and lifts official documentation.
- `docs/rules.md`, the rule reference.

### Changed

- The built-in search log keeps titles and URLs (90-day retention).
- `doctor` says plainly that Claude Code needs no engine.
- The plugin's `search_mode` option is gone, because it silently pinned the mode. A running gateway picks up `settings.yaml` changes, so `/search-hole:mode` works live.
- Keys use a stale-while-revalidate cache that is warmed at gateway start, so hooks no longer spawn the macOS `security` tool once a minute.

### Fixed

- `engines` mode falls back to the filtered built-in search when every engine has failed. Before, a down engine trapped the model in a deny loop.
- Fetch rows keep their URLs (migration 0002). The CLI migrates an older database on read, so `log` no longer looks empty after an upgrade.
- Turns: a prompt in a new session replaces the open turn, and built-in search after a Stop reopens it. SessionStart re-keys move or drop session rules.
- Only domain blocks go into WebSearch `blocked_domains`; exact-host blocks apply after the search. Results are parsed per item, and an empty `allowed_domains` is dropped.
- The Bash guard reads shell words. Commit messages and grep patterns no longer trip it, while `pnpm -C … dev block`, `npx search-hole@x`, `xargs`, `sh -c`, `$(…)` and writes into search-hole files are caught.

## [0.1.0] - 2026-10-30

First test build, for Claude Code.

### Added

- Core pipeline: YAML rules with scopes and precedence (`block`, `allow`, `pin`, `raise`, `lower`), canonical-URL dedupe, RRF merge, freshness, source typing, and date extraction.
- Engine adapters for SearXNG, Brave and Tavily, with health, fallback and a mock engine for tests.
- A safe fetcher: private addresses refused on every redirect hop, size and time caps, robots.txt, readable text and page dates.
- A local SQLite store (`node:sqlite`, WAL) with migrations and retention.
- Query hygiene: secret-like queries are blocked before any engine sees them.
- CLI `searchhole`: `search --explain`, rule commands, `rules`, `log`, `explain <url>`, `doctor`, `searxng up|down|status`, `keys set|status`, `mcp`.
- MCP gateway (SDK v2, 2025-era and 2026-07-28 clients): `search`, `fetch`, `receipt` and `suggest_rule`, plus the app-only `hook` tool.
- Claude Code plugin: `mcp_tool` hooks that filter the built-in WebSearch and WebFetch, a guard on rule changes, a one-line receipt at Stop, a Node preflight, slash commands and a `research` skill. Claude Code modes `auto`, `builtin` and `engines` (ADR-0018).

### Fixed

- Claude Code gets compact text only, without `structuredContent`.
- The model is told when rules applied to built-in search, and gets guidance when no engine is set up.
