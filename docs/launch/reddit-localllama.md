# r/LocalLLaMA draft

**Before posting:** keep it about local use. This sub dislikes posts that are really about a cloud product. Make sure the generic MCP setup (P7) is documented, and test it with one local-model client you name. [check: which clients you actually tested, for example LM Studio or Open WebUI through MCP]

**Title:**

> search-hole: a local MCP search gateway — your SearXNG, your site rules, dates and a receipt for every search your model makes

---

If you give a local model web search through MCP, you usually get a thin wrapper around one engine, and no idea what it searched or which junk sites it read. search-hole is a local search gateway that any MCP client can run:

```sh
npx -y search-hole mcp --host generic     # the MCP server your client starts (stdio)
npx search-hole searxng up                # optional: a private SearXNG in Docker on 127.0.0.1
```

**What the model gets:** four small tools, and the tool descriptions stay under about 1.5k tokens in total (a CI budget):

- `search` merges your engines, dedupes, applies your rules, and returns compact results with real publish dates and source types (official docs, forum, news…).
- `fetch` opens a page safely: private and link-local addresses are refused on every redirect hop, with size and time caps and robots.txt. It returns readable text and dates.
- `receipt` says what was searched, hidden and opened, with warnings (stale, single source, no official source).
- `suggest_rule` only *proposes* a rule. You approve it in the CLI or the dashboard, so a prompt-injected page can't change your rules.

**What you control:**

- Engines: SearXNG (no key), Tavily and Brave (your keys), with fallback and health checks.
- Site rules in YAML: block, allow, pin, raise, lower, per profile or session, with freshness limits.
- Every search is logged to a local SQLite file, with a localhost dashboard (`searchhole ui`) to browse it.
- Query hygiene: queries that look like they contain secrets are blocked, and private IPs are cut out, before anything leaves your machine.

**Fully local:** no telemetry, no account, and nothing calls home. The only network traffic is to the engines you configure and the pages the model opens.

**Limits**

- It needs Node 22+.
- With SearXNG alone, upstream engines rate-limit you under heavy agent use. A second engine helps.
- It doesn't rank with a model. Ranking is rules plus reciprocal-rank fusion, deterministic and explainable (`searchhole explain <url>`).
- Smaller models sometimes ignore tool descriptions. The receipt still shows you what happened.

Apache-2.0; the first-party lists are CC0. https://github.com/baselissmail/search-hole

Which local clients would you want a one-command setup for?
