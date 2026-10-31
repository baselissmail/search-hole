# search-hole for OpenAI Codex (plugin)

This folder is the search-hole Codex plugin in the [Agent Plugins](https://agent-plugins.org/specification) layout, which Codex reads:

| File | What it is |
|---|---|
| `plugin.json` | The manifest (Agent Plugins 1.0). Codex-only fields sit under `extensions["com.openai"]`. |
| `mcp.json` | One stdio server: `node ${PLUGIN_ROOT}/dist/searchhole.mjs mcp --host codex`. |
| `skills/research/` | A short research skill: search or fetch, how deep, cite with dates, suggest rules. |

The assembled plugin also holds `dist/` (the built bundle), `assets/logo.png` and `LICENSE`. They are copied in by the build, not committed here.

**It has no hooks, on purpose.** OpenAI's plugin directory does not list plugins that ship lifecycle hooks, so this variant stays hookless (MASTER_PLAN §9.3). It also has none of the Claude Code slash-command skills: those run search-hole's CLI through Claude Code's pre-execution commands, which Codex does not have. Codex gets the four model tools (`search`, `fetch`, `receipt`, `suggest_rule`) and no `apply_rule`, because Codex does not render MCP Apps and may show app-only tools to the model (ADR-0012).

## Build and install a local copy

Needs Node.js 22.19 or newer on your PATH, and a Codex version with plugins.

```sh
node scripts/build-plugin.mjs --target codex
codex plugin marketplace add "<repo>/distribution/out/codex-marketplace"
```

Then run `codex`, type `/plugins`, install **search-hole** from **search-hole-local**, and start a new session. The build prints these steps with your paths. After a rebuild, run it again and start a new Codex session.

Without the plugin, `searchhole setup codex` writes the same server into `~/.codex/config.toml` instead. See [docs/clients/codex.md](../../docs/clients/codex.md).

## Keys

The Agent Plugins format can't reference your environment or hold secrets, so `mcp.json` has no `env`. Store a key in your OS keychain once, and the gateway finds it in every app:

```sh
searchhole keys set tavily
```

## Notes

- Codex starts plugin servers in the plugin's own folder, so a project's `.searchhole.yaml` rules are not picked up from your working directory. Your global rules apply as usual.
- Remove the plugin in `/plugins`, then `codex plugin marketplace remove search-hole-local`.
