# search-hole in your AI app

search-hole is one local program. Every app below starts it the same way, as an MCP server: `node <path>/searchhole.mjs mcp --host <profile>`. Only the way you add it, and what the app can do with it, differ.

| App | Guide | How you add it | Host profile | Hooks | Receipt panel | Panel buttons | Built-in search filtered |
|---|---|---|---|---|---|---|---|
| Claude Code | [claude-code.md](claude-code.md) | plugin | `claude-code` | yes | no (text receipt) | n/a | yes |
| Claude Desktop | [claude-desktop.md](claude-desktop.md) | extension (`.mcpb`), or `searchhole setup claude-desktop` | `claude-desktop` | no | yes | yes | no |
| OpenAI Codex | [codex.md](codex.md) | `searchhole setup codex`, or the Codex plugin | `codex` | no (hookless by design) | no | no | no |
| Cursor | [cursor.md](cursor.md) | `searchhole setup cursor`, or the Cursor plugin | `cursor` | no (see the guide) | yes | yes | no |
| VS Code (Copilot) | [vscode.md](vscode.md) | `searchhole setup vscode` | `vscode` | no | yes | yes | no |
| Windsurf (Devin Desktop) | [windsurf.md](windsurf.md) | `searchhole setup windsurf` | `generic` | no | unknown | no | no |
| Zed | [zed.md](zed.md) | `searchhole setup zed` | `zed` | no | no | no | no |
| Goose | [goose.md](goose.md) | `searchhole setup goose` | `goose` | no | yes | no (the panel shows commands instead) | no |
| Any other MCP app | [generic.md](generic.md) | `searchhole setup generic` prints a snippet | `generic` | no | depends on the app | no | no |

What the columns mean:

- **Host profile** is the `--host` value. It decides which internal tools the gateway registers (ADR-0012). Every app gets the four tools the model uses: `search`, `fetch`, `receipt` and `suggest_rule`.
- **Hooks** run search-hole when the app does something, such as before a built-in web search or at the end of a turn. Only Claude Code has hooks that can call the gateway, so only Claude Code gets the one-line receipt after each turn and the guard against the model editing your rules.
- **Receipt panel** is the receipt card shown as an MCP App inside the chat. Apps that don't render MCP Apps get the same receipt as text.
- **Panel buttons** ("Block a site…") use the app-only `apply_rule` tool. They are only on hosts that hide app-only tools from the model and let a panel call the server. Codex and Zed never get `apply_rule`.
- **Built-in search filtered** means search-hole applies your rules to the app's own web search. Only Claude Code allows that (ADR-0018). In every other app search-hole is an extra search tool: it needs an engine, and the app may still use its own search unless you ask for search-hole or turn the built-in one off.

## Before you start (every app except Claude Code)

1. **Node.js 22.19 or newer** must be on your PATH: `node --version`. Apps started from the Dock or the Start menu may not see a Node.js installed by nvm, fnm, mise or similar; see each guide's troubleshooting.
2. **The `searchhole` command.** Once search-hole is on npm, install it with:

   ```sh
   npm install -g search-hole
   ```

   Until then, use a checkout. Build it once with `node scripts/build-plugin.mjs` (this needs [mise](https://mise.jdx.dev)), then run `node "<repo>/packages/search-hole/dist/searchhole.mjs"` wherever these guides say `searchhole`. `setup` writes the path of the copy you run into the app's config, so run it from a copy that stays put: a global install or your checkout, not `npx` (npx's cache can be deleted).
3. **An engine.** Outside Claude Code, search-hole needs one. The quickest is a free Tavily key (1,000 searches a month, no card, from https://app.tavily.com), kept in your OS keychain:

   ```sh
   searchhole keys set tavily
   ```

   Or run a private SearXNG in Docker with `searchhole searxng up`. `searchhole doctor` checks either.

## What `searchhole setup` does

`searchhole setup <app>` adds one entry named `search-hole` to the app's own config file:

- It **keeps everything else**: other servers, other settings and, in files that allow them, comments.
- It **saves the old file first**, next to it, as `<file>.bak-<time>`.
- It **refuses a file it can't read** instead of guessing, and prints what to add by hand.
- It **never writes a key.** `--env NAME` lets the app pass an environment variable through, by name only. Keys stored with `searchhole keys set` need nothing at all.

`--dry-run` shows the change and writes nothing. `--project` writes the project's file instead of your user file (VS Code, Cursor, Zed and Codex). Running it again changes nothing.

## Check that it works

Ask the app something that needs the web, for example: *"Use search-hole to find the Node.js 24 release notes, and cite your sources with dates."* Then:

```sh
searchhole log          # the search you just made
searchhole ui --open    # the dashboard: live log, rules, engines
```

## Sources

Formats and file locations were checked on 2026-10-31 against these sources. Where a source didn't settle a question, the open questions below say what was chosen.

| App | What was checked | Source |
|---|---|---|
| Codex | `~/.codex/config.toml` (and `.codex/config.toml` in trusted projects), `[mcp_servers.<name>]` with `command`, `args`, `env`, `env_vars`, `cwd`, `startup_timeout_sec`, `enabled`; `codex mcp add` | https://learn.chatgpt.com/docs/extend/mcp?surface=cli (redirect from developers.openai.com/codex/mcp) |
| Codex | Plugin layout: root `plugin.json` plus `mcp.json` (Agent Plugins), Codex fields under `extensions.com.openai`, `.codex-plugin/plugin.json` as a compatibility fallback, `.agents/plugins/marketplace.json`, `codex plugin marketplace add`, and "Plugins containing lifecycle hooks aren't eligible for the public plugin directory" | https://developers.openai.com/plugins/build/plugins, https://learn.chatgpt.com/docs/plugins |
| Codex | Agent Plugins 1.0: required `$schema`, the name pattern, stdio `type`/`command`/`args`/`env`/`cwd`, only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expanded (in `args`, `env` values and `cwd`, never in `command`), no secrets in `env`, `skills/<name>/SKILL.md` | https://agent-plugins.org/specification, https://agent-plugins.org/schemas/1.0.0/plugin.schema.json, https://agent-plugins.org/schemas/1.0.0/mcp.schema.json |
| Cursor | `~/.cursor/mcp.json` and `.cursor/mcp.json`, `mcpServers` with `type: "stdio"`, `command`, `args`, `env`, `envFile`, `${env:NAME}` interpolation, MCP Apps supported | https://cursor.com/docs/context/mcp |
| Cursor | `.cursor-plugin/plugin.json` fields, `mcp.json` at the plugin root, `${CURSOR_PLUGIN_ROOT}` (not `${PLUGIN_ROOT}`), plugin variables set by team admins, local plugins in `~/.cursor/plugins/local/` | https://cursor.com/docs/plugins, https://cursor.com/docs/reference/plugins |
| Cursor | Hooks: command (and prompt) hooks only, plugin hooks command-only, `preToolUse` tool names, `postToolUse` rewrites MCP output only, fail-open by default | https://cursor.com/docs/agent/hooks |
| VS Code | `.vscode/mcp.json` and the user-profile `mcp.json` ("MCP: Open User Configuration"), top-level `servers`, `type: "stdio"`, `${env:NAME}`, `code --add-mcp` (page dated 2026-10-28) | https://code.visualstudio.com/docs/copilot/reference/mcp-configuration |
| Windsurf | Renamed Devin Desktop. Cascade's `mcp_config.json` is `~/.config/devin/mcp_config.json` (`$XDG_CONFIG_HOME/devin/…`, `%AppData%\devin\…` on Windows); before the rename it was `~/.codeium/windsurf/mcp_config.json`; `mcpServers`; `${env:NAME}` in `command`, `args` and `env` | https://docs.devin.ai/windsurf/plugins/cascade/mcp.md, https://docs.devin.ai/cli/extensibility/mcp/configuration.md, https://docs.devin.ai/cli/reference/configuration/read-config-from.md |
| Zed | `context_servers` with `command`, `args`, `env` (no `source` key any more), user settings at `~/.config/zed/settings.json` (macOS), `$XDG_CONFIG_HOME/zed` or `$FLATPAK_XDG_CONFIG_HOME/zed` (Linux), `%APPDATA%\Zed` (Windows), project `.zed/settings.json` | https://zed.dev/docs/ai/mcp; source: `zed-industries/zed` `crates/paths/src/paths.rs` and `crates/settings_content/src/project.rs` (main) |
| Goose | `extensions:` entries with `type: stdio`, `cmd`, `args`, `enabled`, `envs`, `env_keys`, `timeout`; config at `$XDG_CONFIG_HOME/goose` or `~/.config/goose` (macOS, Linux), `%APPDATA%\Block\goose\config` (Windows), `GOOSE_PATH_ROOT` overrides; `env_keys` read from the environment, then goose's secret store | https://goose-docs.ai/docs/getting-started/using-extensions; source: `aaif-goose/goose` `crates/goose/src/config/paths.rs`, `crates/goose/src/agents/extension.rs`, `crates/goose/src/config/extensions.rs`, `crates/goose/src/config/base.rs` (main) |
| Claude Desktop | `claude_desktop_config.json` at `~/Library/Application Support/Claude/` (macOS), `%APPDATA%\Claude\` (Windows), `~/.config/Claude/` (Linux); extensions are the recommended way | https://modelcontextprotocol.io/docs/develop/connect-local-servers, https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop |
| Claude Code | Plugins, `mcp_tool` hooks, MCP Apps not rendered | [ADR-0014](../adr/0014-claude-code-hook-integration.md), [platform-facts-mcp.md](../research/platform-facts-mcp.md) |

### Open questions, and what was chosen

- **VS Code user file per OS.** The official page says only "your user profile". `setup` uses VS Code's user folder: `~/Library/Application Support/Code/User/mcp.json` (macOS), `$XDG_CONFIG_HOME/Code/User` or `~/.config/Code/User` (Linux) and `%APPDATA%\Code\User` (Windows). Third-party guides agree. A non-default profile or VS Code Insiders keeps its own file; use **MCP: Open User Configuration** to see yours.
- **Comments in Cursor's `mcp.json`.** This isn't documented. Cursor is a VS Code fork and its own docs example has a `//` comment, so `setup` treats the file as JSON with comments and keeps them. Windsurf and Claude Desktop files are treated as plain JSON, so a comment there makes `setup` refuse.
- **Environment passed to servers.** Cursor and Zed don't document whether a server sees the app's environment, and Codex forwards only what `env_vars` lists. That is why the guides recommend `searchhole keys set` (the keychain), which needs no environment at all.
- **Codex.** The docs don't say which Codex version first reads a root `plugin.json`, or what arguments `codex plugin marketplace remove` takes. Check `codex plugin marketplace --help`.
- **Windsurf.** The folders are poor signals: the Devin CLI also creates `~/.config/devin`, and Devin Desktop keeps using `~/.codeium/windsurf` for other data. So `setup` writes `~/.config/devin/mcp_config.json` if that file exists. Otherwise it writes `~/.codeium/windsurf/mcp_config.json` if Windsurf's file or folder exists (a Windsurf from before 3.0), and Devin's file if neither does. **Open MCP config file** in Cascade shows which file an install reads. Whether pre-rename builds expand `${env:NAME}`, and whether Devin Desktop renders MCP Apps, wasn't found.
- **Cursor hooks.** Cursor's hooks can't call an MCP tool, so the Cursor plugin ships without hooks. [cursor-plugin/README.md](../../distribution/cursor-plugin/README.md) explains why.
