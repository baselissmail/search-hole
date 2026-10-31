# search-hole in Cursor

Cursor's agent gets search-hole's tools, and the receipt card renders in the chat with its "Block a site…" button. There are two ways in: one command that edits `~/.cursor/mcp.json`, or the Cursor plugin.

## Quickstart (about 60 seconds)

You need Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Add search-hole to Cursor:

   ```sh
   searchhole setup cursor
   ```

   It adds `search-hole` to `~/.cursor/mcp.json` (`%USERPROFILE%\.cursor\mcp.json` on Windows), keeps your other servers and saves the old file as `mcp.json.bak-<time>`.
2. Open **Customize** in Cursor's sidebar (older versions: **Cursor Settings → MCP**) and check that **search-hole** is on, with a green dot.
3. In a new chat in Agent mode, ask: *"Use search-hole to find the Node.js 24 release notes, then show the search-hole receipt."*
4. Run `searchhole log` or `searchhole ui --open` to see the search.

For one project only: `searchhole setup cursor --project` writes `.cursor/mcp.json` in the current folder. The file then holds a path on your computer, so keep it out of git.

By hand, add this inside `mcpServers`, with your path:

```json
"search-hole": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "cursor"]
}
```

## The Cursor plugin

The plugin (`distribution/cursor-plugin/`) is the same server plus a research skill. To try a local build:

```sh
node scripts/build-plugin.mjs --target cursor
mkdir -p ~/.cursor/plugins/local
cp -R "<repo>/distribution/out/cursor/search-hole" ~/.cursor/plugins/local/
```

Then run **Developer: Reload Window** and check **Customize**. Use the plugin or the config entry, not both. Cursor can also load the Claude Code plugin, so don't install that one in Cursor as well.

## What works here

| | |
|---|---|
| Host profile | `cursor` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | None. Cursor's plugin hooks can only run commands, not call the running gateway, and Cursor has no built-in web search tool a hook could steer. [Why](../../distribution/cursor-plugin/README.md#why-there-are-no-hooks). |
| Receipt panel | Yes (MCP Apps), with the "Block a site…" button. The agent can't press it. |
| Built-in search | Not filtered. Ask for search-hole by name if the agent reaches for its own web search. |

## Keys

- **Keychain (recommended):** `searchhole keys set tavily`.
- **Forward a variable by name:** `searchhole setup cursor --env TAVILY_API_KEY` adds `"env": { "TAVILY_API_KEY": "${env:TAVILY_API_KEY}" }`. Cursor fills it from its own environment, which may not include your shell's variables when Cursor starts from the Dock.

## Troubleshooting

- *Red dot, "node: command not found":* Cursor started from the Dock may not see a Node.js installed by nvm or similar. Start Cursor from a terminal, or install Node.js system-wide (from https://nodejs.org or your package manager).
- *Tools missing in chat:* check that search-hole is switched on in **Customize**, then start a new chat.

## Uninstall

- Config entry: delete the `"search-hole"` entry from `~/.cursor/mcp.json` (or restore the `.bak-…` copy), or switch it off in **Customize**.
- Plugin: delete `~/.cursor/plugins/local/search-hole` and reload Cursor.

Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
