# search-hole in VS Code (GitHub Copilot)

Copilot Chat's agent gets search-hole's tools, and the receipt card renders in the chat with its "Block a site…" button.

Status: the config search-hole writes is checked by tests; this guide has not yet been tried in the real app.

## Quickstart

You need VS Code with GitHub Copilot, Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Add search-hole to VS Code:

   ```sh
   searchhole setup vscode
   ```

   It shows the lines it will add and asks before it writes. Then it adds `search-hole` under `servers` in your user `mcp.json`: `~/Library/Application Support/Code/User/mcp.json` on macOS, `~/.config/Code/User/mcp.json` on Linux, `%APPDATA%\Code\User\mcp.json` on Windows. Comments and other servers stay, and the old file is saved as `mcp.json.bak-<time>`.
2. Reload VS Code (Command Palette → **Developer: Reload Window**). The first time VS Code starts search-hole, it asks you to trust it.
3. Open Copilot Chat, pick **Agent** mode, and check that search-hole is ticked in the tools list. Ask: *"Use search-hole to find the Node.js 24 release notes, then show the search-hole receipt."*
4. Run `searchhole log` or `searchhole ui --open` to see the search.

For one workspace only: `searchhole setup vscode --project` writes `.vscode/mcp.json` in the current folder. The file then holds a path on your computer, so keep it out of git.

By hand, run **MCP: Open User Configuration** and add this inside `servers`, with your path:

```json
"search-hole": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "vscode"]
}
```

Or from a terminal: `code --add-mcp '{"name":"search-hole","type":"stdio","command":"node","args":["/path/to/search-hole/dist/searchhole.mjs","mcp","--host","vscode"]}'`.

## What works here

| | |
|---|---|
| Host profile | `vscode` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | None. Copilot's own web tools aren't filtered: search-hole is an extra search tool. |
| Receipt panel | Yes (MCP Apps), with the "Block a site…" button. Copilot can't press it. |
| Sessions | VS Code sends a conversation id, so each chat gets its own receipt. |

## Keys

- **Keychain (recommended):** `searchhole keys set tavily`.
- **Forward a variable by name:** `searchhole setup vscode --env TAVILY_API_KEY` adds `"env": { "TAVILY_API_KEY": "${env:TAVILY_API_KEY}" }`.

## Troubleshooting

- *The user file is somewhere else:* a non-default profile or VS Code Insiders keeps its own `mcp.json`. Run **MCP: Open User Configuration** to see it, and add the entry by hand.
- *The server fails to start:* **MCP: List Servers** → search-hole → **Show Output**. A Node.js installed by nvm or similar may not be on VS Code's PATH when it starts from the Dock.

## Uninstall

Delete the `"search-hole"` entry from `mcp.json` (or restore the `.bak-…` copy), or use **MCP: List Servers** → search-hole to stop or disable it. Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
