# search-hole in Goose

Goose (CLI and Desktop) gets search-hole as a command-line extension. The receipt card renders in Goose Desktop.

Status: the config search-hole writes is checked by tests; this guide has not yet been tried in the real app.

## Quickstart

You need Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Add search-hole:

   ```sh
   searchhole setup goose
   ```

   It shows the lines it will add and asks before it writes. Then it adds an extension named `search-hole` to goose's `config.yaml`: `~/.config/goose/config.yaml` on macOS and Linux (`$XDG_CONFIG_HOME/goose/` if you set it), `%APPDATA%\Block\goose\config\config.yaml` on Windows, or under `$GOOSE_PATH_ROOT/config/` if you use that. Other extensions, settings and comments stay, and the old file is saved as `config.yaml.bak-<time>`.
2. Start a new session (`goose session`), or restart Goose Desktop. search-hole is listed under Extensions.
3. Ask: *"Use search-hole to find the Node.js 24 release notes, then show the search-hole receipt."*
4. Run `searchhole log` or `searchhole ui --open` to see the search.

By hand, add this under `extensions:`, with your path:

```yaml
  search-hole:
    enabled: true
    type: stdio
    name: search-hole
    cmd: node
    args:
    - /path/to/search-hole/dist/searchhole.mjs
    - mcp
    - --host
    - goose
    envs: {}
    timeout: 300
```

## What works here

| | |
|---|---|
| Host profile | `goose` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | None. Goose's own tools aren't filtered. |
| Receipt panel | Yes in Goose Desktop (MCP Apps). Goose doesn't let a panel call the server, so the panel shows the matching command instead of a button. |
| Sessions | Goose sends a session id and working folder, so receipts follow the session and project rules apply. |

## Keys

- **Keychain (recommended):** `searchhole keys set tavily`.
- **Through goose:** `searchhole setup goose --env TAVILY_API_KEY` adds `env_keys: [TAVILY_API_KEY]`. Goose then reads `TAVILY_API_KEY` from its environment or its own secret store (`goose configure`). Only the name goes in the file.

## Uninstall

Remove it in Goose (Desktop: **Extensions** → search-hole → turn it off, then **Remove Extension**; CLI: `goose configure` → **Remove**), or delete `extensions → search-hole` from `config.yaml`. Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
