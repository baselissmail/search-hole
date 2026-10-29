# iorate/ublacklist

> Ref: `research/refs/ublacklist` @ e3df713 (2026-10-23) · License: MIT (`LICENSE.txt`, "Copyright (c) 2018 iorate"). `third-party/is-mobile/LICENSE` is MIT (Julian Gruber). `builtin/` is an empty git submodule here (`.gitmodules` → `ublacklist/builtin`, branch `dist`; its license is not visible in the ref). **The rule parser and matcher are not in this repo.** They live in npm packages `@ublacklist/ruleset@2.0.1` and `@ublacklist/match-pattern@2.0.0` (`package.json`; `pnpm-lock.yaml:875-882, 1625-1635`), published from `github.com/ublacklist/packages`. That repo is MIT according to its root `LICENSE` ("Copyright (c) 2026 iorate"; fetched 2026-10-29), and `packages/ruleset/package.json` (v2.0.1) declares `"license": "MIT"`. Neither file is in the ref. Where this note describes package internals, it says "(upstream, not in ref)".

## Purpose
uBlacklist is a browser extension (Chrome, Firefox, Edge, Safari) that hides or highlights sites in search engine result pages (SERPs) using user rules plus subscribed rulesets, synced across devices through Google Drive, Dropbox, OneDrive, WebDAV or browser sync. It matters to search-hole for four reasons:
1. It is the **origin format for several of our seed lists** (unverified count: Appendix B does not record each list's format, so "about 8 of 13" is an estimate to re-check list by list).
2. It has the cleanest **user-vs-subscription precedence** model in the reference set.
3. Its **"block this site" dialog** computes a minimal, validated rule patch: the closest prior art for `suggest_rule` and `apply_rule`.
4. It is MIT, so we can reuse code and depend on its MIT parser package.

## Architecture sketch
```
SERP page (content script) ── SERPINFO (YAML: page matches, result root/url/props selectors)
   │  for each result: {url, props:{title,...}}
   ▼
InteractiveRuleset(user, subscriptions[])  ── query() ─► block | unblock | highlight(N) | null
   │                                          createPatch()/validateRulesToAdd()/applyPatch()
   ▼
browser.storage.local  (blacklist text + precompiled PlainRuleset, subscriptions{id→…})
   ▲                       ▲
background: subscriptions.ts (alarm, fetch, compile)   sync.ts + sync-sections.ts (per-section files, last-writer-wins)
                                                        sync-backends/{google-drive,dropbox,onedrive,webdav,browser-sync}.ts
options page (React 19 + Base UI): CodeMirror 6 ruleset editor (Lezer parser + linter), subscriptions table, sync forms
```

## Key modules and data flow
- `src/scripts/shared/interactive-ruleset.ts`: the policy layer above the package's `Ruleset`.
  - `query` (line 35) resolves the user ruleset first, then the subscriptions.
  - `createPatch` (line 44) computes a mode, `rulesToAdd`, `lineNumbersToRemove`/`rulesToRemove` and an optional `matchingRules` report.
  - `validateRulesToAdd` (line 99) re-evaluates user-typed rules against the intended mode.
  - `applyPatch` (line 113) rewrites the user source by deleting matched lines and appending the new rule.
  - `dominantAction` (line 147) sets action priority; `suggestMatchPattern` (line 170) builds the suggested rule.
- `src/scripts/shared/utilities.ts`:
  - `toPlainRuleset` (line 205) runs `new Ruleset(source).toJSON()` and stores `{metadata, rules: JSON.stringify(ruleMap), frontMatterUnclosed}`.
  - `fromPlainRuleset` (line 189) rebuilds a `Ruleset` from the precompiled `ruleMap` plus the raw `source`, which is still needed for line text.
  - `createInteractiveRuleset` (line 120) filters to enabled subscriptions and names each ruleset (frontmatter `name`, then the user-given name, then the URL).
- `src/scripts/background/subscriptions.ts`: `update(id)` (line 37) does fetch → optional domains conversion → `toPlainRuleset` → store, with a per-id lock (`tryLock`, line 22). `updateAll` (line 86) runs on a periodic alarm.
- `src/scripts/background/domains.ts`: `parseDomainLine` and `domainsToRuleset` (lines 5, 33) convert a "domains" list into `*://*.<domain>/*` rules, **preserving line numbers** (invalid lines become empty lines).
- `src/scripts/background/local-storage.ts`: a section pipeline in `beforeSave` / `afterSave`.
  - Saving `blacklist` recompiles the `ruleset`, bumps `timestamp` and marks the blocklist dirty for sync (lines 31-80).
  - `compileRules` (line 94) recompiles the user ruleset on install, update and startup (`background/index.ts:41-58`), so a package-format change is picked up without a migration step.
- `src/scripts/background/raw-storage.ts`: typed `browser.storage.local` wrapper with defaults. All writes are serialized through a `Mutex` (`modifyInRawStorage` is load → callback → set under the lock).
- `src/scripts/background/sync.ts`, `sync-sections.ts`, `sync-backends.ts`: debounced sync, per-section serializers, and the `syncFile` last-writer-wins decision (sync-backends.ts:119-193).
- `src/scripts/content-script/filter.ts`: the `Filter` class. It scans result roots from SERPINFO, extracts `url` and `props`, adds a block button, and judges each result with `ruleset.query` (`#judgeResult`, line 293). A MutationObserver is batched per animation frame (line 121) and watches only `href` attributes (line 165). It re-judges all known results when rules change.
- `src/scripts/block-dialog/index.tsx`: the "Block this site" form (`BlockForm`, lines 240-460).
- `src/scripts/options/shared/ruleset-lang.ts`: CodeMirror 6 language. It uses the package's Lezer `parser` for highlighting, plus a linter that flags Lezer error nodes and re-validates `String` and `RegExp` nodes with `parseString` / `parseRegExp`.

## Data model and storage
Everything lives in `browser.storage.local`. The schema is `LocalStorageItems` + `RawStorageItems` (`shared/types.ts:107-170`, `background/raw-storage.ts:12-24`):

| Key | Type | Notes |
|---|---|---|
| `blacklist` | string | the user's raw ruleset source (the name dates from v1) |
| `ruleset` | `PlainRuleset \| false` | precompiled user ruleset `{metadata, rules: <JSON string of ruleMap>, frontMatterUnclosed?}` |
| `compiledRules` | string \| false | legacy v6 format, cleared on recompile |
| `timestamp`, `generalLastModified`, `appearanceLastModified`, `subscriptionsLastModified` | ISO strings | per-section modified time, used by sync |
| `subscriptions` | `Record<number, Subscription>` | `{name, url, type?: "ruleset"\|"domains", ruleset?: PlainRuleset, blacklist: <raw text>, updateResult: {type:"success",timestamp}\|{type:"error",message}\|null, enabled?}` |
| `nextSubscriptionId` | number | monotonic id |
| `updateInterval` | minutes | default **1440**, clamped to ≥ **1440** (`shared/intervals.ts:5`) |
| `syncCloudId`, `syncCloudToken` | | OAuth token `{accessToken, expiresAt, refreshToken, pkce?}` or WebDAV `{url, username, password, path}`, stored **in plain text** |
| `syncInterval` | minutes | default **15**, clamped to ≥ **5** (`intervals.ts:1`) |
| `blockWholeSite` | bool | default **true** (`shared/local-storage.ts`) |
| `skipBlockDialog`, `hideBlockLinks`, `hideControl`, `enableMatchingRules` | bool | general settings |
| `highlightColors` | string[] | colour N used for `@N` |
| `serpInfoSettings` | object | SERPINFO user and remote sources |

Precompiled JSON shape (upstream, not in ref): `RulesetJSON = {source, metadata, ruleMap, frontmatterUnclosed}`. The `ruleMap` is a serialized `MatchPatternMap` whose entries are `[lineNumber, value?, expression?]`. The value encodes the action: 1 = block (default, omitted), 0 = unblock, negative = highlight with colour `-value`. Rules without a match pattern (bare regex or expression) live under `<all_urls>`. **The JSON has no version field.** The extension relies on recompiling at startup (`compileRules`) for the user ruleset; subscriptions are recompiled only on their next fetch (inferred from `background/index.ts:41-58` and `subscriptions.ts:37-76`).

## Config format
The ruleset is a text file of one rule per line. Optional YAML frontmatter between `---` lines carries metadata; `name` is recommended (`README.md` "For subscription providers"). Frontmatter is parsed with js-yaml (JSON schema) and validated as a record; errors give an empty `{}` (upstream, not in ref).

**Syntax.** Evidence: the in-ref tests `src/scripts/shared/interactive-ruleset.test.ts` and `background/domains.test.ts`. Upstream sources: `packages/ruleset/src/ruleset.grammar` and https://ublacklist.github.io/docs/advanced-features, both fetched 2026-10-29.

| Construct | Example | Meaning |
|---|---|---|
| Match pattern | `*://*.example.com/*` | WebExtensions match pattern. Scheme `*` (http or https), `http` or `https` only. A host starting with `*.` matches subdomains **and the bare host**. Path `*` wildcards. `<all_urls>` is allowed (upstream grammar) |
| Exact host | `*://example.com/*` | does **not** match `sub.example.com` (test "Subscription highlight overrides...", interactive-ruleset.test.ts:86-110) |
| Path-scoped | `@https://example.edu/path/to/*` | prefix match on the path. `path` = pathname + query (upstream) |
| Regex on URL | `/example\.(net|org)/` | JS regex literal, flags `i m s u` (upstream grammar). It is shorthand for `url =~ /…/` |
| Title / URL matcher | `title/Example/`, `t/Example/`, `url/…/`, `u/…/`, `@title/allowed/i` | long and short forms (interactive-ruleset.test.ts:23-56). `title` comes from the SERP result's props |
| Expressions | `title $= "domain" i`, `path *= "blah" i`, `title *= "a" i \| title *= "b" i` | variables `url`, `title`, `scheme`, `host`, `path`, plus SERPINFO props such as `$site` and `$category`. Operators `=` `^=` `$=` `*=` with an `i` suffix, `=~` regex, `!` `&` `\|` (precedence `!` > `&` > `\|`), and parentheses (upstream) |
| Conditional | `*://*.amazon.com/* @if($category="images")` | match pattern plus an expression guard (upstream docs) |
| Unblock | `@*://example.net/*` (whitespace allowed: ` @ *://…`) | exception (test at interactive-ruleset.test.ts:59-85) |
| Highlight | `@1*://example.org/*`, `@10/example\.com/` | colour N, which also acts as priority (test at lines 59-85) |
| Comment | `# text`, also trailing after a rule | lines that fail to parse are skipped, so they behave like comments (upstream docs) |
| Domains list (subscription `type: "domains"`) | `example.com` | becomes `*://*.example.com/*`. Lines must match `^[A-Za-z0-9.-]+$` and contain a dot. Labels are 1-63 chars with no leading or trailing `-`, and the total is ≤ 253. Hosts-file lines (`0.0.0.0 x`) and Unicode are rejected, so Punycode is required (`background/domains.ts:1-31`, `domains.test.ts:31-46`) |

## Extension points (plugins, hooks)
- **SERPINFO** (YAML, `@ublacklist/serpinfo`; e2e mock at `e2e/mocks/google-serpinfo.yml`): `name`, then `pages[]` with `matches` (URL match patterns), and `results[]` with `root`, `url` and `props` (CSS selectors or commands). Optional fields: `button`, `preserveSpace`, `extraSelector`, `delay`, `commonProps`. Users can add their own SERPINFO. Built-in SERPINFO is downloaded periodically from `ublacklist/builtin` (`background/serpinfo.ts:25-75`, alarm `update-all-remote-serpinfo`). This is a data-driven adapter layer for scraping result pages; search-hole's engine adapters return structured JSON, so it does not apply directly.
- **Subscription links:** `https://ublacklist.github.io/rulesets/subscribe?url=…` is redirected by a `declarativeNetRequest` dynamic rule to `pages/options.html?url=…` (`background/serpinfo.ts:77-110`, `setupSubscriptionURL`), once the user has granted host permission for `ublacklist.github.io` (`shared/constants.ts:6-8`, `shared/enable-subscription-url.tsx`). The options page reads the `url`, `name` (also `addSubscriptionURL` / `addSubscriptionName`) and `type` query parameters and passes them to the `Options` component as an `addSubscription*` query (`options/index.tsx:49-60`); that this prefills the add-subscription dialog is inferred from the names.
- **Host permissions per subscription origin:** `requestPermission` asks for `<scheme>//<host>/*` unless the origin is `raw.githubusercontent.com` or `cdn.statically.io` (`shared/permissions.ts`, `shared/constants.ts:1-4`).
- **Agent skills** for writing rulesets and SERPINFO ship in `ublacklist/packages` (`README.md` "Authoring rulesets... with AI agents"; `AGENTS.md`).

## Rules / lists: parsing and compilation
**Parser (upstream, not in ref).**
- `packages/ruleset/src/ruleset.grammar` and `frontmatter.grammar` are Lezer grammars compiled to an LR parser (`ruleset.grammar.ts`). Dependencies are `@lezer/common`, `@lezer/lr`, `@lezer/highlight`, `@lezer/yaml`, `js-yaml` and `zod` (`pnpm-lock.yaml:1627-1635`).
- Rules with syntax errors, invalid string or regex literals, or failed map insertion are skipped silently. Errors surface only in the editor's linter (`options/shared/ruleset-lang.ts:20-50`).
- `Ruleset.extend(text)` parses only the appended range and merges it into that ruleset's own map (upstream `ruleset.ts`, fetched 2026-10-29). In the ref, `validateRulesToAdd` builds a throwaway `new Ruleset("")`, extends it with only the typed rules and evaluates them against the one result, so validation never re-parses the user's file (interactive-ruleset.ts:99-111).

**Matching structure (upstream `packages/match-pattern/src/index.ts`, not in ref).**
- `MatchPatternMap` is a **host-label trie walked from the TLD inward**.
- Each node is `[exactHostEntries, anySubdomainEntries, children?]`; each entry is `{value, scheme?, path?}`.
- `*.example.com` is stored in the `anySubdomain` bucket of the `example.com` node. `<all_urls>` entries sit in a flat list that is checked for every URL.
- `get(url)` rejects non-http(s) URLs, collects `anySubdomain` entries along the walk, then collects both buckets at the final node, and filters by scheme and path.
- Pattern-only rules cost one trie walk. Expression and regex rules attached to a pattern are evaluated only after the trie hit. **Bare regex rules sit under `<all_urls>` and are evaluated linearly for every result.**
- Regexes are JS `RegExp`, compiled lazily on first use and cached per rule. There is **no ReDoS guard** (upstream).

**Precedence (in ref: `shared/interactive-ruleset.ts:35-42, 139-158`).**
1. Evaluate the **user ruleset alone**. If it has *any* match, resolve those matches and stop; subscriptions are not consulted.
2. Otherwise, resolve the union of all enabled subscriptions' matches.
3. Within a tier, every matching rule is reduced with `dominantAction`, by priority. MIT, condensed (braces collapsed) from `src/scripts/shared/interactive-ruleset.ts:147-158`:
```ts
function dominantAction(a: Action, b: Action): Action {
  function actionPriority(action: Action): number {
    if (action.type === "block") { return -1; }
    else if (action.type === "unblock") { return 0; }
    else { return action.colorNumber; }
  }
  return actionPriority(a) < actionPriority(b) ? b : a;
}
```
So, within a tier: highlight with a higher N > highlight with a lower N > unblock > block, independent of rule order. Consequences, all asserted in tests (interactive-ruleset.test.ts:59-110, 301-330):
- a user unblock beats a subscription block
- a subscription highlight on `sub.example.com` applies even though the user blocks `example.com` exactly (the user tier had no match for that URL)
- a user block on `example.com` beats a subscription highlight on `*.example.com` for that exact host

**Subscription pipeline** (`background/subscriptions.ts:37-76`):
1. Plain `fetch(url)` with **no ETag, no If-Modified-Since, no size or shrink guard** and no timeout.
2. If `response.ok`, convert domains lists, compile with `toPlainRuleset`, store both the raw `blacklist` and the compiled ruleset, and set `updateResult: success(timestamp)`.
3. Otherwise store `updateResult: error(message)` and **keep the previous ruleset** (the object is re-saved with its old `ruleset` and `blacklist` fields).
4. `updateAll` (line 86) recreates the alarm with `periodInMinutes = max(1440, updateInterval)` and updates all subscriptions in parallel.
5. Adding the first subscription triggers `updateAll`; later additions trigger `update(id)` (`local-storage.ts:101-123`).
6. A single global interval applies to all subscriptions. There is no per-list interval and no `Expires` header support.

**Sync model** (`background/sync.ts`, `sync-sections.ts`, `sync-backends.ts`):
- Five independent files: `uBlacklist.txt` (raw user rules), `general.json`, `appearance.json`, `subscriptions.json` (**metadata only**: `[{name,url,type,enabled}]`, each device re-downloads the content) and `serpinfo.json` (`sync-sections.ts:13-17`, 234-290).
- Uploads are debounced 5 s after a change (`SYNC_DELAY`, sync.ts:19) plus a periodic alarm. Dirty flags select which sections upload (`beforeSync`).
- `syncFile` (sync-backends.ts:119-193) is **last-writer-wins on file modified time** at the backend's precision (`modifiedTimePrecision`: Google Drive and browser sync `millisecond`; Dropbox, OneDrive and WebDAV `second`). If local is older, download; if equal, no-op; if newer, upload with the local modified time.
- `force: "upload"` stamps `now`. The initial sync lets the user pick "Keep newest", "Use local" or "Use remote" (`_locales/en/messages.json: options_turnOnSyncDialog_initialSync*`).
- After downloading, `afterDownloadAll` drops a section if local items changed during the sync (sync-sections.ts:98-105). Every incoming JSON is zod-validated, with "File corrupted: <file>" errors.
- Backends:
  - Google Drive: `drive.appdata` scope, `appDataFolder` (google-drive.ts:25, 73, 99).
  - Dropbox: files at `/<filename>` with `client_modified` (dropbox.ts:52-55); that this resolves to `/Apps/uBlacklist/` depends on the Dropbox app-folder setting, which is not in the ref (unverified).
  - OneDrive: `special/approot` (onedrive.ts:133).
  - WebDAV: HEAD for `Last-Modified`, then PUT with `X-OC-Mtime`, `credentials: "omit"` and `cache: "no-store"` (webdav.ts:47-51, 141). It creates the folder recursively with PROPFIND/MKCOL.
  - Browser sync: `lz-string` base64 in 8180-byte chunks, at most 15 chunks (browser-sync.ts:14-19, 44-45).

## Testing strategy
- `node --test` with Node 26's native TypeScript type stripping: no test framework, no bundler (`package.json` `"test": "node --test"`).
- **Unit tests:**
  - precedence and patch semantics, with prose comments explaining each case (`shared/interactive-ruleset.test.ts`, 522 lines)
  - domains parsing (`background/domains.test.ts`)
  - sync section round-trip, current file formats, and corrupted input (`background/sync-sections.test.ts`)
  - backends with `t.mock.method(globalThis, "fetch", …)` and recorded calls (`sync-backends/webdav.test.ts`, `cloud.test.ts`)
  - CSS builders (`content-script/style-builders.test.ts`) and SERPINFO settings (`shared/serpinfo-settings.test.ts`)
- **E2E:** Playwright loads the built extension (`e2e/fixtures/extension.ts`). `context.route` serves a mock Google SERP (`e2e/mocks/google-serp.html`) and a mock SERPINFO. `e2e/tests/blocking.spec.ts` walks the happy path: two example.com results are blocked by clicking the block button and then the dialog action (`getByTestId("block-dialog-action-button")`); the control toggles visibility; reload keeps them blocked; the options page shows `*://*.example.com/*`; unblocking restores them.
- CI (`.github/workflows/ci.yml`) runs `pnpm check` (oxlint + oxfmt), `pnpm test`, then `pnpm e2e` on Chromium.

## UX patterns worth copying
- **Block dialog** (`block-dialog/index.tsx:240-460`):
  - The title shows the auto-detected mode: Block, Unblock or Unhighlight.
  - It shows the host. With `blockWholeSite` this is the registrable domain via `tldts` with private suffixes (`shared/registrable-domain.ts`), Unicode-decoded with punycode (`computeHost`, line 47).
  - A collapsible "Details" section holds the result's properties table, an **editable "rules to add" textarea prefilled with the suggestion**, and a read-only "rules to remove".
  - A collapsible "Matching rules" section groups output by action as `# <ruleset name>` / `<line>: <rule>` (`formatMatchingRules`, interactive-ruleset.ts:223).
  - A split button lets the user change mode (block, unblock, highlight, unhighlight).
  - **Apply is disabled unless the edited rules actually achieve the mode** (`validateRulesToAdd`, line 318). Shift-click toggles "skip dialog" (`content-script/dialog.ts:41`).
- **Minimal patch semantics:** unblocking first *removes* the user's own blocking lines, and adds an `@` rule only if a subscription still blocks (interactive-ruleset.test.ts:132-152). The user's file stays clean and comments are preserved (test at lines 341-372).
- **Safe suggestion:** suggest `*.<registrable domain>`, but fall back to the bare host when the host is itself a public suffix such as `vercel.app`, to avoid blocking everyone's deployments. Quoted from `interactive-ruleset.ts:177-183` (MIT):
```ts
    // `domain` is null when `host` itself is a public suffix (e.g.
    // `vercel.app`). Fall back to the bare host to avoid suggesting
    // `*.vercel.app`, which would match unrelated users' deployments.
    const domain = getRegistrableDomain(host);
    if (domain != null) {
      host = `*.${domain}`;
    }
```
- **SERP control:** a floating, draggable badge shows the count of blocked results and toggles "show blocked" (blocked results are then shown tinted with `blockColor` instead of hidden) (`content-script/index.ts:135-200`). Per-result button labels: "Block this site", "Unblock this site", "Unhighlight this site".
- **Subscriptions table:** columns Name, URL, Last update (success time or error message), Enabled checkbox. The row menu has Show (view rules), Update now, Rename and Remove. There is a global "Update now" and an interval in days. In the "Add" dialog, the name is optional and falls back to the frontmatter `name`, then the URL (`_locales/en/messages.json`, `options/subscription-section/*`).
- **Import:** from a file, or paste a Google "Personal Blocklist" domain export, with an "append to existing" option (`options/general-section.tsx:46-83`).
- **Editor:** CodeMirror with the package's Lezer grammar for highlighting and a linter that reports literal errors precisely (`options/shared/ruleset-lang.ts`).

## Performance tricks
- Store the **precompiled match map** (`ruleMap` JSON) next to the raw text, so pages never re-parse rulesets (`utilities.ts:189-214`). The raw text is kept only for line text and reports.
- Host-label trie with exact and anySubdomain buckets: lookup cost is proportional to the number of labels, not the number of rules (upstream match-pattern).
- Expressions are evaluated only after a trie hit; regexes compile lazily (upstream).
- The content script batches MutationObserver records per `requestAnimationFrame`, observes only `href` changes, and skips re-judging results whose url and props are unchanged (`content-script/filter.ts:116-226`).
- `extend()` parses only appended text (upstream), which keeps validation in the dialog instant.
- Known cost: bare regex and title rules live under `<all_urls>` and run linearly for every result. A list of thousands of regexes costs roughly O(results × regexes) (inferred).

## License and what it means for us
MIT. Code may be copied with the copyright notice and license text kept, e.g. in `THIRD_PARTY_NOTICES` and a header comment on adapted files. Good candidates: `interactive-ruleset.ts` (patch, validate, precedence logic), `domains.ts` (domain-line validation) and the sync LWW logic. The parser and matcher packages (`@ublacklist/ruleset`, `@ublacklist/match-pattern`) are MIT upstream. They are pure JS with no native code (Lezer, js-yaml, zod), so **depending on them directly** for the uBlacklist importer fits the zero-native-deps goal. Re-check their LICENSE files before adding them. Lists published *in* uBlacklist format each carry their own license (Appendix B); the format being MIT says nothing about list content.

## Implications for search-hole
- [rule-format-precedence] Use uBlacklist's **"most local tier with any match wins entirely"** algorithm (interactive-ruleset.ts:35-42) to implement §6's scope precedence. Evaluate session, then project, then global, then subscribed lists. The first tier with ≥ 1 matching rule decides, and lower tiers are ignored for that result. It is deterministic, easy to explain ("decided by your project rules, line 4") and easy to property-test. Two gaps must be closed:
  - `important` must lift a rule above tier order. uBlacklist has no `important`; add an "important pass" before the tier walk.
  - A user `allow` must still beat list rules. That falls out of tier order, because user tiers always come first.
  - Inferred consequence to settle in the ADR: because *any* match in a tier decides, a user `lower` or `raise` on a domain also overrides a subscribed list's `block` for that domain (the same holds in uBlacklist, where a user highlight beats a subscription block). If that is not wanted, restrict the tier shortcut to `allow`/`block`/`pin` and let `lower`/`raise` fall through to the next tier.
- [rule-format-precedence] Within a tier, resolve by **action priority, not file order**, as `dominantAction` does (interactive-ruleset.ts:147-158). Proposed order: `allow` > `block` > `pin` > `raise`/`lower`, per the plan. Note that uBlacklist ranks highlight *above* unblock and unblock above block. When importing, map `@N` to `raise` (N clamped to 1-10) and record a warning that ranking semantics differ from uBlacklist's colour priority.
- [lists-subscriptions] **uBlacklist importer: depend on `@ublacklist/ruleset`** (MIT, pure JS) to parse. Do not write our own grammar. Caveat on the API: the package exports `Ruleset` (`exec`, `get`, line iteration, `toJSON`, `extend`), the Lezer `parser` / `bodyParser`, `parseString` and `parseRegExp` (upstream `index.ts`); it has **no ready-made list of structured rules**. Translation therefore means walking the Lezer parse tree (node names such as `String` and `RegExp` are visible in `ruleset-lang.ts`; the rest are upstream and unverified) or decoding `toJSON().ruleMap`. Budget for that work and pin the package version. Translate each rule into the search-hole IR:

  | uBlacklist | search-hole IR |
  |---|---|
  | `*://*.d/*` | domain + subdomains |
  | `*://d/*` | exact host |
  | path pattern | URL-prefix rule |
  | `/re/` | URL regex, **recompiled with our linear-time engine; reject if not RE2-compatible** |
  | `title/re/` | title regex (we do have titles) |
  | `@` | `allow` |
  | `@N` | `raise` |
  | `@if($category=…)`, `$site` | skipped with a counted warning (SERP-specific props) |

  Keep the **original line number** per rule, so explanations can cite "list X line N". Reuse `domainsToRuleset`'s line-preserving trick for domain lists (domains.ts:33-41).
- [security] The upstream matcher uses JS `RegExp` with no guard, and subscriptions have no size cap. That is why we must **not** execute uBlacklist rulesets with their own `Ruleset.exec`: translate them, then compile regexes with RE2. Enforce our caps on rule count, rule length and download bytes.
- [lists-subscriptions] The subscription record should hold at least uBlacklist's fields: `{id, name (fallback: frontmatter name, then URL), url, type: ruleset|domains|…, enabled, raw text, compiled form, updateResult: {success,timestamp}|{error,message}}` (types.ts:209-218). Add what it lacks:
  - per-list interval
  - ETag / Last-Modified
  - sha256
  - rule counts
  - `License` and `Expires` from frontmatter or headers
  - shrink guard and previous-version rollback
  - fetch timeout
  - a per-list lock that works across processes (uBlacklist's `tryLock` is in-process only, subscriptions.ts:20-35)
- [lists-subscriptions] Read YAML frontmatter `name` at the top of uBlacklist-format lists (README "For subscription providers", which documents only `name`). Also accept `license`, `homepage` and `expires` as our own convention: the compiled metadata is an open `Record<string, unknown>` (`shared/types.ts` `PlainRuleset`), so extra keys survive, but uBlacklist assigns them no meaning. Whether the Appendix B seed lists carry frontmatter is unverified.
- [lists-subscriptions] Default refresh: uBlacklist uses one global interval of **1 day minimum** (intervals.ts:5). For search-hole, use per-list intervals defaulting to 7 days (or the list's `Expires`), with a 4-hour floor (see `ublock.md`) and a 1-day default for first-party lists.
- [mcp-tool-surface] Model `suggest_rule`'s queued suggestion on uBlacklist's **`Patch`** (interactive-ruleset.ts:9-18). The real fields are `{mode, searchResult, rulesToAdd, lineNumbersToRemove, rulesToRemove, userActionNotToRemove, subscriptionsAction, matchingRules}`. The adaptation for search-hole (our additions and renames, not uBlacklist's): add a `scope` per removed rule, and rename `userActionNotToRemove` to `currentAction` and `subscriptionsAction` to `listsAction`. The dashboard, panel or `apply_rule` then shows exactly what changes and refuses to apply a patch that doesn't achieve its mode (`validateRulesToAdd`). Re-run the validation at apply time against the *current* rules, since they may have changed since the suggestion.
- [ui-ux] The "Block" UX in the dashboard and in-chat panel should copy the dialog:
  - prefilled, editable rule
  - "will remove: …" preview
  - collapsible "matching rules" grouped by action, as `# <list name>` + `line: rule`
  - auto mode (block ↔ unblock) based on current state
  - Apply disabled when the rule is invalid or ineffective
  - default to the registrable domain (via `tldts` with private suffixes), **falling back to the bare host for public-suffix hosts** (interactive-ruleset.ts:170-191; `shared/registrable-domain.ts`)
- [ui-ux] Unblocking edits the user's own file minimally: remove the user's blocking lines first, and add an `allow` only when a list still blocks (interactive-ruleset.test.ts:132-152). The same rule applies to `searchhole unblock <domain>`: it should delete the matching lines from `rules.yaml` / `.searchhole.yaml` rather than pile up contradictory rules.
- [ui-ux] Show subscription health the way uBlacklist's table does (last success time or the error message), and offer a **one-click subscribe link** handler: a dashboard route `/lists/subscribe?url=…` that opens a confirmation dialog showing the license, rule count and preview before enabling. The idea comes from `shared/constants.ts:6-8` and `enable-subscription-url.tsx`.
- [other] **No cloud sync in v1.** search-hole's rules are YAML files: `.searchhole.yaml` is committed to git, and `~/.searchhole/rules.yaml` can live in dotfiles or Syncthing. If sync is ever added, copy uBlacklist's design (MIT):
  - per-section files
  - **subscriptions synced as metadata only**
  - last-writer-wins on modified time at backend precision
  - a 5 s debounce
  - zod-validated payloads
  - a "keep newest / local / remote" first-sync choice

  Evidence: sync-sections.ts:13-17 and 234-290; sync-backends.ts:119-193; sync.ts:19.
- [key-storage] Avoid uBlacklist's plain-text credential storage: the WebDAV password and OAuth refresh tokens sit in `browser.storage.local` (`RawStorageItems.syncCloudToken`, raw-storage.ts:17-22). This supports the plan's key ADR: keychain, or env, or an encrypted file, never plain JSON.
- [upgrades-migrations] Recompile user rules from source on every install, update and startup (background/index.ts:41-58; local-storage.ts:94-99) to stay safe when the compiled format changes. search-hole should do better than uBlacklist by also stamping a `compiler_version` on each list's compiled form, because uBlacklist leaves subscription compiled forms stale until their next fetch (inferred).
- [testing] Copy the test style: `node:test` (or Vitest) cases named after behaviours, with prose comments explaining *why* each precedence outcome holds (interactive-ruleset.test.ts). Mock `fetch` per test for list downloads (webdav.test.ts:23-33). Use a Playwright e2e that routes a mock engine response and walks block → verify hidden → unblock (e2e/tests/blocking.spec.ts). Add property tests (fast-check) for the precedence table, which uBlacklist lacks.
- [engine-adapter] SERPINFO is uBlacklist's scraping adapter: page match patterns, result root, url and props selectors. search-hole adapters return structured JSON, so do not copy it. The `props` idea (title, site, category attached to each result and usable in rules) is worth keeping in our result type, so title rules and future `@if`-like conditions have data to match.

## Borrow / avoid
**Borrow**
- `@ublacklist/ruleset` (MIT) as the parser for the uBlacklist importer, translated into our IR with line numbers preserved.
- Tiered precedence: the most local tier with any match decides; inside a tier, action priority beats file order.
- `Patch`, `validateRulesToAdd` and `applyPatch` as the model for `suggest_rule` and `apply_rule`, and for minimal unblock edits that preserve comments.
- Registrable-domain suggestion with the public-suffix fallback (`tldts`, `allowPrivateDomains`).
- The "matching rules" report format: `# <list>` / `line: rule`, grouped by action.
- `domainsToRuleset`-style line-preserving conversion, and its domain-line validation rules.
- The subscription record fields and the success/error `updateResult` shape. Keep the old content on failure.
- One parser for the editor's highlighting and linting.
- Behaviour-named tests with explanatory comments; fetch mocks; a Playwright happy path with routed mocks.
- For any future sync: per-section files, metadata-only subscriptions, LWW at backend precision, debounce, zod validation.

**Avoid**
- Running list regexes on JS `RegExp` (no ReDoS guard upstream); bare regexes evaluated linearly under `<all_urls>` at scale.
- Fetching subscriptions with no ETag, timeout, size cap, shrink guard or version history.
- A single global update interval and an in-process-only lock.
- Plain-text storage of sync credentials.
- Compiled forms with no version stamp.
- Highlight colours as ranking priority (it confuses "visual emphasis" with "rank"). Map them explicitly and warn.
- SERP-specific conditions (`$category`, `$site`) in our core rule language until an engine supplies those props.

## Verification
- Date: 2026-10-29. Checked against `research/refs/ublacklist` @ e3df713; package-internal claims were additionally checked against `github.com/ublacklist/packages` (`main`, fetched 2026-10-29, via a summarising fetch tool, so exact quotes were not re-read byte for byte). Claims checked: 88 (license header and `LICENSE.txt` / `third-party` licenses, the `dominantAction` snippet against `interactive-ruleset.ts:147-158`, tier precedence and its tests, storage keys and defaults, subscription pipeline, sync model and backends, domains parser, block-dialog behaviour, test layout, and every bullet under "Implications for search-hole").
- Confirmed with no change: MIT licenses (ref and upstream `LICENSE`, `@ublacklist/ruleset` `package.json`), user-tier-then-subscriptions precedence, `dominantAction` ordering and the pasted MIT snippet (accurate), 1440-minute update floor, no ETag / timeout / size guard, keep-previous-ruleset-on-failure, in-process-only `tryLock`, plain-text sync credentials, upstream trie structure, lazy regex with no ReDoS guard, `RulesetJSON` having no version field.
- Corrections made:
  1. `Patch` fields: the bullet listed `target result`, `currentAction`, `listsAction` and "rulesToRemove (with scope ...)"; the real type has `searchResult`, `lineNumbersToRemove`, `userActionNotToRemove`, `subscriptionsAction`. The bullet now gives the real fields and marks the scope field and renames as our adaptation.
  2. Sync backend time precision: browser sync is `millisecond` (not seconds) and OneDrive is `second`; Dropbox path `/Apps/uBlacklist/` is not in the ref and is marked unverified.
  3. `Ruleset.extend` claim: in the ref, `validateRulesToAdd` extends a throwaway empty `Ruleset`, not the user's ruleset; the "merges into the existing map" behaviour is upstream and now attributed as such.
  4. Importer bullet: added that `@ublacklist/ruleset` exports no structured rule list (only `Ruleset`, Lezer `parser`/`bodyParser`, `parseString`, `parseRegExp`), so translation means walking the parse tree or `toJSON().ruleMap`.
  5. Seed-list claim "about 8 of 13 are uBlacklist rulesets" is unsupported by Appendix B; marked as an unverified estimate.
  6. Subscribe-link mechanism: the redirect is a `declarativeNetRequest` rule in `background/serpinfo.ts:77-110`, not in `constants.ts`; added the options-page query parameters.
  7. Frontmatter: uBlacklist documents only `name`; `license`, `homepage` and `expires` are our convention.
  8. Added an inferred precedence consequence: with "any match in a tier decides", a user `lower`/`raise` also overrides a list `block`; flagged for the precedence ADR.
  9. Header: recorded the verified upstream license text and package license.
- The ref contains one pasted code excerpt (`dominantAction`, `getRegistrableDomain` comment block). Both are MIT with the notice requirement noted in the License section; no GPL/AGPL/EUPL code is present.

