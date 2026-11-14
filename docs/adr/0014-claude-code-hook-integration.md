# ADR-0014: Claude Code hook integration

- **Status:** Accepted (2026-10-30; revised the same day after adversarial review)
- **Related:** [0002](0002-runtime-and-packaging.md), [0005](0005-session-definition.md), [0009](0009-engine-adapter-interface.md), [0012](0012-mcp-tool-surface-and-output-limits.md)

## Context

§9.1 asks for two hooks:
- a **PreToolUse hook that fails open**: it denies `WebSearch` (and later `WebFetch`) *only while a healthy engine exists*, and otherwise allows the call with `additionalContext`;
- a **Stop hook** that prints a one-line receipt as `systemMessage`, only for turns that searched.

Principle 3 adds: the model can never change rules itself. Verified hook facts ([platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §D; re-checked in the live docs on 2026-10-30):

- **`mcp_tool` hooks** (v2.1.118+): `{"type":"mcp_tool","server":"plugin:<plugin>:<server>","tool":"…","input":{…}}`.
  - String inputs support `${path}` substitution from the hook's JSON input. **Verified on 2.1.312:** `${session_id}`, `${tool_name}`, `${tool_input.query}` and `${tool_input.command}` work, missing paths become `""`, and `${agent_type}` is `""` for the main agent ([spikes-2026-10-30.md](../research/spikes-2026-10-30.md) §1).
  - **Also verified:** an `mcp_tool` hook can call a tool marked `_meta.ui.visibility: ["app"]`, which Claude Code hides from the model.
  - **Also verified:** SessionStart `mcp_tool` hooks don't run at startup (no MCP context), and UserPromptSubmit fires before any model tool call.
  - The tool's text is parsed like command stdout.
  - **If the server isn't connected, the hook gives a non-blocking error and execution continues** (fail-open by design).
  - On blocking events, Claude Code waits for a connecting server up to `MCP_TIMEOUT`.
  - `onFailure` is documented only for command and HTTP hooks.
- **Command hooks:**
  - Exec form (`command` + `args`, v2.1.139+) needs no shell, but on Windows it needs a real `.exe`.
  - Shell form runs under `sh -c` (macOS, Linux), Git Bash, or **PowerShell when Git Bash is absent**. There, a failing hook **blocks the tool** unless `onFailure: "continue"` (v2.1.295+) is set.
- **Output traps:**
  - On **Stop**, `additionalContext` or `decision: "block"` **makes Claude keep working**.
  - `suppressOutput` no longer has any effect.
  - Output strings are capped at 10,000 characters.
- **Deny reasons and naming:** `permissionDecision: "deny"`'s reason is shown to Claude. Plugin tools are named `mcp__plugin_search-hole_search-hole__<tool>`. Subagents may not have every MCP tool.
- **A plugin can't ship permission rules** (only `agent` and `subagentStatusLine` take effect from plugin settings).
- **In Claude Code the model has Bash, Edit and Write.** It can run any CLI the user can, including ours, and edit our YAML files.
- **Hook precedent:** nightshift dot-sources a sh/PowerShell polyglot `.ps1` launcher from shell-form hooks: `". \"${CLAUDE_PLUGIN_ROOT}/hooks/dispatch/claude-hardhat.ps1\""` ([nightshift.md](../research/nightshift.md), checked in the ref).

## Decision

**The gateway answers every hook through `mcp_tool` hooks.** The only shell code is the Node preflight.

`hooks/hooks.json` (shape; exact `${…}` substitutions confirmed by the spike):

```json
{
  "hooks": {
    "SessionStart": [ { "hooks": [
      { "type": "command", "command": ". \"${CLAUDE_PLUGIN_ROOT}/hooks/preflight.ps1\"", "onFailure": "continue", "timeout": 5 },
      { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
        "input": { "event": "SessionStart", "sessionId": "${session_id}", "source": "${source}" } } ] } ],
    "UserPromptSubmit": [ { "hooks": [
      { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
        "input": { "event": "UserPromptSubmit", "sessionId": "${session_id}" } } ] } ],
    "PreToolUse": [ { "matcher": "WebSearch|WebFetch|Bash|Edit|Write", "hooks": [
      { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
        "input": { "event": "PreToolUse", "sessionId": "${session_id}", "agentType": "${agent_type}",
                   "toolName": "${tool_name}", "query": "${tool_input.query}",
                   "command": "${tool_input.command}", "filePath": "${tool_input.file_path}" } } ] } ],
    "Stop": [ { "hooks": [
      { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
        "input": { "event": "Stop", "sessionId": "${session_id}" } } ] } ]
  }
}
```

### 0. The `hook` tool is invisible to the model

`hook` is registered with `_meta.ui.visibility: ["app"]`. Claude Code hides it from the model's tool list and still routes `mcp_tool` hooks to it (verified). The forgery defences below therefore guard against a future host behaving differently, not against today's Claude Code.

### 1. Turn bracketing and session keys (forge-resistant)

- **`UserPromptSubmit` opens a turn.** It fires before any model tool call in that turn. **`Stop` closes it.** The gateway keeps `turnOpen` per session.
- **Re-keying the session id happens only on `SessionStart`** with `source ∈ {startup, resume, clear, compact}` **or on `UserPromptSubmit`, and only while no turn is open.**
  - Model-initiated tool calls happen *inside* a turn, so a forged `hook` call from the model (or injected content) can't re-key the session or open a turn.
  - `PreToolUse` and `Stop` never re-key.
  - `Stop` closes the turn only if `sessionId` equals the current key.
  - A `search`/`fetch` arriving after a Stop and before the next UserPromptSubmit marks that Stop as suspect: the turn is reopened and the event logged.
  - Every re-key and close is logged to the session's receipt history.
- **Session-scope rules survive a re-key from the same `CLAUDE_PROJECT_DIR`.** They are dropped only on `SessionStart(source=clear)`, matching "a fresh conversation" (ADR-0005).

### 2. PreToolUse on `WebSearch` / `WebFetch`: fail-open steering (**`engines` mode only**; the default `builtin` mode filters instead, see [ADR-0018](0018-claude-code-builtin-search-mode.md))

- **Deny `WebSearch` only if all of these hold:**
  - At least one engine in the plan this session's `search` would use (active profile plus fallback chain) is **`healthy`**: a successful call or probe within the last 10 minutes, and not suspended or capped (health states are defined in ADR-0009).
  - The **last search attempt in this process did not fail on every engine**.
  - The engine state isn't merely `unknown`. On `unknown` (for example a fresh install), the gateway runs a **bounded probe** of ≤ 500 ms: SearXNG `GET /config` plus a JSON check; for keyed engines, the key is present and has not been rejected. If the probe fails, WebSearch is allowed.

  The deny reason is short:
  > `search-hole is active: use mcp__plugin_search-hole_search-hole__search (and __fetch for pages) instead of WebSearch; site: operators work. It applies the user's source rules.`
- **Otherwise allow, with `additionalContext`:**
  > `search-hole has no healthy engine (brave: key invalid). Built-in WebSearch allowed. Tell the user to run /search-hole:doctor.`
- **Deny-loop breaker:**
  - The gateway records `lastDeny[sessionId]`.
  - If the next `PreToolUse(WebSearch)` for that session arrives with **no `search` call since the deny**, the caller evidently can't use our tool (a subagent without our MCP tool, a restricted tool list). The call is **allowed**, with `additionalContext` saying so.
  - `agentType` is logged so evals can show which agents can't see the tool.
- **`WebFetch` is allowed** (with an `additionalContext` nudge) until our `fetch` passes the parity gate defined in ADR-0011: PDFs, and long pages via `cursor`. After that, it follows the WebSearch rule.
- **If the gateway is down,** the `mcp_tool` hook fails open by itself.

### 3. PreToolUse on `Bash` / `Edit` / `Write`: guarding rule changes

This guards against the model changing rules (Principle 3). **Deny**, with a reason pointing to `suggest_rule`, when:
- a Bash `command` invokes search-hole's rule-changing verbs: the CLI path or the `searchhole`/`search-hole` command with `block|allow|pin|lower|raise|normal|rules|trust|keys|suggestions approve|enforce|unenforce|lists`;
- an `Edit`/`Write` targets `rules.yaml`, `.searchhole.yaml`, or anything under the search-hole data root.

All other Bash/Edit/Write calls get an immediate allow, with no output, and the check is a plain string match in-process.

**This is defence in depth, not a guarantee.** A model with shell access can always obfuscate, so SECURITY.md says so honestly. The real boundaries are:
- **No MCP tool changes rules.**
- **Rule-changing slash commands are skills with `disable-model-invocation: true`.** They run the CLI through the skill's pre-execution command injection, so the user's own action runs it. The skill text never hands the model a command to run.
- **`suggest_rule` returns an approval *instruction for the user*** ("type `/search-hole:approve 3`"), not a shell command (ADR-0012).
- **Claude Code's permission prompts still apply** to Bash.

### 4. Stop

- Closes the turn's receipt.
- If the turn had ≥ 1 search, it returns only `{"systemMessage": "search-hole · 6 searches · 41 results · 9 hidden · sources: 3 official, 2 blogs · ⚠ 1 stale (2022)"}`. Otherwise it returns `{}`.
- It **never** returns `additionalContext` or `decision`.
- Off with setting `hooks.receiptLine: false` (ADR-0015).

### 5. SessionStart preflight

- **The one shell-form hook:** `". \"${CLAUDE_PLUGIN_ROOT}/hooks/preflight.ps1\""`. That is one escape layer, with a `.ps1` extension so PowerShell can dot-source it.
- **The file is a sh/PowerShell polyglot** (the sh body outside a `<# … #>` block, as in nightshift; MIT, attributed). It runs under `sh -c`, Git Bash and PowerShell.
- **It needs no Node and no network.**
- **What it checks and prints:**
  - **Node missing or older than 22.13:** it prints `{"systemMessage":"search-hole needs Node.js 22.13+ … then run /mcp → reconnect search-hole"}`.
  - **Node present and recent enough:** it prints nothing.
- **It never blocks:** `onFailure: "continue"`, and a 5 s timeout.

### 6. Modes

`hooks.mode` (ADR-0015; also via plugin `userConfig` → `SEARCHHOLE_HOOK_MODE`):

| Mode | Behaviour |
|---|---|
| `steer` (default) | As above |
| `strict` | Deny WebSearch even when unhealthy, with an explanation. It disappears with the plugin |
| `off` | Always allow (the Bash/Edit guard stays on unless `hooks.guard: false`) |

**`/search-hole:enforce`** sets `strict`. As an explicit second step, with a warning that the rules **persist after uninstall**, it offers to write marker-tagged `permissions.deny` entries to `~/.claude/settings.json`. `/search-hole:unenforce` removes exactly those entries. `doctor` detects marker-tagged deny rules while the plugin is absent and says how to remove them.

### 7. Minimum Claude Code version: **2.1.296**

That covers `onFailure` (2.1.295), the 4,096-character `instructions` cap (2.1.296; ADR-0012), exec form (2.1.139), `CLAUDE_CODE_SESSION_ID` for MCP (2.1.154), the resume fix (2.1.163) and `mcp_tool` hooks (2.1.118). Manifests have no minimum-version field, so `doctor` checks and reports it.

## Alternatives considered

- **Node command hooks reading a heartbeat file and the DB** (the plan's default). This is the fallback if the spike shows `mcp_tool` substitution doesn't work. Downsides:
  - one Node spawn per hooked tool call, which matters now that Bash is matched;
  - a heartbeat race;
  - no exact session correlation;
  - Windows shell-failure risk.
- **Bash-only hooks with state files** (nightshift style). These have the same correlation and race problems.
- **Reading the transcript in Stop.** Rejected: it is written asynchronously (ADR-0005).
- **A model-visible `hook` tool.** It was the original plan when hiding seemed impossible. Rejected now that the spike showed app-only visibility works in Claude Code (point 0).

## Consequences

- PreToolUse is exact and current. A dead gateway, an unknown or failing engine, or an agent that can't see our tool all leave built-in search working (§1's promise).
- Matching `Bash|Edit|Write` puts an in-process string check on every such call: a local MCP round-trip of a few ms. Plugin evals measure it.
- Cursor and Codex hooks have their own event schemas and are designed in P7. Cursor also loads this Claude plugin, which is handled by host detection (ADR-0012).

## Validate early

**Done in the 2026-10-30 spike** (Claude Code 2.1.312, macOS; [spikes-2026-10-30.md](../research/spikes-2026-10-30.md) §1):
- ✅ the substitutions;
- ✅ UserPromptSubmit fires before any tool call;
- ✅ a deny steers the model to `search` (one-shot test);
- ✅ the Stop `systemMessage` shows once, with no continuation;
- ✅ the preflight runs via `sh` from the literal hooks.json command;
- ✅ an app-only `hook` is hidden from the model but callable by hooks.

**Still to do, before or in P3:**
1. Steering measured over many cases in plugin evals against a no-plugin baseline. The deny-loop breaker frees a subagent without our tool. `${source}` substitution on SessionStart after `/clear`.
2. Fail-open on macOS, Linux and Windows (with and without Git Bash): the gateway is down, the engine unknown, or all engines failing.
3. The preflight via Git Bash and `powershell -Command` with `node` removed from PATH.
4. Re-run the spike on the minimum supported version (2.1.296).

## Amendment (2026-10-31, v0.1.1): review fixes

- **Point 1, turn bracketing.** A `UserPromptSubmit` now always replaces an open turn, whatever its session id. An interrupt (no Stop), then `/clear`, then a prompt within 10 s used to be refused as `turn_active`. That left the gateway keyed to the old conversation: its session rules applied, and the new searches were logged under it. Point 0 makes prompt events genuine in Claude Code. `SessionStart` from another session still replaces only an idle turn. Tool hooks act for their own `session_id`, and a hook from another session doesn't keep a turn alive. Built-in `WebSearch`/`WebFetch` after a Stop reopens the turn the same way our `search`/`fetch` do, and the App reopens the stopped receipt instead of minting a new one. A re-keying `SessionStart` passes its source to `rekeySession` (ADR-0005: resume and compact carry session rules; clear drops them).
- **Point 3, the Bash guard.** It now scans shell words instead of matching a regex anywhere in the command. A verb counts only when search-hole's CLI is the command being run, directly or through `env`, `sudo`, `timeout`, `xargs`, `npx`/`pnpm dlx`, `node <script>`, a `dev`/`cli`/`start` package script in a search-hole directory, `sh -c`, `eval`, `$(...)`, backticks, or a heredoc fed to a shell. Quoted mentions in commit messages and grep patterns no longer deny. Bash writes into search-hole's roots or a `.searchhole.yaml` are denied: redirects, `tee`, `cp`/`mv`/`ln`/`install` targets, `rm`/`touch`/`truncate`, `sed`/`perl`/`yq -i`, and `dd of=`. `SEARCHHOLE_SKILL=1` counts only as an assignment on the same simple command. This is still defence in depth (Principle 3's boundaries are unchanged).
- **hooks.json.** PostToolUse `WebFetch` sends only `${tool_input.url}`, not the page. Hook `toolInput`/`toolResponse` accept objects as well as JSON strings. A value that is still a literal `${...}` placeholder counts as missing.

## Amendment (2026-11-14): `ui` and `unblock` are guarded verbs

- `ui` joins the guarded verbs: the dashboard it starts can change every rule, and its output used to carry a sign-in link (ADR-0004 amendment of the same date).
- `unblock` is now a CLI alias of `unrule` (it was a slash command only, and `searchhole unblock` answered "Did you mean block?"). It is guarded like `unrule`.
