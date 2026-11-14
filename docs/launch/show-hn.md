# Show HN draft

**Title** (HN allows 80 characters):

> Show HN: search-hole – see what your AI assistant searches, choose its sources

**URL:** https://github.com/baselissmail/search-hole

**Text** (HN shows it under the link, so keep it short and first-person):

---

I use Claude Code all day, and it searches the web constantly. I couldn't see what it searched, what came back, or which pages it opened. So I built a small local program that records all of it, and then read two weeks of my own log (Claude Code on macOS, default setup):

- 96 searches returned 1,243 results from 538 sites.
- Claude opened pages from 37 of those sites.
- Several sites came back in 5 to 10 separate searches and were never opened once.
- The lists search-hole ships with (about 2,900 rules in all) hid nothing.

So the block lists did nothing in this sample. What I use so far is the record: I can see what my assistant searches and skips, and then decide which sites to block, pin, raise or lower.

search-hole sits between your AI assistant and the web. The idea is Pi-hole's, applied to AI search:

- **A log of every search,** in a local SQLite file: the query, every result, which ones were hidden and by which rule. One exception: for results from Brave only the site and the decision are kept, because Brave's terms don't allow storing titles and URLs.
- **A receipt per turn:** what was searched, what was hidden and which pages were actually opened, with publish dates when the page states one. It flags stale pages. Deep searches also warn when every result is from one site or none is official. In Claude Desktop the receipt is a small card with a "Block a site…" button that only you can press. [check: the Desktop card has not been tried in the real app yet]
- **Rules:** block, allow, pin, raise or lower sites, globally or for one session. `searchhole block pinterest.com`, `pin react.dev`. Rules are a YAML file you can read.
- **A local dashboard** (127.0.0.1 only) with the live log, rules and engine health.

How it plugs in:

- **Claude Code:** a plugin. By default it filters Claude's own WebSearch through hooks (your blocked domains are passed into the search, and results are filtered again afterwards). That needs no engine and no key. This is the only setup I use every day.
- **Claude Desktop:** an `.mcpb` extension. [check: not yet tried in the real app]
- **Any MCP client:** `npx search-hole mcp --host generic`. [check: only true after the first release] There are setup guides for Cursor, Codex, VS Code, Zed, Goose and Windsurf. [check: the configs are covered by tests; none has been tried in the real app]
- With an engine, such as a private SearXNG in Docker (one command, listening on 127.0.0.1) or a free Tavily key, it becomes the assistant's search tool, with snippets, dates and freshness rules. Outside Claude Code it needs one.

Privacy: no telemetry and no account. The log and keys stay on your machine. Rules are stored locally; your blocked sites are passed to the search as an exclude list. Queries go only to the engines you configure, or to Claude's own search in built-in mode, as they would without search-hole. Queries that look like they contain a secret are refused before any engine sees them, and private IP addresses are cut out. About once a week it downloads its block lists from their GitHub sources; one setting turns that off.

Limits, honestly:

- In built-in mode Claude's WebSearch returns only titles and URLs, so there are no snippets or dates until a page is opened. Even then a date is found only when the page states one: 8 of the 40 pages opened through search-hole's fetch in those two weeks had one.
- The hooks fail open. If the gateway isn't running, search works unfiltered and no receipt line appears.
- The guard that stops the model editing your rules is defence in depth, not a sandbox.
- It sees searches and fetches, not the final answer, so a receipt says "opened", not "cited".
- claude.ai on the web and ChatGPT can't run a local tool like this. That needs a remote connector, which isn't built.

It needs Node 22.19+. TypeScript, Apache-2.0; the first-party lists are CC0. Claude Code helped write it, and the decision records for every non-obvious choice are in `docs/adr/`.

I'd especially like to hear from people who have tried to steer an agent's sources: which rules you would actually use, and which lists you'd trust.

---

**First comment** (optional, posted right after, for "how does it work"):

> How the Claude Code filtering works: the plugin registers `mcp_tool` hooks, which call the local gateway over MCP instead of starting a process per hook. Over the 96 built-in searches in my log, the gateway's processing time was 2 ms at the median and 15 ms at the 95th percentile (31 ms at most). On PreToolUse for WebSearch it adds your blocked domains to `blocked_domains`. On PostToolUse it rewrites the result to remove anything a finer rule hides and records what was searched. When a healthy engine is configured, `auto` mode instead steers the model to search-hole's own `search` tool, which merges engines with reciprocal-rank fusion, dedupes canonical URLs and applies freshness rules. ADR-0018 has the details and the spikes.

**Before posting:**

- Check every number against the release and against your log. The log numbers are from 2026-10-31 to 2026-11-13; say so if you quote a later period.
- The first release must be out. `npx search-hole …` works only after it. [check: only true after the first release]
- Don't name a site from your log, and don't say what the searches were about.
- The README has no image. Record the GIF first, or post without one.
