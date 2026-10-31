# ADR-0019: Per-session loop guard

**Status:** Accepted (2026-10-31, v0.1.1)

## Context

An agent stuck in a loop can run hundreds of searches in minutes. Each one spends the user's money or quota: Tavily credits, Brave's monthly allowance, and Anthropic's $10 per 1,000 built-in searches. ADR-0005 anticipated "a per-session search cap with a clear tool error, as in litellm", using the session id, with approximate sessions treated conservatively. Nothing enforced it in v0.1.0.

Loops come in two shapes:
- **Runaway volume:** many different queries.
- **Repetition:** the same query again and again, often after a result the model didn't like.

## Decision

Three limits in `settings.yaml` under `limits` (env: `SEARCHHOLE_LIMIT_*`). 0 turns a limit off.

| Setting | Default | Scope |
|---|---|---|
| `searchesPerTurn` | 40 | Hook-keyed sessions only (Claude Code), whose turns are exact (ADR-0014 point 1). Reset by the next prompt. |
| `searchesPerHour` | 120 | Per session key, sliding hour. Fallback and sessionless keys get **twice** the limit: one approximate key may cover several chats in one process, and a false stop is worse than a late one. |
| `repeatQuery` | 3 | The same search (NFKC-lowercased, whitespace-collapsed query + depth, profile and engines) for the Nth time within 10 minutes is refused. `1` is rejected as a setting, because it would refuse everything. |

- **What counts:** our `search` and Claude Code's built-in WebSearch, together. A built-in search and our `search` with the same words are different repeat keys, since they return different results. Only searches that returned count: engine failures and refusals never use up the budget, so they can't strand the model.
- **Where it applies:** in the App, for every host except the CLI (the terminal is the user's own command).
  - `search` throws `search_limit`, which becomes a tool error with "why → fix".
  - The WebSearch PreToolUse hook denies with the same text, through `App.searchBudget`, in every mode.
- **The fix text** tells the model to answer with what it has, or ask the user. It never tells it to retry.
- **State:** in memory per gateway process, bounded to 256 sessions. The gateway is the source of truth for its sessions (receipts.ts). A restart forgets the counts, which errs on the side of not blocking.

## Alternatives considered

- **Store-backed counters** (shared across processes). Rejected for v0.1: a session belongs to one gateway process, and an extra write per search on the hot path buys nothing.
- **Returning cached results for repeats** instead of refusing. Deferred. It hides the loop from the model, which keeps looping, and needs a result cache we don't keep yet (ADR-0015 retention).
- **Per-receipt caps for `_meta`/env sessions.** Their receipts close after 10 idle minutes, so the hourly cap covers them with one rule.

## Consequences

- A runaway turn costs at most 40 searches by default, and a looping session at most 120 an hour.
- Deep research in one turn above 40 searches needs a higher `searchesPerTurn`. The error names the setting.
- The limits apply per gateway process, so two Claude Code windows each get their own budget.

## Validate early

- Dogfood the defaults with the research skill. If deep turns routinely pass 30 searches, raise the turn limit.
