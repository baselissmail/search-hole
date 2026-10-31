# Changelog

All notable changes to search-hole are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may change behaviour; the notes say when it does.

Versions 0.1.0 to 0.2.0 were local test builds. They were never published to npm or tagged, so they have no compare links. The entries below were reconstructed from the git history and STATUS.md.

## [Unreleased]

### Added

- Release engineering (MASTER_PLAN P8):
  - CI on Linux, macOS and Windows: Biome, typecheck, layer check, SPDX headers, unit tests, builds, bundle-size budgets, Playwright e2e with axe, `claude plugin validate --strict`, the `.mcpb` pack, and a bundle smoke test on Node 22.13, 24 and Bun.
  - A DCO sign-off check on pull requests.
  - CodeQL, OpenSSF Scorecard and Renovate, with a 14-day minimum release age.
  - A tag-driven release workflow: signed-tag check, npm publish with provenance, a CycloneDX SBOM, the plugin zip and `.mcpb` as release assets, SHA-256 checksums, and build attestations.
- `scripts/check-bundle-size.mjs` (`pnpm check:size`), `scripts/sbom.mjs` (`pnpm build:sbom`), and the release helpers `pnpm release:bump` and `pnpm check:release`.
- CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, docs/release.md, docs/dogfood.md, and issue and pull request templates.

### Changed

- The Playwright e2e configs use the `E2E_CHANNEL` environment variable (CI sets `chromium`). Local runs still use the installed Google Chrome.

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
