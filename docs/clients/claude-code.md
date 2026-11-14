# search-hole in Claude Code

Claude Code gets the most: a plugin with hooks, so search-hole can filter Claude's own WebSearch, steer it to your engines, guard your rules and print a one-line receipt after each turn.

Status: used daily on macOS. On Linux and Windows it passes the test suite in CI, and is not yet used daily.

## Quickstart

You need Claude Code 2.1.296 or newer (tested on 2.1.312) and Node.js 22.19 or newer on your PATH (`node --version`). search-hole is not in a plugin marketplace yet, so you build it from a checkout.

1. Clone the repository, then install the toolchain and the dependencies, and build the plugin (this needs [mise](https://mise.jdx.dev)). The last command prints the next steps with your paths:

   ```sh
   mise install
   mise exec -- pnpm install --frozen-lockfile
   mise exec -- node scripts/build-plugin.mjs
   ```

2. Install it from the local marketplace:

   ```sh
   claude plugin marketplace add "<repo>/distribution/marketplace"
   claude plugin install search-hole@search-hole-local
   ```

3. Restart Claude Code, then run `/search-hole:doctor`.
4. Ask something that needs the web. If the turn searched, a line like this appears when it ends:

   ```text
   search-hole · 2 searches (2 built-in) · 18 results · 3 hidden · receipt rcpt_…
   ```

   Run `/search-hole:dashboard` to see the search.

It works with no engine at all: in the default `auto` mode, Claude's own WebSearch runs and search-hole filters it with your rules. Adding an engine (`/search-hole:searxng up --yes`, or a Tavily key in the plugin settings) switches it to your engines by itself.

## What works here

| | |
|---|---|
| Host profile | `claude-code` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | Yes: built-in WebSearch and WebFetch filtering or steering, a guard against the model changing rules or starting the dashboard, the end-of-turn receipt line, and a Node.js check at session start. They fail open: if the gateway isn't running, search works unfiltered and no receipt line appears. |
| Receipt panel | No: the Claude Code terminal doesn't render MCP Apps, so the receipt is text. Claude Desktop's "Code" tab is documented to render MCP Apps; search-hole has not been tried there. |
| Slash commands | `/search-hole:block`, `allow`, `pin`, `rules`, `log`, `mode`, `doctor`, `dashboard` and the rest. Only you can run them. |
| Keys | The plugin settings (`claude plugin configure search-hole`), or `searchhole keys set <engine>` |

The full list of commands and modes is in the [README](../../README.md#slash-commands).

## Without the plugin

`claude mcp add search-hole -- node "<repo>/packages/search-hole/dist/searchhole.mjs" mcp --host claude-code` adds the server alone. You get the tools, but no hooks, no slash commands and no filtering of the built-in search. Use the plugin.

## Uninstall

```sh
claude plugin uninstall search-hole@search-hole-local
claude plugin marketplace remove search-hole-local
```

Removing the marketplace also deletes the plugin's saved options and keys. Your log, rules and any keys stored with `searchhole keys set` stay in search-hole's folder and the OS keychain. `searchhole uninstall` lists them, and `searchhole uninstall --purge` deletes them after asking. It deletes only files search-hole wrote; anything else it finds in its folders stays, and is listed under "Left in place".
