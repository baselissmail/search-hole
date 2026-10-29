# ADR-0014: Claude Code hook integration

- **Status:** Accepted (2026-10-30)
- **Related:** [0002](0002-runtime-and-packaging.md), [0005](0005-session-definition.md), [0012](0012-mcp-tool-surface-and-output-limits.md)

## Context

§9.1 asks for two hooks:
- a **PreToolUse hook that fails open**: it denies `WebSearch` (and later `WebFetch`) *only while a healthy engine exists*, and otherwise allows the call with `additionalContext`;
- a **Stop hook** that prints a one-line receipt as `systemMessage`, only for turns that searched.

Verified hook facts ([platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §D; re-checked in the live docs on 2026-10-30):

- **`mcp_tool` hooks** (v2.1.118+): `{"type":"mcp_tool","server":"plugin:<plugin>:<server>","tool":"…","input":{…}}`. String inputs support `${path}` substitution from the hook's JSON input (the docs show `${tool_input.file_path}`; **whether top-level `${session_id}` works is undocumented**). The tool's text is parsed like command stdout. **If the server isn't connected, the hook gives a non-blocking error and execution continues**, so it fails open by design. On blocking events (PreToolUse, Stop), Claude Code waits for a connecting server up to `MCP_TIMEOUT`.
- **Command hooks:**
  - **Exec form** (`command` + `args`, v2.1.139+) needs no shell quoting, which matters because Basel's path contains a space.
  - **Shell-form failures block the tool on Windows without Git Bash**, unless `onFailure: "continue"` (v2.1.295+) is set.
  - A missing `node` counts as a failure.
- **Output traps:**
  - On **Stop**, `additionalContext` or `decision: "block"` **makes Claude keep working**, so the receipt line must use `systemMessage` only.
  - `suppressOutput` no longer has any effect.
  - Strings are capped at 10,000 characters.
- **`permissionDecision: "deny"`'s reason is shown to Claude**, which is how we steer it to our tool. `updatedInput` can't redirect to an MCP tool.
- **Plugin tool naming:** `mcp__plugin_search-hole_search-hole__search`.
- **A plugin can't ship permission deny rules.** Only `agent` and `subagentStatusLine` take effect from plugin settings.
- **The MCP server keeps its spawn-time `CLAUDE_CODE_SESSION_ID` after `/clear`** (ADR-0005).
- **Hook precedent:** nightshift runs all its hooks in bash plus a PowerShell polyglot, with no Node. It uses hooks as gates and records each plugin copy that answers ([nightshift.md](../research/nightshift.md)).

## Decision

**The gateway answers the hooks itself through `mcp_tool` hooks.** The only command hook is the node preflight.

`hooks/hooks.json` (Claude Code plugin):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "\". \\\"${CLAUDE_PLUGIN_ROOT}/hooks/preflight\\\"\"",
          "onFailure": "continue", "timeout": 5 },
        { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
          "input": { "event": "SessionStart", "sessionId": "${session_id}" } } ] } ],
    "PreToolUse": [
      { "matcher": "WebSearch|WebFetch",
        "hooks": [ { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
          "input": { "event": "PreToolUse", "sessionId": "${session_id}",
                     "toolName": "${tool_name}", "query": "${tool_input.query}" } } ] } ],
    "Stop": [
      { "hooks": [ { "type": "mcp_tool", "server": "plugin:search-hole:search-hole", "tool": "hook",
          "input": { "event": "Stop", "sessionId": "${session_id}" } } ] } ]
  }
}
```

The preflight is the one **shell-form** hook, because exec form needs a real executable and Windows has no `sh` without Git Bash.
- It is a POSIX-sh / PowerShell **polyglot**, dot-sourced, so it runs under `sh -c` on macOS and Linux, under Git Bash on Windows, and under PowerShell on Windows without Git Bash. This is nightshift's launcher technique (MIT, attributed).
- `onFailure: "continue"` guarantees it never blocks.
- The exact quoting is fixed and tested on all three OSes in P3; `claude plugin validate` warns on an unquoted `${CLAUDE_PLUGIN_ROOT}`.
- The `mcp_tool` hooks have no shell or quoting concerns at all.

1. **PreToolUse.** The `hook` tool (registered only for the `claude-code` host profile, ADR-0012) returns:
   - **Deny**, if this gateway has ≥ 1 healthy, non-capped engine *right now*. This comes from in-process state plus `engine_health`, with no heartbeat file and no race. The reason is short:
     > `search-hole is active: use mcp__plugin_search-hole_search-hole__search (and __fetch for pages) instead of WebSearch. It applies the user's source rules.`
   - **Allow plus `additionalContext`**, if no engine is healthy:
     > `search-hole has no healthy engine (brave: key invalid). Built-in WebSearch allowed. Tell the user to run /search-hole:doctor.`
   - **`WebFetch` is allowed** with an `additionalContext` nudge until our `fetch` matches it on PDFs and long pages (a P2/P3 gate). After that, it is denied under the same health rule.
   - **If the gateway isn't connected,** the `mcp_tool` hook fails open by itself: WebSearch proceeds.
   - **Escape hatch:** the plugin `userConfig.hook_mode: "steer" | "off"` (default `steer`), plus the env var `SEARCHHOLE_HOOKS=off`. With `off`, the hook always allows.
2. **Stop.**
   - The `hook` tool closes this session's open receipt (ADR-0005).
   - If the receipt has ≥ 1 search, it returns only `{"systemMessage": "search-hole · 6 searches · 41 results · 9 hidden · sources: 3 official, 2 blogs · ⚠ 1 stale (2022)"}`. Otherwise it returns `{}`, which is silent.
   - It **never** returns `additionalContext` or `decision`.
   - Turned off with `userConfig.receipt_line: false`.
3. **SessionStart:**
   - The `mcp_tool` hook re-keys the gateway's session to the current `session_id`. This runs after `/clear` and compaction, but is skipped at first launch, when no MCP context exists yet; `CLAUDE_CODE_SESSION_ID` from the spawn env covers that case.
   - The **preflight command hook** is the only shell code. It is the sh/PowerShell polyglot described above, with no Node and no network. It checks that `node` exists and is ≥ 22.13. If not, it prints `{"systemMessage": "search-hole needs Node.js 22.13+ … then run /mcp → reconnect search-hole"}`. If Node is fine, it prints nothing. It sets `onFailure: "continue"`, so it can never block.
4. **Every hook call re-keys the session.** Each `hook` call carries `sessionId`, so the gateway's session label is always the current one (ADR-0005 precedence 1).
5. **Strict mode is opt-in via `/search-hole:enforce`.**
   - With explicit consent, it writes `"permissions": {"deny": ["WebSearch", "WebFetch"]}` to the user's `~/.claude/settings.json`, tagged with a marker so `/search-hole:unenforce` removes exactly those entries.
   - It shows the diff before writing.
   - It is reversible, and `uninstall --purge` reminds the user to run it.
6. **Minimum Claude Code version:** 2.1.295. That covers `onFailure` (2.1.295), exec-form hooks (2.1.139), `CLAUDE_CODE_SESSION_ID` for MCP (2.1.154), the resume fix (2.1.163) and `mcp_tool` hooks (2.1.118). Plugin manifests have no minimum-version field, so the preflight hook also checks `claude --version` when cheap (it may skip this) and `doctor` reports it.

## Alternatives considered

- **Command hooks in Node that read a heartbeat file and the DB** (the plan's default). These are kept as the fallback if the P0/P2 spike shows `${session_id}` substitution or `mcp_tool` hooks don't work as needed. Downsides:
  - one Node spawn per WebSearch attempt (≈ 50–100 ms);
  - a heartbeat race ("healthy" as of the last write);
  - no exact session correlation, because a command hook can't reach *this* gateway process;
  - a Windows shell-failure risk.
- **Bash-only hooks with a heartbeat file** (nightshift style). These need no Node, but they have the same correlation and race problems, and they need `stat` portability shims.
- **Reading the transcript in the Stop hook** to find receipt ids. Rejected: the transcript is written asynchronously (ADR-0005).
- **Hiding the `hook` tool from the model.** Not possible in Claude Code: no documented mechanism exists, and `visibility: ["app"]` is unverified on non-Apps hosts. It is mitigated instead: one line of description, read-only behaviour, and tool search defers its definition (only the name costs tokens).

## Consequences

- The PreToolUse decision is exact and current. A dead or absent gateway means built-in search keeps working, which is §1's "my AI's built-in search keeps working until search-hole has a healthy engine".
- The model sees a `hook` tool in Claude Code. Calling it can at worst produce a decision string or re-label its own session. This is documented in SECURITY.md.
- Cursor and Codex hooks use their own event schemas (Cursor `preToolUse`, `stop`, …) and are designed in P7. Codex directory listing needs a hookless variant (and is blocked anyway for local stdio servers without partner approval).

## Validate early (P0 spike, before P3 work)

1. `${session_id}`, `${tool_name}` and `${tool_input.query}` substitution in `mcp_tool` hook `input`.
2. PreToolUse deny via `mcp_tool` actually steers the model to our tool. Measure it in plugin evals against a no-plugin baseline.
3. The Stop `systemMessage` shows once per searching turn and never triggers continuation.
4. The gateway being down means WebSearch proceeds (fail open) on macOS, Linux and Windows (with and without Git Bash).
5. Behaviour when two plugin copies are installed (Cursor loading the Claude plugin): one receipt line, not two (ADR-0006 point 11).
