# ADR-0007: API key storage and resolution

- **Status:** Accepted (2026-10-30)
- **Related:** [0002](0002-runtime-and-packaging.md), [0009](0009-engine-adapter-interface.md)

## Context

Keys reach the gateway in different ways per host. The CLI and dashboard can't read host-injected values. And §4 wants no native dependencies. Verified facts ([platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §B; [platform-facts-engines-lists-versions.md](../research/platform-facts-engines-lists-versions.md) key answer 14; [mcpb.md](../research/mcpb.md)):

- **Claude Code `userConfig` with `sensitive: true`** is stored in the **macOS Keychain**, but on Linux and Windows in **`~/.claude/.credentials.json`** (a file). Hooks get `CLAUDE_PLUGIN_OPTION_<KEY>`. `${user_config.KEY}` is substituted into the MCP server's `env`.
- **MCPB `user_config` with `sensitive: true`** is stored in the OS keychain by Desktop (per Anthropic's docs). An **unset optional value arrives as the literal string `${user_config.brave_api_key}`**. A **required** value that is missing stops Desktop from launching the server at all. These last two come from reading the mcpb source ([mcpb.md](../research/mcpb.md), not second-pass verified), so tests cover them.
- **Claude Code can strip credentials from subprocess environments.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes credential-looking variables from hook and MCP environments. `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1` passes only a baseline plus the configured `env`.
- **The MCP Inspector passes only `HOME, LOGNAME, PATH, SHELL, TERM, USER`** plus the configured `env` to the servers it spawns.
- **OS stores without native modules:**
  - macOS: `security` (feed `-i` on stdin to keep secrets out of argv). Any same-user process can read the item back.
  - Linux: `secret-tool` works only with a running Secret Service, so it fails on headless and SSH hosts.
  - Windows: `cmdkey` can't read secrets back. DPAPI via PowerShell `ConvertFrom-SecureString` to a file works.
  - Native modules: `@napi-rs/keyring` is healthy but silently falls back to a non-persistent store on Linux unless pinned. `keytar` is archived.
- Brave's own tooling uses `BRAVE_SEARCH_API_KEY` ([brave-search-skills.md](../research/brave-search-skills.md)).

## Decision

1. **Resolution order, evaluated per engine call** (cached for 60 s, not frozen at import, so "paste a key in `doctor`" works without restarting the host):
   1. **Host-injected:** `SEARCHHOLE_<ENGINE>_API_KEY`, set by our own host configs from `userConfig` or `user_config`. An empty or whitespace-only value, or one matching `/^\$\{[^}]+\}$/`, counts as **unset**. The same applies at every level below.
   2. **Process env, conventional names:** `BRAVE_SEARCH_API_KEY` (also `BRAVE_API_KEY`), `TAVILY_API_KEY`, `EXA_API_KEY`, `KAGI_API_KEY`, `MOJEEK_API_KEY`, `MARGINALIA_API_KEY`. Each also accepts a `*_FILE` variant pointing at a file that holds the key (Docker or secret managers). Setting both a name and its `*_FILE` is an error.
   3. **search-hole's own store** (point 2).

   The winning source is recorded per engine (`host-env | env | env-file | keychain | dpapi | file`) and written to `engine_health.key_source`, together with `key_present`. The dashboard and `doctor` can then show "Brave: set (via Claude Code plugin config)" for a key they can't read.
2. **Own store: OS facilities via OS CLI tools.** There are no native modules and no secrets in argv.
   - **macOS:** `security add-generic-password` / `find-generic-password -w`, run through `security -i` with commands on stdin. The service is `search-hole`, the account `<engine>`. The key is trimmed, and **keys containing whitespace, `"` or `\` are rejected**, since `security -i` parses the line.
   - **Linux:** `secret-tool store` / `lookup`, with the secret on stdin. It is used only after a write-and-read-back probe succeeds.
   - **Windows:** a DPAPI-protected file (`<data>/secrets/<engine>.dpapi`, user scope).
     - It is written by `powershell -NoProfile -NonInteractive -Command "$k=[Console]::In.ReadLine(); ConvertTo-SecureString -String $k -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:SEARCHHOLE_DPAPI_OUT"`.
     - **The key arrives on stdin as data, never in the script text**, so it never lands in argv or in the ScriptBlock event log.
     - It is read back the same way, with `ConvertTo-SecureString`.
   - **No OS store** (headless Linux, a locked keychain): `searchhole keys set` **refuses** and explains the env-var and `*_FILE` options. It does not invent a weaker store. `--insecure-file` is an explicit opt-in that writes a plaintext `0600` file, and `doctor` warns about it permanently.
3. **Writers and readers:**
   - Only the CLI writes keys (`searchhole keys set <engine>`, which reads from the TTY with echo off or from stdin, never from argv), plus the dashboard's "set key" form, which hands the key to the same code path.
   - **The gateway only reads and never prompts.** It runs with no TTY under a host.
   - Form elicitation is never used for keys (the spec forbids it).
4. **Never display or log a value.**
   - pino redaction covers every `*_API_KEY`, `*_TOKEN`, `Authorization` and `X-Subscription-Token` field, and query parameters named like secrets.
   - Surfaces show only presence and source. Unlike docker/mcp-gateway's `maskSecret`, we show no "first 4 characters", because prefixes like `sk-a` identify the key.
   - A key forced by the environment is shown **locked**: "set via environment; change it there". The dashboard never writes it back (Pi-hole FTL's env-override UX).
5. **Keys are bound to their engine origin.** The engine transport sends a key only to its configured origin, and strips any engine auth header on a cross-origin redirect. undici only strips `Authorization` by default, not `X-Subscription-Token` or `x-api-key`.
6. **Config files refuse secrets:**
   - `rules.yaml` and `.searchhole.yaml` loaders reject fields named like secrets (`api_key`, `token`, `password`, `secret`), and values that match token patterns (`sk-…`, `ghp_…`, long base64 or hex strings next to a key-like name). The error points to `searchhole keys set`.
   - `.searchhole.yaml` can never name engine endpoints or keys (§12.4, ADR-0008).
7. **`doctor` diagnostics:**
   - "key configured in the host but not visible to the gateway" names `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` and `CLAUDE_CODE_MCP_ALLOWLIST_ENV`;
   - flags an unset MCPB placeholder;
   - flags a key present in the CLI's env but absent from the host's gateway env.
8. **Host config wiring:**
   - The Claude Code plugin maps `userConfig.<engine>_api_key` (`sensitive: true`, never `required`) to `env.SEARCHHOLE_<ENGINE>_API_KEY` in `.mcp.json`.
   - The MCPB maps `user_config.<engine>_api_key` (`sensitive: true`, `required: false`) the same way.
   - Codex and Cursor configs reference env vars only.

## Alternatives considered

- **`@napi-rs/keyring` (native).** Rejected for the default build: it is a native artifact, and it needs pinning to `secret-service` on Linux to avoid silent non-persistence. It becomes the obvious choice if standalone binaries ship (ADR-0002); `Bun.secrets` is another option in that world.
- **An AES-GCM encrypted file with the key in the keychain** (ToolHive). Rejected as unnecessary. If a keychain is available we store the secret there directly. If it isn't, an encrypted file whose key sits beside it is theatre.
- **Reading other tools' key files** (Brave `bx`'s plaintext config). Rejected unless the user explicitly runs `searchhole keys import bx` and confirms.

## Consequences

- PRIVACY.md and the docs must say exactly where keys live per host and OS. That includes "Claude Code on Linux and Windows stores plugin secrets in `~/.claude/.credentials.json`, not a keychain".
- The threat model states: at-rest protection against casual exposure and accidental commits, **not** against malware running as the same user.
- Windows key handling spawns PowerShell (estimated at 300–800 ms; measured in CI), so it is cached per process for 60 s and never sits on the hot path.

## Validate early (P1)

- macOS keychain round-trip via `security -i`, checking no secret appears in `ps` output.
- Linux with and without a Secret Service (container test).
- Windows DPAPI round-trip in CI (`windows-latest`), plus measured PowerShell startup cost.
- The MCPB placeholder string and empty values are treated as unset; host env takes precedence over keychain; a forced env value shows as locked.
- **P1/P3:** with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, and separately with `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`, check whether `SEARCHHOLE_BRAVE_API_KEY` from the plugin's `.mcp.json` `env` reaches the gateway (an open question in the evidence). If it is scrubbed, `doctor` must say so and point to `searchhole keys set`. The plugin's whole key path depends on this.

## Amendment (2026-10-31, v0.1.1): stale-while-revalidate on the engine path

The 60 s cache stays, but the App's engine path now serves an expired entry at once and refreshes it in the background. Concurrent callers share one lookup, and `clear()` (after `keys set/remove` in the same process) stops an in-flight refresh from writing a forgotten value back. Gateways also look keys up in the background at start. Before this, the mode decision on each WebSearch PreToolUse spawned macOS `security` once a minute per keyed engine: 90–110 ms, and up to the 8 s timeout with a locked keychain. A key changed from another process is now seen within one TTL plus one call. `keys status` and `doctor` still read uncached.
