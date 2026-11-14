# ADR-0025: Review list and Opened labels

**Status:** Accepted (2026-11-14)
**Related:** [0003](0003-sqlite-driver-and-access-layer.md) (queries), [0005](0005-session-definition.md) (sessions and receipts), [0009](0009-engine-adapter-interface.md) (engine retention), [0012](0012-mcp-tool-surface-and-output-limits.md) (write paths), [0014](0014-claude-code-hook-integration.md) (guard), [0015](0015-settings-data-locations-retention.md) (retention), [0020](0020-dashboard-v1.md) (dashboard)

## Context

Two weeks of real use: 96 searches, 1,243 results from 538 sites, **zero hidden and zero rules added**. Many low-quality sites showed up in 5 to 10 separate searches, and the assistant never opened one page from them. Checking by hand "which results did the assistant open, and which did it skip" was the most useful thing the log offered, and the product did not do it.

The log already stores what is needed:
- `results.url_hash` and `results.registrable_domain` for every result, kept or hidden;
- `fetches` rows with decision `opened`, written by our `fetch` tool and, in Claude Code, by the WebFetch hook.

Nothing joined the two. Constraints for this change:
- everything is computed from the local SQLite log, with no network call;
- no schema migration;
- rules change only by a user action (Principle 3);
- queries stay fast on a large log (100,000 result rows).

## Decision

### 1. Every logged result is Opened, Seen or Hidden

- **Opened:** a `fetches` row with decision `opened`, **in the same session as the search**, whose `url_hash` or `final_url_hash` equals the result's `url_hash`. All three are the SHA-256 of the canonical key (ADR-0010 point 1), so `http`/`https`, `www.`, tracking parameters, AMP and mobile variants compare equal, and a redirect counts through its final URL.
- **A search without a session** falls back to its own receipt.
- **Hidden:** the result's decision is `hidden`. A hidden result is never "Opened": the assistant was never shown it.
- **Seen:** kept, not opened.

The session, not the receipt, is the scope because a Claude Code receipt is one turn (ADR-0005): a page opened two turns after the search still answers "did the assistant open it".

`fetches` has no session index and this ADR adds none. A session's fetches are reached through `receipts_by_session` and then `fetches_by_receipt`; the session filter is then applied to the rows, so a fetch another session filed under the same receipt does not count. Two statements answer any number of searches (at most 500 per call).

Surfaces:
- **App:** `LogDetail.results[].opened` (a required boolean) and an `opened` count on `LogDetail` and on the `LogEntry` rows of `log.recent`.
- **CLI:** `searchhole log show <id>` marks each kept result `opened` or `seen` and prints `opened N of M`; `--json` carries `opened: true|false`. `searchhole log` adds `· N opened` to a search that led to opened pages.
- **Dashboard:** the results panel of the Live log shows the label per result and "opened 3 of 19" in its header. Pages are opened after a search is logged, so the detail of an expanded search is re-read every 15 s while the tab is visible.
- **Not in the Live log table.** Its rows are pushed when the search is logged, when the count is always 0; keeping a column current would mean re-reading every loaded row. Dashboard pages and stream events therefore carry no `opened` count.

### 2. The review list: sites seen often, never opened

**Definition.** Over the last `days` days (default 30, 1 to 365): every registrable domain with **kept results in at least 3 distinct searches** and **no opened page of that domain** in the window. An opened page counts for the domain it ended on and, when it was redirected, for the domain it was requested from.

**Left out:**
- a site that one of the user's **global rules** decides: any action (`block`, `allow`, `pin`, `raise`, `lower`, `normal`), in any profile, unless the rule is past its `until`. Matching is the rules engine's: the global rules are compiled alone (no lists) and asked about `https://<domain>/` and about the site's stored pages. A site is left out when a rule matches the bare domain, or matches every stored page (which covers `=www.example.com`). Project and session rules do not count: the list is global, and they are not standing decisions about a site;
- a site the user **dismissed** ("this site is fine").

**Returned** for each site: domain, number of searches, number of results, last seen, the source type of its most recent kept result, and up to 3 example pages (distinct pages, the most often returned first). Sorted by searches, then results, descending. Engines that store decisions only (Brave, ADR-0009 point 9) keep no title or URL, so a site only they returned is listed with no examples and says so.

**Queries** (`src/store/queries/review.ts`), never one per site:
1. opened domains: a range scan of `fetches_by_created`;
2. candidates: one grouped query over the `results_by_created` range, with `COUNT(DISTINCT search_id)`, at most 1,000 rows;
3. examples: one query for the sites that are shown, ranked with a window function, reading payloads through `result_payloads_by_result`.

Measured on 100,000 result rows (8,000 searches, 600 sites): about 70 ms for 2 and 3 together. `test/store/review.test.ts` asserts the query plans and runs that size.

**Dismissals** are one `meta_kv` row, `review.dismissed`: a JSON object of registrable domain → epoch ms. It is read, changed and written inside one `BEGIN IMMEDIATE` transaction, and keeps the newest 2,000 entries. No migration. Retention does not prune it.

**Actions per site:**
- **Block** and **Lower** add an ordinary global rule through the existing rule path (`rules.add`), with the dashboard's 8-second Undo;
- **Keep** dismisses the site, with the same Undo, and a kept site can be listed again later.

**Surfaces:**
- **Dashboard:** a Review tab on the Rules page (`/rules/review`) with a count badge. It loads as its own chunk; only the badge is in the initial bundle.
- **CLI:** `searchhole review [--days <n>] [--json]` lists the sites and prints one line naming the commands to act (`searchhole block <site>`, `searchhole lower <site>`, `searchhole review keep <site>`). `searchhole review keep <site>` dismisses and `searchhole review unkeep <site>` undoes it.
- **Slash command:** `/search-hole:review`, a user-only skill like `/search-hole:suggestions`.
- **HTTP:** `GET /api/review` (`days`, `limit`), `POST /api/review/dismiss` and `POST /api/review/restore` with `{ domain }`, behind the same Host, Origin, bearer-token and body-limit checks as every other `/api` route (ADR-0004 point 4).

**The model cannot change the list.** No MCP tool exposes it. `review keep` and `review unkeep` pass the CLI's actor gate (ADR-0012, write paths, point 4), and the PreToolUse guard denies them the way it denies `suggestions approve` (ADR-0014 point 3). Reading the list changes nothing and stays allowed.

## Alternatives considered

- **A migration: an `opened` column on `results`, or an index on `fetches(session_id)`.** Rejected. Whether a result was opened changes after the search is logged, so a column would mean another process updating append-only rows. The receipt indexes already reach a session's fetches. Add the index if a query plan ever shows a scan.
- **Scope "opened" to the receipt.** Rejected: a Claude Code receipt is one turn, so a page opened in the next turn would read "Seen".
- **Match by domain for the per-result label.** Rejected: it would mark every result of a site once one page was opened. The domain is the right unit for the review list, not for the label.
- **Queue a suggestion per site, or lower such sites automatically.** Rejected. "Never opened" is a hint, not a verdict: the assistant may have answered from the snippet. The list points; the user decides (Principle 3).
- **Keep dismissals in `rules.yaml` or `settings.yaml`.** Rejected. A dismissal is not a rule and would add noise to a file people share; settings hold endpoints and limits. A user who prefers a file can add a `normal` rule, which takes the site off the list as well.
- **A daily rollup table (domain × day).** Rejected for now: it needs a migration, and the grouped query takes about 70 ms on 100,000 rows.
- **An "opened" column in the Live log table.** Skipped (see point 1).

## Consequences

- `LogDetail` results gain a required `opened` flag. For JSON consumers this is additive.
- The list knows only what was logged:
  - a page read outside search-hole (a shell command, or a host's own fetch tool on hosts without hooks) is not an opened page, so its result reads "Seen" and its site can be listed;
  - retention (90 days by default) bounds the window;
  - a site returned only by a decisions-only engine has no examples.
- On hosts that do not identify chats, one approximate session key can cover several conversations of one gateway process (ADR-0005), so "opened" is then per process, not per chat.
- The Rules pages make one more request (`GET /api/review`) for the badge, and an expanded search is re-read every 15 s.
- The 1,000-candidate cap is applied before rules are checked. A user with more than 1,000 unruled, never-opened sites in the window sees the most-seen ones first; `total` then undercounts.

## Validate early

- Dogfood for two weeks: does the list contain the sites found by hand, and is 3 searches the right threshold?
- Watch for sites that are useful but answered from snippets (reference pages). If Keep is used for most of the list, raise the threshold or weigh by rank.
