# ADR-0010: Merge algorithm and weights

- **Status:** Accepted (2026-10-30)
- **Related:** [0008](0008-rule-format-and-precedence.md), [0009](0009-engine-adapter-interface.md), [0011](0011-date-extraction-chain.md)

## Context

§5 steps 5–8: normalise and dedupe, fuse ranks across engines with reciprocal rank fusion, apply rule weights (`raise N` = ×(1 + 0.15·N)), put pins on top, remove blocks, then apply freshness. Record a decision for every result, including hidden ones. The research:

- **SearXNG's score** is `n·(Πw)·Σ1/p`. It over-rewards agreement quadratically, multiplied weights drag down co-found results, and "high priority" only removes rank decay rather than pinning. Its dedupe key normalises almost nothing ([searxng.md](../research/searxng.md)).
- **agent-search** blends coverage, a hard-coded authority table and the index in a concatenated list, which penalises later query variants. It does have good URL hygiene (16 tracking keys, sorted params, keep the longest snippet) and a coverage guarantee for deep searches ([agent-search.md](../research/agent-search.md)).
- **Vane** ranks by embedding similarity with silent drops: non-deterministic and unexplainable ([vane.md](../research/vane.md)).
- **mcp-omnisearch** does no cross-engine merge at all ([mcp-omnisearch.md](../research/mcp-omnisearch.md)).
- **SearXNG applies host rules before merge**, so removed results never consume a rank. For explainability we keep raw ranks ([searxng.md](../research/searxng.md)).

## Decision

### 1. Canonical URL (dedupe key; display keeps the original)

- The scheme is ignored for the key; https is preferred for display.
- The host is lowercased, IDNA-encoded to punycode ASCII, and loses a trailing dot, a default port and a leading `www.`.
- The fragment is dropped.
- Tracking parameters are removed: `utm_*`, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `igshid`, `mc_cid`, `mc_eid`, `mkt_tok`, `msclkid`, `ref`, `ref_src`, `spm`, `ved`, `_hsenc`, `_hsmi`, `oly_*`, `vero_*`. The list is data, extendable.
- Remaining query parameters are **kept and sorted**, so `?v=AAA` ≠ `?v=BBB`.
- A trailing slash is removed, except at the root.
- Path case is preserved.
- **AMP and mobile variants collapse** for known patterns: an `amp.` or `m.`/`mobile.` host prefix, `/amp/` path segments, `?amp`/`?outputType=amp`, and `cdn.ampproject.org` cache URLs (unwrapped).
- The presentation type (video, news, image) is never part of the key.

### 2. Merge duplicates

- Keep every engine's raw rank (`positions[engine]`) and the union of engines.
- Keep the longest title and the longest snippet.
- Dates: keep the **earliest** known *published* date and the **latest** known *modified* date, each with its source (ADR-0011).

### 3. Fuse (RRF on raw, pre-block ranks)

```
fused(d) = Σ_engines  w_e / (k + rank_e(d))        k = 20, w_e = 1.0 by default (per-profile override)
```
- Ranks are each engine's **raw** rank, before any blocking, so hiding one site never shifts the evidence for others. Every hidden result is still recorded with its raw rank.
- SearXNG counts as **one** engine, ranked by its `score`, with `engines[]` kept for attribution.
- **Why k = 20, not the textbook 60:** we fuse short lists (10–20 results), and k = 60 flattens rank so much that rule weights swamp everything. With k = 20:
  - rank 1 = .0476 and rank 10 = .0333 (ratio 1.43);
  - agreement still dominates: rank 5 on two engines (.0800) beats rank 1 on one engine (.0476).

### 4. Rule weight (one effective adjustment per result, from ADR-0008 pass 3)

`raise N` → `fused × (1 + 0.15·N)`; `lower N` → `fused ÷ (1 + 0.15·N)`; `normal` → ×1. Worked examples at k = 20, single engine:

| Result | Score | Lands at about |
|---|---|---|
| rank 10, `raise 1` (×1.15) | .0383 | rank 6 (a nudge) |
| rank 10, `raise 3` (×1.45) | .0483 | rank 1 (a promotion) |
| rank 20, `raise 3` | .0363 | rank 7–8 |
| rank 1, `lower 3` (÷1.45) | .0328 | rank 10–11 |
| any, `raise 10` (×2.5) | | above every unweighted organic result |

These values go into the docs and the golden tests. They can be tuned later through the dashboard's "test a query" sandbox, with a new ADR if the defaults change.

### 5. Order and decide

1. Visibility from ADR-0008 pass 1. Hidden results are removed from the output but **recorded** (`decision: hidden`, reason, rule, tier, list, raw ranks).
2. **Pins** go first, in pin order (ADR-0008 pass 2).
3. The rest sort by adjusted score.
4. **Deterministic tie-break:** best raw rank ascending, then engine id order from the plan, then canonical URL lexical. The same inputs and rules always produce the same output (Principle 5).

### 6. Freshness (§5 step 7), after rules

- **Effective date** = the most recent *high- or medium-confidence* published or modified date (ADR-0011).
- If the effective date is older than the profile's `maxAgeDays`: **hidden** with reason `stale`. Pinned results are exempt: they are kept and flagged `stale`, because a pin is explicit trust.
- If the date is unknown or low-confidence: kept and flagged `date_unknown`, unless the profile sets `requireDate: true`, in which case it is hidden with reason `date_required`.

### 7. Depth-specific rules

- **`deep` coverage guarantee:** at least one result from each engine that responded makes the top N, swapped in for the lowest-ranked slot. It is recorded as `kept_reason: coverage`.
- **Gap flags for `deep`:**
  - `no_official_source`: no `official`/`docs` source type in the top N;
  - `single_source`: all kept results come from one registrable domain;
  - `all_stale`.

  These feed the receipt warnings and tell the model to dig further.

### 8. Output count

Return `limit`: default 10, max 20. Hidden results never consume output slots, which is why we over-fetch (ADR-0009).

## Alternatives considered

- **SearXNG's formula.** Rejected (see context).
- **A static domain-authority table** (agent-search). Rejected. Authority comes from user rules and lists, so it stays explainable and user-owned (Principle 2).
- **RRF with k = 60.** Rejected for our list lengths (see the worked table).
- **Fusing after blocking.** Rejected. It shifts other results' evidence and makes "what would have happened without this rule" impossible to replay.
- **Learned or embedding re-ranking.** Out of scope: no LLM or ML in the v1 gateway (non-goal).

## Consequences

- Every output position can be explained from stored data: raw ranks, engines, the effective weight rule, pin and freshness. The dashboard's "replay with today's rules" (mitmproxy's dry-run replay) re-runs steps 3–7 on stored raw results with no network.
- Golden tests cover a fixed multi-engine fixture covering: duplicates, AMP and `www` variants, tracking parameters, ties, pins, blocks and freshness. Expected orderings are checked in.

## Validate early (P1)

- The canonicaliser property tests: idempotent (`canon(canon(u)) = canon(u)`), never merges different `v=` parameters, and passes IDNA spoof cases.
- Dogfood the k = 20 / 0.15 calibration during P3. Log user corrections such as "raised but still low" in `docs/dogfood.md`.
