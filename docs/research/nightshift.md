# orwa-mahmoud/nightshift

> Ref: `research/refs/nightshift` @ 4b4abca (2026-10-22) · License: MIT (root `LICENSE` and an identical `plugins/nightshift/LICENSE`, both "Copyright (c) 2026 Orwa Mahmoud"; no per-directory exceptions or third-party/vendored code; all 15 plugin skills carry `license: MIT` frontmatter (the root bootstrap `skills/install-nightshift/SKILL.md` has none), and all three `plugin.json` files plus the Claude and Cursor marketplace entries declare `"license": "MIT"`)

## Purpose

Nightshift is a hooks-and-skills plugin for Claude Code, Codex and Cursor. It holds an agent to a file-based "punch list" during long, unattended runs. A Stop hook refuses to end the turn while boxes are open, a PreToolUse "hardhat" denies forbidden tools and commands, a watchman revives crashed sessions, and per-item receipts record tokens and time. **There is no MCP server, always-on service or Node, and the plugin ships no `.py` files.** The runtime is Bash (3.2-compatible), awk and optional `jq`/`perl` on POSIX; `python3 -c` is an optional fallback JSON reader after jq in `lib/policy.sh` and some runtime verbs (`runtime/evidence.sh`, `runtime/export-support.sh`). Native Windows uses PowerShell 5.1+ (`README.md:22`: "No separate service or API key"; `tests/armed-no-python-jq.bats`: "the plugin ships no Python", and an armed shift runs with neither python3 nor jq). The watchman is a per-shift background process launched by Start (`runtime/start-watchman.sh`), not a resident service. The repo's maintainer eval SDK is Python (`evals/lib/sdk.py`). For search-hole it is the reference for **multi-host plugin packaging, hook wire formats, polyglot Windows hooks, spaced-path quoting, file-based state and CI validation**. It is not a reference for MCP servers.

## Architecture sketch

```text
.claude-plugin/marketplace.json        Claude marketplace  -> source "./plugins/nightshift", strict: true
.agents/plugins/marketplace.json       Codex marketplace   -> source {source:"local", path:"./plugins/nightshift"}
.cursor-plugin/marketplace.json        Cursor marketplace  -> source "./plugins/nightshift", logo
skills/install-nightshift/SKILL.md     skills.sh bootstrap skill that installs the real plugin per host
plugins/nightshift/                    the only thing a host copies (moved here in v0.7.4: install 876 KB -> 216 KB, CHANGELOG.md)
  .claude-plugin/plugin.json (+icon.png)  no hooks/skills keys -> default discovery of hooks/hooks.json, skills/
  .codex-plugin/plugin.json              "skills":"./skills/", "hooks":"./hooks/codex/hooks.json", "interface":{...}
  .cursor-plugin/plugin.json             "skills":"./skills/", "hooks":"./hooks/cursor/hooks.json", "logo"
  .codexignore                           .DS_Store .env .nightshift/ *.log
  hooks/hooks.json                       Claude wiring -> hooks/dispatch/claude-*.ps1 (sh/PowerShell polyglots)
  hooks/{hardhat,clock-out-gate,pulse,session-*,prompt-*}.sh   Claude POSIX hooks
  hooks/codex/, hooks/cursor/            per-host wrappers + lib-io.sh (the only place a wire format lives)
  hooks/shared/{hardhat-core,gate-core,idle,cold-stop}.sh      host-neutral decisions
  hooks/windows/*.ps1, lib/Nightshift.psm1 (+Nightshift.0[1-7].ps1)   native Windows twins
  lib/*.sh *.awk *.jq, lib/state-layout.tsv                    shared library and state layout table
  runtime/ns (+ runtime/windows/ns.ps1)  verb dispatcher the skills call
  skills/<15 skills>/SKILL.md            act as slash commands (/nightshift:setup ...); no commands/ dir
tests/ (179 .bats files, 2,307 @test), tests/windows/run.ps1, evals/, docs/
```

Plugin tree today: 79 `.sh`, 59 `.ps1`, 82 `.md`, 28 `.json`, 10 `.awk`, 5 `.jq` (~3.4 MB on disk). The hook code alone is ~7,850 lines (`wc -l` over the `.sh`/`.ps1` files under `plugins/nightshift/hooks/`; `hooks/shared/hardhat-core.sh` 1,559 lines, `hooks/windows/hardhat.ps1` 1,409 lines).

## Key modules and data flow

**Claude hook path** (`plugins/nightshift/hooks/hooks.json`):
1. The host runs the command `. "${CLAUDE_PLUGIN_ROOT}/hooks/dispatch/claude-hardhat.ps1"`, which **dot-sources** the launcher. The launcher is tracked as mode `100644`, so no exec bit is needed.
2. The launcher is a sh/PowerShell polyglot. On POSIX it `exec`s `hooks/hardhat.sh`. Under MINGW/MSYS/CYGWIN or `OS=Windows_NT` it `exec`s `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File hooks/windows/hardhat.ps1 -HostName claude`. Under PowerShell, the sh part sits inside a `<# … #>` block comment.
3. `hooks/shared/idle.sh` runs **before stdin is read**. If `CLAUDE_PROJECT_DIR` (or the CURSOR/CODEX equivalent) has no armed marker, it exits 0 and the call is allowed.
4. `ns_read_stdin_bounded 2` (`lib/common.sh:87-130`) reads the payload under a 2 s process alarm. It uses Perl `alarm` when available and otherwise a `/bin/sleep` killer. The code comment records that one hook once hung a session for 5.5 hours on an stdin that never closed.
5. Fields (`tool_name`, `tool_input.command`, `cwd`, `session_id`, `transcript_path`) come from `jq`, with a `sed` regex fallback. If no command can be extracted, the **raw payload becomes the match target**, so a broken parse cannot disable a string guard (`hooks/hardhat.sh:61-79`).
6. Shared decisions (`hooks/shared/hardhat-core.sh`) run, then a host-specific emitter writes one JSON object and the hook exits 0.

**Per-host seam.** Codex and Cursor wrappers call `codex_read_input` / `cursor_read_input` and `*_emit_{deny,block,release}` in their `lib-io.sh`. "Every byte of Codex's wire format lives here and nowhere else" (`hooks/codex/lib-io.sh:2-5`; same in `hooks/cursor/lib-io.sh:2-4`).

**Skills to runtime.** Each skill resolves `$NIGHTSHIFT_PLUGIN_ROOT` (`${CLAUDE_PLUGIN_ROOT}` on Claude, `$PLUGIN_ROOT` on Codex, else the skill file's own absolute path). It then runs `"$NIGHTSHIFT_PLUGIN_ROOT/runtime/ns" <verb>` (`skills/status/SKILL.md:10-20`). `runtime/ns` derives verbs from filenames (`runtime/<verb>.sh` or `runtime/<host>/<verb>.sh`) and detects the host from env vars (`CLAUDE_PROJECT_DIR|CLAUDECODE|CLAUDE_PLUGIN_ROOT` → claude, `CODEX_*` → codex, `CURSOR_*` → cursor; `runtime/ns:46-60`).

**PostToolUse "pulse".** `hooks/pulse.sh` overwrites `.shift-pulse` with `epoch sid` and incrementally parses the host transcript for token usage. The parse resumes from a byte offset and is de-duplicated by `requestId`, because one response spans several JSONL lines: "2,421 usage-bearing lines for 1,526 responses" (`lib/usage-claude.awk:1-27`). It can also emit `additionalContext` notices.

## Data model and storage

- **All state lives in the project, not in plugin data**: `<project>/.nightshift/`. Nothing references `CLAUDE_PLUGIN_DATA` (grep over `plugins/nightshift` is empty). An optional `.nightshift-link` file points a task folder at another workspace. `.codexignore` excludes `.nightshift/`.
- **Layout table** `lib/state-layout.tsv` (135 lines) has the columns `key  since  path  kind` (kinds: file/dir/group/field/retired/stray). A key resolves to the row with the highest `since` that is ≤ the workspace's `state-version`. Example: `parking-lot` is `0 parking-lot.md` and becomes `2 inbox/parking-lot.md`.
- **Schema version**: `.nightshift/state-version` holds a single integer (current = 2). `ns_state_kind` returns `absent|legacy|current|malformed|future`. Leading zeros, more than 8 digits, more than one line, or a symlink count as `malformed`. A `malformed` or `future` version is refused with a repair message only by the guard (PreToolUse deny, `hooks/hardhat.sh:54-59`) and the clock-out gate (Stop block, `hooks/clock-out-gate.sh:57-63`). `pulse`, `session-start` and `session-end` just exit 0 (`hooks/pulse.sh:438-441`, `hooks/session-end.sh:29-32`), and the prompt hooks don't check (`lib/state.sh:2488-2543`, `ns_state_refuse_message` at `lib/state.sh:2581-2593`). Migration is explicit only: "never migrate from hooks, start, status, archive, or recovery". It is idempotent, never overwrites, and writes the marker last (`lib/migrate.sh:1-15`).
- **Records** are line-oriented text:
  - `.shift-session` has 5 lines: sid, transcript, pid, process start time, host (`lib/ownership.sh:63-75`).
  - `.shift-lease` has 6 lines: scope, host, generation, nonce, pid, start.
  - `hook-copies` is TSV: `epoch host session root version` (`lib/ownership.sh:760-790`).
  - Logs are append-only `ts · line`.
  - Receipts are Markdown under `receipts/`, optionally versioned in a local-only git repo.
- **Concurrency**:
  - `mkdir` lock with a `pid` file inside, because macOS has no `flock`. A holder that `kill -0` shows is dead gets broken. The wait is bounded at 10×0.2 s, and on timeout the caller proceeds without the lock, because "a Stop hook must never hang a session over bookkeeping" (`lib/ownership.sh:4-28`).
  - First-writer-wins creation uses `ln tmp rec`, a hard link that fails if the record already exists. Replacement uses `mv -f tmp rec`. Writes happen under `umask 077`.
  - Every marker read checks `[ ! -L ]` to defeat planted symlinks.
  - On Windows: atomic claims plus a non-inherited ACL for the user and SYSTEM (`docs/windows.md`, "Rule and filesystem details").

## Config format

- **`.nightshift/rules.json`** is a strict JSON subset (objects, strings, bools, ints, string arrays; no comments or trailing commas). It is read by a shipped awk reader with **no jq/python** (`lib/rules-read.sh:1-6`, `lib/rules-read.awk`). The template carries a `$schema` URL that points to `skills/nightshift/references/nightshift-rules.schema.json` (505 lines). Keys:
  - `toolDeny` (exact tool name → message; an empty string allows)
  - `forbiddenCommands` and `neverCommitPatterns` (ERE strings)
  - `expectedEmail`, `protectedDirs`
  - `elevation.{sudo,containers,global-packages,daemons,external-services}.{policy,pattern}`
  - stall and watch knobs, `notifyCommand`, `clockOutMessage`
  - `shift{}`, `handoff{}`, `archive{}`, `receipts{}`

  (`skills/nightshift/references/nightshift-rules-template.json`)
- **Precedence** (`lib/policy.sh:1-17`): `rules.json` holds permanent boundaries. `shift-policy.json` is tonight's authoritative snapshot, written before arming and archived at clock-out. `shift-defaults.json` only pre-fills questions and is "never the source of an effective value". `NIGHTSHIFT_*` env vars override a key for the session as a test lever (`hooks/hardhat.sh:18-19`) and are never reported as a policy source. A single resolver, `ns_policy_resolve`, serves every consumer.
- **Profiles**: small JSON files `{name, version, risk, use, rules{}}`, e.g. `skills/nightshift/references/profiles/no-push.json` = `forbiddenCommands: "git .*push"`. They are applied by `runtime/apply-profile.sh`.

## Extension points (plugins, hooks)

- **Host hook events used.**
  - Claude: `PreToolUse` (matcher `*`), `PostToolUse`, `SessionStart` (matcher `compact|resume`), `SessionEnd`, `UserPromptSubmit`, `UserPromptExpansion` (matcher `^nightshift:(plan-exit|start)$`), `Stop`.
  - Codex: the same set minus SessionStart and UserPromptExpansion, each with `command` and `commandWindows`.
  - Cursor (`version: 1`, camelCase): `preToolUse` (matcher `Shell|Read|Write|Grep|Delete|Task|MCP:.*`), `postToolUse`, `afterAgentThought`, `stop` (`loop_limit: null`), `sessionEnd`, `beforeSubmitPrompt`.
  - No hooks file sets a `timeout`; hooks bound themselves instead.
- **Output shapes per host** (from the emitters; `systemMessage`, `updatedInput` and `suppressOutput` are never used):

| Host | Deny a tool | Force continue at Stop | Allow stop | Model-visible context |
|---|---|---|---|---|
| Claude | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}` (`hooks/hardhat.sh:47-51`) | `{"decision":"block","reason":…}` (`hooks/clock-out-gate.sh:90-94`) | silence, exit 0 | `hookSpecificOutput.additionalContext` on SessionStart/UserPromptSubmit/UserPromptExpansion/PostToolUse |
| Codex | same hookSpecificOutput shape (`hooks/codex/lib-io.sh:93-99`) | same `decision:block`; reason becomes a continuation prompt | **must print** `{"continue":true}`; plain text is invalid for Stop (`hooks/codex/lib-io.sh:86-90`, `hooks/shared/cold-stop.sh:21-23`) | `hookSpecificOutput.additionalContext` on UserPromptSubmit (`hooks/codex/lib-io.sh:102-109`) and PostToolUse (`hooks/pulse.sh:364-381`) |
| Cursor | `{"permission":"deny","agent_message":…,"user_message":…}` (`hooks/cursor/lib-io.sh:91-98`) | `{"followup_message":…}` | empty stdout | `{"additional_context":…}` (`hooks/pulse.sh:362-380`); prompt block `{"continue":false,"user_message":…}` |

- **Fail-open vs fail-closed.**
  - **Inert by default**: with no armed shift, every hook exits 0 before parsing anything (`hooks/shared/idle.sh`). That is fail-open "by absence".
  - **Fail-closed once armed**:
    - An invalid link, a malformed or future state, or unreadable `toolDeny` produces a deny or block that includes the repair command (`hooks/hardhat.sh:53-59,183-185`, `hooks/clock-out-gate.sh:52-62`).
    - Commit guards that cannot resolve the repo deny: "a guard that cannot look is never a guard that approves" (`hooks/hardhat.sh:21-23`).
    - Unknown tools whose payload cannot be decoded (jq missing or failing) are treated as targeting the lease. `AskQuestion`/`AskUserQuestion`/`request_user_input`/`WebFetch`/`WebSearch`/`Task`/`TodoWrite` are explicitly exempt (`hooks/shared/hardhat-core.sh:749-761`).
- **Model-invocation boundary.** Claude's `UserPromptExpansion` fires only for commands the user types (`command_name`, `command_source: plugin`, `prompt`). "A skill Claude invokes through the Skill tool fires neither event, so the model cannot close the room" (`skills/nightshift/references/hosts/claude.md`). `skills/plan-exit/SKILL.md` adds `disable-model-invocation: true`.
- **Other extension points**: `notifyCommand` (a shell command fired once at shift end), the shift catalog (one Markdown file per shift under `skills/nightshift/references/compose/shifts/`), and verbs that come into existence when a file is dropped into `runtime/`.

## Rules / lists: parsing and compilation

There are no list subscriptions. The rules are exact tool-name maps plus ERE strings matched with `grep -E` on POSIX and with .NET regex on Windows. On Windows, POSIX classes (`[[:space:]]` etc.) are translated, and a class that cannot be mapped **fails closed** (`docs/windows.md`, "Rule and filesystem details"). Before matching, a commit message argument is blanked (`ns_hardhat_scrub`) so that `git commit -m "don't git push"` does not trip `git .*push` (`hooks/hardhat.sh:83-88`).

## Testing strategy

- **Bats**: 179 files and 2,307 `@test`s. They run as 6 shards on Ubuntu **and** as 6 shards on macOS under the **system bash 3.2** with `PATH` pinned (`.github/workflows/ci.yaml`, job `bats-macos`). `CONTRIBUTING.md:25-28` forbids assertion forms that bash 3.2 silently ignores.
- **Windows**: `tests/windows/run.ps1` runs under both `powershell` (5.1) and `pwsh` (7) on `windows-latest`.
- **Lint and validation**: shellcheck `-x` over `git ls-files '*.sh'`, and **`claude plugin validate . --strict`** (Node 20 + `npm i -g @anthropic-ai/claude-code`) whenever manifests or the runtime change (`ci.yaml`, job `validate`).
- **Hook wiring tests** (`tests/hooks-json.bats`):
  - every hook is declared (by name, plus an exact count of 7)
  - every command matches the pattern `. "${CLAUDE_PLUGIN_ROOT}…"` (quoted)
  - the plugin is copied to `"plugin root with spaces"` and a hook runs from there
  - every referenced file exists
  - the hooks are driven *through hooks.json* (`sh -c "$cmd"`), e.g. `NIGHTSHIFT_TOOL_RULES='{"WebSearch":"no browsing"}'` must deny `WebSearch`, and on Codex `mcp__web__search` must be denied
- **Payload replay and fuzz**:
  - `tests/fixtures/hooks/v1/{claude,codex,cursor}/*.json` are sanitized, structural host payloads replayed through the real adapters (`tests/hook-replay.bats`).
  - `tests/hook-fuzz.bats` covers truncated JSON, wrong types, hostile strings, oversized fields, NUL/control bytes, and broken state.
- **Docs as contract**: every path the docs and skills name must resolve (`tests/doc-refs.bats`, `tests/skill-refs.bats`). Docs-only PRs run `tests/run-docs-contract.sh`. Required job names always report, even when their work is skipped.
- **Evals** (`evals/`) are **not** `claude plugin eval`. They are an SDK for case schemas and **instruction-size budgets**: `maxBytes 32768`, `maxEstimatedTokens 8192`, 4 bytes/token (`evals/config.json`), over 21 cases in `evals/cases/v1.json`. The baseline comparison against the host without the plugin is explicitly informational and "never a deterministic release gate" (`evals/README.md`).
- **Other CI**:
  - HOL Plugin Scanner (`.github/workflows/hol-plugin-scanner.yml`, `min_score: 80`, `fail_on_severity: high`, SARIF), described as the "listing gate for the Codex plugin directory".
  - A devcontainer and remote-ssh environment job.
  - All actions pinned by SHA.

## UX patterns worth copying

- **Install docs per host**:
  - Claude: `/plugin marketplace add orwa-mahmoud/nightshift` then `/plugin install nightshift`.
  - Codex: `codex plugin marketplace add …` then `codex plugin add nightshift@nightshift`.
  - Cursor: Customize → Add → From GitHub Repository → Import (`README.md:58-103`).
  - Naming the marketplace the same as the plugin gives `nightshift@nightshift`.
- **Bootstrap skill** (`skills/install-nightshift/SKILL.md`, via `npx skills add … --skill install-nightshift`):
  - detects each host (`claude plugin list`, `codex plugin list`, `~/.cursor/plugins/cache/`)
  - enforces **one copy per host**
  - installs on the current host and *asks* before installing on others
  - ends with one "what next" line per host: restart Claude Code; on Codex "review and trust the plugin's hooks with `/hooks`"; on Cursor start a new chat
  - "If a command fails, show its output and stop … Do not retry with other flags."
- **Actionable deny reasons** that tell the model what to do instead. Example: "BLOCKED: … Park the need in `<path>` and keep working". Every refusal names the exact repair command for each host (`/nightshift:setup` on Claude, "ask Nightshift to set up" on Codex).
- **Status and doctor**: "Render, never re-derive". The runtime prints fact lines, the skill only summarises them, and the skill must "relay every Warning … never soften a warning into silence" (`skills/status/SKILL.md`).
- **Context re-injection**: `SessionStart` with `compact|resume` re-injects one line of context, and only for the owning session (`hooks/session-start.sh`).
- **Ask, default no**: Setup asks before writing anything that persists, defaults to no, and shows a diff before replacing an existing user file (`skills/setup/SKILL.md:122-160`).

## Performance tricks

- **Idle fast path** before stdin or library load. With a catch-all matcher, a cold project pays only for a few `[ -f ]` tests (`hooks/shared/idle.sh`, `hooks/shared/cold-stop.sh`).
- **2 s bounded stdin.** This prevents hangs when Cursor or Claude keeps the descriptor open (`lib/common.sh:87-130`).
- **Lazy rule reads.** Rule keys used only by command guards are read only for `Bash|PowerShell|Shell` calls (`hooks/hardhat.sh:210-216`).
- **Rate-limited bookkeeping.** The hook-copy note is written at most once a minute per copy, and its file is trimmed to the last day once it passes 500 lines (`lib/ownership.sh:760-790`).
- **Incremental transcript parsing** by byte offset with a carry identity (`lib/usage-claude.awk`).
- **Plugin in a subdirectory**, so marketplace installs skip tests, CI and screenshots (CHANGELOG v0.7.4).
- **No sibling lookup through `dirname`.** Sibling files are resolved as `${BASH_SOURCE[0]%/*}`, so "a hostile PATH cannot unsource the helpers" (`hooks/hardhat.sh:26-30`).

## License and what it means for us

MIT, at the root and in the plugin directory. We may copy code, manifests and test patterns with attribution: keep the copyright and permission notice, e.g. in `THIRD_PARTY_NOTICES` or file headers for any copied launcher or test. Snippet (MIT, from `plugins/nightshift/hooks/dispatch/claude-hardhat.ps1` lines 1-3 and 11-14; lines 4-10 are the Windows `case` that re-`exec`s into `powershell.exe -File …\hooks\windows\hardhat.ps1`):

```sh
#!/bin/sh
echo --% >/dev/null;: ' | Out-Null
<#'
exec "$CLAUDE_PLUGIN_ROOT/hooks/hardhat.sh"
exit #>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$env:CLAUDE_PLUGIN_ROOT\hooks\windows\hardhat.ps1" -HostName claude
exit $LASTEXITCODE
```

## Implications for search-hole

- [distribution] Copy the repo shape:
  - one plugin directory (`plugins/search-hole/`) that all three marketplaces point at: `.claude-plugin/marketplace.json` (`strict: true`), `.agents/plugins/marketplace.json` (`source: {source:"local", path}`, `policy: {installation:"AVAILABLE", authentication:"ON_INSTALL"}`) and `.cursor-plugin/marketplace.json`
  - per-host manifests in `.claude-plugin/`, `.codex-plugin/` and `.cursor-plugin/` inside the plugin directory
  - the marketplace named the same as the plugin, so installs read `search-hole@search-hole`

  Evidence: root `*/marketplace.json`, `plugins/nightshift/.*-plugin/plugin.json`.
- [distribution] **Re-verify §3's Codex claims.**
  - Layout: nightshift ships Codex as `plugins/nightshift/.codex-plugin/plugin.json`, with `skills`, `hooks` and a rich `interface{displayName, shortDescription, longDescription, developerName, category, capabilities[], defaultPrompt[], websiteURL, privacyPolicyURL, termsOfServiceURL, composerIcon, logo, screenshots[]}`. It does not use a root `plugin.json` + `mcp.json`.
  - Directory listing: its README links an **OpenAI Plugin Directory listing even though the Codex manifest declares hooks** (`README.md:5,62`), and says the marketplace install is "the same package" (`README.md:64`). Separately, the HOL scanner workflow calls itself the "Listing gate for the Codex plugin directory" (`.github/workflows/hol-plugin-scanner.yml:3-4`); the repo doesn't say that directory is the OpenAI one. "Hooks can't be listed" may therefore be stale (inferred; the listing's contents can't be seen from the repo).
- [distribution] Keep each host's hook wiring separate.
  - Claude uses the default `hooks/hooks.json`; the Codex and Cursor manifests point at `hooks/codex/hooks.json` and `hooks/cursor/hooks.json`, so "the two hosts never read each other's wiring" (`hooks/codex/README.md`).
  - Codex appears to fall back to `hooks/hooks.json` otherwise (inferred from "Codex loads `hooks.json` in this directory instead of `../hooks.json`", `hooks/codex/README.md:3-4`), so a **hookless Codex variant** must be checked to make sure it doesn't pick up the Claude file.
- [distribution] Version all three manifests from one source. release-please (`release-type: simple`) with `extra-files` jsonpath `$.version` covers each `plugin.json` (`release-please-config.json`). Marketplace entries carry no version.
- [runtime-packaging] Nightshift shows that a plugin needs **no Node for its hooks**: Bash scripts kept to bash 3.2 (`#!/usr/bin/env bash`, `CONTRIBUTING.md:21-24`, not POSIX sh) plus, on Claude, a sh/PowerShell polyglot launcher. The launcher is dot-sourced, so *it* needs no exec bit, but it `exec`s `hooks/<hook>.sh`, which is tracked `100755`. Codex and Cursor commands run their `.sh` directly (also `100755`). Codex adds `commandWindows` with `-EncodedCommand` (decoded: `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $input | & (Join-Path -Path $env:PLUGIN_ROOT -ChildPath 'hooks/windows/<hook>.ps1') -HostName codex; exit $LASTEXITCODE`). `hooks/cursor/hooks.json` has no Windows command, and `docs/windows.md:9-11` scopes the native PowerShell path to Claude Code and Codex.
  - **Design**: our gateway (which needs a runtime) keeps a tiny heartbeat file next to the DB (e.g. `~/.searchhole/run/health`: epoch, healthy-engine count). The PreToolUse hook then needs only a `[ -f ]` check plus a freshness check, with no sqlite3 or node in the hook path. File mtime needs a per-OS `stat` (`stat -f %m` on Darwin, `stat -c %Y` elsewhere; `ns_mtime` in `lib/common.sh:28-33`). Writing the epoch into the file, as `.shift-pulse` does, avoids that.
- [security] Flip nightshift's posture. Its hooks are **inert unless armed, fail-closed once armed**. Ours must be **fail-open** (§9.1):
  - With no fresh heartbeat, exit 0 and add `hookSpecificOutput.additionalContext` explaining why.
  - Deny `WebSearch|WebFetch` only when healthy.
  - Strict mode is opt-in.

  Nightshift exempts `WebSearch`/`WebFetch` (and the ask/Task/TodoWrite tools) only from its lease-protection fallback, which fails closed when a payload can't be decoded (`hooks/shared/hardhat-core.sh:749-761`). `toolDeny` can still deny `WebSearch` (`tests/hooks-json.bats:74-77`). Nightshift never emits `additionalContext` from PreToolUse, so that part of the design rests on §3, not on this repo.
- [security] Make rule changes provably user-initiated:
  - mark the `:block`/`:allow`/`:pin`/`:enforce` skills `disable-model-invocation: true` (as `skills/plan-exit/SKILL.md` does)
  - optionally use a `UserPromptExpansion` hook (matcher `^search-hole:(block|allow|pin|enforce)$`) as the only path that mints a consent token, since the Skill tool never fires it (`plugins/nightshift/skills/nightshift/references/hosts/claude.md:13-17`)
- [security] Hook reasons interpolate untrusted strings, such as domains from search results. Strip control characters and JSON-escape them, or build the JSON with `jq -n --arg`, so a quote can't "void the deny" (`hooks/hardhat.sh:45-51`; there Claude's `deny()` only escapes, while other emitters use `jq -nc --arg` when jq exists and fall back to escaping, e.g. `hooks/clock-out-gate.sh:88-94`). Resolve sibling files without `dirname` (`hooks/hardhat.sh:26-30`). Check every state file read for symlinks (`lib/ownership.sh:805-816`).
- [security] Nightshift never writes the user's permission settings: "Nightshift never writes permission modes or allowlists" (`plugins/nightshift/skills/nightshift/references/hosts/claude.md:3-4`). That is a precedent for keeping `/search-hole:enforce` strictly consent-based, reversible and separate.
- [session-definition] Hooks get `session_id` and `transcript_path`; Cursor uses `conversation_id`, and Codex's `SessionEnd.reason` is always `other`.
  - Nightshift binds a session to state with a **distinctive no-op command** (`: nightshift-binding-probe`) that the PreToolUse hook recognises (`skills/start/SKILL.md:161-176`, `hooks/shared/hardhat-core.sh:35-41`).
  - It identifies the host process by walking ancestry (`ps -o comm=`/`ppid=`, up to 6 hops) plus `ps -o lstart=` to guard against pid reuse (`lib/process.sh:7-27`).
  - For our ADR: hooks record `session_id → claude pid+start`; the gateway resolves its own ancestor host pid and looks up the session (inferred mechanism, not done by nightshift).
- [upgrades-migrations] Adopt the state-version discipline:
  - an integer marker; `future` → refuse with a named repair; `malformed` is strict. In nightshift only the guard and the Stop gate refuse (deny/block with "Upgrade Nightshift; never rewrite or downgrade the marker"). The other hooks stand down silently with exit 0 (`hooks/hardhat.sh:54-59`, `hooks/clock-out-gate.sh:57-63`, `hooks/pulse.sh:438-441`).
  - migrations explicit, idempotent and table-driven (`lib/state-layout.tsv`), with the marker written last; **never migrate from hooks** (`lib/state.sh:2488-2545`, `lib/migrate.sh:1-15`)
- [upgrades-migrations] **Duplicate copies are real.**
  - Cursor IDE also loads the Claude marketplace plugin. Nightshift detects a Cursor surface when `transcript_path` contains `/.cursor/` and stands the Claude copy down (`lib/ownership.sh:739-745`, `hooks/pulse.sh:453-458`).
  - Codex can hold both a directory copy and a marketplace copy (`skills/install-nightshift/SKILL.md:27-31`). Nightshift records each copy that answers a hook in the `hook-copies` file (`lib/ownership.sh:760-784`). Start's bind phase refuses a session that two copies answer (`runtime/start-preflight.sh:157-164`), and Doctor warns (`runtime/doctor.sh:145`).
  - search-hole needs the same dedupe, or receipts will double-log.
- [other] Hook coverage per host:
  - Codex: PreToolUse reaches "MCP and other local function tools … hosted tools do not" (`hooks/codex/README.md`), so a hook cannot steer a hosted built-in web search there (inferred).
  - Codex runs plugin hooks only after the user reviews and trusts them via `/hooks` (`skills/nightshift/references/hosts/codex.md:22-23`, `skills/plan-exit/SKILL.md:33`, `skills/install-nightshift/SKILL.md:74`).
  - The Cursor CLI ignores plugin hooks and runs only project `.cursor/hooks.json` (`skills/setup/SKILL.md:141-151`).
- [testing] Copy the test patterns:
  - hooks.json wiring tests (quoted root, existing files, a run from a spaced path, driving hooks through their config)
  - sanitized per-host payload fixtures, with replay and fuzz tests
  - macOS system-bash-3.2 shards
  - `claude plugin validate . --strict` in CI
  - an instruction-size budget gate like `evals/config.json`, alongside our 1.5k-token tool-description budget. Nightshift applies it per catalog entry and composer skill through `evals/validate.sh`, which `exec`s the Python `evals/lib/sdk.py`, and `tests/evals.bats` drives it

  Real plugin evals stay informational, not gates.
- [rule-format-precedence] There is precedent for one resolver over a layered policy: permanent rules, then a per-run snapshot, then prefill-only defaults, with env as a test lever that is never reported as a source (`lib/policy.sh:1-17`). There is also precedent for a `$schema` URL in user-edited config.
- [ui-ux] Doctor and status print fact lines that the skill relays verbatim, including every warning. The install skill reports one line per host.

## Borrow / avoid

**Borrow**
- The three-marketplace, one-plugin-directory layout with per-host manifests and per-host `hooks` pointers.
- The sh/PowerShell polyglot launcher, dot-sourced via `. "${CLAUDE_PLUGIN_ROOT}/…"`, which gives a single `hooks.json` for POSIX and Windows. Codex's `commandWindows` for Codex.
- The quoting rule `"${CLAUDE_PLUGIN_ROOT}/…"` in every command, enforced by a test that runs from `plugin root with spaces`.
- The idle fast-exit before reading stdin, plus a bounded stdin read (~2 s).
- One `lib-io.sh`-style adapter per host for wire formats, with a host-neutral decision core.
- `mkdir` locks with a pid inside, `ln`-based atomic claim, `umask 077`, symlink refusal, and bounded lock waits that never hang a hook.
- release-please `extra-files` covering all manifests, SHA-pinned actions, `claude plugin validate . --strict`, and an instruction-size budget check.
- A bootstrap install skill with host detection, one copy per host and consent before touching other hosts.

**Avoid**
- A catch-all `*` PreToolUse matcher. Use `WebSearch|WebFetch` (and the Cursor/Codex equivalents) so non-search tools never pay for our hook.
- Thousands of lines of duplicated Bash and PowerShell decision logic (`hardhat-core.sh` 1,559 lines vs `hardhat.ps1` 1,409). Keep hooks tiny and put decisions in the gateway or CLI.
- Fail-closed defaults for a search gate. They break the "built-in search keeps working until healthy" promise.
- `sed`-regex JSON parsing fallbacks. Our hook should need only the matcher plus a heartbeat file, not payload parsing.
- Unquoted `${CURSOR_PLUGIN_ROOT}/…` commands in `hooks/cursor/hooks.json`. The spaced-path test covers only Claude (inferred risk).
- Doc drift: Claude install is `/plugin install nightshift` in `README.md:81` but `nightshift@nightshift` in the install skill, and `hooks/codex/README.md` says `./plugin` where the actual path is `./plugins/nightshift`.
- Very long skills (`skills/nightshift/SKILL.md` 343 lines, `setup` 284). Our skill must stay short because tokens are part of the product.

## Verification

- Date: 2026-10-29, against `research/refs/nightshift` @ 4b4abca.
- Claims checked: 82 (license header and section, every "Implications" bullet, and the mechanism claims they rely on).
- Corrections:
  - License header: `license: MIT` frontmatter is on the 15 plugin skills only. The root `skills/install-nightshift/SKILL.md` has none. Noted that the manifests also declare MIT and that the repo has no vendored code. Both `LICENSE` files were confirmed identical, and the MIT snippet matches `claude-hardhat.ps1` lines 1-3 and 11-14.
  - Purpose: "no daemon, Node or Python" tightened. The plugin ships no `.py`, but `python3 -c` is an optional fallback JSON reader. The watchman is a per-shift background process. The eval SDK is Python.
  - Data model and [upgrades-migrations]: a `future`/`malformed` state is *not* refused by every hook. Only the guard (deny) and the Stop gate (block) refuse with the repair message. `pulse`, `session-start` and `session-end` exit 0 silently, and the prompt hooks don't check.
  - Fail-closed fallback: the exempt list also includes `AskQuestion` and `request_user_input`. The fallback applies only when a payload can't be decoded (lines 749-761).
  - Output-shape table: on Codex, model-visible context is also emitted on PostToolUse (pulse), not only on UserPromptSubmit.
  - [runtime-packaging]: the hooks are bash-3.2 Bash, not POSIX sh. Only the dot-sourced launcher needs no exec bit, because it `exec`s `100755` scripts. The decoded `-EncodedCommand` is now given exactly. The Cursor hooks have no Windows command, and native Windows covers Claude Code and Codex only. Added an mtime portability caveat for the heartbeat design.
  - [distribution] directory listing: the HOL workflow says "Codex plugin directory", which is not stated to be the OpenAI one. Added README "the same package" (`README.md:64`). The claim stays inferred.
  - [security] fail-open: the exemption covers only the lease fallback, and `toolDeny` can still deny `WebSearch`. Nightshift never emits PreToolUse `additionalContext`, so that part of the design rests on §3.
  - Counts: 2,307 `@test` (not 2,311; four are non-test strings) and ~7,850 hook `.sh`/`.ps1` lines (not ~7,750).
  - Paths: fixed the `no-push.json` path, gave the full `references/hosts/claude.md` path, and added citations for Codex hook trust, duplicate-copy refusal and the Codex `hooks.json` fallback inference.
