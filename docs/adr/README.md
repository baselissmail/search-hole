# Architecture decision records

One file per decision: `NNNN-title.md`. Each records the context, the decision, the alternatives considered, the consequences, the evidence behind it, and what to validate early. The evidence lives in [`../research/`](../research/), and the cross-cutting summary is [`../research/SYNTHESIS.md`](../research/SYNTHESIS.md).

Status values: **Proposed**, **Accepted**, **Superseded by ADR-NNNN**. To change a decision, write a new ADR that supersedes the old one. Don't rewrite history.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-shape.md) | Three-package pnpm workspace: one published package with internal layers, plus two UI apps | Accepted |
| [0002](0002-runtime-and-packaging.md) | Require Node ≥ 22.13 and ship one dependency-free bundle; Desktop uses its bundled Node via `.mcpb`; standalone binaries deferred | Accepted |
| [0003](0003-sqlite-driver-and-access-layer.md) | `node:sqlite` behind a small driver port, with plain SQL and typed query functions | Accepted |
| [0004](0004-dashboard-process-model.md) | No daemon: gateways write SQLite directly; `searchhole ui` runs on demand as a single instance and pushes a rowid tail over SSE | Accepted |
| [0005](0005-session-definition.md) | Session = best host conversation key per request; receipt = server-minted handle | Accepted |
| [0006](0006-upgrades-migrations-multi-install.md) | Forward-only migrations under `BEGIN EXCLUSIVE`; read-only on unknown newer schema; lease-owned background jobs | Accepted |
| [0007](0007-key-storage-and-resolution.md) | Host env → process env → own store (OS keychain via OS CLIs); the gateway never prompts or writes | Accepted |
| [0008](0008-rule-format-and-precedence.md) | YAML rules; visibility decided by tier walk; list tier keeps ABP semantics; re2js for regex | Accepted |
| [0009](0009-engine-adapter-interface.md) | Pure request/parse adapters with typed capabilities and retention; core owns transport, health and spend caps | Accepted |
| [0010](0010-merge-algorithm-and-weights.md) | Canonical-URL dedupe, then RRF (k = 20) on raw ranks, then rule multipliers, pins, blocks and freshness | Accepted |
| [0011](0011-date-extraction-chain.md) | Our own extractor: engine dates, then page metadata, then HTTP headers; typed dates with method and confidence | Accepted |
| [0012](0012-mcp-tool-surface-and-output-limits.md) | Four model tools plus host-scoped internal tools; compact text plus object-root `structuredContent`; budgets in CI | Accepted |
| [0013](0013-dual-protocol-support.md) | Serve 2026-07-28 and 2025-era clients from one binary with the SDK v2 defaults | Accepted |
| [0014](0014-claude-code-hook-integration.md) | Claude Code hooks are `mcp_tool` hooks answered by the gateway; turn bracketing; fail-open health predicate; Bash/Edit guard on rule changes; a Node preflight hook covers the "no node" case | Accepted |
| [0015](0015-settings-data-locations-retention.md) | `settings.yaml` (separate from rules); XDG and AppData roots; per-table retention defaults; query hygiene; user-managed SearXNG container | Accepted |
| [0016](0016-licensing.md) | Apache-2.0 for code and docs, CC0-1.0 for first-party lists, DCO for contributions | Accepted |
| [0018](0018-claude-code-builtin-search-mode.md) | Claude Code default: filter Claude's own WebSearch via hooks (blocked_domains + output rewrite); engines optional there | Accepted |
| [0017](0017-first-run-and-default-engines.md) | No scraping and no shared keys: SearXNG via Docker (asks once), otherwise a guided free Tavily key; P1 adapters SearXNG, Brave, Tavily | Accepted |
| [0019](0019-loop-guard.md) | Per-session loop guard: searches per turn and per hour, and repeated searches, refused with a clear error; built-in and engine searches count together | Accepted |
| [0020](0020-dashboard-v1.md) | Dashboard v1: React + TanStack + Tailwind + Base UI app; Hono server bundled in the CLI; contract-typed API; ADR-0004 security | Accepted |

The ADRs were revised on 2026-10-30 after a three-lens adversarial review (facts, consistency, red team; 90 findings). Where an ADR writes `~/.searchhole/`, read it as the root that ADR-0015 resolves.
