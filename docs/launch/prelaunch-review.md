# Pre-launch review (2026-11-14)

A review of search-hole 0.3.0 before any public announcement: what two weeks of real use show, the defects found, the claims in the docs and launch drafts that don't hold, and what was never tested. Tick items off as they are done.

**Verdict that morning: not ready to announce.** The engineering is in good shape. The product has not yet shown that it changes anything for its user, four defects need fixing first, and several claims in the launch drafts are false or unproven.

## Status at the end of 2026-11-14

Everything in sections 2 and 3 that could be fixed in the repository is fixed, and the repository is public. Ticked items carry the commit that closed them.

**Done**

- All five "must fix" defects and eleven of the smaller ones, each with tests. One is left on purpose (17, empty receipts).
- The review list and the Opened / Seen marks (ADR-0025): dashboard, `searchhole review`, `/search-hole:review`. On the real two-week log it lists 28 sites.
- Every user-facing document corrected against the code; the launch drafts open on what the log shows.
- The repository is public, with private vulnerability reporting, Dependabot alerts, secret scanning and push protection on.

**Found once the repository was public** (GitHub's scanners ran for the first time)

- 20 Dependabot alerts. `pnpm audit --prod` had missed them, because the bundled libraries are dev dependencies. hono and @hono/node-server are upgraded; `tmp` and `node-forge`, used only by the tool that packs the Desktop extension, are overridden to patched versions. One stays open: zod 3 inside that same tool, whose only fix is zod 4.
- The built files did not carry the licence texts of the 110 npm libraries bundled into them. The build now writes `dist/THIRD_PARTY_LICENSES.txt`.
- 16 CodeQL alerts. The file races in shipped code are closed. What remains is in tests, one build script, and two places in shipped code where the pattern is intended (a lock file read after an exclusive create failed, and following a symlink to the user's own config).
- One secret-scanning alert: a made-up Tavily key in a test. Checked and closed as "used in tests".
- A guard gap: a command run through `mise exec --` was not recognised. Fixed.

**Still open before announcing**

- [ ] Use it for a week with an engine on (a free Tavily key or `searchhole searxng up`), and act on the review list. Engines mode still has no real use behind it.
- [ ] Try it in the real apps, or keep the "not yet tried" labels: Claude Desktop, VS Code, Cursor, Codex, Windsurf, Zed, Goose; and Windows on a real machine.
- [ ] A clean-machine install, and the release rehearsal (`docs/release.md` §3).
- [ ] The rest of `docs/release.md` step 0, which needs the owner: workflow permissions, the two rulesets, the Renovate app, the tag-signing key, npm trusted publishing and the two environments.
- [ ] A recorded GIF, if wanted; the README has two still pictures now.
- [ ] Decide what to do with the open zod alert (dismiss it as a dev-only tool, or wait for the tool to move to zod 4).

## 1. What two weeks of real use show

Source: the local search log, 2026-10-31 to 2026-11-13. One user, Claude Code on macOS, default setup with no engine (built-in mode). `docs/dogfood.md` was not filled in, so this log is the only record.

| Measure | Value |
|---|---|
| Searches | 96, on 9 of 14 days |
| Results seen | 1,243, from 538 sites |
| Results hidden by any rule or list | **0** |
| Rules the user added | 0 |
| Rules Claude suggested | 0 |
| Pages Claude opened | about 200 |
| Sites in results that Claude opened at least one page from | 37 of 538 (7%) |
| Results an audit list would have hidden | 6 (one of them a false positive, see below) |
| Searches where one site filled 3 or more results | 60 of 96 |
| Results with source type "unknown" | 767 of 1,243 |
| Pages opened through search-hole's own `fetch` that got a publish date | 8 of 40 |

What this means:

- **The lists did nothing.** 2,908 list rules never matched one result. They target copy sites of Stack Overflow and GitHub, and Claude's search no longer returns those.
- **Low-quality sites were there, and nothing pointed at them.** Several sites appeared in 5 to 10 separate searches and were never opened once. They are the natural candidates for a rule, but the product waits for the user to notice them in the log.
- **Claude skipped most of them by itself.** That is good for the user and weak for the pitch. One caveat: in built-in mode Claude's search writes its summary from every result, so a site can shape an answer without being opened.
- **The audit default was right.** `laylavish-huge-ai` would have hidden results from huggingface.co. Enforcing it would have been a false positive.
- **Engines mode had no real use.** Ranking, snippets, dates and freshness rules, the "better" half of the product, were never exercised outside tests.

### Changes that would make it useful

- [x] **A review list built from the log:** "sites Claude keeps seeing and never opens", each with Block, Lower and Keep. The data is already stored (`results` and `fetches` tables). This turns the log into decisions, which is what the user did by hand and found valuable.
- [x] **Opened / seen / hidden labels** on each result in the Live log (already noted as not built in `docs/dashboard.md`).
- [x] **Stop the no-engine error at the start of every session** (defect 5 below).
- [ ] **Then one more week of use with an engine on** (free Tavily key or SearXNG), making rules from the review list. If it still hides nothing the user cares about, change the pitch from "filter what your AI reads" to "see what your AI reads".

## 2. Defects to fix before anyone else installs it

Verified means reproduced in this review, either by me or by a reviewer running the built CLI against throwaway data.

### Must fix

- [x] **1. Claude can sign in to the dashboard and change rules.** `ui` is not in `RULE_CHANGING_VERBS` (`packages/search-hole/src/gateway/guard.ts:28`), and `searchhole ui` prints the one-time sign-in link to stdout (`packages/search-hole/src/cli/run.ts:265`). A model with a shell runs `searchhole ui --detach`, reads the link, and calls the write routes. Verified twice: I was handed a sign-in link in a normal session, and a reviewer wrote a rule this way against sandbox data. It breaks the promise "Claude can only suggest rules". Fix: guard the `ui` verb, and print the link only to a terminal. *Fixed in `bb141ac`.*
- [x] **2. `explain` gives the wrong answer without `https://`.** `searchhole explain csdn.net` says "kept"; `explain https://csdn.net/x` says "hidden". `explain notaurl` also says "kept", exit 0. Verified. Fix: add the scheme when it is missing, and refuse input that isn't a host or URL. *Fixed in `26a810d`.*
- [x] **3. A list named `local` deletes every imported list when removed; one named `generation` breaks list updates.** List ids reserve nothing (`packages/search-hole/src/lists/registry.ts:107`), and those two names collide with search-hole's own folder and stamp file (`packages/search-hole/src/app/listfiles.ts:91`, `packages/search-hole/src/app/lists.ts:587`). The id is derived from the URL, so `lists add https://…/local.txt` is enough. Verified. Fix: reject both names on add and import. *Fixed in `7432d0f`.*
- [x] **4. `uninstall --purge` can delete folders it never made.** `lists`, `backups`, `secrets`, `run` and `searxng` are removed recursively by name (`packages/search-hole/src/cli/uninstall.ts:20`, `:135`). With `SEARCHHOLE_HOME` set to a shared folder, a user's own `backups/` goes too. The "is your home folder" check is also case-sensitive, which is wrong on macOS and Windows. Verified in a sandbox. Fix: delete known files inside those folders, then remove each folder only if empty. *Fixed in `b96a088`.*
- [x] **5. With no engine, the plugin tells Claude to prefer a tool that always fails.** The server instructions are fixed text (`packages/search-hole/src/gateway/instructions.ts`): "Prefer search and fetch over built-in web search". In the default setup `search` returns "No healthy engine…" every time, so each session starts with a failed call and a visible error. It is in dozens of session transcripts on the test machine. Fix: choose the instructions at start from whether an engine is set up. Outside Claude Code the same text is untrue in another way: it promises that search-hole filters the host's built-in search, and it points at `/search-hole:searxng`, a Claude Code command. *Fixed in `c827206`.*

### Should fix

- [x] **6. Four engines are offered that don't exist.** `exa`, `mojeek`, `kagi` and `marginalia` are in the `search` tool's `engines` list, in `keys status`, `help keys` and `uninstall`. Only `searxng`, `brave` and `tavily` have adapters. *Fixed in `af36631`.*
- [x] **7. A `--project` rule prints success and does nothing until `searchhole trust`.** No hint is given. The dashboard's "Project" scope has the same problem and a second one: it writes into the folder the dashboard was started from, not the project you are in (`packages/search-hole/src/app/rules.ts:319`). Simplest fix: remove Project from the dashboard form. *Fixed in `759279f`.*
- [x] **8. `lists add` enforces at once in the CLI but starts in Audit in the dashboard** (`packages/search-hole/src/app/lists.ts:551`). Pick Audit for both. *Fixed in `fe29a3e`.*
- [x] **9. `unblock` is a slash command only.** `searchhole unblock x` answers "Did you mean searchhole block?", the opposite action. Add the alias. *Fixed in `fe29a3e`.*
- [x] **10. Imported lists can smuggle in a match-everything rule.** `*://*/*`, `/.*/`, `://` and similar pass the check that stops `*` (`packages/search-hole/src/lists/import/ublacklist.ts:188`, `abp.ts:137`). An allow-everything line would un-hide every other list's blocks. A user's own allow still wins. Fix: test each pattern rule against a few unrelated URLs and skip the ones that match all. *Fixed in `7a664a5`.*
- [x] **11. Lists in search-hole's own format turn scoped and expired rules into permanent ones** (`packages/search-hole/src/lists/import/searchhole.ts:30`). *Fixed in `7a664a5`.*
- [x] **12. One slow health check makes a running dashboard undiscoverable** (`packages/search-hole/src/ui/run.ts:73` deletes `ui.json` without checking the process is dead). *Fixed in `ac8bb7f`.*

### Small

- [x] **13.** `POST /api/settings` accepts inherited names such as `constructor` and writes a junk key (`packages/search-hole/src/app/dashboard.ts:120`); a `null` body returns 500. *Fixed in `759279f`.*
- [x] **14.** `setup codex --env` replaces `env_vars` where the other apps merge (`packages/search-hole/src/cli/setup.ts:1160`); one-line JSON configs lose precision on very large numbers (`:821`). *Fixed in `0ff1c97`.*
- [x] **15.** `explain` doesn't show the ×1.45 lift that `official-docs` gives, so ranking is not fully explained. *Fixed in `26a810d`.*
- [x] **16.** `setup generic` prints bare JSON with no next step; `doctor` lists SearXNG twice and calls unconfigured optional engines "unhealthy"; the no-engine error says "run searchhole doctor", and doctor then says "Ready". *Fixed in `badb288`.*
- [ ] **17.** 721 of 760 stored receipts are empty: one is created for every prompt, searched or not. *Left as it is: the rows are tiny and retention removes them after 90 days.*
- [x] **18.** `searchhole uninstall` and the README hardcode `search-hole@search-hole-local`, which will be wrong for installs from the public marketplace. *Fixed in `badb288`.*

## 3. Claims that are false or unproven

### In the launch drafts

- [x] **"Nothing calls home."** False by default: lists refresh about weekly from `raw.githubusercontent.com` (`lists.autoUpdate` defaults to true; the test machine's lists were checked on 2026-11-09). Say so, and name the setting that turns it off.
- [x] **"The log, rules and keys stay on your machine."** Blocked sites are sent with each search as an exclude list, to Claude's search and to Tavily and Brave. `docs/rules.md` already admits it.
- [x] **The opening story** ("it kept citing SEO copies of Stack Overflow…"). The usage data above doesn't show it. Open with what the data does show.
- [x] **Receipt warnings "stale, single source, no official source".** A receipt carries only a stale count. The other two are `search` warnings at depth `deep`, with an engine.
- [x] **"The receipt says so" when hooks fail open.** No receipt line is written when the gateway is down.
- [x] **"Node 22+".** The floor is 22.19.
- [x] **"2–7 ms overhead".** Measured once, for the Bash and Write guard only. Nothing covers the search path.
- [x] **"No scraping of search engines".** The recommended engine, SearXNG, scrapes upstream engines.
- [x] **"Real publish dates".** 8 of 40 opened pages got one, and built-in mode has none until a page is opened.
- [x] **`npx search-hole …` and `/plugin marketplace add baselissmail/search-hole`.** Neither exists until the first release.
- [x] **`npx search-hole searxng up  # optional`** in the r/LocalLLaMA draft. For a local model it is required: there is no built-in search to fall back on.
- [x] **"Block this site" button.** The label is "Block a site…", and it shows only when a page was opened.
- [x] `directories.md` still says the Cursor and Codex plugins are blocked; both are built.

### In the README and docs

- [x] **Status line says "v0.1, a test build".** The version is 0.3.0.
- [x] **The quickstart is a source build and skips installing dependencies**, so a fresh clone fails at step 1. After the release, lead with the two marketplace commands.
- [x] **No image.** The launch checklist asks for a hero GIF.
- [x] `searchhole search "…" --explain` is shown as the first thing to try; without an engine it exits with an error.
- [x] The receipt example doesn't match the real line (`… (2 built-in) · … · receipt rcpt_…`).
- [x] `setup` "previews the change": it only names the file and asks. The content shows with `--dry-run --json`.
- [x] "Claude Code 2.1.296 or newer": filtering was verified on 2.1.312 only.
- [x] Tavily "1,000 searches a month": search-hole's own default cap stops at 900 a month and 300 a day, and no doc says so.
- [x] "Every result" is logged: Brave results are logged as site and decision only.
- [x] `docs/rules.md`: the regex example doesn't match what it implies; rules "live in `~/.searchhole/`" is macOS only; "official lists only mark sources" (they also lift them); lists refresh "weekly" (sooner if the list asks).
- [x] `docs/dashboard.md`: "Your dogfooding finding" speaks to the author; "new subscriptions start in Audit" is true in the dashboard only.
- [x] `ARCHITECTURE.md`: names an Exa engine, wrong folder names, "four hooks" (there are five events), and three things that don't exist: a 300 ms startup budget, plugin evals, and nightly live engine checks.

## 4. Never tested for real

- [ ] The release zip installed the way a user gets it (the dry-run rehearsal in `docs/release.md` §3).
- [ ] A clean machine or user account with no Node, no data and no keys.
- [ ] Claude Desktop extension (`.mcpb`), on macOS and Windows.
- [ ] Codex, Cursor, VS Code, Windsurf, Zed and Goose: each config was checked for shape, never loaded by the real app.
- [ ] Windows on a real machine (CI only).
- [ ] Engines mode in daily use.
- [ ] The dashboard with two weeks of real data. It could not be viewed in this review: the browser tool was not connected.

For the announcement, either test an app or label it "untested" in the README. Claude Code is the only client with real use behind it.

## 5. What is solid

- 2,612 tests pass locally (2 skipped); lint, types and layer checks are clean; the bundle smoke test passes.
- CI passed on Linux, macOS and Windows at `e54dc07`.
- No known vulnerabilities in production dependencies; only patch-level updates are waiting.
- Bundle sizes are inside their budgets (dashboard 94%, CLI 92%).
- Reviewed and found sound: dashboard sign-in, Host and Origin checks, body limits, static file serving and security headers; no key values in any API response; HTTPS-only list fetching with size and time limits; importers keep path rules narrow; a user's allow, pin and block beat any list; `setup` for all eight apps keeps comments and other servers, backs up first and writes atomically; the receipt card's buttons can't be pressed by the model.

## 6. Repository housekeeping

- [ ] Delete the stray `.searchhole.yaml` in the repo root (a reviewer's probe wrote it; it is untracked and untrusted, so it has no effect).
- [x] CodeQL and Scorecard fail every week while the repo is private. *Both run now that the repository is public. The runs that failed to start were a billing lock on the account while it was private.*
- [x] The installed local plugin was built before the last source commit. *Rebuilt on 2026-11-14 with everything below.*
- [x] Fill in `docs/dogfood.md` daily from now on, or drop the 14-day gate from `docs/release.md`. *The two weeks are filled in from the log; daily notes start now.*
- [ ] One-time setup in `docs/release.md` step 0: signing key, npm trusted publishing, environments.

## Suggested order

1. Fix defects 1 to 5, then 6 to 12.
2. Build the review list and the opened / seen / hidden labels.
3. One week of use with an engine on, writing the dogfood log.
4. Rewrite the README and the launch drafts from that week's evidence.
5. Rehearse the release, test on a clean machine, test or label each client.
6. Release, then announce in one place first.
