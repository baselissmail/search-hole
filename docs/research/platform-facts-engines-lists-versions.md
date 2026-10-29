# Platform facts: npm versions, engines, seed lists, regex, key storage, dates

> Verified 2026-10-29 against live primary sources: the npm registry, the GitHub API, official pricing and terms pages, upstream source code and local man pages. The scope is MASTER_PLAN §3, §4, §5.2, §6, §7, §12.1, §12.4, §13 and §15.A–C. Anything I could not reach first-hand is marked *unverifiable*, and secondary sources are named as such.
> Method notes:
> - npm: `npm view <pkg> version time dist-tags.latest`. The tables give the publish date of the `latest` version, not `time.modified`, because `time.modified` also moves on prerelease publishes.
> - GitHub: `gh api repos/<o>/<r>`.
> - Terms pages: read with WebFetch or curl. The Exa ToS PDF was decoded with a stdlib-only ToUnicode extractor because no PDF tools are installed.
> - V8 regex: tested on the local Node 24.14.1. Nothing was run from `research/refs/`.

---

## 1. npm versions (§15.A, §8.2, §12.1)

48 packages checked. **43 match and 5 have moved by a patch or minor version** (all published 2026-10-28/29). Nothing regressed or was deprecated.

| Claim (as in plan, §15.A) | Status | Current fact (latest · published) | Source | Impact on search-hole |
|---|---|---|---|---|
| `@modelcontextprotocol/server` 2.4.0 | confirmed | 2.4.0 · 2026-10-23 · Apache-2.0 | npm registry | none |
| `@modelcontextprotocol/ext-apps` 2.0.4 | confirmed | 2.0.4 · 2026-10-27 · MIT | npm | none |
| `@anthropic-ai/mcpb` 2.1.2 | confirmed | 2.1.2 · 2025-12-04 · MIT | npm | none |
| typescript 7.0.2 | confirmed | 7.0.2 · 2026-07-08 | npm | none |
| @biomejs/biome 2.6.3 | **changed** | **2.6.4** · 2026-10-28 (2.6.3 was 2026-10-24) | npm | pin 2.6.4 |
| eslint 10.13.0 | confirmed | 10.13.0 · 2026-10-16 | npm | none |
| vitest 5.0.5 | confirmed | 5.0.5 · 2026-10-15 | npm | none |
| @playwright/test 1.64.1 | confirmed | 1.64.1 · 2026-10-14 | npm | none |
| @axe-core/playwright 4.14.0 | confirmed | 4.14.0 · 2026-10-15 · **MPL-2.0** | npm | dev-only; MPL is fine for a test dependency |
| fast-check 4.10.2 | confirmed | 4.10.2 · 2026-09-19 | npm | none |
| zod 4.6.7 | confirmed | 4.6.7 · 2026-10-12 | npm | none |
| hono 4.13.14 | confirmed | 4.13.14 · 2026-10-25 | npm | none |
| @hono/node-server 2.1.5 | confirmed | 2.1.5 · 2026-10-13 | npm | none |
| pino 10.4.0 | confirmed | 10.4.0 · 2026-10-02 | npm | none |
| undici 8.12.3 | confirmed | 8.12.3 · 2026-10-19 | npm | see §8 (custom `lookup` works) |
| ipaddr.js 2.5.0 | confirmed | 2.5.0 · 2026-08-04 | npm | see §8 |
| yaml 2.9.1 | confirmed | 2.9.1 · 2026-09-11 · ISC | npm | none |
| pnpm 12.16.1 | confirmed | 12.16.1 · 2026-10-27 | npm | none |
| tsdown 0.23.3 | **changed** | **0.23.4** · 2026-10-29 | npm | pin 0.23.4 (still 0.x, so expect churn) |
| tsup 9.0.0 | confirmed | 9.0.0 · 2026-10-14 | npm | none |
| @changesets/cli 3.0.3 | confirmed | 3.0.3 · 2026-09-14 | npm | none |
| release-please 17.11.2 | confirmed | 17.11.2 · 2026-08-24 | npm | none |
| knip 6.43.0 | confirmed | 6.43.0 · 2026-10-24 | npm | none |
| better-sqlite3 13.0.3 | confirmed | 13.0.3 · 2026-08-05 | npm | none |
| drizzle-orm 0.45.4 | confirmed | 0.45.4 · 2026-10-08 | npm | none |
| kysely 0.29.7 | confirmed | 0.29.7 · 2026-10-17 | npm | none |
| metascraper-date 5.58.4 | confirmed | 5.58.4 · 2026-10-09 · MIT (the `metascraper` core is 5.58.5) | npm | **pulls in the native `re2`**, see §7 |
| robots-parser 3.0.1 | confirmed | 3.0.1 · **2023-02-21** (no release since) | npm | see §8 |
| react 19.3.1 | confirmed | 19.3.1 · 2026-10-14 | npm | none |
| vite 8.3.5 | confirmed | 8.3.5 · 2026-10-21 | npm | none |
| @vitejs/plugin-react 6.1.2 | confirmed | 6.1.2 · 2026-10-05 | npm | none |
| @tanstack/react-router 1.170.46 | confirmed | 1.170.46 · 2026-10-22 | npm | none |
| @tanstack/react-query 5.105.0 | confirmed | 5.105.0 · 2026-10-26 | npm | none |
| @tanstack/react-table 9.3.1 | confirmed | 9.3.1 · 2026-10-12 | npm | none |
| @tanstack/react-virtual 3.14.23 | **changed** | **3.14.24** · 2026-10-29 | npm | patch bump |
| tailwindcss 4.3.3 | confirmed | 4.3.3 · 2026-07-16 | npm | none |
| shadcn 4.23.0 | confirmed | 4.23.0 · 2026-10-27 | npm | none |
| @base-ui/react 1.9.0 | confirmed | 1.9.0 · 2026-10-09 | npm | none |
| recharts 3.10.1 | confirmed | 3.10.1 · 2026-07-25 | npm | none |
| uplot 1.6.32 | confirmed | 1.6.32 · 2025-03-14 (no release in 19 months) | npm | stable but quiet; fine for sparklines |
| motion 14.7.1 | **changed** | **14.8.0** · 2026-10-29 | npm | minor bump |
| cmdk 1.1.1 | confirmed | 1.1.1 · 2025-03-14 | npm | quiet; fine |
| sonner 2.0.8 | confirmed | 2.0.8 · 2026-08-09 | npm | none |
| geist 1.8.2 | confirmed | 1.8.2 · 2026-10-21 · **SIL OFL** | npm | font licence: keep a NOTICE entry |
| lucide-react 1.63.0 | **changed** | **1.64.0** · 2026-10-29 · ISC | npm | minor bump |
| storybook 10.6.5 | confirmed | 10.6.5 · 2026-10-27 | npm | none |
| preact 11.1.0 | confirmed | 11.1.0 · 2026-10-27 | npm | none |
| vite-plugin-singlefile 2.3.4 | confirmed | 2.3.4 · 2026-10-17 | npm | none |

**Related packages the plan names without versions:**

| Claim | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| §3: SDK v2 `client` and `core` are 2.4.0; adapters `node`/`hono`/`express` | confirmed | client 2.4.0, core 2.4.0 (2026-10-23); **node 2.1.2**, **hono 2.0.2**, **express 2.0.2** (adapters version on their own line); legacy `@modelcontextprotocol/sdk` 1.32.2 (MIT) | npm | pin adapters separately; don't assume they share the core's version |
| §4 option (b) `bun build --compile` | info | bun 1.4.4 (GitHub release 2026-10-22) | npm, GitHub releases | current Bun line for the runtime ADR |

## 2. Node runtime (§3, §4, §12.1)

| Claim | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| §12.1 "Develop on Node 26 (LTS from late Oct 2026; check its exact status)" | confirmed | **v26.13.0, released 2026-10-28, is the first LTS ("Lithium").** Active LTS until 2027-10-20, end of life 2029-04-30. V8 14.6 | nodejs.org/dist/index.json; github.com/nodejs/Release schedule.json | Node 26 is safe as the development baseline |
| §12.1 "Support at least Node 22 and 24 (both still in security maintenance)" | confirmed | 22 (Jod) has been in maintenance since 2025-10-21, EOL 2027-04-30 (latest 22.23.4). 24 (Krypton) has been in maintenance since **2026-10-20**, EOL 2028-04-30 (latest 24.22.2). 20 reached EOL on 2026-04-30 | same | Node 22's EOL lands about 6 months after v1, so plan to drop it in 2027 |
| §3 "Node 20+ required" (SDK) | info | Node 20 is EOL | same | set `engines` to `>=22` |

## 3. Search engine APIs (§5.2, §7, §13)

| Claim (§) | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| §5.2 SearXNG "Must enable `json` in `search.formats` or requests get 403" | confirmed | Default `search.formats: [html]`. `webapp.py:654` has `if output_format not in settings['search']['formats']: flask.abort(403)`. Same at upstream HEAD on 2026-10-29 | `research/refs/searxng` @ c360868 `searx/settings.yml:84-86`, `searx/webapp.py:649-655`; GitHub contents API at HEAD | ship our own `settings.yml` with `formats: [html, json]`; `doctor` maps 403 to "enable json" |
| §5.2 / §5.1 SearXNG limiter vs API clients (lead from searxng.md) | confirmed | `botdetection/ip_limit.py`: `API_WINDOW = 3600`, `API_MAX = 4` (non-HTML formats), `BURST_MAX = 15`, `LONG_MAX = 150`. Defaults are `server.limiter: false` and `public_instance: false` | same refs and upstream HEAD | a public or limiter-enabled instance allows only **4 JSON requests per hour per IP**. Local bundled instance: limiter off. `doctor` maps 429 to "limiter on" |
| §5.2 SearXNG "AGPL, but calling it over HTTP is fine" | unverifiable (legal reading) | AGPL-3.0-or-later. We don't modify or distribute SearXNG code; we only ship a compose file that pulls the upstream image | searxng.md, LICENSE | low risk; don't vendor SearXNG code |
| §5.2 Brave "Free tier removed Feb 2026; $5/month credit (~1k queries), then $5 per 1k" | confirmed (with nuance) | Brave's own post (2026-02-12, updated 2026-06-25 and 2026-09-17): "Every plan gets $5 of free credit that renews every month". Search costs $5 per 1k requests at 50 QPS. Answers costs $4 per 1k plus $5 per M tokens. **The credit requires attributing the Brave Search API on your project's website or about page**, and a card on file (community reply). Brave pages don't mention the old free plan; that it was removed comes from third-party trackers | brave.com/blog/most-powerful-search-api-for-ai/; brave.com/search/api/; community.brave.app thread 656627; (secondary) implicator.ai, agentdeals.dev | `doctor` and the docs must say "card required; $5/month credit needs attribution". Enforce spend caps (§5.1) |
| §5.2 Brave `goggles`, `freshness`, `page_age` | confirmed | `goggles` takes a URL **or inline** definition, and "multiple goggles can be combined". `freshness` takes `pd`/`pw`/`pm`/`py` or `YYYY-MM-DDtoYYYY-MM-DD`. `count` ≤ 20, `offset` ≤ 9. `web.results[].page_age` is an ISO datetime with no timezone (Brave's own skills repo; the dashboard docs page doesn't show it) | api-dashboard.search.brave.com/app/documentation/web-search/query; github.com/brave/brave-search-skills `skills/web-search/SKILL.md:142` (repo pushed 2026-10-29) | inline-goggle compile works. `offset ≤ 9` with `count ≤ 20` limits how deep we can over-fetch. Treat `page_age` as "published or modified" (medium confidence) |
| §5.2 Brave "Storing results may require a storage-rights plan, so cache briefly" | confirmed | ToS (last updated 2026-09-01) §3(b)(i): may not "store, cache, or create a database of Search Results, in whole or in part", except "transient storage required for operation of Customer Applications". §13(c)(ii): destroy on termination. §3(b)(xiii): no training or benchmarking of AI models. Pricing FAQ: storing is allowed "with a plan that includes storage rights" (which plans isn't stated) | api-dashboard.search.brave.com/terms-of-service; brave.com/search/api/ FAQ | Brave adapter retention defaults to transient: store decisions, counts and URL hashes, not titles or snippets, unless the user declares a storage-rights plan |
| §5.2 Kagi "About $12 per 1k; applies the account's personalization. Check whether it's still preview" | confirmed; **still public preview** | Search costs **$12 per 1k requests** and Extract **$4 per 1k pages**, pay-as-you-go. New **v1** API at `https://kagi.com/api/v1` (`POST /search`); "v0" is being replaced. "The Search API inherits settings from your account" (block/raise personalization). Changelog 2026-05-21: "making the Kagi Search API preview publicly available" (subscribers got $5 in credits). No GA entry through the 2026-10-16 changelog. API ToS (effective 2026-09-22): may not "store, cache, or build a database of Results beyond the transient caching needed"; explicitly **allows "sending Results to an AI model to answer your users' queries"** | kagi.com/api/pricing; kagi.com/api/docs; help.kagi.com/kagi/api/search.html; kagi.com/changelog (us-west mirror); kagi.com/privacy/api | target v1, not v0. Mark the adapter "preview". Retention is transient. Kagi's personalization can **double-apply** with our rules: tell users |
| §5.2 Tavily "1k free credits/month" | confirmed | Researcher plan: free, 1,000 credits/month, no card. PAYG $0.008/credit. Project plan $30/mo for 4k credits. Search depth `basic`/`fast`/`ultra-fast` costs 1 credit, `advanced` 2 | tavily.com/pricing; docs.tavily.com/documentation/api-credits; docs.tavily.com/.../endpoint/search | adapter defaults to `basic` |
| §5.2 Tavily "**Its terms forbid storing or caching results**" | **changed** | The plan's cited source **tavily.com/policy now returns 404**. The current **Tavily Platform Terms of Service (last updated 2026-05-04)** at tavily.com/terms have **no caching or storage clause**. Restrictions that remain: use "solely for Customer's internal business purposes" (§2), no resale or redistribution (§3.2(ii)), no data mining or robots (§3.2(viii)), no using AI-functionality Output to build competing models (§6.6(i)). The old "Search API Agreement" required eliminating API Materials at termination (secondary snippet only) | curl of tavily.com/policy (404) and tavily.com/terms; WebFetch of tavily.com/terms | we may keep a local receipt log for personal use. Keep the per-adapter retention policy anyway (conservative default: no snippet retention beyond the receipt TTL). Update §15.C's link to tavily.com/terms |
| §7 Tavily `published_date` | confirmed (with condition) | Returned "only when `include_published_date` is `true` (automatically enabled when `topic` is `news`)". `include_domains` max 300, `exclude_domains` max 150. `time_range` d/w/m/y; `start_date`/`end_date` as YYYY-MM-DD. `max_results` ≤ 20 | docs.tavily.com/documentation/api-reference/endpoint/search | always send `include_published_date: true` |
| §5.2 Exa "Gives `publishedDate`" | confirmed | `publishedDate`: "An estimate of the creation date, from parsing HTML content. Format is YYYY-MM-DD" (optional). Filters: `startPublishedDate` and `endPublishedDate`; crawl-date filters are deprecated and ignored. `includeDomains`/`excludeDomains` max 1,200 each. `numResults` ≤ 100. Types: `auto` (default), `lite`, `deep-lite`, `deep` (`fast`/`instant` are legacy) | exa.ai/docs/reference/search (OpenAPI) | date confidence is medium ("estimate"). Use `auto` or `lite` |
| §5.2 Exa "only temporary caching allowed" | confirmed (stricter than stated) | Exa ToS, "Restrictions On Your Use": you may not "download, modify, copy, distribute … reproduce, duplicate, publish … any information … obtained from or through, the Services, **except for temporary files that are automatically cached by your web browser for display purposes**, or as otherwise expressly permitted in these Terms or by us in writing". I could not extract a "Last Revised" date | exa.ai/terms (PDF, decoded locally) | Exa adapter retention is **none** by default: store only decisions, counts and URL hashes. Ask Exa in writing whether a local receipt log is allowed (open question) |
| §5.2 Exa pricing (not in plan) | info | Search costs $7/1k (`auto`/`fast`, up to 10 results), $4/1k (`lite`/`instant`) or $12/1k (deep), plus $1/1k for each extra result. Contents cost $1/1k pages per content type. Free tier: $10 credit that resets monthly, no card | exa.ai/pricing | spend-cap defaults |
| §5.2 Mojeek "`fi`/`fe`, date params; cache allowance depends on plan" | confirmed | `fi`/`fe` take comma-separated domains, **max 25 each**. `since`/`before` take `day`/`month`/`year`/`YYYYMMDD`. `datewr=100` ranks by date. `date=1` includes "the last modified date as recognised by Mojeek". Plans: **Startup £2/1k** (5 QPS, 100k/day, ≤10 results, "cache results for one hour"); **Business £3/1k** (10 QPS, 400k/day, ≤40 results, storage rights for "indefinite data retention"); Enterprise is custom. "We don't require attribution." A card is needed; there's a free credit of unstated size | mojeek.com/support/api/search/request_parameters.html; mojeek.com/services/search/web-search-api/ | compile at most 25 domains into `fi`/`fe` and filter the rest locally. Mojeek's `date` is **last-modified**, so label it that way, not "published". Retention: 1 h on Startup |
| §5.2 / §13 Marginalia "Small-web, non-commercial key" / "shared public key for non-commercial use" | confirmed (expanded) | Shared key **`public`**: "cannot create custom filters, and often hits a rate limit" (old API: shared limit, HTTP 503 when hit). A free non-commercial key comes by email. A paid non-commercial key is a one-time payment. **A metered commercial key now exists** ("no commercial usage restriction or attribution requirement"). Non-commercial keys are "Provided under **CC-BY-NC-SA 4.0**". New endpoint `api2.marginalia-search.com` with an `API-Key` header (`api.marginalia.nu` is deprecated). The response has a `license` field and **no date field** (page updated 2025-12-08) | about.marginalia-search.com/article/api/ | as the no-key fallback it works but is unreliable (503s), so treat 503 as quota. Receipts must carry CC-BY-NC-SA attribution, and search-hole itself must not be commercial when using it |
| §5.2 Serper / SerpApi "Google results; check terms" | confirmed (checked) | **Serper** ToS (2024-05-29): no caching clause, B2B only, "download the materials … for as long as your use case requires", no as-is mirroring. **SerpApi** legal page (2026-08-27): no caching clause; they retain search data 31 days (ZeroTrace mode avoids that); no reproducing or reselling the Service; "U.S. Legal Shield" excludes the Free, Starter and Developer plans. **Google sued SerpApi under the DMCA on 2025-12-19.** A reported dismissal with leave to amend on 2026-07-20 is unconfirmed (single blog) | serper.dev/terms; serpapi.com/legal; theregister.com 2026-02-21; mjtsai.com 2025-12-24; (secondary) octoparse | keep both optional and off by default. Docs should mention the legal risk around scraping Google |
| §5.2 DuckDuckGo "No official API; terms and breakage risk" | confirmed | No official web-results API. The Instant Answer API "is not a full search results API" (third-party mirror of DDG's text; DDG's own docs page now redirects). The Python **`ddgs` 9.16.1** (2026-10-23, MIT) **is now a multi-backend metasearch scraper** (bing, brave, duckduckgo, google, grokipedia, mojeek, startpage, yandex, yahoo, wikipedia), disclaimer "for educational purposes only". The old `duckduckgo-search` 8.1.1 (2025-07-06) was renamed. The JS `duck-duck-scrape` 2.2.7 hasn't been released since 2025-01-09 | PyPI JSON; github.com/deedy5/ddgs README; npm; (secondary) web search | keep it off. A JS adapter would mean our own scraper (fragile) or a Python sidecar. Not a good no-key default |

## 4. Seed lists (§6, §15.B)

Rule counts are non-comment, non-blank lines in the main uBlacklist-format file, counted on 2026-10-29.

| Claim (§15.B) | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| NotaInutilis/Super-SEO-Spam-Suppressor: ~418k, WTFNMFPL, 2026-10-28, subscribe | confirmed | LICENSE is "DO WHAT THE FUCK YOU WANT TO BUT IT'S NOT MY FAULT PUBLIC LICENSE v1" (GitHub reports `NOASSERTION`). Pushed **2026-10-29** (updated daily). `ublacklist.txt` **417,684** rules, 0 regex. `domains.txt` 416,974 | gh api repos + contents/LICENSE; raw file | permissive. Precompiled matcher needed (plan §4). Subscribe, because of size |
| laylavish/uBlockOrigin-HUGE-AI-Blocklist: ~1.7k, CC0, 2025-10-02 | confirmed | CC0-1.0, pushed 2025-10-02. `list_uBlacklist.txt` **1,674** rules, of which **92 are regex** (`/pinterest.+\/user/`), **all RE2-compatible** (no lookarounds or backrefs). `list.txt` (uBO) 3,333 | gh api; raw file | bundle OK. Exercises the regex path |
| alvi-se/ai-ublock-blacklist: ~2.8k, GPL-3.0, subscribe only | confirmed | GPL-3.0, pushed 2026-10-28, `ublacklist.txt` **2,767** | gh api; raw | subscribe only |
| popcar2/BadWebsiteBlocklist: ~420, CC0 | confirmed | CC0-1.0, pushed 2026-10-10, **423** | gh api; raw | bundle OK |
| quenhus/uBlock-Origin-dev-filter: ~625, Unlicense, 2025-04-24 | confirmed (count differs) | Unlicense, pushed 2025-04-24. `data/*.txt` total **710** domains (SO 535, GitHub 88, Wikipedia 46, SEO 39, npm 2) | gh api; raw | bundle OK |
| arosh/ublacklist-stackoverflow-translation: ~139, CC0 | confirmed | CC0-1.0, pushed 2025-07-26, **139**. Ships `evidence.md` | gh api; raw | bundle OK. Its evidence file is a model for our CONTRIBUTING |
| arosh/ublacklist-github-translation: ~35, CC0 | confirmed | CC0-1.0, pushed 2025-07-26, **35** | gh api; raw | bundle OK |
| rjaus/ublacklist-pinterest: ~50, CC0 | confirmed | CC0-1.0, pushed 2025-02-23. `ublacklist-pinterest.txt` **54** (4 variant files) | gh api; raw | bundle OK |
| elliotwutingfeng/SpamdexingSites: ~3.7k, BSD-3 | confirmed | BSD-3-Clause, pushed 2026-01-29, `blocklist.txt` **3,685** | gh api; raw | bundling OK with notice (plan says subscribe) |
| insomnimus/seo-garbage: ~260, Apache-2.0 | confirmed | LICENSE text is Apache 2.0 (GitHub `NOASSERTION`), pushed 2026-10-27, `list.txt` **261** | gh api; contents/LICENSE | bundle OK with NOTICE |
| ncaq/uBlacklistRule: ~7.8k, MIT, 2026-09-27 | confirmed (newer) | MIT, pushed **2026-10-29**, `uBlacklist.txt` **7,786** | gh api; raw | subscribe |
| danny0838/content-farm-terminator: "repo GPL-3.0 / lists 'mostly MIT'", 2026-07-27, check before use | **resolved: still ambiguous, so subscribe by URL only** | The repo licence is GPL-3.0 (`main` = browser extension). The lists live on the **`gh-pages` branch, which has no LICENSE file**. Its README says: "The blacklists are mostly released under MIT license, but you may have to check the underlying license of the sources for aggregated contents." Last `gh-pages` commit **2026-10-25**. `src/blocklist/content-farms.txt` has **15,597** rules (plus nearly/extra/scam/fake-news/sns lists). **Three are regex, and one uses a negative lookahead `(?!www\.)`, which RE2 can't compile** | gh api (branches, gh-pages README, config.yaml, content-farms.txt) | **don't bundle** ("mostly", with per-source caveats). Subscribe by URL. The importer must reject or skip non-RE2 regex rules and report them |
| Brave public Goggles: no license, link only | confirmed | brave/goggles-quickstart: no licence, pushed 2026-04-22 | gh api | link only |
| "Avoid wdmpa/content-farm-list (no license, stale)" | confirmed | No licence, last push 2024-01-10 | gh api | avoid |
| "More: ublacklist.github.io/rulesets" | confirmed | Live (HTTP 200): "Community Rulesets … independently created and maintained by individual users, not endorsed or verified" | curl | fine as a discovery link |

## 5. Linear-time regex in JS (§6 "Regex safety")

| Claim (§6) | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| "regex rules … run on a linear-time engine (RE2-style, e.g. a WASM build)" | changed (prefer pure JS) | **re2js 2.9.1** (2026-10-28, MIT, **zero deps**, 51 releases since 2023-07, 4 in Oct 2026, 0 open issues) is a pure-JS port with "full architectural parity with the Go regexp implementation". It has DFA/NFA tiers, a **`RE2Set`** (many patterns in one pass), `test()`/`exec()`/`matchAll()` mirroring the JS API, and an optional `LOOKBEHINDS` flag for captureless lookbehinds. No lookaheads or backrefs. The author's own benchmark claims 4–15× faster than native `re2` on 30k short strings (FFI overhead; vendor claim, not reproduced) | npm; github.com/le0pard/re2js README | **use re2js** in core: no native module, and it works under Node and Bun. `RE2Set` fits the "separate regex set" in the precompiled matcher (§4) |
| WASM build (re2-wasm) | wrong (stale) | **re2-wasm 1.0.2 last published 2022-05-14**; repo last push 2023-04-10 | npm; gh api google/re2-wasm | don't use |
| Native `re2` | confirmed (native) | re2 1.27.0 (2026-09-26, BSD-3). Install script: `install-from-cache … \|\| node-gyp rebuild` (downloads a prebuilt from GitHub, otherwise compiles). `engines: ^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | npm view re2 | avoid (native plus install-time network download) |
| V8 linear engine (`l` flag) as an alternative | confirmed (experimental only) | V8 main (flag-definitions.h, 2026-10-29) still has `DEFINE_EXPERIMENTAL_FEATURE(enable_experimental_regexp_engine, "recognize regexps with 'l' flag …")`, default off. **Tested on Node 24.14.1:** `new RegExp(x,'l')` throws "Invalid flags" without the flag. With `--enable-experimental-regexp-engine`, `/(a*)*b/l` on 50k chars takes 6 ms, and lookahead or backref patterns throw "Cannot be executed in linear time". The flag is **not allowed in `NODE_OPTIONS`**, but works as a CLI argument or via `v8.setFlagsFromString()` at startup. Node 26 (V8 14.6) and 22 were not tested locally; V8 main is unchanged, so same expectation. Bun runs on JavaScriptCore, so no V8 flag | local `node --v8-options` plus tests; github.com/v8/v8 `src/flags/flag-definitions.h` | don't depend on it: experimental, and absent under Bun. Possible later fast path, but re2js stays the baseline |
| "Cap per-rule length and per-list rule count" | n/a (design) | Static ReDoS checkers exist: recheck 4.6.2 (2026-10-26), redos-detector 6.1.4, safe-regex2 5.1.2 | npm | optional lint for user-authored rules. re2js already guarantees linear time |

## 6. OS secret storage (§4 "API keys", §12.4)

| Claim (§) | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| §4 "OS CLI tools such as `security`" (macOS) | confirmed (with caveats) | `security add-generic-password -a <acct> -s <svc> [-U] -w <pw>`; `find-generic-password -a -s -w` prints the password only; `delete-generic-password`. **`-w <pw>` puts the secret in argv** (visible to `ps`). The man page recommends a bare `-w` "at end of command to be prompted", which needs a tty. `security -i` "allow[s] the user to enter multiple commands on stdin", a way to keep the secret out of argv. "By default, the application which creates an item is trusted to access its data without warning", and that application is `/usr/bin/security`, so any same-user process can read the item via `security find-generic-password -w` without a prompt | `man security` (local macOS, Darwin 27) | write through `security -i` over stdin, never argv. Document that keychain storage via the CLI protects at rest, not against other same-user processes |
| §4 "`secret-tool`" (Linux) | confirmed (fragile headless) | `/usr/bin/secret-tool` ships in Debian/Ubuntu **`libsecret-tools`**, a separate package not installed on servers by default. `store` reads the secret **from stdin until EOF** (good). It needs a running Secret Service (gnome-keyring, KWallet, KeePassXC) on the D-Bus session bus. On headless, SSH or container hosts it fails ("Cannot autolaunch D-Bus without X11 $DISPLAY", Ubuntu bug 1420914). Workarounds (dbus-run-session plus `gnome-keyring-daemon --unlock`) are documented as painful | packages.debian.org/trixie/.../libsecret-tools/filelist; manpages.debian.org secret-tool(1); Launchpad bug 1420914; docs.rs/dbus-secret-service | use it when `secret-tool` exists and a probe write+read succeeds. Otherwise fall back to an encrypted or `0600` file with a loud warning. `doctor` reports which store is in use |
| §4 Windows (implied) | confirmed / partly unverifiable | `cmdkey` can **add, list and delete but never prints a stored password**. `ConvertFrom-SecureString` with no key uses **DPAPI** (current user), and "The contents of a SecureString aren't encrypted on non-Windows systems". No built-in Credential Manager *read* cmdlet in Windows PowerShell or pwsh (SecretManagement and CredentialManager are separate gallery modules, *unverified*). Candidates: DPAPI via PowerShell (`ConvertTo-SecureString` then `ConvertFrom-SecureString`) into a `0600` file; `CredRead`/`CredWrite` P/Invoke via `Add-Type`; WinRT `PasswordVault` from Windows PowerShell 5.1 (*unverifiable*, no Windows host) | learn.microsoft.com cmdkey; learn.microsoft.com ConvertFrom-SecureString (7.6, updated 2026-08-10) | **DPAPI file via PowerShell** is the verified zero-native path. PowerShell start-up adds roughly 300–800 ms per call (estimate), so cache the decrypted key per process |
| §4 "a native keyring module" | confirmed (caveat) | **@napi-rs/keyring 2.1.2** (2026-10-19, MIT, wraps keyring-rs; N-API prebuilds for 12 targets incl. musl, arm64, win-arm64, riscv64). **On Linux it tries the Secret Service, then *silently* falls back to the kernel keyutils store, which "will not persist across reboots"**. Pass `{ linux: { store: 'secret-service' } }` to make it throw instead | npm; github.com/Brooooooklyn/keyring-node README and Cargo.toml | if used, always pin `secret-service` on Linux. Otherwise keys "disappear" after a reboot |
| keytar | wrong (dead) | keytar 7.9.0; **atom/node-keytar is archived** (last push 2022-12-12) | gh api; npm | don't use |
| (not in plan) Bun built-in | new | **`Bun.secrets`** (Bun 1.4.4 docs) uses Keychain Services on macOS, libsecret on Linux ("Requires a secret service daemon") and Credential Manager on Windows. "This API is new and experimental" | bun.com/docs/runtime/secrets | if the runtime ADR picks `bun build --compile`, this replaces all three CLI shims (same headless-Linux caveat) |

## 7. Date extraction (§7)

| Claim (§7) | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| "`metascraper-date` 5.58.4, MIT" | confirmed | 5.58.4 (2026-10-09), MIT; repo pushed 2026-10-15 | npm; gh api | — |
| "check its published-vs-modified rule options" | confirmed: **default `date` is modified-first** | `src/index.js`: `date: dateModifiedRules().concat(datePublishedRules(), dateRules())`. With no options the single `date` field returns **JSON-LD `dateModified` / `meta[property*=modified_time]` / `itemprop datemodified` first**, then published (`datePublished`, `dateCreated`, `*published_time`, `itemprop datepublished`, `.publish*`), then generic (`meta[name=date]`, `itemprop*=date`, `time[datetime]`, byline/date/time classes). Options `{ datePublished: true, dateModified: true }` add separate `datePublished` and `dateModified` fields. Identical in the 5.58.4 tarball (unpkg) | github.com/microlinkhq/metascraper `packages/metascraper-date/src/index.js`; unpkg metascraper-date@5.58.4 | **never show the default `date` as "published"**. Enable both options and record both with their method |
| (implied) zero native deps | **wrong for metascraper** | `metascraper-date` → `@metascraper/helpers` 5.58.4 lists **`re2` ~1.27.0 (native, install script)**, **`jsdom` ~30.1.2**, `chrono-node`, `tldts`, `normalize-url` and ~20 more as hard `dependencies`. At runtime `re2` is optional (`url-regex-safe` falls back to `RegExp`; `METASCRAPER_RE2=false` disables it), and `jsdom` is only used by `load-iframe`. Rules also need the `metascraper` core (cheerio) | npm view; unpkg @metascraper/helpers@5.58.4 src/index.js; url-regex-safe@4.0.0 lib/index.js | either bundle with `re2`/`jsdom` external and `METASCRAPER_RE2=false`, or **write our own ~15-selector extractor** over htmlparser2 or parse5 (credit metascraper, MIT). The second keeps the zero-native goal and the bundle small |
| "htmldate (F1 ≈ 0.95 on its own benchmark)" | confirmed | htmldate **1.11.0** (PyPI 2026-10-02, Apache-2.0, repo pushed 2026-10-21). README table: `htmldate[all] 1.11.0 (extensive)` F-score **0.949**, `(fast)` 0.926 | PyPI JSON; github.com/adbar/htmldate README | still optional (Python sidecar, later) |
| (alternatives) | info | **chrono-node 2.10.3** (MIT, 2026-10-12; text dates such as "3 days ago" or "Oct 5, 2024"); **@extractus/article-extractor 9.0.1** (MIT; deps @mozilla/readability 0.6.0 and linkedom); parsers **htmlparser2 12.0.0**, **parse5 8.0.1**, **linkedom 0.18.14**, **cheerio 1.2.0**. `@mozilla/readability` 0.6.0 hasn't been released since 2025-03-03 | npm | own extractor = htmlparser2 (or parse5) + JSON-LD walk + chrono-node for text dates |
| Engine-provided dates, best first | confirmed (with labels) | Brave `page_age` (ISO, "published or last modified" per the freshness doc); Exa `publishedDate` ("estimate of the creation date"); Tavily `published_date` (needs `include_published_date`); Mojeek `date=1` (**last-modified**); SearXNG `publishedDate` (nullable); Marginalia none | §3 table above | store `date_kind` (published/modified/unknown) plus `method` and `confidence` per result |

## 8. Safe-fetch libraries (§12.4)

| Claim (§12.4) | Status | Current fact | Source | Impact |
|---|---|---|---|---|
| "`request-filtering-agent` with `got`" | confirmed | request-filtering-agent **3.2.1** (2026-06-29, MIT, `engines node >=20`, dep `ipaddr.js ^2.1.0`; repo pushed 2026-09-29). It's an `http(s).Agent` that checks the DNS-resolved IP (stops DNS rebinding), with options `allowPrivateIPAddress`, `allowMetaIPAddress`, `allowIPAddressList` and `denyIPAddressList`. README: "Node.js's built-in `fetch` does not support `http.Agent`" (undici support is still issue #23). Support table lists Node 20/22. got **16.1.0** (2026-10-13) | npm; github.com/azu/request-filtering-agent README | works with got; not with undici or fetch |
| "or an undici `connect.lookup` with `ipaddr.js`" | confirmed | undici 8.12.3 `lib/core/connect.js` spreads `...options` into `tls.connect()`/`net.connect()`, so a custom `lookup` is honoured. It overrides `lookup` only when the host is already an IP literal with a different servername, and **Node skips `lookup` entirely for IP-literal hosts** | unpkg undici@8.12.3/lib/core/connect.js | feasible with no extra dependency. **Also validate IP-literal URLs before connecting**, and re-check on every redirect hop (`maxRedirections: 0` plus a manual loop) |
| `ipaddr.js` 2.5.0 | confirmed | 2.5.0 (2026-08-04, MIT, ships `.d.ts`). The repo is active: 2026-10-25 commits add the **RFC 9780 dummy IPv6 prefix to reserved ranges** and RFC 6874 zone-ID fixes (not released yet). `range()` names include `carrierGradeNat`, `linkLocal`, `uniqueLocal`, `reserved`, `rfc6145`, `rfc6052`, `6to4`, `teredo`, `benchmarking`, `amt`, `as112v6`, `orchid2`, … | npm; gh api commits; unpkg lib/ipaddr.js | use an **allowlist** (`range() === 'unicast'`) rather than a denylist of names. Unwrap IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and NAT64 (`rfc6052`/`rfc6145`) before checking |
| `robots-parser` 3.0.1 | confirmed (quiet) | 3.0.1 is still the latest release, **published 2023-02-21**. The repo still gets dependency bumps, plus a TypeScript `export =` fix on 2026-08-07 that is **not yet released**. README: "aims to be complaint with the RFC 9309 specification"; supports wildcards, `$`, `Crawl-delay`, `isAllowed`/`isDisallowed`/`isExplicitlyDisallowed`. 7 open issues | npm; gh api; README | fine to use (small, MIT). Expect to add a local type shim. Alternative: robots-txt-guard 1.0.2 (2022) is staler |

---

## Key answers

1. **Are the §15.A versions current?** Yes, 43 of 48 match exactly. Five got patch or minor bumps on 2026-10-28/29: biome 2.6.4, tsdown 0.23.4, @tanstack/react-virtual 3.14.24, motion 14.8.0, lucide-react 1.64.0. SDK adapters version separately (node 2.1.2, hono and express 2.0.2). *Confidence: high. Source: npm registry.*
2. **Node status?** Node 26.13.0 became LTS on 2026-10-28. 24 entered maintenance on 2026-10-20, 22 is in maintenance until 2027-04-30, and 20 is EOL. *High. nodejs.org dist index and the Release schedule.*
3. **SearXNG json and limiter?** By default only `html` is enabled, and any other format returns 403 (`webapp.py:654`). With the limiter on, non-HTML API calls are capped at 4 per hour per IP (`API_MAX = 4`). Both checked at upstream HEAD. *High. Source code.*
4. **Brave?** Search costs $5 per 1k at 50 QPS, with a $5 monthly credit (about 1k queries) since 2026-02-12. The credit needs a card on file plus attribution on the project's site. The old free plan isn't offered (third-party sources). `goggles` takes a URL or inline rules, `freshness` takes `pd/pw/pm/py` or a date range, and `page_age` is an ISO datetime. The ToS (2026-09-01) bans storing or caching results beyond transient use; storage needs a "storage rights" plan. *High (pricing, ToS) / medium (free-plan history).*
5. **Kagi?** Still **public preview** (opened to all users 2026-05-21; no GA through 2026-10-16). Search is $12 per 1k on the v1 API, and it inherits account personalization. Terms allow transient caching only, and sending results to an AI model is allowed. *High.*
6. **Tavily?** 1k free credits a month; PAYG $0.008 per credit; basic search costs 1 credit and advanced 2. **The "forbids storing or caching" claim is outdated:** the current Platform ToS (2026-05-04) has no caching clause, and the cited tavily.com/policy URL now returns 404. Use is still limited to internal business, with no redistribution. *Medium-high. tavily.com/terms.*
7. **Exa?** `publishedDate` is an estimated creation date (YYYY-MM-DD). The ToS allows only "temporary files … automatically cached by your web browser" unless Exa permits more in writing, which is stricter than the plan says. Search is $7 per 1k (auto/fast), and the free tier gives $10 a month. *High (fields, price) / medium (ToS date unknown).*
8. **Mojeek?** `fi`/`fe` take at most 25 domains each. `since`/`before` take day/month/year or YYYYMMDD, and `datewr=100` sorts by date. `date=1` returns a *last-modified* date. Prices: £2 per 1k (Startup, 1-hour caching) or £3 per 1k (Business, indefinite storage). No attribution needed. *High.*
9. **Marginalia?** The shared key `public` works with no signup but often hits a rate limit (503s on the old API). Free non-commercial keys come by email under CC-BY-NC-SA 4.0, and a metered commercial key now exists. The endpoint is `api2.marginalia-search.com`. Results have no date field. *High.*
10. **Serper/SerpApi?** Neither has a caching clause. Serper is B2B and allows downloads "for as long as your use case requires". SerpApi forbids reproducing or reselling the Service and is being sued by Google under the DMCA (filed 2025-12-19; current status unconfirmed). *Medium.*
11. **DuckDuckGo?** No official web-results API. Python `ddgs` 9.16.1 is active but is now a multi-engine scraper marked "for educational purposes only". There's no maintained JS equivalent. *High.*
12. **Seed list licences?** All match the plan. Counts and push dates are refreshed in §4 above. Two repos show `NOASSERTION` on GitHub but their LICENSE texts are WTFNMFPL and Apache-2.0. **danny0838:** the repo is GPL-3.0, while the `gh-pages` lists have no LICENSE file and are "mostly MIT", with aggregated sources under their own licences. Subscribe by URL and never bundle. One of its regex rules uses a lookahead that RE2 rejects. *High.*
13. **Linear-time regex without native deps?** Use **re2js 2.9.1**: pure JS, MIT, zero dependencies, actively released, with `RE2Set`. re2-wasm is abandoned (2022). Node `re2` is native. V8's `l` flag is still experimental behind `--enable-experimental-regexp-engine`, which `NODE_OPTIONS` rejects, and is absent in Bun. *High (Node 24 tested; Node 22/26 inferred from V8 main).*
14. **OS secret storage without native modules?**
    - **macOS:** `security` works. Feed it via `security -i` on stdin to keep the key out of argv. Any same-user process can read the item back.
    - **Linux:** `secret-tool` (package `libsecret-tools`, reads the secret from stdin) works only when a Secret Service is running. It fails on headless or SSH hosts.
    - **Windows:** `cmdkey` can't read passwords back. DPAPI via `ConvertFrom-SecureString` (no `-Key`) into a file is the verified path.
    - **Native modules:** @napi-rs/keyring 2.1.2 is healthy but silently falls back to the non-persistent keyutils store on Linux unless pinned to `secret-service`. keytar is archived.
    - **Bun:** `Bun.secrets` is a built-in (experimental) option.

    *High for macOS and Linux; medium for Windows (docs only, no host to test).*
15. **metascraper-date?** 5.58.4, MIT. The default `date` prefers **modified** over published. Pass `{datePublished:true, dateModified:true}` to get both fields. Its helpers package hard-depends on the native `re2` and on `jsdom`. htmldate 1.11.0 scores F ≈ 0.949 on its own benchmark. A good JS alternative is our own selector set over htmlparser2 or parse5, plus chrono-node. *High.*
16. **robots-parser, request-filtering-agent, ipaddr.js?** All maintained.
    - robots-parser: last release 2023-02-21, but the repo is active and an unreleased types fix exists.
    - request-filtering-agent 3.2.1: an `http.Agent` only, so it pairs with got 16, not fetch or undici.
    - ipaddr.js 2.5.0: active, with an unreleased RFC 9780 change.
    - undici: passes a custom `lookup` through, so an undici-native guard is feasible.

    *High.*

## Open questions

- **Brave credit attribution:** does a local, personal search-hole install need to "attribute the Brave Search API in your project's website / about pages" to get the $5 credit? Who is the "project": the user or search-hole? Which plans include "storage rights"?
- **Exa and Kagi terms vs a local receipt log:** is keeping result URLs and titles in a local SQLite receipt for N days "transient"? For Exa only written permission settles it. I also couldn't extract the "Last Revised" date of Exa's ToS (PDF text only partly decoded).
- **Tavily:** is there a separate API usage policy, or a privacy-policy clause, that still restricts caching? The old Search API Agreement is gone from tavily.com/policy.
- **Kagi:** GA date, v0 shutdown date, and whether personalization can be turned off per key so it doesn't double-apply with our rules.
- **Marginalia:** the numeric rate limit on the `public` key on api2, and whether its results also carry CC-BY-NC-SA. The `license` field value wasn't documented.
- **Google v. SerpApi:** current docket status (a 2026-07-20 dismissal with leave to amend is reported by one blog only).
- **Windows:** confirm on a real Windows host that `CredRead`/`CredWrite` via `Add-Type` P/Invoke, or WinRT `PasswordVault` from Windows PowerShell 5.1, work without extra modules. Measure PowerShell start-up cost.
- **`Bun.secrets` on headless Linux:** does it throw or return null with no Secret Service? Does `bun build --compile` embed it on all targets?
- **V8 `l` flag** was not tested on Node 22 or 26 binaries (only 24.14.1 is installed). V8 main says it's unchanged.
- **Brave `page_age`:** the official dashboard docs page doesn't document it, so its semantics come from Brave's skills repo and a freshness-doc paraphrase in brave-search-skills.md. Confirm against a live response in contract tests.

## Implications for ADRs

- [rule-format-precedence] Compile every regex rule (user and list) with **re2js**. Reject lookarounds and backrefs with a per-rule error the importer counts and shows ("1 rule skipped: not linear-time"). Use `RE2Set` to batch a list's regexes into one pass. The danny0838 list will hit this (it has a `(?!www\.)` rule).
- [lists-subscriptions] The bundle set stays as planned (CC0, Unlicense, MIT, BSD-3, Apache-2.0, WTFNMFPL). **danny0838 and alvi-se are subscribe-only.** Store each list's licence string from its LICENSE file, not GitHub's `spdx_id` (two repos show `NOASSERTION`). Super-SEO-Spam-Suppressor is about 418k rules and updates daily, which confirms the need for the precompiled matcher plus ETag.
- [engine-adapter] Per-adapter capability and retention table:
  - **Brave:** inline goggles; `freshness`; `count` ≤ 20 and `offset` ≤ 9; transient retention.
  - **Kagi:** v1 API, preview, transient retention.
  - **Tavily:** `include_published_date: true`; include/exclude domain caps 300/150; local log allowed.
  - **Exa:** `publishedDate` (estimate); domain caps 1,200; retention none.
  - **Mojeek:** `fi`/`fe` ≤ 25; `since`/`before`; `date` is last-modified; retention 1 h (Startup).
  - **Marginalia:** api2 endpoint, `API-Key` header, CC-BY-NC-SA attribution, 503 means quota.
  - **SearXNG:** 403 means json is off; 429 means the limiter is on.
- [engine-adapter] Classify Kagi as preview. Personalization on the Kagi account double-applies with search-hole rules, so surface that in receipts and docs.
- [key-storage] The zero-native default is OS CLI shims:
  - macOS: `security -i` via stdin
  - Linux: `secret-tool` via stdin, only after a successful write+read probe
  - Windows: a DPAPI-protected file via PowerShell
  - fallback: a `0600` file in a `0700` dir with a loud `doctor` warning

  Never put secrets in argv. If a native module is accepted, use @napi-rs/keyring **pinned to `secret-service` on Linux**, never keytar. If Bun-compiled binaries win the runtime ADR, `Bun.secrets` replaces the shims.
- [runtime-packaging] Bun-compiled binaries lose V8's linear regex engine but have `Bun.secrets`; Node gets neither natively. Either way re2js covers regex. Set `engines` to `>=22`. Node 26 is LTS as of 2026-10-28.
- [date-extraction] Store `date_published`, `date_modified`, `date_kind`, `method` and `confidence` separately. **Don't use metascraper-date's default `date` as "published"** (it's modified-first). Prefer our own selector extractor (htmlparser2 or parse5, JSON-LD walk, chrono-node), because metascraper's helpers hard-depend on the native `re2` and on `jsdom`. If we do use metascraper, mark `re2`/`jsdom` external and set `METASCRAPER_RE2=false`.
- [security] SSRF guard on undici: a custom `connect.lookup` that checks every resolved address with `ipaddr.js` against an allowlist (`unicast` only, after unwrapping IPv4-mapped and NAT64 addresses). **Separately reject IP-literal hosts**, because Node skips `lookup` for them. Use manual redirect handling and re-check each hop. Use `request-filtering-agent` only if we choose got.
- [security] On macOS any same-user process can read keychain items the `security` CLI creates. The threat model should say "protects at rest and from casual exposure, not from same-user malware".
- [distribution] Docs and `doctor` copy:
  - Brave: card required; the $5 credit needs attribution.
  - Marginalia: non-commercial keys are CC-BY-NC-SA 4.0.
  - DuckDuckGo and SerpApi: legal and breakage caveats.
  - Fix §15.C: Tavily terms now live at tavily.com/terms, and Exa docs moved to exa.ai/docs.
- [other] §13 no-key fallback: Marginalia `public` is legitimate but rate-limited. ddgs is Python-only, "educational purposes only", and scrapes Google and Bing, so it shouldn't ship as a default. Recommend: SearXNG when Docker is present; otherwise Marginalia `public` with honest "may be rate-limited" messaging, plus a nudge toward a Brave key or a free Marginalia non-commercial key.
- [testing] Contract fixtures:
  - a Brave response with `page_age`
  - a Tavily result with and without `published_date`
  - a Mojeek `date=1` result
  - a Marginalia 503
  - a SearXNG 403 and 429
  - a list containing a lookahead regex, which must be skipped and counted
  - IP-literal and IPv4-mapped SSRF attempts
  - keychain-unavailable paths (headless Linux)
- [monorepo-shape] Pin the SDK adapter packages separately from server, client and core (2.1.2 / 2.0.2 vs 2.4.0).
