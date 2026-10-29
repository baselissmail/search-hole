# ADR-0008: Rule format and precedence

- **Status:** Accepted (2026-10-30)
- **Related:** [0005](0005-session-definition.md), [0006](0006-upgrades-migrations-multi-install.md), [0009](0009-engine-adapter-interface.md), [0010](0010-merge-algorithm-and-weights.md)

## Context

§6 sets the canonical YAML format and the default precedence:
- **actions:** `block / lower / normal / raise / pin / allow`, plus `important`;
- **within a scope:** allow > block > pin > raise/lower;
- **across scopes:** session > project > global > lists;
- a user's `allow` always beats any list rule.

The research confirms the shape and closes gaps:

- **Pi-hole FTL's real order:** user allow > user deny > list allow > list block. A user allow beats every list ([pi-hole-ftl.md](../research/pi-hole-ftl.md)).
- **AdGuard Home's production behaviour lets a subscribed allowlist override the user's `$important` block.** Its next-gen code puts custom rules above all lists. We want the latter ([adguardhome.md](../research/adguardhome.md)).
- **uBlock Origin layers** user trust > user rules > list rules. Inside the list layer: `$important` block > `@@` exception > block. `$badfilter` cancels an identical rule across lists ([ublock.md](../research/ublock.md)).
- **uBlacklist** uses "the most local tier with any match wins", resolved by action priority rather than file order. Its consequence: a user `lower` would also override a list `block` ([ublacklist.md](../research/ublacklist.md)).
- **Goggles** resolve internally as: discard is final, max boost wins, *weakest* downrank wins, no summing. A generic `$discard` means allowlist mode ([goggles-quickstart.md](../research/goggles-quickstart.md)).
- **Matching bugs elsewhere:** SearXNG's unanchored `re.search` makes `facebook.com` patterns match `notfacebook.com`. agent-search uses exact-or-dot-suffix matching on IDNA-normalised names, with spoof fixtures ([searxng.md](../research/searxng.md), [agent-search.md](../research/agent-search.md)).
- **Linear-time regex without native deps:** **re2js 2.9.1** (MIT, pure JS, `RE2Set`). V8's linear engine flag can't be set via `NODE_OPTIONS`, and Bun lacks it. One seed list (danny0838) contains a lookahead that RE2 rejects ([platform-facts-engines-lists-versions.md](../research/platform-facts-engines-lists-versions.md)).

## Decision

### Files and scopes

| Scope | Where | Who can write | Notes |
|---|---|---|---|
| session | DB table `rules_session` (with TTL) | slash commands / dashboard / approved suggestions with `scope: session` | Dies with the session key (ADR-0005) |
| project | `.searchhole.yaml` in the project dir | the user, by editing; applies **only after `searchhole trust`** approves its content hash (re-prompt on any change) | May contain only `rules` and `profiles`. It may select configured engines **by id**, but never endpoints, keys, `subscriptions` or retention |
| global | `~/.searchhole/rules.yaml` | CLI / dashboard / user edits (atomic write, comments preserved, ADR-0006) | Everything, including `subscriptions` |
| lists | subscribed and bundled lists, compiled to versioned artifacts | list refresh job | Permissive parsing |

Both files share one schema (`version: 1`, JSON Schema published for editors via `$schema`). Profiles with the same name in project and global: **the project profile shadows the global one entirely** (no deep merge, which avoids surprises). Settings precedence for a search: **explicit tool argument > project profile > global profile > `defaults`**. A test enforces it, because one-search-mcp silently overwrote the model's argument with env defaults.

### Rule syntax

```yaml
rules:
  - { match: pinterest.com, action: block }                 # host and all subdomains (label boundary)
  - { match: "*.medium.com", action: lower, weight: 3 }     # subdomains only, not medium.com itself
  - { match: "=example.com", action: allow }                # exact host only
  - { match: "github.com/orgname/", action: raise, weight: 2 }   # host + path prefix
  - { match: "|https://*.example.*/amp/^", action: block }   # URL pattern: *, ^, |  (Goggles/ABP style)
  - { match: "/-tutorial-.*\\.xyz$/", action: block }       # RE2 regex over the canonical URL
  - { match: developer.mozilla.org, action: pin, profile: coding }
  - { match: w3schools.com, action: block, important: true, note: "never" }
  - { match: example.org, action: block, until: 2026-12-31 }
```

- **Domain matching:** the host is lowercased, IDNA-normalised (punycode ASCII) and has its trailing dot stripped. A rule matches the host itself or any `.`-boundary suffix, so `pinterest.com` never matches `notpinterest.com`. Spoof fixtures go into the property tests.
- **URL patterns** compile to RE2 with Goggles' `^` definition: end of URL, or any character other than a letter, digit, `_`, `.`, `%` or `-`. A pattern allows at most 2 `*` and 2 `^`, and at most 500 characters.
- **Regex rules** compile with **re2js only**. Lookarounds and backreferences are rejected. The cap is 1,000 characters.
- **Fields:** `match`, `action`, `weight` (1–10, for raise/lower; default 1), `profile` (one name or a list), `important`, `until`/`ttl`, `note`, and an optional `id`.
- **Rule ids:** the stable id is `r_` plus 10 hex characters of the SHA-256 of the normalised `(scope, match, action, weight, profile)`. Hand-edited YAML therefore needs no ids. Every logged decision stores the rule id *and* a snapshot of the rule text, so explanations survive deleting the rule.
- **Title/snippet matching** is out of v1. The result type keeps `props` (title, snippet, site) so it can be added later without a format change.

### Precedence: three passes per result

**Tiers, in order:**

| Tier | Contents |
|---|---|
| T0 important | user rules with `important: true`, walked session → project → global |
| T1 session | |
| T2 project | |
| T3 global | |
| T4 lists | all subscribed and bundled lists |

1. **Visibility** (actions `allow`, `block`, `pin`). Walk T0 → T4. **The first tier with any matching visibility rule decides.** Inside a user tier: `allow` → keep; otherwise `block` → hide; otherwise `pin` → keep. Inside T4, ABP semantics are kept so imported lists behave as their authors intended: `$important` block > `allow` (`@@`) > block. `$badfilter` cancels the identical normalised rule across all lists at artifact build time. If no tier matches, the result is kept, unless the active profile sets `default: block` (allowlist mode, needed to import a generic Goggles `$discard`).
   - Consequence: **any user allow, pin or block beats every list rule, including a list's `$important`**, because user tiers come first. `important: true` lifts a user rule above scope order.
   - `raise`, `lower` and `normal` never change visibility, which avoids uBlacklist's "a user `lower` un-blocks a list block" surprise.
2. **Pin.** A kept result is pinned if any **user** tier (T0–T3) has a matching `pin` for the active profile. Pin order is by tier (session first), then rule order in the file. Pins reorder results the engines returned; they never inject results.
3. **Weight** (`raise N`, `lower N`, `normal`). Walk T0 → T4, and **the first tier with a matching weight rule decides**. Inside a tier, the most specific match wins:
   1. a regex or URL pattern with a path
   2. host plus path prefix
   3. an exact host
   4. a domain suffix with more labels, then fewer
   5. file order, as a tie-break

   `normal` explicitly neutralises lower tiers. Profile `prefer: {lists: [official-docs]}` acts as a T4 `raise 3` for list members (the weight is configurable). The multiplier maths is in ADR-0010.

Every result records **one** winning reason per pass (`decision`, `reason_code`, `rule_id`, `tier`, `list_id`). `--explain`, the dashboard and `searchhole explain <url>` show *all* matches, so "why" and "what else matched" are both answered (Pi-hole: row reason plus `/api/search`).

### Lists

- **Subscription fields:** `subscriptions: [{name, url, format: auto|ublacklist|abp|adguard|hosts|domains|goggles|searchhole, kind: block|allow|official|content-farm|clone, update: 7d, mode: enforce|audit|disabled, sha256?}]`. These live in global `rules.yaml` only. URLs must be HTTPS.
- **List role defines meaning** (AdGuard Home's idea). A plain domain list with `kind: official` annotates source type and feeds `prefer`; it never hides anything. `kind: allow` turns its entries into list-tier exceptions.
- **`mode: audit`** records "would hide" without hiding (context-forge's permissive mode). The dashboard shows "would remove 312 results/week", so a user can trial a list before enforcing it. New subscriptions default to `enforce`, and audit is one click.
- **Strict vs permissive compile:**
  - User files are **strict**: a bad rule fails the load with file, line and reason, and the last good compiled rules stay in force.
  - Lists are **permissive**: bad or unsupported lines become counted, reported no-ops, never silent passes or crashes. Examples are cosmetic filters, `$client`/`$dnstype`/`$denyallow`, and non-linear regex.
  - Per-list caps: 2,000,000 rules, 64 MiB, 20,000 regex rules.
- **Import mapping** (golden-tested in P6):

| Source | Maps to |
|---|---|
| ABP/AdGuard | `\|\|d^` → domain; `@@` → allow; `$important` → list-important; `$badfilter` → cancel |
| hosts | exact host |
| plain domains | domain suffix |
| uBlacklist | match patterns → domain or URL pattern; `/re/` → regex; `@` → allow; `@N` → `raise N` (clamped 1–10, with an "approximate" warning) |
| Goggles | resolved **per goggle with its own semantics** (discard final, max boost, weakest downrank) into one effective action per (result, goggle); `discard` → block, `boost=N` → raise N, `downrank=N` → lower N |

- **Compiled matcher (artifact):**
  - a host-label hash set (walk the labels of `a.b.example.com` from the full host down to the TLD, so O(labels) lookups);
  - path-prefix tries per host;
  - one re2js `RE2Set` per list for URL patterns and regex.

  It is serialised with a checksum and loaded lazily on the first search (ADR-0006). The target is a 418k-rule list loading in under 50 ms from its artifact.

### Secrets and untrusted input

- Rule files refuse secrets (ADR-0007).
- `suggest_rule` from the model only queues a suggestion; it never writes a rule (ADR-0012).
- Subscribed lists are untrusted. The shrink guard and checksum pinning are covered in [SYNTHESIS §6](../research/SYNTHESIS.md).

## Alternatives considered

- **Pure uBlacklist "most local tier wins entirely"** for all actions. Rejected: a user `lower medium.com` would un-hide list-blocked `spam.medium.com`. Splitting visibility from weight keeps the intuitive result.
- **AdGuard Home's production order** (a list allowlist can beat the user's `$important`). Rejected per §6.
- **Specificity-first within a tier for visibility** (block `sub.x.com` beats allow `x.com`). Rejected for v1. Plan, ABP and Pi-hole users expect allow > block. The explain view shows both matches, and the user can scope the allow more narrowly.
- **Summing weights across tiers.** Rejected: hard to explain, and Goggles doesn't sum either.
- **re2-wasm / native `re2`.** Rejected: abandoned, and native, respectively.

## Consequences

- The precedence table is small enough to print in the docs and to property-test exhaustively over (tier × action × important × list-important) combinations with fast-check.
- Required properties:
  - **idempotence:** applying the same rules twice gives the same result;
  - **user supremacy:** for any user allow and any list rule, the result is visible;
  - **monotonicity:** adding a list block never hides a result that a user rule keeps;
  - **determinism:** permuting the order of lists never changes the outcome.
- Importers can't express everything. Every skip is counted per list and shown in the dashboard, never silently dropped.

## Validate early

- **P1:** property tests above; the spoof fixtures; re2js throughput on a 20k-regex `RE2Set` (target: under 0.2 ms per result).
- **P6:** golden import of every seed list (ADR appendix lists in [platform-facts-engines-lists-versions.md](../research/platform-facts-engines-lists-versions.md) §4), with the counted skips recorded in the fixture.
