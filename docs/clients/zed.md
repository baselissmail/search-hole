# search-hole in Zed

Zed's Agent panel gets search-hole's tools as a context server.

## Quickstart (about 60 seconds)

You need Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Add search-hole:

   ```sh
   searchhole setup zed
   ```

   It adds `search-hole` under `context_servers` in your Zed settings: `~/.config/zed/settings.json` on macOS and Linux (`$XDG_CONFIG_HOME/zed/` if you set it on Linux), `%APPDATA%\Zed\settings.json` on Windows. Your other settings and comments stay, and the old file is saved as `settings.json.bak-<time>`.
2. Zed reloads its settings by itself. Open the Agent panel's settings: search-hole should have a green dot.
3. Ask the agent: *"Use search-hole to find the Node.js 24 release notes, and cite your sources with dates."*
4. Run `searchhole log` or `searchhole ui --open` to see the search.

For one project only: `searchhole setup zed --project` writes `.zed/settings.json` in the current folder. Zed starts a project's servers only in a project you trust.

By hand (**zed: open settings file**), add this, with your path:

```json
"context_servers": {
  "search-hole": {
    "command": "node",
    "args": ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "zed"]
  }
}
```

## What works here

| | |
|---|---|
| Host profile | `zed` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule`. Never `apply_rule`: Zed doesn't render MCP Apps and may show app-only tools to the model. |
| Hooks | None |
| Receipt panel | No. The receipt comes back as text. |

## Keys

Zed's `env` takes literal values only, and a key must never go in your settings. Use the keychain:

```sh
searchhole keys set tavily
```

## Troubleshooting

- *Red dot:* Zed may not find `node` when it starts outside a terminal. Check **zed: open log**. If you need to, use the full path to `node` as `command`.
- *Turned off:* `"enabled": false` in the entry turns it off. `setup` leaves it in place and tells you.

## Uninstall

Delete the `"search-hole"` entry from `context_servers` (or restore the `.bak-…` copy). Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
