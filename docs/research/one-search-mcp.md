# yokingma/one-search-mcp
> Ref: `research/refs/one-search-mcp` @ 16eb424 (2026-07-31) · License: **MIT** (`LICENSE`, "Copyright (c) 2025 zac_ma."). One root LICENSE file; `package.json` `"license": "MIT"`; no per-directory licenses. Short snippets with attribution are fine. Runtime dependencies keep their own licenses; per `package-lock.json`, `agent-browser` 0.8.5 and `playwright-core` 1.58.1 are Apache-2.0, and `duck-duck-scrape`, `@tavily/core` and `turndown` are MIT.

## Purpose
A stdio MCP server (npm `one-search-mcp` 1.2.4) with **one search tool backed by exactly one provider chosen by env var**, plus three headless-browser tools for scrape, map and extract. The providers are SearXNG, DuckDuckGo (scraped via `duck-duck-scrape`), Bing API, Tavily, Google CSE, Zhipu, Exa, Bocha, You.com (`ydc`) and `local`, which drives a real Chromium against Bing/Google/Baidu/Sogou HTML (`src/interface.ts: SearchProvider`; `README.md` lines 172–192). The default is `local` (`src/index.ts` line 26). Why it matters to search-hole:
1. It is the competitor with the most **key-less** options (SearXNG, DuckDuckGo scraping, browser scraping). That is exactly the §13 Q3 question of "which no-key fallback is acceptable".
2. It has a real, tested **SSRF guard for browser fetching** using `node:net` `BlockList` and per-request Playwright routing (`src/libs/agent-browser/url-guard.ts`). That is a useful foil for our §12.4 design.
3. `PATTERNS.md` is a compact list of hard-won rules (abort-aware providers, honest schemas, a security floor for SDK versions) that apply to us directly.

## Architecture sketch
```text
index.ts (single file wires everything)
  dotenvx.config({quiet:true})              ← loads .env silently
  env → SEARCH_PROVIDER / SEARCH_API_URL / SEARCH_API_KEY / YDC_API_KEY
        LIMIT, CATEGORIES, ENGINES, LANGUAGE, TIME_RANGE, TIMEOUT, SAFE_SEARCH
  new McpServer({name, version:'1.2.4'}, {capabilities:{tools:{}, logging:{}}})
  registerTool(one_search | one_scrape | one_map | one_extract, {description, inputSchema}, createToolHandler(...))
  server.connect(new StdioServerTransport())   ← @modelcontextprotocol/sdk ^1.29.0 (2025-era path)
one_search → processSearch(args, {provider, apiKey, apiUrl, defaults}, signal)  (switch over 10 providers)
one_scrape/map/extract → new AgentBrowser() per call → runBrowserTask() → url-guard → page.goto → turndown
```
- `src/server/tool-handler.ts: createToolHandler` wraps every tool. It sends MCP `notifications/message` logs at start, end and error (`server.sendLoggingMessage`), and turns any thrown error into `{content:[{type:'text', text: msg}], isError: true}`.
- Process hygiene: `installStdioDisconnectCleanupHandlers` exits when stdin `end`/`close` fires, and `installProcessCleanupHandlers` covers SIGINT/SIGTERM/beforeExit. Both close every tracked browser through `activeBrowserRegistry` (`src/server/*.ts`, `src/libs/agent-browser/registry.ts`).

## Key modules and data flow
| Module | Role |
|---|---|
| `src/search/process-search.ts: processSearch` | A pure dispatcher with an injectable `handlers` map (testable without MCP). It merges `{...defaultSearchOptions, ...args, apiKey}` per provider. |
| `src/search/{searxng,tavily,exa,ydc,google,bing,bocha,zhipu,duckduckgo,local}.ts` | One async function per provider, `(options, signal) → {results, success}`. |
| `src/search/request-signal.ts: createRequestSignal` | Combines the MCP request `AbortSignal` with a provider timeout via `AbortSignal.any`. |
| `src/libs/agent-browser/index.ts: AgentBrowser` | Launches Chromium (finds a local Chrome/Edge via `src/libs/browser/finder.ts`, else Playwright's). `scrapeUrl` = navigate → wait 2 s (`BROWSER_CONFIG.DEFAULT_WAIT_MS`) → optional actions → `page.content()` → Turndown + GFM → markdown/html/links/screenshot. `search()` scrapes SERP HTML with cheerio selectors (`div.g`, `li.b_algo`, `div.result`, `div.vrwrap`). |
| `src/libs/agent-browser/url-guard.ts` | SSRF guard (details below). |
| `src/libs/agent-browser/task.ts: runBrowserTask` | Races the task against request abort and guarantees `browser.close()` runs once. |
| `src/extract/process-extract.ts` | Sequential loop over `urls`; each becomes `## Content from <url>` or `## Failed to extract from <url>`, joined by `---`. |

## Data model and storage
- **No persistence**, no cache, no logs on disk (pino goes to stderr; `src/libs/logger/index.ts`).
- Normalized result (`src/interface.ts: ISearchResponseResult`): `{title, snippet, url, thumbnailUrl?, markdown?, source?, engine?, image?: {thumbnail, src}|null, video?: {...}|null}`. There is **no date field and no score**. The SearXNG adapter maps `item.content`, `item.source`, `item.engine` and image/video, and **drops `publishedDate`, `score` and `engines[]`** (`src/search/searxng.ts` lines 82–100).
- The tool output is plain text with no `structuredContent`: per result `Title: …\nURL: …\nDescription: …\n[Content: markdown]`, joined by blank lines (`src/index.ts` lines 103–108).

## Config format
- Env vars only, loaded with `@dotenvx/dotenvx` (`src/index.ts` lines 21–37). `SEARCH_PROVIDER` defaults to `local`. `SEARCH_API_URL` is the SearXNG base URL **or the Google CSE `cx` id** (overloaded). `SEARCH_API_KEY` is shared by every keyed provider except You.com (`YDC_API_KEY`). Then `LIMIT=10`, `CATEGORIES=general`, `ENGINES=all`, `LANGUAGE=auto`, `TIME_RANGE=''`, `TIMEOUT=10000`, `SAFE_SEARCH=0`, and `ALLOW_PRIVATE_NETWORK` (truthy set `1/true/yes/on`, `url-guard.ts` line 8).
- One provider per process. Switching engines means reconfiguring the MCP server entry (`README.md` lines 85–92, `claude mcp add one-search-mcp -e SEARCH_PROVIDER=searxng -e SEARCH_API_URL=http://127.0.0.1:8080 -- npx -y one-search-mcp`).
- Docker images are published to GHCR and Docker Hub (`.github/workflows/docker-publish.yml`; `README.md` lines 128–160).

## Extension points (plugins, hooks)
- Adding a provider means a function, a `case` in `processSearch`, a union member in `SearchProvider`, and an entry in `server.json` (enforced by `test/package-metadata.test.ts` "documents all supported search provider environment variables in server.json").
- There are no plugins or hooks. `one_scrape.actions` (`wait/click/write/press/scroll/executeJavascript`) is a model-driven extension surface, and `executeJavascript` needs `allowExecuteJavascript: true` (`src/schemas.ts: ScrapeSchema.superRefine`).

## Rules / lists: parsing and compilation
n/a. There are no rules, lists or domain filters. The search schema has no include/exclude domain parameters at all (`src/schemas.ts: SearchSchema` = `query, limit, language, categories, timeRange`).

## Testing strategy
- **Vitest 4**, `test/**/*.test.ts`: 14 files, ~50 `it(` cases (`vitest.config.ts`).
- **Dependency injection over mocking**:
  - `processSearch(..., handlers)` takes a handler map (`test/process-search.test.ts`).
  - `assertUrlIsSafe(url, resolveHostname)` and `installUrlProtection(page, resolver)` take a fake DNS resolver and a fake `page.route` collector (`test/url-guard.test.ts`).
  - Provider tests stub `fetch` and assert the **exact request URL** (`test/searxng.test.ts`, for example `…/search?q=mcp&pageno=1&categories=general&format=json&safesearch=0&language=auto&engines=all&time_range=month`).
- **Real-process integration**: `test/stdio-disconnect.integration.test.ts` spawns the server, closes stdin, and walks `ps -ax -o pid=,ppid=,command=` to assert **no orphaned browser descendants** after a 2 s grace period. It is skipped when no local browser is found.
- **Metadata/security-floor tests** (`test/package-metadata.test.ts`) check that the versions match across `package.json`, `server.json` and `src/index.ts` (`PATTERNS.md` also lists `package-lock.json`, but the test does not check it), that `@modelcontextprotocol/sdk` is pinned to a patched minimum, that the `server.json` description is ≤ 100 chars, and that `prepublishOnly` runs the release checks.
- Gaps: the SSRF redirect test drives the *mocked* route handler with the redirect URL directly (`test/url-guard.test.ts` lines 68–91), so it does not prove that Playwright really invokes the route on 3xx hops (see Implications).

## UX patterns worth copying
- **`PATTERNS.md` as an executable style guide.** Its sections are "Shared Safe-Search Semantics" (0/1/2 mapped explicitly per provider and tested), "Honest Browser-Backed Tool Schemas" (expose only what is implemented; `.strict()` so removed fields fail loudly), "Abort-Aware Search Providers" (every branch gets the signal; check `response.ok` before parsing; omit unsupported option values instead of guessing), "Browser SSRF Guard" and "Publish Artifacts". The same "decisions as rules plus a test that enforces each" format would work for our `docs/` and `CONTRIBUTING.md`.
- **A loud warning when a safety default is weakened**: with `ALLOW_PRIVATE_NETWORK=true` the server sends a `warning` log at startup (`src/index.ts` lines 312–317) and the README explains the prompt-injection risk (lines 184–186).
- **A helpful missing-browser error** listing install options (`AgentBrowser.ensureLaunched`, lines 64–74). This is the kind of first-run message §4 "Runtime availability" wants for missing Node.

## Performance tricks
- Few. A browser is launched **per tool call** (`new AgentBrowser()` in `processScrape`/`processMapUrl`/`processExtract`/`localSearch`), plus a fixed 2 s wait (3 s for SERP pages, `BROWSER_CONFIG`). Cold Chromium launch dominates latency (inferred).
- `one_extract` processes URLs **sequentially** (`process-extract.ts` `for … of`).
- `extractLinks` dedups with `links.includes()`, which is O(n²) on link-heavy pages (`agent-browser/index.ts` lines 434–451).
- Provider timeouts: SearXNG 10 s default; Exa/Tavily 20 s; You.com 10 s. DuckDuckGo uses `async-retry` with `retries: 3` (`src/search/duckduckgo.ts` line 11).

## License and what it means for us
MIT. We may borrow code with attribution. The SSRF guard is short and well-shaped, but we will write our own on undici (§12.4). The guard is browser-specific and has the gaps below. `PATTERNS.md` ideas are free to adopt.

## Implications for search-hole
- [mcp-tool-surface] **Measured cost.** Reconstructed from `src/tools.ts` and `src/schemas.ts`, measured as compact JSON, tokens estimated as chars/4:

  | Tool | Description chars | Params (required) | `tools/list` JSON chars | ≈ tokens |
  |---|---|---|---|---|
  | `one_search` | 102 | 5 (`query`) | 829 | 210 |
  | `one_map` | 104 | 4 (`url`) | 606 | 150 |
  | `one_scrape` | 253 | 7 (`url`) + 6-variant `actions` union | 2,677 | 670 |
  | `one_extract` | 134 | 1 (`urls`) | 428 | 110 |
  | **Total** | 593 | | **≈ 4,540** (±5 %) | **≈ 1.1k (up to ~1.5k at chars/3)** |

  - **`one_scrape` alone is ~60 % of the `tools/list` JSON** (2,677 of ~4,540 chars). Its nested `actions` union is about 1.5k chars of that (~33 % of the total).
  - Lesson: the description text was never the problem; nested schemas are. Keep `search`/`fetch` inputs flat with enums, and measure the full `tools/list` JSON in CI, not just the description strings.
- [mcp-tool-surface] The `one_search` description ("Search and retrieve content…") says nothing about when to use it versus the host's built-in search, or about depth. With ~100 chars it relies entirely on the tool name. Our descriptions plus server `instructions` must carry the "quick vs deep" and "read receipt warnings" guidance (§4 "Teaching the model").
- [mcp-tool-surface] **There are no output limits anywhere.** Exa asks for `contents.text.maxCharacters: 10000` **per result** and maps it into `snippet` (`src/search/exa.ts` lines 12, 48–52, 67), so a default 10-result call can return ~100k chars. `one_scrape` concatenates markdown, raw HTML, HTML, links and a **base64 PNG data URI as text** (`src/index.ts` lines 199–225). This is the anti-pattern our §4 caps (`search` ≤ 2.5k tok, `fetch` ≤ 8k with a `cursor`) exist to prevent.
- [engine-adapter] **No key-less skipping and no fallback chain.** Exactly one provider is active, and a missing key surfaces only at call time (`'Tavily API key is required'`, `src/search/tavily.ts` line 53). The only "fallback" is inside `local`, which tries bing → google → baidu → sogou in sequence and takes the **first engine with any results**. It **swallows every per-engine error and returns `success: true` with `results: []`** when all fail (`src/search/local.ts` lines 63–92), so the model cannot tell "no results" from "all engines broken". Our receipts must distinguish `empty` from `error` per engine (agent-search's `upstream_status` does this well).
- [engine-adapter] Per-provider quirks:
  - **SearXNG:** `GET {SEARCH_API_URL}/search?q&pageno&categories&format=json&safesearch&language&engines[&time_range]`, optional `Authorization: Bearer` (`src/search/searxng.ts`). `time_range` is sent only for `day|month|year`; **`week` is silently dropped** (`VALID_SEARXNG_TIME_RANGES`, tested in `test/searxng.test.ts` "omits unsupported timeRange values").
  - **Tavily:** via the `@tavily/core` SDK with `timeout` in seconds; `categories` mapped to `topic` only if `general|news|finance`.
  - **You.com:** `GET https://ydc-index.io/v1/search?query&count&language&freshness&safesearch`, header `X-API-Key`.
  - **Google CSE:** `num ≤ 10`.
  - **Bing v7:** `Ocp-Apim-Subscription-Key`, `mkt`.
- [engine-adapter] **Bug pattern to avoid:** for SearXNG, `processSearch` overwrites the model's `categories` and `language` with the env defaults whenever those are set, and `CATEGORIES` defaults to `'general'` (`src/search/process-search.ts` lines 71–79). The model's argument is silently ignored. In our precedence ADR, explicit tool args must beat profile defaults, which must beat global defaults, and this needs a test.
- [engine-adapter] Abort plumbing: `createRequestSignal` combines the request signal and the timeout with `AbortSignal.any`, and `PATTERNS.md` says "If a third-party SDK does not expose request cancellation, prefer a direct HTTP implementation". Yet the Tavily adapter uses `@tavily/core` and only checks `signal.aborted` *before* the call (`src/search/tavily.ts` lines 56–77). We should use plain HTTP (undici) for every engine so cancellation and spend caps actually work.
- [security] **The SSRF guard technique** (`src/libs/agent-browser/url-guard.ts`):
  1. `parseUrl` allows `http:`/`https:` only.
  2. Literal IPs are checked directly. Hostnames are resolved with `dns.lookup(host, {all: true, verbatim: true})`, and **every** answer must pass: mixed answers fail, and zero answers fail.
  3. A `node:net` `BlockList` holds `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, ::/128, ::1/128, fc00::/7, fe80::/10` (lines 24–35). The shape, MIT, abridged:
     ```ts
     const blockedIpRanges = new BlockList();
     blockedIpRanges.addSubnet('10.0.0.0', 8, 'ipv4');
     blockedIpRanges.addSubnet('100.64.0.0', 10, 'ipv4');
     blockedIpRanges.addSubnet('fc00::', 7, 'ipv6');
     // … check(address, family === 4 ? 'ipv4' : 'ipv6') → throw
     ```
  4. After the pre-check, `installUrlProtection` registers `page.route('**/*', …)`, which re-validates every request (navigation and subresources) and aborts with `'blockedbyclient'`. A `WeakMap` keeps it to one install per page.
  5. `ALLOW_PRIVATE_NETWORK` is the opt-out.
- [security] **Gaps that our design must close:**
  - **No connection pinning.** The guard resolves DNS itself, then Chromium resolves again, which leaves a DNS-rebinding window (inferred).
  - **Redirect hops.** The Playwright `page.route` docs (playwright.dev, checked 2026-10-29) say: "The handler will only be called for the first url if the response is a redirect." So a public URL that 302s to `169.254.169.254` may bypass the route check (the docs wording is the evidence; real-browser behaviour is not tested in the ref). The ref's redirect test uses a mock that calls the handler directly.
  - **Missing ranges:** `198.18/15`, `192.0.0/24`, the TEST-NETs, `224/4` multicast, `240/4` reserved, `255.255.255.255`, `64:ff9b::/96` NAT64 (which can embed private IPv4), `2002::/16` 6to4 and `ff00::/8`. IPv4-mapped IPv6 such as `::ffff:127.0.0.1` is matched against the IPv4 rules by Node's `BlockList` (inferred from Node docs).
  - **No byte cap** on page content. The only time limits are the navigation timeout (30 s default) and the fixed 2 s wait.
  - **`skipTlsVerification` is a model-controllable argument** (`src/schemas.ts` line 82).

  Our §12.4 plan already fixes most of this: undici `connect.lookup` + `ipaddr.js` `range() === 'unicast'`, manual redirects re-validated per hop, and size and time caps. NAT64/6to4 need no unwrapping if we simply reject them: ipaddr.js `main` (checked 2026-10-29) lists `64:ff9b::/96`, `2002::/16`, `198.18.0.0/15`, multicast and reserved ranges as special ranges, so `range() === 'unicast'` already refuses them (version-dependent, so pin the version and test it). Never let the model turn TLS off.
- [security] The fetched page goes to the model with no "external content" marking and no injection flags. Turndown converts the **whole** HTML, ignoring the `onlyMainContent: true` it is passed (`process-extract.ts` line 20; `AgentBrowser.scrapeUrl` never reads it), so nav and footers are included too. Our `fetch` should use a readability-style extractor and wrap output as clearly untrusted (§12.4).
- [security] Error messages pass raw upstream bodies to the model (You.com: `` `You.com Search API error ${resp.status}: ${body}` ``, `src/search/ydc.ts` line 86). Ours should truncate and redact them, and treat them as untrusted.
- [dual-protocol] It uses `@modelcontextprotocol/sdk ^1.29.0` with `McpServer.registerTool` and imports **`zod/v3`** (`src/schemas.ts` line 1), connected via `server.connect(new StdioServerTransport())` (`src/index.ts` lines 303–304). That is the 2025-era path that, per §3, only speaks to 2025-era clients. There are no tool annotations (`readOnlyHint`/`openWorldHint` absent), no `outputSchema`, and no `structuredContent`. A competitor on SDK v1 is common, which confirms that hosts will keep sending `initialize` for a while. Our gateway must answer both.
- [testing] Copy: (a) a pure dispatcher with an injected handler map; (b) a resolver-injectable SSRF guard with fixtures for mixed answers, IPv6 and subresources; (c) a **spawn-and-close-stdin test that asserts no orphaned children**, which matters once our gateway holds SQLite leases or launches a dashboard; (d) a package-metadata test that pins the SDK security floor and keeps the version consistent across manifests. That last one is relevant to plugin `.mcp.json`, `.mcpb` `manifest.json` and `server.json`.
- [upgrades-migrations] The stdin-close → cleanup → exit pattern (`src/server/stdio-cleanup.ts`) is how a stdio gateway learns that its host died. We need it to release the list-refresh lease (§4 "exactly one owner for background jobs") promptly instead of waiting for lease expiry.
- [runtime-packaging] It needs a Chromium for three of its four tools plus the default provider. That is a heavy first-run dependency with a long install-help error. It confirms that we keep `fetch` plain-HTTP (no browser) in v1.
- [distribution] It ships Docker images (`ghcr.io/yokingma/one-search-mcp`, `zacma/one-search-mcp`) as an alternative to `npx`, and `PATTERNS.md` "Publish Artifacts" says to publish only the exact semver tag and `latest`, never floating major tags.
- [other] On §13 Q3: one-search's key-less options are `local` browser scraping of Google/Bing/Baidu/Sogou SERPs and `duck-duck-scrape`. Both are ToS- and breakage-prone (cheerio selectors like `div.g`, `div.VwiC3b` in `agent-browser/index.ts` lines 338–343 break when Google changes markup). That supports keeping scraping adapters "off; experimental at most" (§5.2).

## Borrow / avoid
**Borrow**
- The `PATTERNS.md` format: short normative rules per concern, each backed by a regression test.
- `createRequestSignal` (`AbortSignal.any([caller, timeout])`), with every engine receiving the MCP request signal.
- Resolver injection for SSRF tests and the "mixed DNS answers ⇒ block" rule.
- A strict input schema (`.strict()`) so unknown or removed args fail at the seam, plus runtime cross-field validation kept separate from the advertised flat `inputSchema` (the `ScrapeToolInputSchema`/`ScrapeSchema` split) so `tools/list` stays concrete.
- The stdin `end`/`close` cleanup handler and the orphan-process integration test.
- A loud startup warning whenever a security default is relaxed.

**Avoid**
- One provider per process, chosen by env, with no fallback or health.
- Env defaults silently overriding explicit tool arguments.
- Unbounded outputs (10k chars per Exa result, base64 screenshots as text).
- Browser-per-call extraction, and SERP scraping as a default.
- Exposing `skipTlsVerification` or `executeJavascript` to the model.
- SDK-wrapped engines that cannot be cancelled.
- Dropping `publishedDate`/`score`/`engines` from SearXNG results.
- An SSRF guard without connection pinning or per-hop redirect checks.

## Verification
- Date: 2026-10-29. Checked against `research/refs/one-search-mcp` @ 16eb424. Claims checked: 78 (license header and section, every Implications bullet, and the mechanism claims they rely on: tool sizes, provider dispatch, SearXNG/Tavily/Exa/You.com request shapes, SSRF guard ranges and flow, abort plumbing, test and CI structure, `PATTERNS.md` quotes).
- License confirmed: one root `LICENSE` (MIT, "Copyright (c) 2025 zac_ma."), `package.json` `"license": "MIT"`, no per-directory license files. No GPL/AGPL/EUPL code is pasted. The one code excerpt (the `BlockList` lines) is MIT and attributed.
- Tool-surface table re-measured: description lengths (102/104/253/134), parameter counts (5/4/7/1) and the `tools/list` sizes reproduce (606, 2,677 and 428 chars exactly; `one_search` within 4 %; total 4.5–4.6k chars, ≈ 1.1k tokens).
- Corrections:
  1. "60 % of the budget is the `one_scrape` action union" was wrong: `one_scrape` as a whole is ~60 %; the `actions` union alone is ~1.5k chars (~33 %). Fixed. The lesson (nested schemas, not descriptions) still holds.
  2. The package-metadata test does not check `package-lock.json` (only `package.json`, `server.json` and `src/index.ts`; the lockfile is named in `PATTERNS.md` only). Fixed.
  3. "No byte or time caps" was imprecise: there is a navigation timeout (30 s default) and fixed waits, but no byte cap. Fixed.
  4. The Playwright redirect claim was marked "inferred"; the `page.route` docs on playwright.dev say "The handler will only be called for the first url if the response is a redirect". Updated with the quote.
  5. Dependency licenses filled in from `package-lock.json` (`agent-browser`, `playwright-core` Apache-2.0).
  6. "Add NAT64/6to4 unwrapping" in the SSRF recommendation was imprecise: with ipaddr.js `main` (checked 2026-10-29) those ranges are special ranges, so the planned `range() === 'unicast'` check already rejects them. Reworded (version-dependent, pin and test).
