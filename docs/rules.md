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

**What reordering changes.** `raise`, `lower` and `pin` change the order of the results Claude sees. Assistants weigh earlier results more, so this shifts which sources get read, opened and cited; it is a nudge, not a guarantee. With your engines, it can also change *which* results are returned, because search-hole fetches more than it returns and keeps the top 10 (up to 20). With Claude Code's built-in search, it only reorders the results that search returned. It never adds a site the search didn't find, never hides anything, and doesn't change what is sent to the engines (only blocks are). The score starts from each result's original position, so a raise is weighed against it, and in engines mode a site that several engines agree on outranks a small raise.

## Lists

Lists are shared block lists that sit below your own rules: any rule of yours wins over every list, including a list's `$important`. See them with `searchhole lists` (or `/search-hole:lists`).

- **Built in and on by default:** search-hole's own lists (`official-docs` and `official-health` only mark sources as official; `github-clones` hides copy sites; `ai-content-farms` is in audit mode) and a small starter set of third-party lists shipped with search-hole: the Stack Overflow and GitHub copy-site lists (`quenhus-dev-filter`, `arosh-stackoverflow-translation`, `arosh-github-translation`) and Pinterest (`rjaus-pinterest`), enforced, plus `laylavish-huge-ai` (AI-generated sites) in audit mode. They work offline and refresh from their source about once a week.
- **Modes:** `enforce` hides what the list matches; `audit` only records what it *would* hide (the log and dashboard show it, the assistant never does), so you can try a list first; `disabled` turns it off.
- **More lists:** `searchhole lists catalog` shows lists you can add, with their licence (for example the ~418k-rule `super-seo-spam-suppressor`).

```yaml
version: 1
subscriptions:                      # lists fetched from a URL (HTTPS only)
  - name: super-seo-spam-suppressor
    url: https://raw.githubusercontent.com/NotaInutilis/Super-SEO-Spam-Suppressor/main/ublacklist.txt
    format: ublacklist              # auto | ublacklist | abp | adguard | hosts | domains | goggles | searchhole
    kind: block                     # block | allow | official | content-farm | clone
    mode: audit                     # enforce (default) | audit | disabled
    update: 1d                      # refresh interval (default 7d)
    # sha256: <64 hex>              # optional: refuse any copy whose bytes differ
lists:                              # modes of built-in, starter and imported lists
  laylavish-huge-ai: { mode: enforce }
  rjaus-pinterest: { mode: disabled }
```

| Command | Does |
|---|---|
| `searchhole lists` | Every list: mode, source, rules, and what it hid (or would hide) in the last 7 days |
| `searchhole lists add <catalog-id or https URL> [--mode audit] [--name id] [--kind …] [--format …] [--update 1d] [--sha256 …]` | Subscribe and download now |
| `searchhole lists enforce\|audit\|disable <id>` | Change a list's mode |
| `searchhole lists update [id…] [--force]` | Download new copies now |
| `searchhole lists import <file> --name <id> --kind block` | Use a local file as a list (copied, never refreshed) |
| `searchhole lists remove <id>` | Unsubscribe, or delete an import (built-in lists can only be disabled) |

**Safety:** lists are fetched over HTTPS from public addresses only, up to 64 MiB. An update that would shrink a list to under half its rules is refused and the current copy is kept (accept it with `lists update <id> --force`); so is a copy that doesn't match a pinned `sha256`. A failed refresh never removes a list; `searchhole doctor` tells you about it. Lines a list format can't express are skipped and counted, never silently dropped. Details: [ADR-0022](adr/0022-lists-implementation.md).

See why any URL is kept or hidden: `/search-hole:explain <url>`. Full design: [ADR-0008](adr/0008-rule-format-and-precedence.md).
