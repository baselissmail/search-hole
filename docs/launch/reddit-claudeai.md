# r/ClaudeAI draft

**Before posting:** check the subreddit's rules for project posts. Use the flair for things you built, and say how Claude was involved, if the rules ask. The first release must be out: the install commands below work only after it. Don't name a site from your log, and don't say what the searches were about.

**Title:**

> I built a Claude Code plugin that shows what Claude searched and opened, and lets you block or pin sites

---

I couldn't see what Claude Code searched for, what came back, or which pages it opened. search-hole records that on your machine and lets you act on it. It's a free, open-source plugin for Claude Code (plus a Claude Desktop extension).

Two weeks of my own log (Claude Code on macOS, default setup): 96 searches returned 1,243 results from 538 sites, and Claude opened pages from 37 of them. Several sites came back in 5 to 10 separate searches and were never opened once. The block lists I ship hid nothing in that sample. So the use for me so far is seeing what happens, then deciding what to block or pin.

**Install (Claude Code 2.1.296 or newer, tested on 2.1.312; Node 22.19+):**

```text
/plugin marketplace add baselissmail/search-hole
/plugin install search-hole@search-hole
/search-hole:doctor
```

[check: only true after the first release; confirm the exact commands and the marketplace name then]

**What you get**

- **A log of every search:** the query, each result, and whether a rule hid it. `/search-hole:log`, or the dashboard.
- **A one-line receipt** when a turn that searched ends, for example `search-hole · 2 searches (2 built-in) · 18 results · 3 hidden · receipt rcpt_…`.
- `/search-hole:block pinterest.com`, `/search-hole:pin react.dev`, `/search-hole:raise` and `/search-hole:lower`. These are user-only slash commands that Claude can't run itself. Claude can only *suggest* a rule, and you approve it.
- **Filtering of Claude's own WebSearch,** with zero setup. Your blocked domains are passed into the search, and the results are filtered again afterwards. No engine or API key is needed.
- **A local dashboard** (`/search-hole:dashboard`) with the live log, rules, Claude's suggestions and engine health.
- **Optional engines** (a private SearXNG in Docker, or a free Tavily key). In `auto` mode Claude then uses search-hole's own search tool, which gives snippets, publish dates when the page states one, freshness rules and source types.
- **Claude Desktop:** an `.mcpb` extension, where the receipt is a small card with "Block a site…". Only you can press the button. The model never sees the token behind it. [check: not yet tried in the real Desktop app]

**How it works:**

- The plugin uses `mcp_tool` hooks, so a local MCP server answers them. There is no process per hook. Over the 96 built-in searches in my log, the gateway's processing time was 2 ms at the median and 15 ms at the 95th percentile.
- If the server isn't running, the hooks **fail open**: search works as before, just unfiltered, and no receipt line appears.
- A guard denies Claude's attempts to edit your rules through Bash or file edits, or to start the dashboard. It is defence in depth, not a sandbox.

**What it doesn't do**

- In built-in mode there are no snippets or dates, because Claude's WebSearch returns titles and URLs only.
- It sees searches and fetches, not the final answer, so the receipt says "opened", not "cited".
- claude.ai on the web can't use it. That needs a remote connector, which isn't built.
- I use it daily on macOS only. Linux and Windows pass the test suite in CI. [check: update if you have tried them by then]

The log (SQLite) and the keys stay on your machine. Rules are stored locally as YAML; your blocked sites are passed to the search as an exclude list. No telemetry. About once a week it downloads its block lists from GitHub; a setting turns that off.

Built with a lot of help from Claude Code. The repo has an ADR for every non-obvious decision, if you're curious how the hooks and the receipt panel work: https://github.com/baselissmail/search-hole
