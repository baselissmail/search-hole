# search-hole in OpenAI Codex

Codex (the CLI, the IDE extension and the desktop app share one config) gets search-hole's four tools. There are two ways in: one command that edits `~/.codex/config.toml`, or the hookless Codex plugin.

## Quickstart (about 60 seconds)

You need Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Add search-hole to Codex:

   ```sh
   searchhole setup codex
   ```

   It appends this table to `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows, or `$CODEX_HOME/config.toml`), with your path:

   ```toml
   [mcp_servers.search-hole]
   command = "node"
   args = ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "codex"]
   ```

   Everything else in the file stays as it was, and the old file is saved as `config.toml.bak-<time>`.
2. Start a new Codex session. `codex mcp list` should show `search-hole`.
3. Ask: *"Use search-hole to find the Node.js 24 release notes, and cite your sources with dates."*
4. Run `searchhole log` or `searchhole ui --open` to see the search.

To add it by hand instead: `codex mcp add search-hole -- node "/path/to/search-hole/dist/searchhole.mjs" mcp --host codex`.

For one project only: `searchhole setup codex --project` writes `.codex/config.toml` in the current folder. Codex reads it only in projects you have trusted.

## The Codex plugin

The plugin (`distribution/codex/`) is the same server in the Agent Plugins layout: a root `plugin.json` and `mcp.json`, plus a research skill. It has **no hooks**, because OpenAI's plugin directory does not list plugins with lifecycle hooks. To try a local build:

```sh
node scripts/build-plugin.mjs --target codex
codex plugin marketplace add "<repo>/distribution/out/codex-marketplace"
```

Then run `codex`, type `/plugins`, install **search-hole** from **search-hole-local**, and start a new session. Use the plugin or the config entry, not both.

## What works here

| | |
|---|---|
| Host profile | `codex` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule`. Never `apply_rule`: Codex doesn't render MCP Apps and may show app-only tools to the model. |
| Hooks | None, by design (see above). Codex's own web search isn't filtered; ask for search-hole by name, or turn Codex's web search off in its settings. |
| Receipt panel | No. The receipt comes back as text. |
| Project rules | With `setup`, the server starts where Codex runs it. The plugin starts in its own folder, so a project's `.searchhole.yaml` isn't found there. |

## Keys

Codex passes only a few basic variables to MCP servers. A key in your shell (`TAVILY_API_KEY`) doesn't reach search-hole unless the table lists it. Pick one:

- **Keychain (recommended):** `searchhole keys set tavily`. Nothing goes in Codex's config.
- **Forward a variable by name:** `searchhole setup codex --env TAVILY_API_KEY` adds `env_vars = ["TAVILY_API_KEY"]`. The key itself never goes in the file.

## Troubleshooting

- *search-hole doesn't start within 10 seconds:* check `node --version` in the same terminal you start Codex from. Add `startup_timeout_sec = 20` to the table if your disk is slow. `setup` keeps any key you add.
- *Disabled:* `enabled = false` in the table turns it off. `setup` leaves it in place and tells you.

## Uninstall

- Config entry: delete the `[mcp_servers.search-hole]` table from `config.toml` (or restore the `.bak-…` copy), or turn it off with `enabled = false`.
- Plugin: remove it in `/plugins`, then `codex plugin marketplace remove search-hole-local`.

Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
