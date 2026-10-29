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

1. **Hook-reported key** (Claude Code): the latest `session_id` reported to *this gateway process* by a search-hole hook (ADR-0014). Every hook call carries `session_id`, so after `/clear` the next hook re-keys the process.
2. **Host `_meta` key:** `openai/session`, `vscode.conversationId`, `agent-session-id`. The adapter table lives in `gateway/host-keys.ts`, so adding a host is one line.
3. **Spawn env:** `CLAUDE_CODE_SESSION_ID` (Claude Code before the first hook fires).
4. **Fallback label:** `(gateway pid, host profile)` plus an **idle gap of 30 minutes**. Activity after a longer gap starts a new session. This is a grouping label, never a security or trust decision, and the UI marks it "approximate".

The `sessions` table holds `id`, `host_profile`, `host_key`, `key_source`, `client_name`, `client_version`, `protocol_era`, `project_dir`, `gateway_id`, `started_at` and `last_seen_at`. `clientInfo` is a display label only, never a key: it is optional and self-reported, and Desktop and claude.ai both send `claude-ai` 0.1.0.

**Project directory** (for `.searchhole.yaml` lookup), first available:
1. Claude Code `CLAUDE_PROJECT_DIR` env
2. Codex `_meta["codex/sandbox-state"].sandboxCwd` (declare the experimental capability)
3. Goose `_meta["agent-working-dir"]`
4. an explicit `--project` argument in the host config
5. the process `cwd` (only if it isn't the home directory or `/`)

Roots is deprecated and not used.

**Session-scope rules** (ADR-0008) attach to the session id. When a session's key changes (for example `/clear`), its session rules don't carry over. That matches the user's mental model of a fresh conversation.

### Receipt: "which searches belong together?"

A **receipt** is a server-minted handle naming a set of searches and fetches.

- **Format:** `rcpt_` followed by 22 base64url characters (128-bit random). It is unguessable because on a local server it is the only bearer for reading receipt contents.
- **Returned on every `search`,** in text and `structuredContent`. `search` and `fetch` accept an optional `receiptId` to join an existing receipt explicitly.
- **Default grouping, when no `receiptId` is passed:** the session's *open* receipt. A receipt closes at:
  - a Claude Code `Stop` hook for that session (one receipt per turn);
  - 10 minutes of inactivity in the session;
  - an explicit `receipt` call with `close: true`.

  The next search opens a new receipt.
- **`receipt` with no `receiptIds`** returns the session's most recent receipt (open or closed). With a list, it returns those receipts.
- **Unknown or expired ids** produce a tool error: "receipt rcpt_… expired; omit receiptId to start a new one". The search still runs.
- **Retention:** receipts live as long as their searches (90 days by default, ADR-0006). Because the id survives in the chat transcript, reopening an old conversation can show its receipt again (SEP-2567 "resumption").

## Alternatives considered

- **Process lifetime as the session** (the plan's Desktop default). Rejected as a source of truth: the spec forbids it, and the facts show it's wrong almost everywhere. Kept only as fallback 4.
- **Reading the receipt id back from the transcript in the Stop hook** (plan §4 idea). Rejected. The transcript is written asynchronously and may lag. Hook-to-gateway calls (ADR-0014) give exact correlation with no file parsing.
- **Process ancestry matching** (nightshift: walk `ps` to the `claude` pid in both the hook and the gateway). Rejected as the primary mechanism: it is fragile on Windows and unnecessary once hooks call the gateway directly. Kept as a documented fallback if `mcp_tool` hooks prove unusable (ADR-0014).
- **Making the model always thread `receiptId`.** Rejected as a requirement, because models forget. It is optional; automatic grouping covers the common case, and explicit ids handle hosts that pool sessions.

## Consequences

- Claude Code receipts are exact per turn. ChatGPT, VS Code and Goose sessions are exact. Desktop, claude.ai, Cursor, Codex and Zed sessions are approximate. The dashboard says so, and the receipt itself (an explicit handle) is exact everywhere.
- The Stop-hook line shows "searches in this turn" because the turn's receipt closes at Stop.
- A loop guard (a per-session search cap with a clear tool error, as in litellm) can use the session id, with "approximate" sessions treated conservatively.

## Validate early

- **P0/P2:** confirm `${session_id}` substitution in `mcp_tool` hook `input`. The docs show only `${tool_input.*}` (ADR-0014).
- **P2:** log unknown `_meta` keys per `clientInfo` in debug mode, to find conversation keys we don't yet know about (Desktop, Cursor).
