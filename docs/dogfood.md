# Dogfood log

The release gate in MASTER_PLAN §11 P8: **at least 2 weeks of daily use since P3, with no open P0 or P1 entry here.** Log every miss as it happens, even a small one. The log drives what gets fixed next, and it is the evidence for the gate.

## How to log

Add one row per problem to the table at the bottom, newest first. Keep queries and URLs only when they are not private (no internal hostnames, ticket numbers or personal searches).

| Field | What to write |
|---|---|
| **Date** | `YYYY-MM-DD` |
| **Version** | `searchhole version`, or the plugin or extension version |
| **Client** | Claude Code (built-in, auto or engines mode), Claude Desktop, CLI, dashboard, or another MCP client; plus the OS |
| **Task** | What you were doing, in a few words ("React 19 upgrade notes", "compare two NAS models") |
| **What went wrong** | What happened, what you expected, and how you noticed. Link a `searchhole log show <id>` id when there is one |
| **Severity** | P0 to P3 (below) |
| **Status** | `open`, `fixed in <version or commit>`, `wontfix: <why>`, `duplicate of <date>` |

### Severity

| Level | Meaning | Examples |
|---|---|---|
| **P0** | Search is broken, unsafe, or loses data. Stop and fix. | Every WebSearch is denied with no fallback; a blocked site reaches the model; a key appears in a log or tool output; the database is corrupted after an upgrade |
| **P1** | A main path fails or misleads, with no reasonable workaround. Must be fixed before a release. | The receipt says "opened" for a page that wasn't; the plugin fails to start on a fresh install; the dashboard login code never works; rules are silently ignored in one mode |
| **P2** | Works, but worse than it should be, or there is a workaround. | Poor ranking for a common query; a confusing `doctor` message; slow hooks (> 50 ms); a stale official doc ranked first |
| **P3** | Polish. | Wording, layout, a missing shortcut, a log line that could be clearer |

Gate check before tagging a release (docs/release.md):

- the first row of the "Daily use" table is at least 14 days old;
- there are no gaps longer than a weekend;
- no row has severity P0 or P1 with status `open`.

## Daily use

One line per day of real use, so the 2-week clock is visible. Fill in a day even when nothing went wrong.

| Date | Version | Clients used | Searches (roughly) | Notes |
|---|---|---|---|---|
| YYYY-MM-DD | 0.2.0 | Claude Code (auto) | 20 | — |

## Problems

| Date | Version | Client | Task | What went wrong | Severity | Status |
|---|---|---|---|---|---|---|
| YYYY-MM-DD | 0.2.0 | Claude Code (builtin), macOS | example: "React 19 compiler docs" | example: a Medium copy ranked above react.dev after `pin react.dev` | P2 | open |
