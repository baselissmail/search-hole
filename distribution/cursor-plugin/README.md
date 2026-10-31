# search-hole for Cursor (plugin)

This folder is the search-hole Cursor plugin:

| File | What it is |
|---|---|
| `.cursor-plugin/plugin.json` | The manifest. |
| `mcp.json` | One stdio server: `node ${CURSOR_PLUGIN_ROOT}/dist/searchhole.mjs mcp --host cursor`. Cursor expands `${CURSOR_PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_ROOT}`), not the Agent Plugins `${PLUGIN_ROOT}`. |
| `skills/research/` | A short research skill: search or fetch, how deep, cite with dates, suggest rules. |

The assembled plugin also holds `dist/` (the built bundle), `assets/logo.png` and `LICENSE`. They are copied in by the build, not committed here.

## Why there are no hooks

The Claude Code plugin's hooks are `mcp_tool` hooks: Claude Code calls the running gateway's internal `hook` tool, so the gateway can filter the built-in WebSearch, guard rule files, and print the one-line receipt (ADR-0014, ADR-0018). Cursor's hook model can't do that safely today (checked against cursor.com/docs/agent/hooks, 2026-11-01):

- **Plugin hooks are command hooks only.** Cursor has no hook type that calls an MCP tool, and the gateway registers its `hook` tool for the `claude-code` profile only. A command hook would start a second Node process for every matching tool call. That process can't see the gateway's state for the turn (which session, which receipt is open, whether a search just happened), and that state is what makes the Claude Code hooks safe to fail open.
- **There is no built-in web search to steer or filter.** Cursor's documented `preToolUse` tool names are `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task` and `MCP:<tool>`, with no web search tool. `postToolUse` can rewrite MCP tool output only, so built-in results can't be filtered the way ADR-0018 does in Claude Code.
- **A guard against rule edits would be weaker than it looks.** Cursor's `beforeShellExecution` and `preToolUse` could deny `searchhole block …` or edits to `rules.yaml`, but the Cursor CLI ignores plugin hooks, and a hook that crashes lets the action through by default.

So in Cursor, search-hole is the search tool the agent calls, with your rules applied inside the gateway. The receipt panel renders as an MCP App, and its "Block a site…" button works through the app-only `apply_rule` tool. If Cursor adds an MCP-tool hook type, this can be revisited.

## Build and install a local copy

Needs Node.js 22.19 or newer on your PATH.

```sh
node scripts/build-plugin.mjs --target cursor
mkdir -p ~/.cursor/plugins/local
cp -R "<repo>/distribution/out/cursor/search-hole" ~/.cursor/plugins/local/
```

Then run **Developer: Reload Window** in Cursor and check **Customize**: search-hole and its MCP server should be listed. Cursor doesn't load a symlink that points outside its local plugins folder, so copy the folder again after each rebuild.

Without the plugin, `searchhole setup cursor` writes the same server into `~/.cursor/mcp.json`. See [docs/clients/cursor.md](../../docs/clients/cursor.md).

## Keys

`mcp.json` has no `env`. Plugin variables in Cursor are set by team admins, which doesn't fit a personal key. Store a key in your OS keychain once, and the gateway finds it in every app:

```sh
searchhole keys set tavily
```

## Notes

- Install only one copy. Cursor can also load Claude Code plugins, and two copies of search-hole mean two servers. If both are present, the gateway marks the Claude copy as Cursor's (ADR-0012), but remove one anyway.
- To uninstall, delete `~/.cursor/plugins/local/search-hole` and reload Cursor.
