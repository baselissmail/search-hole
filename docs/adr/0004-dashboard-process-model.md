# ADR-0004: Dashboard process model

- **Status:** Accepted (2026-10-30)
- **Related:** [0003](0003-sqlite-driver-and-access-layer.md), [0006](0006-upgrades-migrations-multi-install.md), [0012](0012-mcp-tool-surface-and-output-limits.md)

## Context

§4 proposes a default to test against Pi-hole FTL, AdGuard Home and Uptime Kuma:
- every gateway writes SQLite directly;
- the dashboard is a separate on-demand process;
- live updates tail `rowid > last` and push over SSE;
- there is no IPC.

What the research found:

- **The daemon projects are daemons because they own everything.** Pi-hole FTL, AdGuard Home and Uptime Kuma each run one long-lived process that owns the DB, API and UI. Kuma's live updates are in-process emits at write time. That only works with a single writer ([pi-hole-ftl.md](../research/pi-hole-ftl.md), [adguardhome.md](../research/adguardhome.md), [uptime-kuma.md](../research/uptime-kuma.md)).
- **Our writers are many and short-lived.**
  - Claude Desktop runs separate copies of local servers for chat and for Cowork/Code, plus a disposable probe sibling. The Windows Store build starts each one twice.
  - Claude Code stdio servers outlive the session that spawned them.
  - SDK-based clients spawn a probe sibling per connect.

  ([platform-facts-mcp.md](../research/platform-facts-mcp.md) §4, §7; [mcp-typescript-sdk.md](../research/mcp-typescript-sdk.md))
- **Live streams exist, but none tails a DB that many processes write:**
  - **agentgateway** tails a *single-writer* SQLite request log over SSE: a cursor, a 1 s poll, a 15 s heartbeat and a limit clamp. That is the closest precedent.
  - **mitmweb** and **Dokploy** push over WebSocket from the writing process.
  - **Context-forge** streams a per-process memory buffer that can't see other workers.
  - **Pi-hole, Langfuse, Infisical and Supabase Studio** poll.

  Our rowid tail *across processes* is the new part, so it needs a spike ([agentgateway.md](../research/agentgateway.md), [mitmproxy.md](../research/mitmproxy.md), [pi-hole-ftl.md](../research/pi-hole-ftl.md), [langfuse.md](../research/langfuse.md), [supabase-studio.md](../research/supabase-studio.md), [mcp-context-forge.md](../research/mcp-context-forge.md)).
- **There are good patterns to copy:**
  - mitmweb's *snapshot plus buffered deltas* with idempotent reducers ([mitmproxy.md](../research/mitmproxy.md))
  - ToolHive's discovery file with a nonce health check ([toolhive.md](../research/toolhive.md))
  - smart-doctor's SSE hygiene: `: ping` every 15 s, failure events never named `error`, close after `end` ([smart-doctor.md](../research/smart-doctor.md))
  - the Inspector's `fetch`-reader SSE that can carry auth, plus priming the stream to avoid a Firefox deadlock ([mcp-inspector.md](../research/mcp-inspector.md))

## Decision

**Keep the §4 default: no daemon, no IPC, and SQLite as the only shared medium.**

1. **Gateways write directly** (ADR-0003). Each also upserts a `gateways` row: pid, host profile, client name and version, search-hole version, schema version known, started_at and last_seen_at, refreshed at most every 30 s while active. The dashboard and `doctor` read it: "3 gateways running: claude-code 0.4.1 ×2, claude-desktop 0.5.0 ×1".
2. **`searchhole ui` is an on-demand, single-instance process:**
   - **Bind** `127.0.0.1` only, on a fixed default port **7341** (configurable). On `EADDRINUSE` from something other than us, exit with a clear message and `--port` advice. Never silently fall back to a random port, because the bookmark and cookie depend on the port.
   - **Discovery file** `<run>/ui.json` (`0600`, in a `0700` dir; roots per ADR-0015): `{port, pid, nonce, version, startedAt, loginSecret}`. A second `searchhole ui`, `/search-hole:dashboard` or a gateway building a receipt reads it, checks that `GET /health` returns the same nonce, and then reuses that instance. If the check fails, it removes the stale file. A lock (`ui.lock`, `O_EXCL` create with pid and start time, stale-checked) guards startup races.
   - **Lifetime:** the UI exits after 30 minutes with no connected browser and no API calls (configurable). Running in the foreground with `--stay` disables that.
3. **Who starts it:** only an explicit user action, which means the CLI or the `/search-hole:dashboard` slash command (`searchhole ui --detach --open`).
   - A gateway **never** starts it by itself: orphaned UI processes from model actions are not acceptable.
   - The receipt panel has no "Open dashboard" button. It keeps its two actions (ADR-0012).
   - The `receipt` text shows the bare URL `http://127.0.0.1:7341/` when `ui.json` shows a live instance, plus "run `/search-hole:dashboard` to sign in". Otherwise it names the command that starts one. **No token or login code ever appears in MCP output.**
4. **Security.** smart-doctor provides the Host allowlist, CSP, JSON-only writes and bundled fonts ([smart-doctor.md](../research/smart-doctor.md)). The fragment token idea comes from MCPJam, and the bearer-over-fetch SSE from the Inspector. The login-code flow and the Origin check are **new code with their own tests**.
   - **Login:**
     - `searchhole ui --open` (or the slash command) calls `POST /api/login-code`, authenticated with `loginSecret` from `ui.json`, and receives a **single-use code valid for 60 s**. It then opens `http://127.0.0.1:7341/#c=<code>`.
     - The page exchanges the code (`POST /session`) for a session token and immediately calls `history.replaceState(null, '', '/')`.
   - **Session token:**
     - It lives in **`sessionStorage`**, which is origin-scoped and therefore isolated per port.
     - It is sent as **`Authorization: Bearer`** on every API call, and on the SSE stream, which is read with `fetch()` + a stream reader (not `EventSource`, which can't set headers; Inspector pattern).
     - **No cookies**, because cookies aren't isolated by port and every `127.0.0.1:*` server would receive them.
   - **Request checks:**
     - a Host-header allowlist (`127.0.0.1:<port>`, `localhost:<port>`) against DNS rebinding;
     - an `Origin` check on every non-GET request;
     - no CORS headers;
     - a strict CSP with no inline script and fonts bundled;
     - every write endpoint and the SSE endpoint authenticate exactly like the rest (Dokploy's WebSocket lesson, [dokploy.md](../research/dokploy.md)).

   Web-sourced text is rendered as text only, never as HTML (§12.4).
5. **Live updates:** SSE over a DB tail.
   - `GET /api/stream?after=<rowid>`. Each event is `id: <rowid>`, `event: search`, with a *summary* payload: query, client, profile, counts, latency and decision summary. Results load when a row is expanded.
   - The tailer polls `SELECT … WHERE rowid > ? ORDER BY rowid LIMIT 200` every **250 ms**, only while at least one client is connected.
   - It serializes each row once and fans out through bounded per-client queues. On overflow it sends `reset` to that client.
   - Keepalive is a `: ping` comment every 15 s. Failure events are named `stream-error`.
6. **Client protocol** (mitmweb):
   1. Open the stream (fetch reader with the bearer token) and fetch the snapshot page in parallel.
   2. Buffer stream events until the snapshot lands.
   3. Apply the snapshot, then replay the buffer.

   Reducers are idempotent. `Last-Event-ID` resumes after a reconnect. A `reset` event (retention prune, "delete all data", queue overflow) forces a refetch. The **polling fallback** uses the same cursor contract (`GET /api/searches?after=`, every 2 s), so a broken SSE path degrades to Pi-hole behaviour, not to a blank page.
7. **Long operations** such as list refresh or import stream progress as SSE or chunked lines from a `POST`, mirroring the CLI output (Pi-hole's gravity stream).

## Alternatives considered

- **A long-running daemon that gateways call over HTTP.** Rejected. It needs process supervision on three OSes, a discovery and auth handshake for every gateway, a version handshake (the Inspector's mcpdo daemon serves stale code after upgrades), and it creates a single point of failure on the search path. SQLite already gives cross-process durability and ordering.
- **A gateway auto-starting the UI.** Rejected (point 3). It would create orphans and surprise listeners.
- **WebSocket.** Rejected. The client never needs to send data over the socket: filters are query parameters and keyset SQL. SSE is simpler and resumable.
- **SQLite `update_hook` or file watching.** Rejected. Neither crosses process boundaries reliably on all three OSes, and polling `rowid` at 250 ms costs less than 1 ms per poll.
- **A random port per start** (smart-doctor). Rejected for a long-lived tool: bookmarks would break.

## Consequences

- No coordination code on the search path, and a gateway crash can't take the UI down (or the reverse).
- Live latency is at most about 250 ms plus the write commit, which meets "live but calm".
- The UI reads per-engine health and quota from rows the gateways write. That works even for keys the UI can't see (ADR-0007).
- Running 30 or more gateway rows is normal. `doctor` and Engines show them grouped.

## Validate early (P1 spike, before P4)

- Tail benchmark: 8 writers at 10 searches/s for 10 minutes, with 2 browser clients connected. Check the latency distribution and that nothing is duplicated or lost across a reconnect with `Last-Event-ID`.
- The port-conflict and stale-`ui.json` paths; the login code is single-use and expires after 60 s; a session token from another port's origin is rejected; DNS-rebinding tests (a wrong `Host` gets 403); and a test that no MCP tool output contains a code or token.
- A tail cursor that survives deletes: `searches.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`, and a `meta.data_epoch` change or `MAX(rowid) < cursor` triggers `reset` (ADR-0003).
