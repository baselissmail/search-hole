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
| 2026-11-14 | 0.3.0 | Claude Code (auto, no engine), macOS | 1 | Pre-launch review; see Problems |
| 2026-11-13 | 0.3.0 | Claude Code (auto, no engine), macOS | 38 | 77 pages opened |
| 2026-11-12 | 0.3.0 | Claude Code (auto, no engine), macOS | 0 | Used all day, no web search |
| 2026-11-11 | 0.3.0 | Claude Code (auto, no engine), macOS | 0 | Used, no web search |
| 2026-11-10 | 0.3.0 | Claude Code (auto, no engine), macOS | 0 | Used all day, no web search |
| 2026-11-09 | 0.3.0 | Claude Code (auto, no engine), macOS | 1 | — |
| 2026-11-08 | 0.3.0 | Claude Code (auto, no engine), macOS | 0 | Used, no web search |
| 2026-11-07 | 0.3.0 | Claude Code (auto, no engine), macOS | 12 | 61 pages opened |
| 2026-11-06 | 0.3.0 | Claude Code (auto, no engine), macOS | 9 | — |
| 2026-11-05 | 0.3.0 | Claude Code (auto, no engine), macOS | 6 | — |
| 2026-11-04 | 0.3.0 | Claude Code (auto, no engine), macOS | 10 | — |
| 2026-11-03 | 0.3.0 | Claude Code (auto, no engine), macOS | 4 | — |
| 2026-11-02 | 0.3.0 | Claude Code (auto, no engine), macOS | 0 | Used, no web search |
| 2026-11-01 | 0.3.0 | Claude Code (auto, no engine), macOS | 14 | 39 pages opened |
| 2026-10-31 | 0.2.0 | Claude Code (auto, no engine), macOS | 2 | First day |

These rows were filled in afterwards, on 2026-11-14, from the local search log (searches and opened pages per day, counted in local time). Nothing was noted day by day, so the "Notes" are thin. From here on, write the row on the day.

What this period does **not** cover: engines mode (no engine was set up, so ranking, snippets, dates and freshness rules had no real use), every client other than Claude Code, and every OS other than macOS.

## Problems

| Date | Version | Client | Task | What went wrong | Severity | Status |
|---|---|---|---|---|---|---|
| 2026-11-14 | 0.3.0 | Claude Code (auto, no engine), macOS | Review of two weeks of use | In 96 searches (1,243 results from 538 sites) no rule or list hid anything, and no rule was added or suggested. Several sites appeared in 5 to 10 separate searches and were never opened; nothing in the product points at them. | P2 | open: a review list ("seen often, never opened") and Opened / Seen / Hidden labels are being added |
| 2026-11-14 | 0.3.0 | Claude Code (auto, no engine), macOS | Any first search in a session | The plugin told Claude to prefer its `search` tool, which always fails with no engine, so sessions began with a failed call and a visible error. Found in dozens of session transcripts. | P2 | fixed in `c827206` |
| 2026-11-14 | 0.3.0 | Claude Code, macOS | Review | `searchhole ui` was not a guarded command and printed its sign-in link, so Claude could sign in to the dashboard and change rules. | P1 | fixed in `bb141ac` |
| 2026-11-14 | 0.3.0 | CLI, macOS | Checking a site | `searchhole explain csdn.net` said "kept" for a blocked site; only `https://csdn.net/…` gave the right answer. | P1 | fixed in `26a810d` |
| 2026-11-14 | 0.3.0 | Claude Code (auto, no engine), macOS | Review of two weeks of use | Only 8 of 40 pages opened through search-hole's `fetch` got a publish date. | P2 | open |
| 2026-11-14 | 0.3.0 | Claude Code (auto, no engine), macOS | Review of two weeks of use | 767 of 1,243 results had the source type "unknown". | P3 | open |
| 2026-11-14 | 0.3.0 | Claude Code (auto), macOS | Review of two weeks of use | An audit list (`laylavish-huge-ai`) would have hidden results from huggingface.co. Audit was the right default; it must not be enforced as it is. | P3 | open: report upstream or add an allow to the starter set |
