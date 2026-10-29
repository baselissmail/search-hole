# pi-hole/web
> Ref: `research/refs/pi-hole-web` @ fb699c4 (2026-10-17) · License: **EUPL-1.2** for the repo (root `LICENSE`), **except `vendor/`**, "whose licenses are located therein". `vendor/LICENSE` is MIT (AdminLTE, © almasaeed2010). The other vendored libraries (Bootstrap 3, jQuery, DataTables, Chart.js, Select2, moment, daterangepicker, Font Awesome, etc.) carry their own upstream licences, mostly MIT in their headers. **`vendor/qrious/` is GPL v3** (header of `qrious.min.js`), so nothing under `vendor/` should be lifted without reading the individual header. `package.json` declares `"license": "EUPL-1.2"`. **Pi-hole's own files: ideas only.**

## Purpose
The Pi-hole v6 admin UI is a set of **Lua server pages** (`*.lp`) plus plain browser JS (`scripts/js/*.js`, about 11k lines) and CSS themes. The FTL daemon serves it directly (CivetWeb plus embedded Lua; see `pi-hole-ftl.md`). There is **no build step and no SPA framework**: jQuery 3.7, Bootstrap 3.4, AdminLTE 2.4, DataTables 1.10, Chart.js 4.5 (`package.json` dependencies). Every data call is a `fetch` or `$.ajax` to the FTL REST API at `document.body.dataset.apiurl`.

It matters to search-hole as the UX reference that §8.3-8.4 cite ("Pi-hole calm", "every row explains itself", one-click allow/deny). This note records what the v6 UI actually does, including where it falls short of our bar.

## Architecture sketch
```
Browser ──GET /admin/queries──► FTL CivetWeb
                                 └─ lua_web.c: every .lp except login requires a session (else 302 → login)
                                 └─ queries.lp includes scripts/lua/header.lp:
                                      <meta name="csrf-token" content=<session csrf>>, <body data-apiurl=…>
                                      header_authenticated.lp → vendor libs + page JS (cache-busted via pihole.fileversion)
Browser JS ──$.ajax/fetch──► /api/* (cookie `sid` is HttpOnly; jQuery adds X-CSRF-TOKEN to every request: utils.js $.ajaxSetup)
     polling loops (utils.setTimer → callIfVisible) per widget; nothing is pushed
```
Pages: `index.lp` (dashboard), `queries.lp` (query log), `search.lp` (which list contains X), `groups*.lp` (groups, clients, domains, lists), `gravity.lp` (run an update with streamed output), `messages.lp`, `network.lp`, `taillog.lp`, `settings-*.lp` (one page per area plus `settings-all.lp` generated from the config schema), `login.lp`.

## Key modules and data flow
- **`scripts/js/utils.js`**:
  - global CSRF header (`$.ajaxSetup`, L17)
  - `escapeHtml` and `unescapeHtml`
  - `setTimer`/`setInter`, which wrap `setTimeout` with **`callIfVisible`**: when `document.hidden` is set, retry in 1 s instead of hitting the API
  - `stateSaveCallback`/`stateLoadCallback`, which persist DataTables state (page length, sort) to `localStorage`
  - `addFromQueryLog` (one-click allow/deny), `checkMessages` (badge count from `/api/info/messages/count`), `parseQueryString`, `datetimeRelative` (moment `fromNow`), validators for IP, CIDR, MAC and hostname
- **`scripts/js/footer.js`**: the `REFRESH_INTERVAL` table:

  | Widget | Poll interval |
  |---|---|
  | logs | 0.5 s |
  | dashboard summary | 1 s |
  | query log | 2 s |
  | blocking state | 10 s |
  | system | 20 s |
  | pies and top lists | 60 s |
  | version, ftl | 120 s |
  | history graphs | 600 s |

  It also holds the sidebar's **disable-blocking timer** (`piholeChange` → `POST /api/dns/blocking {blocking, timer}`, countdown kept in `localStorage`), version checks, and the "basic/expert settings" toggle in `localStorage.expert_settings` (`initSettingsLevel`). `apiFailure` reloads the page on 401, which sends the user to login.
- **`scripts/js/queries.js`** (query log, 801 lines) is described under UX below.
- **`scripts/js/gravity.js`**: `POST /api/action/gravity?color=true` with the CSRF header. It reads `response.body.getReader()` chunk by chunk, splits on `\r` to emulate the CLI's line overwrite (`OVER`), escapes HTML, maps a small set of ANSI colour codes to CSS classes, and shows a success banner once the text contains "Done.". In effect this is a streamed CLI rendered in the browser.
- **`scripts/js/taillog.js`**: polls `/api/logs/{ftl|dnsmasq|webserver}?nextID=N` every 0.5 s and appends only new lines. It resets when the returned `pid` changes, i.e. FTL restarted (FTL `src/api/logs.c`).
- **`scripts/js/groups-*.js`**: DataTables over `/api/domains`, `/api/lists`, `/api/clients` and `/api/groups`, with inline editing and batch delete via `/<type>s:batchDelete` (`groups-common.js: delGroupItems`).
- **`scripts/js/search.js`**: `GET /api/search/<domain>?partial=&N=`, rendered as "found exactly/partially in …".
- **`scripts/js/settings.js` / `settings-advanced.js`**: render settings from `GET /api/config?detailed=true` metadata (description, allowed values, type, `flags.restart_dnsmasq`, `flags.env_var`), save with `PATCH /api/config`, and **disable inputs whose value is forced by an env var** (`settings.js` L59-77, `settings-advanced.js` L37, L79).
- **`scripts/js/login.js`**: `POST /api/auth {password, totp}`. A first `GET /api/auth` tells the page whether to show the TOTP field (`session.totp`). The form auto-submits when 6 TOTP digits are typed and the password is filled in. A password-visibility toggle shows a warning title.

## Data model and storage
n/a for persistence: the UI stores nothing server-side. All data lives in FTL (`pi-hole-ftl.md`). Browser-side it keeps only conveniences in `localStorage`: DataTables state per table (`query_log_table`, …), `expert_settings`, `countDownTarget`. That matches our plan's rule of `localStorage` for per-viewer conveniences only.

## Config format
n/a: there is no UI config file. Settings pages are a generic renderer over FTL's config registry, with one panel per top-level key in `settings-all.lp` and help text taken from the registry. Theme choice is a server config value (`webserver.interface.theme`), with themes `default-auto`, `default-light`, `default-dark`, `default-darker`, `high-contrast`, `high-contrast-dark` and `lcars` (`style/themes/*.css`; FTL `src/api/theme.c`).

## Extension points (plugins, hooks)
n/a: no plugin mechanism. Customisation comes from themes, the boxed layout flag and FTL's `webserver.headers`.

## Rules / lists: parsing and compilation
The UI does no parsing. It does three client-side transforms worth noting:
- The **wildcard checkbox** on the Domains page turns `example.com` into an anchored "subdomain-or-self" regex and strips a leading `*.` (`groups-domains.js` ~L503-512). The CLI does the same (`pi-hole.md`, `list.sh`).
- Domains are displayed as the **Unicode form followed by the punycode form in parentheses** when they differ (`groups-domains.js` rowCallback, `data.unicode` vs `data.domain`).
- List rows show **health from FTL's status codes** (`groups-lists.js: setStatusText`): 1 downloaded fine (label "OK"), 2 unchanged upstream so the local copy was used ("OK"), 3 unavailable so the local copy was used (label "check list"), 4 unavailable with no local copy (label "replace list"), 0 not downloaded yet or disabled (anything else shows "unknown"). They also show an icon (check / history / exclamation / times / question), entries, ABP entries, invalid count, and "last updated" as relative time with the absolute date in a tooltip.

## Testing strategy
- No unit or E2E tests in this repo. `npm test` runs `prettier --check` plus `xo` (ESLint with `eslint-plugin-compat` against a browserslist that includes "Firefox ESR" and "last 2 major versions") (`package.json` scripts, `xo.config.js`).
- CI workflows: `codeql.yml`, `codespell.yml`, `editorconfig-checker.yml`, `test.yml` (`.github/workflows/`). `test.yml` runs `npm run testpr` (autoprefix, prettier fix, a clean-diff check, then xo), not plain `npm test`. API behaviour is tested in the FTL repo (`pi-hole-ftl.md` "Testing strategy").

## UX patterns worth copying
**Query log** (`queries.lp`, `scripts/js/queries.js`):
- **Columns**: Time · status icon · Type · Domain · Client · reply time (stopwatch icon) · action button. Header and footer rows are identical, and the footer cells become per-column search inputs for searchable columns (domain, client) (`initComplete`).
- **Status → presentation map** (`parseQueryStatus`). Each status gets colour class, icon, text and the *inverse* action:
  - blocked (GRAVITY / REGEX / DENYLIST / *_CNAME): red `fa-ban`, "Blocked (gravity|regex|exact)", **Allow** button
  - allowed (FORWARDED "Forwarded to <upstream>" / CACHE "Served from cache" / CACHE_STALE "Served by cache optimizer" / IN_PROGRESS): green, **Deny** button
  - externally blocked: red, no button
  - unknown: orange question mark

  Whole rows get a `blocked-row` or `allowed-row` background. This is §8.4's "status chip + one-click inverse", but colour and icon only, with the word in a `title` tooltip.
- **Expandable details row** on click (ignored while text is selected): received time with ms and TZ, client name (IP), DNSSEC, extended DNS error, status, CNAME chain ("blocked during CNAME inspection of X"), "Query was blocked/allowed, *search lists*" link, TTL, reply type, DB id (`formatInfo`). Text selection doesn't toggle the row, a nice touch.
- **Server-side paging** (`serverSide: true`):
  - the API URL is built from filters, plus `from`/`until` and `disk=true`
  - `cursor` from the first response is sent on later page requests, so **new rows don't shift pages** while you browse; Refresh or Live mode clears it (`refreshTable`)
  - page sizes 10-1000 ("All" was removed, and an old saved "All" falls back to 25; `stateLoadCallback`)
  - DataTables' `draw` counter discards out-of-order replies
- **Filters**: a filter box with Select2 dropdowns for domain, client IP, client name, upstream, type, status, reply and DNSSEC. Suggestions come from `GET /api/queries/suggestions`; the first four accept free text (`tags`). Changes apply on "Refresh". A **date-range picker** offers presets (last 10 min, last hour, today, yesterday, 7 and 30 days, this or last month, this year, all time) and is clamped to the earliest timestamp in memory or on disk. A "Query on-disk data" checkbox (slower, needed beyond 24 h) disables Live.
- **URL as initial state**: `queries?domain=x`, `?client_ip=…`, `?upstream=blocklist`, `?from=&until=` prefill the filters (`utils.parseQueryString` → `addSelectSuggestion`). Dashboard top-domain, top-client and "Queries Blocked" tiles link straight into a filtered log (`index.js` L336, L414; `index.lp` L41). The URL isn't *updated* as filters change, only read.
- **Live mode**: a checkbox that re-fetches page one every `REFRESH_INTERVAL.query_log` (2 s). It's a full redraw, with no "N new" pill and no pause on hover.
- **One-click allow/deny** (`utils.addFromQueryLog`): opens a **modal** ("Adding X to Allowlist…"), POSTs `{domain, comment: "Added from Query Log", type, kind: "exact"}`, shows success, auto-closes after 2 s (8-10 s on error, with the API's `error.hint` or `message`). There is **no undo** and no scope choice; it is always exact, global and permanent. The auto-comment records provenance.

**Dashboard** (`index.lp`, `index.js`):
- Four stat tiles (Total Queries · Queries Blocked · Percentage Blocked · Domains on Lists), each linking to its detail page.
- Stacked over-time chart (cached, blocked, permitted, other colours from CSS variables via `utils.getCSSval`), client activity, query type and upstream doughnuts, top permitted and blocked domains, top clients total and blocked-only.
- Widgets refresh at different cadences (1 s to 10 min).

**Elsewhere**:
- **Disable blocking** from the sidebar for 10 s, 30 s, 5 min, a custom time or indefinitely, with a live countdown (`scripts/lua/sidebar.lp` L88-120, `footer.js: piholeChange, countDown`). Our "pause search-hole for 10 minutes" can follow this.
- **Messages badge**: a counter in the header polls `/api/info/messages/count` every 60 s. The page lists typed background problems such as an unreachable list, gravity restored or a rate limit (`utils.checkMessages`, `messages.js`).
- **Settings**: a "Basic / Expert" switch hides advanced options (`settings-level-expert` class). Env-forced values are disabled with a marker, and restart-required options carry an orange redo icon (`settings.js`, `settings-advanced.js`).
- **Domains table**: per-row inline type selector (allow/deny × exact/regex), enabled toggle, editable comment and group multi-select. A tooltip shows added and modified dates plus the DB id. Monospace `<code>` is used for domains, checkbox multi-select is followed by "Delete selected", and toasts confirm ("Adding domain(s)…", errors with the response text) (`groups-domains.js`).
- **Visibility-aware polling**: no requests while the tab is hidden (`callIfVisible`).

## Performance tricks
- Server-side paging, capped page sizes, a frozen cursor and an in-memory history DB on the FTL side keep the log fast on a Pi with millions of rows. The client never loads the full log (`queries.js` `serverSide`; FTL `api/queries.c` cap of 10,000).
- From/until parameters are **omitted** when they cover the whole available range, so the DB skips the time predicate (a code comment in `getAPIURL` credits this with faster lookups on slow devices).
- Each widget polls on its own interval, pauses when the tab is hidden, and an earlier request's timer is cancelled before a new one is set (`utils.setTimer` keeps `func.timer`). That avoids duplicate in-flight polls.
- Static assets are cache-busted with a version query (`pihole.fileversion(...)` in `header*.lp`), so they can be cached long-term.
- `chartjs-plugin-deferred` renders charts only when scrolled into view (`package.json`, `header_authenticated.lp`).

## License and what it means for us
EUPL-1.2 on Pi-hole's own JS, Lua pages and CSS means **no copying** of code, markup, CSS, status strings or icon mappings. We describe patterns only. `vendor/` is third-party (AdminLTE is MIT) but irrelevant: our stack is React plus a modern table (§8.2). Don't reuse Pi-hole's themes, colours, logo or wording, and don't use "Pi-hole" in the branding.

## Implications for search-hole
- [ui-ux] Make the log row explain itself with **colour, icon and word** (in the status column Pi-hole puts the word only in a `title` tooltip, which fails §8.4.7; the action button and the details row do carry words). Put the **rule or list name inline** with a link to it. Pi-hole only says "Query was blocked, search lists" and makes the user search (`queries.js: formatInfo`). We already store `rule_id`/`list_id`, so render "Hidden by **ai-content-farms** (`||contentfarm.example^`)" directly.
- [ui-ux] Replace Pi-hole's modal-then-auto-close allow/deny (`utils.js: addFromQueryLog`) with **optimistic apply plus an Undo toast**, and a scope and duration picker (global, project or session; permanent or for N days), per §8.4.2-3. Keep Pi-hole's provenance idea: auto-comment "Added from log, search #123".
- [ui-ux] Live log: copy Pi-hole's **cursor freeze** for paging (`queries.js` `cursor`; FTL `api/queries.c`), but go beyond its 2 s full redraw. Stream new rows over SSE into a buffer, show "N new" while the user is scrolled or hovering, and insert in batches (§8.3 "Live log"). Keep `callIfVisible`-style pausing for any polling fallback.
- [ui-ux] Read **and write** filters and the time range to the URL. Pi-hole reads `?domain=&client_ip=&from=&until=` but never updates the URL as filters change (`queries.js` `parseQueryString` only at load). Our §8.4.4 wants typed search params both ways. Copy its deep links from dashboard tiles and top lists into a filtered log (`index.js` L336, L414).
- [ui-ux] Filter UX: value suggestions from the server for each facet (`/api/queries/suggestions` → Select2) and date presets clamped to the data's real range. Adapt the facets to ours: engine, client (tool), profile, decision kept/hidden/pinned, rule, list, domain.
- [ui-ux] Details row: a key-value grid with exact timestamp (ms, TZ), client, status, the matched chain (for us: rule precedence path), reply metadata and the DB id. Opening on click but not while text is selected is worth copying (`queries.js` click handler checks `getSelection`).
- [ui-ux] List health UI: icon plus word plus "what to do" (OK / check list / replace list), counts (entries, ABP-style, invalid), and relative "updated 3 days ago" with the absolute date on hover (`groups-lists.js: setStatusText`). Add our planned contribution metric ("removed 312 results this week").
- [ui-ux] A messages or inbox badge for background problems (list unreachable, restored from backup, engine quota exceeded), polled cheaply via a count endpoint (`utils.checkMessages`). It maps to our engine-health and suggestions inbox.
- [ui-ux] A **Pause** control with presets and a live countdown (`sidebar.lp`, `footer.js: piholeChange`). For search-hole: "bypass rules for 10 min" or "pass-through mode", shown in receipts while active.
- [ui-ux] Schema-driven settings: render from config metadata (description, allowed values, type, restart-needed, **env-forced → disabled with badge**), with a Basic/Expert split (`settings-advanced.js`, `settings.js`, `footer.js: initSettingsLevel`). It fits "Engines: key status (set or missing, and where it comes from; never the value)".
- [ui-ux] Show IDN domains as Unicode with punycode alongside, in monospace (`groups-domains.js` rowCallback). Use the same in receipts and the sources view.
- [security] The page carries the CSRF token in a `<meta>` tag, the session cookie is HttpOnly, and a global AJAX setup adds `X-CSRF-TOKEN`. On 401 the page reloads, which lands on login (`header.lp` L71, `utils.js` L17, `footer.js: apiFailure`). For our dashboard: embed a per-start token in the served HTML or in the launch URL, and send it as a header on every mutating call.
- [security] Escape every server string before inserting HTML. Pi-hole does it by hand at each call site (`utils.escapeHtml`), including the streamed gravity output. React's default escaping removes that class of bug for us, but any raw-HTML rendering of list output or URLs must still be sanitised.
- [dashboard-process-model] Long operations (list refresh) stream progress as chunked text that the page reads with `ReadableStream` (`gravity.js`; FTL `api/action.c`). That is a simple alternative to job IDs plus polling. For us, an SSE or chunked endpoint `POST /api/lists/refresh` streams the same per-list lines as the CLI.
- [testing] Pi-hole has no UI tests at all, only lint (`package.json` `test`). Our plan's Playwright and visual checks (§12.3) are a deliberate step beyond. At minimum, cover the log's cursor paging, the Undo flow and env-locked fields.
- [other] The no-build, server-rendered approach (Lua pages plus jQuery) keeps the daemon self-contained, but makes for large per-page scripts with globals (`xo.config.js` disables `no-implicit-globals`). Our plan (React dashboard built to static assets and served by `searchhole ui`) keeps the self-contained property without that cost.

## Borrow / avoid
**Borrow**
- Status → icon, colour and inverse action mapping per row; whole-row tint for blocked; details row on click.
- Server-side paging with a frozen cursor, capped page sizes, `draw` sequencing, from/until omitted when unbounded.
- Facet filters with server suggestions; date presets clamped to the data range; deep links from dashboard tiles into a filtered log.
- Visibility-aware polling with a per-widget cadence; cancel-before-reschedule timers.
- Streamed progress for long jobs rendered in the page.
- List health with icon, word and next action; relative and absolute timestamps; per-list counts.
- Schema-driven settings with env-locked fields and a Basic/Expert split; a messages badge; a pause with countdown.
- Unicode plus punycode display of IDNs; monospace domains; provenance auto-comments on rules created from the log.

**Avoid**
- Modal confirmation for allow/deny with no undo and no scope (always exact, global, permanent).
- Words only in tooltips (colour plus icon without visible text).
- "Search lists" indirection instead of naming the matching rule or list inline.
- Live mode as a 2 s full-table redraw (layout jumps, lost scroll); no "N new" pill, no pause on hover.
- One-way URL state (read at load, never written back).
- jQuery globals and per-call-site manual HTML escaping; no UI tests.
- An "All rows" page size (Pi-hole had to remove it; cap at about 1,000 per page).

## Verification
Checked 2026-10-29 against `research/refs/pi-hole-web` @ fb699c4 (read-only; nothing was run). Claims checked: about 55. They cover the licence header (root `LICENSE`, `vendor/LICENSE`, `package.json`, and a scan of the licence headers inside `vendor/`), all 16 "Implications for search-hole" bullets, and the mechanisms they rely on: the `REFRESH_INTERVAL` table, the global CSRF header and meta tag, `addFromQueryLog` (modal, payload, auto-close timings, no undo), cursor paging and page sizes, the "All" fallback, read-only URL state (no `pushState` anywhere), live mode, details-row text, list-status handling, wildcard-to-regex and Unicode/punycode display, taillog `nextID` and `pid` reset, streamed gravity output, the disable-blocking presets, env-locked settings, and the test and CI setup. FTL-side references (`api/queries.c` cap, `api/logs.c`, `lua_web.c` login redirect, theme names) were cross-checked in `research/refs/pi-hole-ftl`.

Corrections made:
- Licence header: `vendor/` is not uniformly permissive. `vendor/qrious/qrious.min.js` carries a GPL v3 header, so the note now says to read each vendored header before lifting anything (MIT for AdminLTE and most others was confirmed).
- List-status descriptions: status 0 means "not downloaded yet or disabled", not just "unknown"; the four quoted UI sentences were replaced by short paraphrases (licence hygiene).
- Status column: the word appears only in a `title` tooltip in the icon cell, but the action button and the details row do carry words; the Implications bullet now says so.
- CI: `test.yml` runs `npm run testpr` (autoprefix, prettier fix, clean-diff check, xo), not plain `npm test`.
- Licence hygiene: one paraphrased source comment about omitting `from` / `until`.

Confirmed unchanged: EUPL-1.2 for the repo outside `vendor/`; poll intervals (0.5 s logs, 1 s summary, 2 s query log, 60 s messages, 600 s history); modal-then-auto-close allow/deny with a provenance comment and no undo; the URL is read at load and never written back; no UI tests (lint only).
