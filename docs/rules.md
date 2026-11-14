# Rules reference

Your global rules live in `rules.yaml` in search-hole's config folder (macOS `~/.searchhole/`, Linux `~/.config/searchhole/`, Windows `%APPDATA%\searchhole\`; `searchhole doctor` prints it). A project can have its own rules in `.searchhole.yaml`, which apply only after you run `searchhole trust` in the project. Edit by hand or use the commands: `/search-hole:block`, `allow`, `pin`, `raise`, `lower`, `unblock` (or `searchhole block …` in a terminal, where `unblock` and `unrule` are the same command).

`searchhole block <site> --project` on a project file you have not trusted saves the rule and says "Saved, not applied yet". `searchhole rules` marks such rules "not trusted yet".

```yaml
version: 1
rules:
  - { match: pinterest.com, action: block }             # the site and all its subdomains
  - { match: "*.medium.com", action: lower, weight: 3 } # same as medium.com
  - { match: "=docs.example.com", action: allow }       # exactly this host
  - { match: "github.com/myorg/", action: raise, weight: 2 }  # host + path prefix
  - { match: "|https://*.example.*/amp/^", action: block }    # URL pattern: *, ^, |
  # A regex is searched for in the whole URL (RE2: no lookarounds). This one matches
  # hosts that end in .xyz and have "-tutorial-" in the name:
  - { match: "/^https?:\\/\\/[^/]*-tutorial-[^/]*\\.xyz\\//", action: block }
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

**What reordering changes.** `raise`, `lower` and `pin` change the order of the results Claude sees. Assistants weigh earlier results more, so this shifts which sources get read, opened and cited; it is a nudge, not a guarantee. With your engines, it can also change *which* results are returned, because search-hole fetches more than it returns and keeps the top 10 at the default depth (at most 20). With Claude Code's built-in search, it only reorders the results that search returned. It never adds a site the search didn't find, never hides anything, and doesn't change what is sent to the engines (only blocks are). The score starts from each result's original position, so a raise is weighed against it, and in engines mode a site that several engines agree on outranks a small raise.

## Lists

Lists are shared block lists that sit below your own rules: any rule of yours wins over every list, including a list's `$important`. See them with `searchhole lists` (or `/search-hole:lists`).

- **Built in and on by default:** search-hole's own lists. `official-docs` and `official-health` mark sources as official and, unless you define your own `default` profile, lift them like `raise 3`; they never hide anything. `github-clones` hides copy sites. `ai-content-farms` is in audit mode.
- **Starter lists, also on by default:** five third-party lists shipped with search-hole: the Stack Overflow and GitHub copy-site lists (`quenhus-dev-filter`, `arosh-stackoverflow-translation`, `arosh-github-translation`) and Pinterest (`rjaus-pinterest`), enforced, plus `laylavish-huge-ai` (AI-generated sites) in audit mode. They work offline and refresh from their source weekly, or sooner if the list asks. `lists: { autoUpdate: false }` in `settings.yaml` stops the refresh.
- **Modes:** `enforce` hides what the list matches; `audit` only records what it *would* hide (the log and dashboard show it, the assistant never does), so you can try a list first; `disabled` turns it off.
- **More lists:** `searchhole lists catalog` shows lists you can add, with their licence (for example the ~418k-rule `super-seo-spam-suppressor`). A list you add starts in `audit` mode; switch it with `searchhole lists enforce <id>` once you have seen what it would hide.

```yaml
version: 1
subscriptions:                      # lists fetched from a URL (HTTPS only)
  - name: super-seo-spam-suppressor
    url: https://raw.githubusercontent.com/NotaInutilis/Super-SEO-Spam-Suppressor/main/ublacklist.txt
    format: ublacklist              # auto | ublacklist | abp | adguard | hosts | domains | goggles | searchhole
    kind: block                     # block | allow | official | content-farm | clone
    mode: audit                     # audit (what `lists add` writes) | enforce (if you leave it out) | disabled
    update: 1d                      # refresh interval (default 7d)
    # sha256: <64 hex>              # optional: refuse any copy whose bytes differ
lists:                              # modes of built-in, starter and imported lists
  laylavish-huge-ai: { mode: enforce }
  rjaus-pinterest: { mode: disabled }
```

| Command | Does |
|---|---|
| `searchhole lists` | Every list: mode, source, rules, and what it hid (or would hide) in the last 7 days |
| `searchhole lists add <catalog-id or https URL> [--mode enforce] [--name id] [--kind …] [--format …] [--update 1d] [--sha256 …]` | Subscribe and download now. It starts in audit mode; `--mode enforce` skips the trial |
| `searchhole lists enforce\|audit\|disable <id>` | Change a list's mode |
| `searchhole lists update [id…] [--force]` | Download new copies now |
| `searchhole lists import <file> --name <id> --kind block` | Use a local file as a list (copied, never refreshed). An import starts enforced |
| `searchhole lists remove <id>` | Unsubscribe, or delete an import (built-in and starter lists can only be disabled) |

The SOURCE column of `searchhole lists` says where a list comes from: `built in`, `starter`, `subscribed` or `imported`. A list cannot be named `local` or `generation`.

**Safety:** lists are fetched over HTTPS from public addresses only, up to 64 MiB. An update that would shrink a list to under half its rules is refused and the current copy is kept (accept it with `lists update <id> --force`); so is a copy that doesn't match a pinned `sha256`. A failed refresh never removes a list; `searchhole doctor` tells you about it. Lines a list format can't express are skipped and counted, never silently dropped. A line that would match every URL is skipped, however it is written. In a list in search-hole's own format, a rule with `profile:` or `until:` is skipped too, because a list cannot scope a rule to a profile or a date. Details: [ADR-0022](adr/0022-lists-implementation.md).

See why any site or URL is kept or hidden with `/search-hole:explain <site-or-url>` (or `searchhole explain …`). A bare site such as `developer.mozilla.org` is checked as `https://developer.mozilla.org`; input that is not a site or an http(s) URL is an error. With no rules of your own:

```text
$ searchhole explain developer.mozilla.org
developer.mozilla.org
kept
  url: https://developer.mozilla.org
  profile: default
  T4 normal developer.mozilla.org  [official-docs]
  → kept, lifted ×1.45 because profile "default" prefers this source
```

Full design: [ADR-0008](adr/0008-rule-format-and-precedence.md).
