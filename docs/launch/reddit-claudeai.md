# r/ClaudeAI draft

**Before posting:** check the subreddit's rules for project posts. Use the flair for things you built, and say how Claude was involved, if the rules ask.

**Title:**

> I built a Claude Code plugin that lets you block sites from Claude's web search and shows a receipt of what it searched and opened

---

Claude Code kept citing SEO copies of Stack Overflow and docs for the wrong major version, and I had no record of what it had searched. search-hole is my fix. It's a free, open-source plugin for Claude Code (plus a Claude Desktop extension) that runs locally.

**Install (Claude Code 2.1.296+, Node 22+):**

```text
/plugin marketplace add baselissmail/search-hole
/plugin install search-hole@search-hole
/search-hole:doctor
```

[check: exact commands and marketplace name after the first release]

**What you get**

- `/search-hole:block pinterest.com`, `/search-hole:pin react.dev`, `/search-hole:raise` and `/search-hole:lower`. These are user-only slash commands that Claude can't run itself. Claude can only *suggest* a rule, and you approve it.
- **Filtering of Claude's own WebSearch,** with zero setup. Your blocked domains are passed into the search, and the results are filtered again afterwards. No engine or API key is needed.
- **A one-line receipt** when a turn that searched ends, for example `search-hole · 2 searches · 18 results · 3 hidden`. `/search-hole:log` shows what was hidden and why.
- **A local dashboard** (`/search-hole:dashboard`) with the live log, rules, Claude's suggestions and engine health.
- **Optional engines** (a private SearXNG in Docker, or a free Tavily key). In `auto` mode Claude then uses search-hole's own search tool, which gives snippets, real publish dates, freshness rules and source types.
- **Claude Desktop:** an `.mcpb` extension, where the receipt is a small card with "Block a site…". Only you can press the button. The model never sees the token behind it.

**How it works:**

- The plugin uses `mcp_tool` hooks, so a local MCP server answers them. There is no process per hook, and the overhead is a few milliseconds.
- If the server isn't running, the hooks **fail open**: search works as before, just unfiltered.
- A guard denies Claude's attempts to edit your rules through Bash or file edits. It is defence in depth, not a sandbox.

**What it doesn't do**

- In built-in mode there are no snippets or dates, because Claude's WebSearch returns titles and URLs only.
- It sees searches and fetches, not the final answer, so the receipt says "opened", not "cited".
- claude.ai on the web can't use it yet; that needs a remote connector, which is planned.

Everything stays on your machine: the log (SQLite), the rules (YAML) and the keys (OS keychain or env). No telemetry.

Built with a lot of help from Claude Code. The repo has an ADR for every non-obvious decision, if you're curious how the hooks and the receipt panel work: https://github.com/baselissmail/search-hole
