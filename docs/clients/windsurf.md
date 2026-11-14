# search-hole in Windsurf (Devin Desktop)

Windsurf was renamed Devin Desktop in 2026. Its Cascade agent gets search-hole's tools.

Status: the config search-hole writes is checked by tests; this guide has not yet been tried in the real app.

## Quickstart

You need Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Add search-hole:

   ```sh
   searchhole setup windsurf
   ```

   It shows the lines it will add and asks before it writes. Then it adds `search-hole` to Cascade's `mcp_config.json`. Devin Desktop keeps it in `~/.config/devin/mcp_config.json` on macOS and Linux (`$XDG_CONFIG_HOME/devin/` if you set it), or `%APPDATA%\devin\mcp_config.json` on Windows. Windsurf before 3.0 (before the rename) reads `~/.codeium/windsurf/mcp_config.json`. `setup` writes Devin Desktop's file if it exists. If it doesn't, but Windsurf's file or folder does, it writes Windsurf's and says so. Other servers stay, and the old file is saved as `mcp_config.json.bak-<time>`.

   To check which one your app reads, use **Open MCP config file** in Cascade's MCP menu. If it's the other one, paste the entry below there by hand.
2. In Cascade, open the MCP servers list and press **Refresh**, or restart the app.
3. Ask Cascade: *"Use search-hole to find the Node.js 24 release notes, and cite your sources with dates."*
4. Run `searchhole log` or `searchhole ui --open` to see the search.

By hand, use **Open MCP config file** in Cascade's MCP menu and add this inside `mcpServers`, with your path:

```json
"search-hole": {
  "command": "node",
  "args": ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "generic"]
}
```

## What works here

| | |
|---|---|
| Host profile | `generic` (search-hole has no Windsurf-specific profile) |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | None. Cascade's own web search isn't filtered. |
| Receipt panel | Unknown: Devin Desktop doesn't say whether it renders MCP Apps. Without it, the receipt is text. There are no panel buttons on this profile. |

## Keys

- **Keychain (recommended):** `searchhole keys set tavily`.
- **Forward a variable by name:** `searchhole setup windsurf --env TAVILY_API_KEY` adds `"env": { "TAVILY_API_KEY": "${env:TAVILY_API_KEY}" }`.

The file is plain JSON: a comment in it makes `setup` refuse and print the entry to add by hand.

## Uninstall

Delete the `"search-hole"` entry from `mcp_config.json` (or restore the `.bak-…` copy), or toggle it off in the MCP servers list. Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
