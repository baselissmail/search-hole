# Show HN draft

**Title** (HN allows 80 characters):

> Show HN: search-hole – choose the sites your AI assistant searches, see every search

**URL:** https://github.com/baselissmail/search-hole

**Text** (HN shows it under the link, so keep it short and first-person):

---

I use Claude Code all day, and it searches the web constantly. I had no say in which sites it used and no record of what it looked at. It kept citing SEO copies of Stack Overflow, old docs for the wrong major version, and AI-written pages.

search-hole is a small local program that sits between your AI assistant and the web. The idea is Pi-hole's, applied to AI search:

- **Rules:** block, allow, pin, raise or lower sites, globally or for one session. `searchhole block pinterest.com`, `pin react.dev`. Rules are a YAML file you can read.
- **A log of every search,** in a local SQLite file: the query, every result, which ones were hidden and by which rule.
- **A receipt per turn:** what was searched, what was hidden, which pages were actually opened, their real publish dates, and warnings (stale, single source, no official source). In Claude Desktop it is a small card with a "Block this site" button that only you can press.
- **A local dashboard** (127.0.0.1 only) with the live log, rules and engine health.

How it plugs in:

- **Claude Code:** a plugin. By default it filters Claude's own WebSearch through hooks (your blocked domains are passed into the search, and results are filtered again afterwards). That needs no engine and no key.
- **Claude Desktop:** an `.mcpb` extension.
- **Any MCP client:** `npx search-hole mcp --host generic`. [check: P7 setup docs for Cursor, Codex and others]
- With an engine, such as a private SearXNG in Docker (one command, listening on 127.0.0.1) or a free Tavily key, it becomes the assistant's search tool, with snippets, dates and freshness rules.

Privacy: no telemetry and no account. The log, rules and keys stay on your machine. Queries go only to the engines you configure, or to Claude's own search in built-in mode, as they would without search-hole. Queries that look like they contain a secret are refused before any engine sees them, and private IP addresses are cut out.

Limits, honestly:

- In built-in mode Claude's WebSearch returns only titles and URLs, so there are no snippets or dates until a page is opened.
- The hooks fail open: if the gateway isn't running, search works unfiltered, and the receipt says so.
- The guard that stops the model editing your rules is defence in depth, not a sandbox.
- It sees searches and fetches, not the final answer, so a receipt says "opened", not "cited".
- claude.ai on the web and ChatGPT can't route their search through a local tool yet.

It needs Node 22+. TypeScript, Apache-2.0; the first-party lists are CC0. Claude Code helped write it, and the decision records for every non-obvious choice are in `docs/adr/`.

I'd especially like to hear from people who have tried to steer an agent's sources: which rules you would actually use, and which lists you'd trust.

---

**First comment** (optional, posted right after, for "how does it work"):

> How the Claude Code filtering works: the plugin registers `mcp_tool` hooks, which call the local gateway over MCP instead of starting a process per hook (2–7 ms overhead in my tests). On PreToolUse for WebSearch it adds your blocked domains to `blocked_domains`. On PostToolUse it rewrites the result to remove anything a finer rule hides and records what was searched. When a healthy engine is configured, `auto` mode instead steers the model to search-hole's own `search` tool, which merges engines with reciprocal-rank fusion, dedupes canonical URLs and applies freshness rules. ADR-0018 has the details and the spikes.

**Before posting:** check the hook overhead and every number against the release. Make sure the repository is public and the README GIF works.
