# search-hole — status

Checklist per MASTER_PLAN.md §11. Decisions taken without asking Basel are noted here (per §14).

## P0: research and decisions

- [x] Name decided: **search-hole** (command `searchhole`). See MASTER_PLAN.md header.
- [x] Name availability checked (2026-10-29):
  - npm `search-hole`: free · npm `searchhole`: free. **Not reserved yet** (publishing is outward-facing; waiting for Basel).
  - GitHub `baselissmail/search-hole`: free. No `search-hole` or `searchhole` user/org exists.
  - Domains: `searchhole.com` is **taken** (Namecheap, registered 2025-04-03; a live, unrelated site "Search Hole — research-backed guidance for everyday decisions"). Unregistered: `searchhole.dev`, `searchhole.app`, `searchhole.io`, `searchhole.org`, `search-hole.com`, `search-hole.dev`, `search-hole.app`, `search-hole.io`, `search-hole.org`.
- [x] Reference repos cloned to `research/refs/` (git-ignored). Commits pinned in `docs/research/_refs-table.md`.
- [x] Research notes in `docs/research/`: 32 notes (one per reference repo, including smart-doctor) plus 3 platform-fact checks. 25 are adversarially verified; the other 10 had their load-bearing claims spot-checked (see SYNTHESIS §1).
- [x] `docs/research/SYNTHESIS.md`
- [x] ADRs 0001–0015 in `docs/adr/` (index: `docs/adr/README.md`), revised after adversarial review
- [ ] ARCHITECTURE.md drafted. Deliberately not started: Basel asked to stop after SYNTHESIS + ADRs and review first.
- [ ] Basel answers the §13 questions (SYNTHESIS §10)
- [ ] Early spikes before P1 coding (SYNTHESIS §8): `mcp_tool` hook substitution, `node:sqlite` in Desktop's Node

## Decisions log

| Date | Decision | Where |
|---|---|---|
| 2026-10-29 | Repo initialised on `main`, local only, no remote | — |
| 2026-10-29 | Added `modelcontextprotocol/typescript-sdk`, `modelcontextprotocol/mcpb` and the spec repo to the reference set, to check the protocol facts against source | `docs/research/_refs-table.md` |
| 2026-10-29 | Sparse checkouts for litellm (router, spend tracking, hooks), Infisical (`frontend/`) and supabase (studio + ui packages) | `docs/research/_refs-table.md` |
| 2026-10-30 | Architecture decisions 0001–0015 (builder's call per §14; summary in SYNTHESIS §5) | `docs/adr/` |
| 2026-10-30 | Three-lens adversarial review of the ADRs (90 findings, 3 critical). All applied. Biggest changes: the plugin ships via the `archive` source, not `npm`; health-gated fail-open hooks with turn bracketing; a guard on model-reachable rule changes; block-only pushdown; decisions-only retention for Brave/Kagi/Exa; no dashboard cookies | ADRs 0002–0015 |
| 2026-10-30 | Added ADR-0015 (settings, data locations, retention, query hygiene), which the review found undecided | `docs/adr/0015-settings-data-locations-retention.md` |
| 2026-10-30 | Added ADR-0014 (Claude Code hook integration) beyond the §10 list, because hooks span session, tool surface and runtime | `docs/adr/0014-claude-code-hook-integration.md` |

## Dev environment to update before P1

- Node 24.14.1 → **26 LTS** (24.14 prints the `node:sqlite` ExperimentalWarning)
- pnpm 10.33.2 → **12.x**
- Claude Code 2.1.97 → **≥ 2.1.296** (needed for `plugin eval`, `validate --strict`, `onFailure`, `mcp_tool` hooks and the 4,096-char instructions cap)

## Waiting on Basel

See MASTER_PLAN.md §13; the open questions are repeated at the end of `docs/research/SYNTHESIS.md`.
