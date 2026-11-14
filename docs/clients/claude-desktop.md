# search-hole in Claude Desktop

Claude Desktop shows the receipt as a card in the chat, with buttons you can press and Claude can't. Install the extension (`.mcpb`): it runs on Desktop's own Node.js and keeps keys in your system keychain.

Status: the extension's manifest and the config search-hole writes are checked by tests; this guide has not yet been tried in the real app.

## Quickstart with the extension

1. Build the extension file from a checkout (this needs [mise](https://mise.jdx.dev)). There is no release to download it from yet.

   ```sh
   mise install
   mise exec -- pnpm install --frozen-lockfile
   mise exec -- node scripts/build-plugin.mjs
   mise exec -- pnpm -C packages/search-hole build:mcpb
   ```

   This writes `distribution/out/search-hole-<version>.mcpb`.
2. In Claude Desktop, open **Settings → Extensions → Install Extension…** and pick the file. Paste a Tavily key (free plan, no card: <https://app.tavily.com>), or leave the fields empty and start a private SearXNG instead (`searchhole searxng up` in a terminal).
3. Ask: *"Use search-hole to find the Node.js 24 release notes, then show the search-hole receipt."* The receipt appears as a card. **Full receipt** lists what was searched and opened; **Block a site…**, shown when a page was opened, opens the full receipt, where each site Claude used has a Block button.
4. See the search in the dashboard: run `searchhole ui --open` in a terminal (see [Before you start](README.md#before-you-start-every-app-except-claude-code) for the `searchhole` command).

Desktop has no way to filter its own search, so search-hole is the search tool here and needs an engine. With no key and no SearXNG, `search` answers with an error, and Claude is told to ask you to set up an engine and not to retry. Add one as described in [Before you start](README.md#before-you-start-every-app-except-claude-code).

## Without the extension: `searchhole setup claude-desktop`

If you already have the `searchhole` command and Node.js 22.19+ on your PATH:

```sh
searchhole setup claude-desktop
```

This adds `search-hole` to `claude_desktop_config.json`, in `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows or `~/.config/Claude/` on Linux. Then quit Claude Desktop completely and open it again. Store keys with `searchhole keys set tavily`, because this file can't refer to a variable.

To do it by hand, open **Settings → Developer → Edit Config** and add this inside `mcpServers`, with your path:

```json
"search-hole": {
  "command": "node",
  "args": ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "claude-desktop"]
}
```

Install only one of the two (extension or config entry). With both, Claude sees the tools twice.

## What works here

| | |
|---|---|
| Host profile | `claude-desktop` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | No. Claude Desktop's built-in web search isn't filtered: search-hole is an extra search tool. |
| Receipt panel | Yes, with the "Block a site…" button (the app-only `apply_rule` tool; Claude can't press it) |
| Keys | The extension's settings (system keychain), or `searchhole keys set <engine>` |

## Troubleshooting

- *The server doesn't start (config entry):* Desktop may not see a Node.js installed through nvm or similar. Use the extension, or give the full path to `node` as `command`.
- *Logs:* `~/Library/Logs/Claude/mcp-server-search-hole.log` (macOS), `%APPDATA%\Claude\logs` (Windows).

## Uninstall

- Extension: **Settings → Extensions → search-hole → Uninstall**.
- Config entry: delete the `"search-hole"` entry from `claude_desktop_config.json` (or restore the `.bak-…` copy that `setup` saved), then restart Claude Desktop.

Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
