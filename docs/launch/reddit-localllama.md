# r/LocalLLaMA draft

**Before posting:** keep it about local use. This sub dislikes posts that are really about a cloud product. The generic MCP setup is documented (docs/clients/generic.md) but has not been tried in a real app: test it with one local-model client you name. [check: which clients you actually tested, for example LM Studio or Open WebUI through MCP] The first release must be out: the `npx` commands below work only after it. Don't name a site from your log, and don't say what the searches were about.

**Title:**

> search-hole: a local MCP search gateway — your SearXNG, your site rules, and a record of every search your model makes

---

When a model searches the web for you, you don't see what it searched, what came back, or which pages it opened. I built search-hole to record that and let me act on it.

My own data so far is from Claude Code, not from a local model. In two weeks, 96 searches returned 1,243 results from 538 sites, and the assistant opened pages from 37 of them. The block lists I ship hid nothing in that sample. So far the value is seeing what happens, then deciding which sites to block or pin. [check: add what you saw with a local model, once you have tried one]

The same gateway runs as a plain MCP server that any client can start:

```sh
npx -y search-hole mcp --host generic     # the MCP server your client starts (stdio)
npx search-hole searxng up                # required, unless you add a Tavily or Brave key: a private SearXNG in Docker on 127.0.0.1
```

[check: only true after the first release]

**What the model gets:** four small tools, and the tool descriptions stay under about 1.5k tokens in total (a CI budget):

- `search` merges your engines, dedupes, applies your rules, and returns compact results with source types (official docs, forum, news…) and publish dates when the page states one.
- `fetch` opens a page safely: private and link-local addresses are refused on every redirect hop, with size and time caps and robots.txt. It returns readable text and dates.
- `receipt` says what was searched, hidden and opened, and flags stale pages. Deep searches also warn when every result is from one site or none is official.
- `suggest_rule` only *proposes* a rule. You approve it in the CLI or the dashboard, so a prompt-injected page can't change your rules.

**What you control:**

- Engines: SearXNG (no key), Tavily and Brave (your keys), with fallback and health checks.
- Site rules in YAML: block, allow, pin, raise, lower, per profile or session, with freshness limits.
- Every search is logged to a local SQLite file, with a localhost dashboard (`searchhole ui`) to browse it.
- Query hygiene: queries that look like they contain secrets are blocked, and private IPs are cut out, before anything leaves your machine.

**Local:** no telemetry and no account. The only network traffic is to the engines you configure and the pages the model opens, plus a periodic HTTPS refresh of the block lists from their GitHub sources; `lists: { autoUpdate: false }` turns it off. If you use Tavily or Brave, your blocked sites are sent to them as an exclude list.

**Limits**

- It needs Node 22.19+.
- It needs an engine. A local model has no built-in web search to fall back on, so with no engine `search` returns an error.
- SearXNG depends on upstream engines that rate-limit; a second engine covers for it.
- It doesn't rank with a model. Ranking is rules plus reciprocal-rank fusion, deterministic and explainable (`searchhole explain <url>`).
- I haven't tested it with a local model yet. [check: which clients and models you tested] If a model ignores the tool descriptions, the receipt still shows you what happened.

Apache-2.0; the first-party lists are CC0. https://github.com/baselissmail/search-hole

Which local clients would you want a one-command setup for?
