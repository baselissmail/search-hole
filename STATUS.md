# search-hole — status

Checklist per MASTER_PLAN.md §11. Decisions taken without asking Basel are noted here (per §14).

## P0: research and decisions

- [x] Name decided: **search-hole** (command `searchhole`). See MASTER_PLAN.md header.
- [x] Name availability checked (2026-10-29):
  - npm `search-hole`: free · npm `searchhole`: free. **Not reserved yet** (publishing is outward-facing; waiting for Basel).
  - GitHub `baselissmail/search-hole`: free. No `search-hole` or `searchhole` user/org exists.
  - Domains: `searchhole.com` is **taken** (Namecheap, registered 2025-04-03; a live, unrelated site "Search Hole — research-backed guidance for everyday decisions"). Unregistered: `searchhole.dev`, `searchhole.app`, `searchhole.io`, `searchhole.org`, `search-hole.com`, `search-hole.dev`, `search-hole.app`, `search-hole.io`, `search-hole.org`.
- [x] Reference repos cloned to `research/refs/` (git-ignored). Commits pinned in `docs/research/_refs-table.md`.
- [ ] Research notes in `docs/research/` (one per repo, plus platform-fact checks)
- [ ] `docs/research/SYNTHESIS.md`
- [ ] ADRs in `docs/adr/`
- [ ] ARCHITECTURE.md drafted (after Basel answers the §13 questions)

## Decisions log

| Date | Decision | Where |
|---|---|---|
| 2026-10-29 | Repo initialised on `main`, local only, no remote | — |
| 2026-10-29 | Added `modelcontextprotocol/typescript-sdk`, `modelcontextprotocol/mcpb` and the spec repo to the reference set, to check the protocol facts against source | `docs/research/_refs-table.md` |
| 2026-10-29 | Sparse checkouts for litellm (router, spend tracking, hooks), Infisical (`frontend/`) and supabase (studio + ui packages) | `docs/research/_refs-table.md` |

## Waiting on Basel

See MASTER_PLAN.md §13; the open questions are repeated at the end of `docs/research/SYNTHESIS.md`.
