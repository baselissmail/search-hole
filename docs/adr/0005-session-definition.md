# ADR-0005: Definition of "session" and "receipt"

- **Status:** Accepted (2026-10-30)
- **Related:** [0004](0004-dashboard-process-model.md), [0012](0012-mcp-tool-surface-and-output-limits.md), [0013](0013-dual-protocol-support.md), [0014](0014-claude-code-hook-integration.md)

## Context

§4 says everything depends on this definition: receipts, session-scope rules, the `sessions` table and the Stop-hook line. Verified facts ([platform-facts-mcp.md](../research/platform-facts-mcp.md) §1, §7; [platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §E; [mcp-spec.md](../research/mcp-spec.md)):

- **The protocol has no session.** 2026-07-28 removed `initialize` and `Mcp-Session-Id`. Request `_meta` carries `protocolVersion` and `clientCapabilities` (required) and `clientInfo` (optional, self-reported). The spec says *"a server must not treat connection or process identity as a proxy for conversation or session continuity"*, and recommends server-minted handles passed as tool arguments (SEP-2567).
- **Process ≠ conversation almost everywhere.** Claude Code stdio servers outlive their session. Desktop runs separate copies for chat and Cowork/Code. Codex is building cross-chat connection sharing. One legacy-era report says claude.ai pools one session across chats.
- **Hosts expose different conversation keys:**

| Host | Key the gateway can see | Quality |
|---|---|---|
| Claude Code | env `CLAUDE_CODE_SESSION_ID` (frozen at spawn: **not updated on `/clear`**, possibly the startup id on `--continue`); hook input `session_id` (always current) | Exact via hooks |
| ChatGPT | `_meta["openai/session"]` (anonymised conversation id) | Exact |
| VS Code Copilot | `_meta["vscode.conversationId"]` (+ `vscode.requestId`) | Exact |
| Goose | `_meta["agent-session-id"]` (+ `agent-working-dir`) | Exact |
| Claude Desktop, claude.ai, Cursor, Codex, Zed | none found | — |

## Decision

Two separate concepts:

### Session: "which conversation is this?"

Resolved **per request** by a precedence chain. The first available source wins, and the source is recorded as `sessions.key_source`.

1. **Hook-reported key** (Claude Code): the `session_id` that search-hole's `SessionStart` or `UserPromptSubmit` hook reported to *this gateway process*. Re-keying happens only between turns, so a forged model call can't re-key (ADR-0014 point 1). After `/clear`, the next SessionStart or prompt re-keys the process.
2. **Host `_meta` key:** `openai/session`, `vscode.conversationId`, `agent-session-id`. The adapter table lives in `gateway/host-keys.ts`, so adding a host is one line.
3. **Spawn env:** `CLAUDE_CODE_SESSION_ID` (Claude Code before the first hook fires).
4. **Fallback label:** `(gateway pid, host profile)` plus an **idle gap of 30 minutes**. Activity after a longer gap starts a new session. This is a grouping label, never a security or trust decision, and the UI marks it "approximate".

The `sessions` table holds `id`, `host_profile`, `host_key`, `key_source`, `client_name`, `client_version`, `protocol_era`, `project_dir`, `gateway_id`, `open_receipt_id`, `turn_open`, `started_at` and `last_seen_at`. It is a mutable table (ADR-0003).

`clientInfo` is a display label only, never a key, because it is optional and self-reported. Values seen so far are all reports to verify in P2:
- Desktop local stdio reportedly sends `claude-ai` 0.1.0 (MCPJam probe);
- claude.ai connectors reportedly send `Anthropic/ClaudeAI` 1.0.0 [report].

**Project directory** (for `.searchhole.yaml` lookup), first available:
1. Claude Code `CLAUDE_PROJECT_DIR` env
2. Codex `_meta["codex/sandbox-state"].sandboxCwd` (declare the experimental capability)
3. Goose `_meta["agent-working-dir"]`
4. an explicit `--project` argument in the host config
5. the process `cwd` (only if it isn't the home directory or `/`)

Roots is deprecated and not used.

**Session-scope rules** (ADR-0008) attach to the session id.
- A re-key from the same project (`resume`, `compact`) carries them over.
- `SessionStart(source=clear)` drops them, which matches the user's mental model of a fresh conversation.
- **On sessions with a fallback key (source 4), session-scope rules are refused** with an explanation ("this host doesn't identify chats; use a global rule with `until:`"), because one process may serve many chats.

### Receipt: "which searches belong together?"

A **receipt** is a server-minted handle naming a set of searches and fetches.

- **Format:** `rcpt_` followed by 22 base64url characters (128-bit random). It is unguessable because on a local server it is the only bearer for reading receipt contents.
- **Returned on every `search`,** in text and `structuredContent`. `search` and `fetch` accept an optional `receiptId` to join an existing receipt explicitly.
- **Default grouping, when no `receiptId` is passed,** depends on the key source:
  - **Hook-keyed (Claude Code):** the turn's receipt. `UserPromptSubmit` opens it and `Stop` closes it (ADR-0014). There is no idle timeout. `sessions.open_receipt_id` is updated inside each search's `BEGIN IMMEDIATE`.
  - **Host-`_meta`-keyed (ChatGPT, VS Code, Goose):** the session's open receipt, closed after 10 minutes of inactivity.
  - **Fallback key:** **no auto-join.** Each search without a `receiptId` opens its own receipt. The tool description and server instructions tell the model to pass the previous `receiptId` to group related work.
- **`receipt` with no `receiptIds`** returns the session's most recent receipt on hook- or `_meta`-keyed sessions. On fallback sessions it returns a tool error asking for `receiptIds`, because guessing could show another chat's receipt. With a list, it returns those receipts.
- **Unknown or expired ids on `search`/`fetch`** are **not** errors. The search runs under a new receipt and returns a `receipt_expired` warning (ADR-0012). The `receipt` tool itself errors on unknown ids.
- **Retention:** receipts live as long as their searches (90 days by default, ADR-0015). Because the id survives in the chat transcript, reopening an old conversation can show its receipt again (SEP-2567 "resumption").

## Alternatives considered

- **Process lifetime as the session** (the plan's Desktop default). Rejected as a source of truth: the spec forbids it, and the facts show it's wrong almost everywhere. Kept only as fallback 4.
- **Reading the receipt id back from the transcript in the Stop hook** (plan §4 idea). Rejected. The transcript is written asynchronously and may lag. Hook-to-gateway calls (ADR-0014) give exact correlation with no file parsing.
- **Process ancestry matching** (nightshift: walk `ps` to the `claude` pid in both the hook and the gateway). Rejected as the primary mechanism: it is fragile on Windows and unnecessary once hooks call the gateway directly. Kept as a documented fallback if `mcp_tool` hooks prove unusable (ADR-0014).
- **Making the model always thread `receiptId`.** Rejected as a requirement, because models forget. It is optional; automatic grouping covers the common case, and explicit ids handle hosts that pool sessions.

## Consequences

- Claude Code receipts are exact per turn. ChatGPT, VS Code and Goose sessions are exact. Desktop, claude.ai, Cursor, Codex and Zed sessions are approximate, and the dashboard says so. On those hosts a receipt is exact **only when the model passes `receiptId`**. Otherwise each search is its own receipt, which is never wrong, only less grouped.
- The Stop-hook line shows "searches in this turn" because the turn's receipt closes at Stop.
- A loop guard (a per-session search cap with a clear tool error, as in litellm) can use the session id, with "approximate" sessions treated conservatively.

## Validate early

- **P0/P2:** confirm `${session_id}` substitution in `mcp_tool` hook `input`. The docs show only `${tool_input.*}` (ADR-0014).
- **P2:** log unknown `_meta` keys per `clientInfo` in debug mode, to find conversation keys we don't yet know about (Desktop, Cursor).
