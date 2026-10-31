# Rules reference

Your rules live in `~/.searchhole/rules.yaml` (global) and, per project, in `.searchhole.yaml` (applies only after `searchhole trust`). Edit by hand or use the commands: `/search-hole:block`, `allow`, `pin`, `raise`, `lower`, `unblock` (or `searchhole block …` in a terminal).

```yaml
version: 1
rules:
  - { match: pinterest.com, action: block }             # the site and all its subdomains
  - { match: "*.medium.com", action: lower, weight: 3 } # same as medium.com
  - { match: "=docs.example.com", action: allow }       # exactly this host
  - { match: "github.com/myorg/", action: raise, weight: 2 }  # host + path prefix
  - { match: "|https://*.example.*/amp/^", action: block }    # URL pattern: *, ^, |
  - { match: "/-tutorial-.*\\.xyz$/", action: block }        # regex (RE2: no lookarounds)
  - { match: developer.mozilla.org, action: pin, profile: coding }
  - { match: w3schools.com, action: block, until: 2026-12-31, note: "trying without it" }
profiles:
  coding:
    match: { keywords: [docs, api, error, npm, typescript, react] }
    prefer: { lists: [official-docs] }
    freshness: { maxAgeDays: 730 }
```

## Actions

| Action | Effect |
|---|---|
| `block` | Hide matching results. In Claude Code's built-in search, blocked domains are also excluded before the search runs. |
| `allow` | Keep matching results even if a list blocks them. |
| `pin` | Put matching results first. |
| `raise N` / `lower N` | Multiply / divide the score by 1 + 0.15·N (N = 1–10). `raise 3` ≈ moves a 10th result to the top. |
| `normal` | Cancel a raise or lower from a lower tier. |

Add `important: true` (global and session rules only) to make a rule beat narrower scopes.

## Which rule wins

1. **Scope order:** important rules → session → project → global → lists. The first scope with a matching `allow`/`block`/`pin` decides visibility.
2. **Within a scope:** `allow` beats `block`, which beats `pin`.
3. **Your rules always beat lists**, including a list's `$important`.
4. **Ranking** (`raise`/`lower`) never hides or un-hides anything; the most specific match in the closest scope wins.

See why any URL is kept or hidden: `/search-hole:explain <url>`. Full design: [ADR-0008](adr/0008-rule-format-and-precedence.md).
