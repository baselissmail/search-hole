# ADR-0018: Claude Code search modes: `auto` (default), `builtin`, `engines`

- **Status:** Accepted (2026-10-30). Supersedes the Claude Code parts of ADR-0014 point 2 (WebSearch steering) and ADR-0017 points 1–2 (first run).
- **Related:** [0014](0014-claude-code-hook-integration.md), [0017](0017-first-run-and-default-engines.md), [0009](0009-engine-adapter-interface.md), [spikes §6](../research/spikes-2026-10-30.md)

## Context

Basel asked why a user would need SearXNG or Tavily at all. The earlier design assumed search-hole had to *replace* the assistant's search with an engine we call. The 2026-10-30 spike showed that in Claude Code we can **govern the built-in WebSearch instead**:

- **Before the search:** a `PreToolUse` hook's `updatedInput` can add `blocked_domains` (and `allowed_domains`). Anthropic's search applies them server-side.
- **After the search:** a `PostToolUse` hook's `updatedToolOutput` can remove results before the model sees them. Verified: the model never saw the stripped sites.
- **What we can see:** the built-in result contains titles and URLs, plus a summary text written by the search step. It has no snippets and no dates.

## Decision

**Claude Code has three modes. The default is `auto`.** The comparison in [spikes §7](../research/spikes-2026-10-30.md) showed the built-in search is noisier for developer queries (mirrors, scraped copies, SEO farms; official docs sometimes missing, no snippets or dates), while SearXNG gives better raw material but degrades under agent volume. Neither alone is best.

- **`auto` (default):**
  - **With at least one healthy engine:** our `search` is primary, and WebSearch is denied and steered to it (ADR-0014 point 2) for the full pipeline: ranking, freshness, snippets, dates, fusion.
  - **Otherwise, or whenever every engine fails:** WebSearch is **allowed but filtered** (`builtin` behaviour below), so the fallback is never unfiltered while the gateway runs.
  - **Zero setup:** it starts in builtin behaviour and upgrades itself the moment `doctor` adds SearXNG or a key.
- **`builtin`:** always filter Claude's own WebSearch and never steer.
- **`engines`:** always steer to our `search`, falling back to filtered built-in only when every engine fails.

**Recommended setup** (which `doctor` suggests):
- SearXNG via Docker (free, private, best developer results);
- **plus** a free Tavily key (no card) as a second engine, so SearXNG's upstream rate limits don't degrade results;
- `standard` depth fuses both.

The table compares the two behaviours `auto` switches between:

| | builtin behaviour (zero setup; `auto` without a healthy engine) | engines behaviour (`auto` with a healthy engine; the only mode on other hosts) |
|---|---|---|
| Who searches | Claude's own WebSearch | engines the user chose (SearXNG, Tavily, Brave, …) |
| Setup | **none** (works at install) | Docker or a key (ADR-0017) |
| Blocking | domain blocks → `blocked_domains` (clean, server-side); regex, path and list rules → stripped in PostToolUse | full pipeline (ADR-0008/0010) |
| Pins, raise, lower | reorder the result list; mark pins | full RRF weighting |
| Allowlist mode | `allowed_domains` | profile `defaultAction: block` |
| Log, dashboard, receipts | yes (queries, kept/hidden with rules) | yes |
| Snippets and dates in receipts | **no** (only from pages the model opens with our `fetch`, or via WebFetch metadata where available) | yes (engine dates) |
| Engine choice, multi-engine fusion, `deep` | no | yes |

1. **Claude Code hooks in `builtin` mode** (still answered by the gateway through `mcp_tool` hooks; ADR-0014 points 0–1, 3–7 unchanged):
   - **PreToolUse(WebSearch):**
     - run query hygiene (block or redact);
     - resolve the profile;
     - inject the user's and list domain blocks into `blocked_domains`, user tiers first, up to the cap found in the spike;
     - **allow**: no deny, no steering.
   - **PostToolUse(WebSearch):**
     - decide every result with the full rules engine and drop hidden ones;
     - reorder for pins, then raise/lower;
     - if any result was removed *only* in PostToolUse, the summary text is replaced by "(summary withheld: it may cite sources your rules hid)";
     - add one short `additionalContext` line ("search-hole hid 3 results by your rules; receipt rcpt_…");
     - log everything.
   - **PreToolUse(WebFetch):** deny blocked domains (real block, with the rule in the reason).
   - **PostToolUse(WebFetch):** log the opened source for the receipt.
2. **Engines behaviour** (in `auto` with a healthy engine, or in `engines` mode): the ADR-0014 point 2 rules apply, so WebSearch is denied while an engine is healthy and the model is steered to `search`. When steering isn't possible (an engine fails, or the deny-loop breaker trips), WebSearch runs **with the builtin filters**. The mode is set with `/search-hole:mode auto|builtin|engines` or `settings.yaml` `hosts.claude-code.mode`. Our `search` and `fetch` tools stay available in every mode.
3. **Fail-safe:** if the gateway isn't connected, `mcp_tool` hooks fail open and WebSearch runs unfiltered. The Stop line says "search-hole wasn't running for this search" when it can tell.
4. **Other hosts are unchanged.** Claude Desktop, claude.ai, ChatGPT, VS Code and Zed offer no way to filter their built-in search, so search-hole there *is* the search tool and needs an engine (ADR-0017). Cursor and Codex hooks get the same spike in P7. If they support output rewriting, they get `builtin` mode too.
5. **First run in Claude Code is zero-config:** install the plugin and filtering, the log and receipts work at once. `doctor` then offers the upgrade ("better developer results, snippets, dates and freshness: start SearXNG (Docker) and/or add a free Tavily key"), and `auto` switches over by itself.

## Alternatives considered

- **Engines only** (the previous default). Rejected for Claude Code: it forces Docker or an account on every user, for a value (blocking, visibility) we can deliver without either.
- **`builtin` everywhere.** Not possible: other hosts expose no output-rewriting hook.
- **Rewriting the summary text sentence by sentence** to drop mentions of hidden sources. Rejected for v1: it is fragile. Withholding the summary is honest and safe.

## Consequences

- The Claude Code plugin is useful at install with zero setup. That restores the §1 "under 2 minutes" story without Docker or keys.
- **Receipts in `builtin` mode have fewer facts.** No engine dates. Freshness rules can only use dates from opened pages. This is documented.
- The PreToolUse and PostToolUse hooks become the hot path in Claude Code. They must answer in under 50 ms, which an in-process `mcp_tool` call does.
- ADR-0014 point 2 (deny and steer) now applies only in `engines` mode. ADR-0017's flow applies to Claude Code only when the user opts into engines, and remains the default on other hosts.

## Validate early (P2/P3)

- The `blocked_domains` cap (and the behaviour when exceeded). The precedence: a user `allow` must remove that domain from `blocked_domains` even when a list blocks it.
- Shape validation: a malformed `updatedToolOutput` is silently ignored by Claude Code. Tests must catch shape drift across Claude Code versions (a contract test on the recorded shape).
- Plugin evals: blocked domains never reach the model; pins come first; zero-config install works.

## Amendment (2026-10-31): the local log keeps built-in titles and URLs

The first version stored only the domain, URL hash and decision for built-in results, out of caution about the search provider's terms. Dogfooding showed that makes the log useless for its main job: you can't tell which page Claude used. Built-in results are the user's own Claude Code session data, already delivered to this machine, so `filterBuiltinResults` now stores each result's title and URL in `result_payloads` (engine `builtin`) under the normal retention (`retention` → result payloads, default 90 days). Engine results keep their per-engine policies (ADR-0009 point 9): Brave, Kagi and Exa stay decisions-only.

Also added: a bundled `official-docs` list (CC0-1.0, `packages/search-hole/src/lists/bundled/official-docs.ts`). It is annotation-only, so it types results as `official` and never hides anything. The built-in default profile prefers it (×1.45, the same lift as `raise 3`) unless the user defines their own `default` profile.

## Amendment (2026-10-31, v0.1.1): review fixes

An adversarial review of the gateway and app found these gaps:

- **`engines` falls back as decided above.** It now works as filtered built-in once every configured engine has failed (state `unhealthy`); `unknown` still counts as usable. Before, it always denied WebSearch, so with engines down the model went round a deny → failed `search` → deny loop. The deny-loop breaker also counts only `search` calls that returned, so a failed `search` no longer resets it.
- **The mode lives in `settings.yaml` only.** The plugin's `search_mode` option is gone. Claude Code substituted its default into `SEARCHHOLE_MODE`, which outranks the file, so `/search-hole:mode` silently did nothing. `SEARCHHOLE_MODE` remains as an explicit override, and `searchhole mode` warns when it is set. A running gateway re-reads `settings.yaml` when its `stat` changes, so a mode change reaches live sessions on the next call.
- **Only domain blocks go into `blocked_domains`.** The API documents that "subdomains are automatically included (`example.com` covers `docs.example.com`)", and `-site:` behaves the same in engines. Pushing `=github.com` therefore also removed `docs.github.com` upstream, with nothing logged. Exact-host blocks are now applied after the search by our own decision; engine pushdown (ADR-0009 point 8) follows the same rule. An empty `allowed_domains` is dropped before blocks are added, because a request with both lists is a 400.
- **PostToolUse parsing is per item.** A null, an item with no URL, or an error block no longer leaves the whole response unfiltered. A response we can't read at all tells the model the rules were not applied, instead of saying nothing.
