# search-hole — status

Checklist per MASTER_PLAN.md §11. Decisions taken without asking Basel are noted here (per §14).

## P0: research and decisions

- [x] Name decided: **search-hole** (command `searchhole`). See MASTER_PLAN.md header.
- [x] Name availability checked (2026-10-29):
  - npm `search-hole`: free · npm `searchhole`: free. **Not reserved yet.** Placeholder packages are ready in `distribution/npm-reserve/` (needs Basel's npm login; commands in its README).
  - GitHub `baselissmail/search-hole`: free. No `search-hole` or `searchhole` user/org exists.
  - Domains: `searchhole.com` is **taken** (Namecheap, registered 2025-04-03; a live, unrelated site "Search Hole — research-backed guidance for everyday decisions"). Unregistered: `searchhole.dev`, `searchhole.app`, `searchhole.io`, `searchhole.org`, `search-hole.com`, `search-hole.dev`, `search-hole.app`, `search-hole.io`, `search-hole.org`. Recommendation: `search-hole.dev` (Basel registers).
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
- [ ] ARCHITECTURE.md drafted

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

## Dev environment to update before P1

- Node 24.14.1 → **26 LTS** for this repo (via `mise`, project-local; 24.14 prints the `node:sqlite` ExperimentalWarning)
- pnpm 10.33.2 → **12.x** (via `packageManager` + corepack, project-local)
- Claude Code on PATH is 2.1.97. The VS Code extension bundles **2.1.312**, which was used for the spikes. The CLI should be ≥ 2.1.296 for `plugin eval`, `validate --strict`, `onFailure` and `mcp_tool` hooks.

## Waiting on Basel

- Publish the two npm placeholders (`distribution/npm-reserve/README.md`) and register a domain (recommended: `search-hole.dev`).
- Optional: a free Tavily key (no card) for the live adapter check in P1. Set it with `searchhole keys set tavily` once that command exists, or as `TAVILY_API_KEY`.
- Say if you'd prefer MIT over Apache-2.0 (free to switch before outside contributions).
