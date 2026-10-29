# brave/goggles-quickstart
> Ref: `research/refs/goggles-quickstart` @ e83e5c2 (2026-04-22) · License: **none**. There is no LICENSE file anywhere in the tree (`find` shows only README.md, CONTRIBUTING.md, getting-started.md, faq.md, `assets/`, `goggles/*.goggle`, `.github/renovate.json`), and no license grant in README, CONTRIBUTING, getting-started or faq. `faq.md` and `getting-started.md` call goggles "open" / "open-source" and say each author picks a license, but none of the eight example goggles names one. Treat as all-rights-reserved: **link only**. This note describes the syntax in our own words; no goggle file or doc text is reproduced. All examples below use `example.com` and are ours.

## Purpose
Brave's educational repo for **Goggles**, a small rule language that re-ranks Brave Search results: boost, downrank or discard by URL pattern and/or site. It has three docs and eight example goggles by "Goggles 101". `CONTRIBUTING.md` says the content is educational, not something Brave plans to maintain. Why it matters to search-hole:
1. It is the spec for our **Goggles importer** (§6 "Import: Brave Goggles").
2. It is the **push-down target** for Brave (§5 step 3, "compile rules into an inline Goggle").
3. Its **precedence semantics** differ from our planned ones, and that has to be settled in the rule-format ADR.
4. Its **explanation UX** is a good model for "every hidden result names the rule".

## Architecture sketch
There is no code. The lifecycle of a hosted Goggle, per `getting-started.md` ("Creating/Updating/Deleting a Goggle") and `faq.md`:
```
author .goggle text file ─► host on gist.github.com | github.com (public) | gitlab.com (files/snippets)
        ─► submit URL at search.brave.com/goggles/create ─► Brave fetches, validates, caches
        ─► use: search.brave.com/goggles?goggles_id=<url-encoded goggle URL>   (UI)
              or API `goggles=<URL or inline text>`   (see brave-search-skills.md)
        ─► Brave applies instructions to the per-query "expanded recall set" (not the whole index)
```
- **Identity = the hosting URL.** Ownership means control of that URL. Brave keeps no version history, and every update needs a resubmit (`getting-started.md` "Updating a Goggle").
- **Delete** = delete upstream, then resubmit the URL (`getting-started.md` "Deleting a Goggle").
- **Transfer**: add `transferred_to: <new URL>` to the old goggle and resubmit. Both URLs must be registered. Followers are redirected, the old copy is frozen permanently, and a goggle can be transferred only once (`faq.md` "Can Goggles ownership be transferred?").
- **Recall caveat**: instructions are applied only to an "expanded recall set" (tens of thousands of candidates per query). A boost therefore can't surface a page that isn't in that set (`faq.md` "What's next for Goggles?" and "Why is a particular page not recoverable").

## Key modules and data flow
n/a. There are no modules; the whole flow is the lifecycle above. Repo map: `goggles/quickstart.goggle` is an annotated tutorial that is itself a valid goggle. `getting-started.md` covers creation, limits, sharing and the conflict rules. `faq.md` covers ownership, multiple goggles, transfer and recall. `assets/goggle-explanations.png` is a screenshot of the explanation UI.

## Data model and storage
A Goggle is a plain-text file made of **header metadata**, **comments** and **instructions**, one per line.
- **Metadata** lines have the form `! key: value`. The **mandatory** keys are `name`, `description`, `public` (true/false) and `author`. The **optional** keys are `homepage`, `issues`, `transferred_to`, `avatar` (must be a valid hex colour) and `license` (`goggles/quickstart.goggle` header comments; `getting-started.md` "Creating a Goggle").
- `public: true` makes the goggle discoverable on the Discover page. A private one is still usable by anyone who has the URL.
- Users' "followed" goggles are kept in browser localStorage (`getting-started.md` "Sharing a Goggle").
- In the 8 examples, the metadata used is name, description, public and author (8 each) and avatar (6). None of them sets `license` (own count over `goggles/*.goggle`).
- **Inline** goggles sent through the Search API need neither metadata nor registration (documented in `research/refs/brave-search-skills/skills/web-search/SKILL.md` "Goggles"; see that note).

## Config format
The instruction grammar, paraphrased from `goggles/quickstart.goggle` (the comments around each example instruction):
```
line        := comment | metadata | instruction | blank
comment     := '!' anything                     (ignored; metadata is a '! key: value' comment in the header)
instruction := [pattern] ['$' option (',' option)*]
option      := 'site=' domain | 'boost' ['=' N] | 'downrank' ['=' N] | 'discard'
```
- **Pattern** (matched against the URL; `inurl` is the implicit target):
  - plain text matches as a *substring anywhere* in the URL
  - `*` matches any run of characters, including none
  - `^` is a *separator*: it matches end-of-URL or any character that is not a letter, digit, `.`, `_`, `%` or `-`. So a pattern ending in `^` stops `example.org` from matching `example.org.ac`, and stops `/foo.js` from matching `/foo.jsx`.
  - a leading `|` anchors to the URL start and a trailing `|` to the URL end; both can be used together.
- **`site=`** limits an instruction to a domain. It can stand alone (`$site=example.com`) or be combined with a pattern (`/blog/$site=example.com`). The examples use bare TLDs and shared-hosting suffixes (`site=rs` in `rust_programming.goggle`, `site=github.io` in `tech_blogs.goggle`). That implies **label-suffix matching on the hostname** (inferred; the docs never state the rule).
- **Option order is free.** Both `$site=x,boost=2` (`brave_community.goggle`) and `$boost=2,site=x` (most files) appear.
- **Actions**: `boost`, `downrank`, `discard`. **An instruction with no action is a boost.** Strength `N` is capped at **10** (quickstart comment after the `/r/brave_browser/$boost=3` examples). A bare `$boost` or `$downrank` has strength 1 (inferred from the precedence text, which ranks bare `$downrank` above `$downrank=2`).
- **Targets** `$inurl`, `$intitle`, `$indescription` and `$incontent` appear only *commented out*, presented as future work (`goggles/quickstart.goggle` "Another set of options…"; `faq.md` "What's next"). Treat them as **unsupported** for import and compile. The explanation screenshot shows normalized instructions with `,inurl` appended (`assets/goggle-explanations.png`).
- A **generic `$discard`** (no pattern and no `site=`) changes the *default action*: any result not matched by some other instruction is excluded. This turns a goggle into an allowlist (`getting-started.md` "How can I exclude any result not matched by my Goggle?"). It is used as the first rule in `hacker_news`, `tech_blogs`, `rust_programming` and `brave_community`.

## Extension points (plugins, hooks)
n/a. The language is closed. The only "extension" Brave suggests is concatenating several goggles into a new one, because the product applies **one goggle at a time**: it worries that rules from different goggles would "collide in non-intuitive ways" (`faq.md` "Why can't I apply multiple Goggles at the same time?").

## Rules / lists: parsing and compilation
**Precedence when several instructions match** (`getting-started.md` "What happens when two instructions are conflicting?"):
- A *non-generic* `discard` is **final** and beats everything.
- Otherwise **any boost beats any downrank**, on the stated principle that Goggles exist to *surface more* content.
- Among boosts the **highest strength wins**. Among downranks the **weakest wins** (bare `$downrank` beats `$downrank=2`). The overall order is therefore: discard > boost=10 … > boost=1 > downrank=1 … > downrank=10.
- Strengths **do not add up**, as far as the docs show: their one worked example (a site-wide `downrank=3` plus a path `boost=3` matching the same URL) ends as "boosted with strength 3". The docs do not define how a strength changes the score.
- If nothing matches, the default applies: the result stays in place, or is excluded when a generic `$discard` is present.

**Hard limits** for submitted (hosted) goggles (`getting-started.md` "Creating a Goggle"):

| Limit | Value |
|---|---|
| File size | ≤ 2 MB |
| Instructions per file | ≤ 100,000 |
| Instruction length | ≤ 500 chars |
| `*` per instruction | ≤ 2 |
| `^` per instruction | ≤ 2 |

Inline-goggle limits are **not documented in this repo**. Assume the same caps or stricter, and for long goggles send them via POST (inferred from brave-search-skills' "POST is useful for … complex Goggles").

**What real goggles look like** (own tally over `goggles/*.goggle`, 9,242 lines):
- 9,033 `site=` options, 7,829 `boost`, 1,219 `discard`, only 4 `downrank`.
- Boost values cluster at 2, 3 and 4 (2,125, 3,688 and 2,008 occurrences).
- Path or wildcard patterns are rare and appear mainly in `rust_programming` (`*rust*`, `-rs^`, `/coreutils^`) and `tech_blogs` (`/blog/`, `/engineering.`).
- `no_pinterest`, `1k_short` and `copycats_removal` are plain `$discard,site=` blocklists.
- Of the 9,063 non-comment, non-blank lines, 8,821 (about 97%) start with `$`, i.e. have no pattern; 242 have a pattern, and 4 are generic `$discard`.
- **Takeaway:** in practice a goggle is a domain list with tiers, so a domain suffix set covers about 97% of imported instructions. The remaining ~3% (path or wildcard patterns, some combined with `site=`) need the pattern engine.

## Testing strategy
There is no test code. Brave validates on submit and reports errors on the create page (`getting-started.md` "Creating a Goggle"). For tuning, the docs recommend a personal "test set" of queries, iterating with the explanation UI (`getting-started.md` "Fine-tuning a Goggle"). For us: the example goggles are **unlicensed, so we can't vendor them as test fixtures**. We need our own fixtures covering every syntax feature (substring, `*`, `^`, `|…|`, `site=` with a TLD, generic `$discard`, option order, bare pattern = boost, conflict cases).

## UX patterns worth copying
- **Explanation popover** (`assets/goggle-explanations.png`):
  - each affected result gets a **coloured marker in the left margin**, in the goggle's avatar colour
  - hovering shows "Result from ‹goggle name›" and lists **each instruction that matched** in normalized form, each followed by a **plain-English sentence** ("boosts results with strength 3 when site is …" / "… if URL contains pattern …")
  - this is exactly our "every row explains itself"
- **Avatar colour per list** (`! avatar:` hex) gives lists a stable colour identity in the UI.
- **Share by URL** (`goggles_id=`) and **follow** (kept client-side): low-friction distribution of rule sets.
- **Transfer metadata** (`transferred_to`) solves "list moved to a new URL" without losing subscribers.

## Performance tricks
- The caps on `*` and `^` per instruction and on instruction length bound matching cost. They are worth mirroring in our importer and our regex-safety caps (§6).
- Applying rules only to the per-query recall set (`faq.md`) keeps cost proportional to candidates, not to index size. Our gateway gets the same property for free, since we only match engine results.

## License and what it means for us
- **No license, so link only.** Don't copy goggle files, doc prose or the screenshot, and don't bundle the example goggles (Appendix B of the plan already says this).
- Implementing a parser that is *compatible* with the documented syntax is ordinary interoperability work; we write it from this prose description (inferred position, not legal advice).
- Brave's FAQ says each goggle's author picks its license, and the `! license:` metadata exists for that. Our importer should read it, show it, and refuse to **bundle** goggles that have none (subscribing by URL is fine).

## Implications for search-hole
- [rule-format-precedence] **Import mapping:**
  - `discard` → `block`, `boost=N` → `raise N`, `downrank=N` → `lower N`
  - a bare instruction or bare `$boost` → `raise 1`
  - the strength scale 1–10 **matches our weight range numerically**, so the mapping preserves order. It is not score-equivalent: the docs never define what a strength does to a result's score, and ours is the `1 + 0.15·N` multiplier, so treat it as an approximation
  - generic `$discard` has **no equivalent in the planned YAML**. Add a list/profile-level `default: block` (allowlist mode), or the importer must refuse or flag it.
- [rule-format-precedence] **Precedence conflict:**
  - Goggles: discard final, then max-boost wins, then *weakest* downrank wins, no summing.
  - Our plan: `allow > block > pin > raise/lower` within a scope, and multiplicative weights (`1 + 0.15·N`).
  - Proposal: **resolve each imported goggle as a unit using its native semantics**, giving one effective action per (result, list), then combine across scopes and lists with our table.
  - Cover it with property tests: "boost beats downrank inside one goggle", "discard is final inside one goggle", "user allow beats a goggle discard".
- [rule-format-precedence] Add a URL-pattern `match` type with Goggles/ABP-style syntax (`*`, `^`, leading/trailing `|`). Translate it to an RE2-safe regex (`^` becomes "end of URL, or any character other than a letter, digit, `_`, `.`, `%` or `-`", per the quickstart's own definition; a plain "non-word" class would wrongly treat `.`, `%` and `-` as separators). Enforce the same caps: ≤ 2 `*`, ≤ 2 `^`, ≤ 500 chars.
- [engine-adapter] **Brave push-down compiler** (works on *resolved* rules, never by naive concatenation):
  - `block` → `$discard,site=d`, `raise N` → `$boost=N,site=d`, `lower N` → `$downrank=N,site=d`
  - `pin` → `$boost=10,site=d`, and the pin is still applied locally (Brave has no pin)
  - a user `allow` that overlaps a list block must **omit** that discard, because Goggles can't express an exception to a discard
  - regex rules that can't be written in goggle syntax are applied locally only
- [engine-adapter] **Size budget:**
  - never compile the ~418k-rule list (that is over 100k instructions)
  - cap the inline goggle (e.g. a few thousand instructions, with the user's blocks first)
  - **always re-filter locally**, because Goggles only re-rank the recall set and a boost doesn't guarantee inclusion
  - a generic `$discard` in a compiled goggle would silently drop everything unmatched, so never emit one unless the profile is explicitly in allowlist mode
- [lists-subscriptions] Goggle subscriptions:
  - fetch the raw GitHub/GitLab/gist URL and parse the `! name/description/author/license/homepage/issues/avatar` headers
  - follow `transferred_to` (once, with user-visible notice)
  - store the license and show the avatar colour
  - hosted goggles have no version history, so our ETag/rollback guard (§6) matters
- [security] **Privacy of push-down:**
  - Brave's README warns that a rarely used goggle URL can act as a user identifier
  - an inline goggle compiled from personal rules is probably even more unique and is sent with every query (inferred; the README only discusses goggle URLs)
  - make push-down a per-engine setting, documented in PRIVACY.md, and consider pushing only blocks and common list rules
- [ui-ux] Copy the explanation pattern in the dashboard and in-chat panel: a coloured marker per list (avatar colour), plus a popover listing the matched rules in normalized form with a one-line plain-English explanation and the list name.
- [testing] We can't use the example goggles as fixtures (no license). Write our own golden fixtures per syntax feature and conflict case. Fuzz the parser (fast-check) for the caps and anchors.
- [lists-subscriptions] Brave applies one goggle at a time to avoid confusing collisions. We will run many lists at once, so the precedence explainer and the "test a query" sandbox (§8.3) are required, not optional.

## Borrow / avoid
**Borrow**
- Documented grammar (`*`, `^`, `|`, `site=`, `boost/downrank/discard`, N ≤ 10, a bare instruction is a boost) as an import format and as the Brave compile target.
- Per-instruction caps (≤ 2 `*`, ≤ 2 `^`, ≤ 500 chars) and per-file caps (≤ 100k instructions, ≤ 2 MB) as importer limits.
- Header metadata (`name`, `description`, `author`, `license`, `homepage`, `issues`, `avatar`, `transferred_to`) as the model for our own list-file headers.
- The explanation popover, with normalized rule text plus a plain-English sentence.
- The idea of URL-as-identity with an explicit `transferred_to` for lists that move.

**Avoid**
- Copying or bundling any example goggle or doc text (no license).
- Adopting "boost always beats downrank, no summing" as our *global* semantics. Keep it local to the imported goggle.
- Relying on Brave-side filtering alone. Goggles only re-rank the recall set; always filter locally too.
- Supporting `$intitle/$indescription/$incontent`. They are documented only as future and commented out.
- Emitting a generic `$discard` in compiled goggles unless the profile is explicitly allowlist-only.

## Verification
- Date: 2026-10-29. Checked against `research/refs/goggles-quickstart` @ e83e5c2. Claims checked: 52 (license and file inventory, metadata keys, grammar and `^` definition, precedence text, hard limits, ownership / transfer / recall FAQ, the screenshot, the example-goggle tallies recomputed over `goggles/*.goggle`, and every bullet under "Implications for search-hole").
- Confirmed with no change: no LICENSE file in the tree; mandatory and optional metadata keys; limits (2 MB, 100,000 instructions, 500 chars, 2 `*`, 2 `^`); discard > boost > downrank with bare `$downrank` ahead of `$downrank=2`; generic `$discard` as allowlist mode; transfer rules; one-goggle-at-a-time FAQ; 9,242 lines, 9,033 `site=`, 7,829 `boost`, 1,219 `discard`, 4 `downrank`, boost=2/3/4 counts, 6 of 8 files with `avatar`, 0 with `license`; `,inurl` in the explanation screenshot.
- Corrections made:
  1. "About 99% of instructions are domain-only" was wrong: 8,821 of 9,063 instruction lines (about 97%) have no pattern, so about 3% need the pattern engine.
  2. Import mapping said the strength scale is "lossless". Only the numeric range matches; what a strength does to a score is undefined in the docs, so the mapping is order-preserving, not score-equivalent (an input to the rule-format ADR).
  3. Importer bullet translated `^` as "a non-word separator or end of URL". Per the quickstart, `^` is end of URL or any character other than letter, digit, `_`, `.`, `%`, `-`; "non-word" would treat `.`, `%` and `-` as separators.
  4. License header: said no grant in README/CONTRIBUTING; added that `faq.md` / `getting-started.md` call goggles open-source and let authors pick a license, and that no example goggle names one (conclusion "link only" unchanged).
  5. "Strengths do not add up" is supported only by one worked example; reworded.
  6. Privacy bullet: the claim that an inline goggle is more unique than a goggle URL is our inference; marked as such.
- No GPL/AGPL/EUPL code is in this note. The note quotes only a few short phrases from the docs and no goggle text.

