# ADR-0017: First run and default engines

- **Status:** Accepted (2026-10-30). Answers MASTER_PLAN §13 question 3 from live spikes ([spikes-2026-10-30.md](../research/spikes-2026-10-30.md) §3–5).
- **Related:** [0009](0009-engine-adapter-interface.md), [0014](0014-claude-code-hook-integration.md), [0015](0015-settings-data-locations-retention.md)

## Context

§1 promises an install in under 2 minutes, a working engine within one `doctor` step, and the AI's built-in search still working until search-hole is healthy. Docker isn't guaranteed. §13 asks which no-key, no-Docker fallback is acceptable. The evidence:

| Option | Spike or fact | Verdict |
|---|---|---|
| SearXNG in Docker (our overlay) | 1–3 s per query, 37–41 results from 3 upstreams, official docs first in 2 of 3 dev queries; 380 MB image, 35 s pull | **Best no-account default** when Docker exists |
| Marginalia shared `public` key | `429 QPM Limit Exceeded`, then `Daily Limit Exceeded` | **Not viable** as a default |
| DuckDuckGo scraping | No official API; terms and breakage risk; `ddgs` is Python, "educational purposes only" | **Rejected** |
| **Tavily** | 1,000 credits/month, **no card**; `published_date`; domain include/exclude; current ToS has no caching clause | **Best no-Docker default** |
| Exa | $10/month credits, **no card**; strict retention terms; dates estimated | Second choice |
| Brave | $5 credit/month (~1k), **card + attribution** | Good, but more friction |
| Marginalia personal key | free, non-commercial, by email; small-web, no dates | Niche option |

## Decision

1. **There is no keyless, Docker-free default engine. That is an honest limit, not a gap to paper over with scraping.** search-hole never ships a scraping engine.
2. **The first-run flow is the same on every host.** Before any engine works, hooks allow built-in search (ADR-0014), and `search` returns a tool error that names the next step.
   1. **`searchhole doctor`** (also `/search-hole:doctor` and `npx search-hole doctor`) checks for engines.
   2. **If Docker is present**, it asks **once**: "Start a private search engine on this machine? SearXNG, no account, ~380 MB download, runs only on 127.0.0.1. [Y/n]". On yes it runs `searchhole searxng up` (ADR-0015 point 5). The answer is remembered in `settings.yaml`.
   3. **Otherwise, or if declined,** it shows a guided key step, best first:
      - **Tavily** (1,000 searches/month, no card): it opens the signup URL and offers a hidden paste prompt that stores the key in the OS store (ADR-0007);
      - then Exa (no card), Brave (card; $5 monthly credit), and a Marginalia personal key.
   4. It runs a live test query and prints "✓ search-hole is ready (searxng 1.4 s)". From this point, the hooks start steering.
3. **Claude Desktop** has no slash commands. The `.mcpb` `user_config` shows optional key fields, Tavily first, with its signup URL in the description, plus a "SearXNG URL" field. The first tool error explains both options. The receipt panel shows the same guidance.
4. **P1 adapters: SearXNG, Brave and Tavily.** Tavily moves into P1 because it is the no-Docker default. Exa, Mojeek, Kagi and Marginalia follow in P1.x.
5. **Default engine order:** `fallback: [searxng, tavily, brave, exa]`, filtered to what's configured. `standard` depth uses the first two healthy engines.
6. **Default spend caps** (ADR-0009): Tavily 900/month and 300/day; Brave 900/month and 300/day; Exa 2,000/month. All are editable.
7. **Starter lists** (implemented in P6; the target default is recorded here so P1 and P4 design for it). It is a small, low-false-positive set, all CC0 or Unlicense:
   - **Enforced:** SO/GitHub clone lists (quenhus dev-filter, arosh ×2) and the Pinterest list (rjaus).
   - **Audit mode** (shows "would hide N" before the user opts in): the AI-content-farm list (laylavish HUGE-AI).
   - The large subscribe-only lists (Super-SEO, ~418k) are offered in the catalog and never auto-enabled.

## Consequences

- The README quickstart has two paths: "Docker? one command" and "No Docker? a free Tavily key (no card)". Both take under 2 minutes.
- Tavily's terms (internal business use, no redistribution) are fine for a personal tool. The docs link them, and the adapter retention is `full` (ADR-0009).
- With no engine configured, nothing breaks. The assistant keeps its built-in search and the user gets one clear next step.

## Validate early

- **P1:** the Tavily adapter against a real free key, if Basel creates one. Otherwise fixtures plus a nightly optional live check.
- **P3:** a timed first-run test on a clean machine for each path (Docker, Tavily key), with a target of under 2 minutes.
