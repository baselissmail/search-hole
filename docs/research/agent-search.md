# brcrusoe72/agent-search
> Ref: `research/refs/agent-search` @ f65b7a3 (2026-10-13) · License: **MIT (root) + AGPL-3.0 (`mcp-server/`)**, verified from the files.
> - **Root: MIT.** `LICENSE` says "Copyright (c) 2026 AgentSearch Contributors". `pyproject.toml` has `license = { text = "MIT" }`, and `sdk/pyproject.toml` also says MIT. This covers `app/`, `adapters/`, `sdk/`, `tests/`, `scripts/`, `searxng/`, `examples/` and the docs.
> - **`mcp-server/`: AGPL-3.0.** `mcp-server/LICENSE` is a stub: the header line plus a link to the full AGPL text, not the text itself. `mcp-server/pyproject.toml` has `license = { text = "AGPL-3.0" }`, and `mcp-server/README.md` line 180 says the MCP server is AGPL while the root API is MIT.
>
> **This note describes `mcp-server/` in prose only. No code or verbatim strings are taken from it.** MIT snippets from `app/` are attributed.

## Purpose
A **self-hosted search API for agents** (Python 3.11+, FastAPI, `app/main.py`, 1,899 lines) wrapping SearXNG. It adds:
- cross-engine dedup and scoring
- named "strategy modes" that also call 11 no-key vertical APIs directly (GitHub, MDN, PyPI, arXiv, …; `README.md` counts 11, the code registers 12, and the Reddit one is used by no mode)
- an escalating extraction "kill chain"
- domain trust scoring
- prompt-injection scrubbing
- a fetch log with a failure "evolver"

A separate thin **MCP server** (`mcp-server/`, AGPL) exposes the API as 16 tools over stdio. There is also an optional Tor/private Docker stack (`examples/compose.private.yml`). Why it matters to search-hole:
1. It is the only competitor with **domain trust scoring** and a **merge/ranking formula**. Both feed our merge-weights and source-type ADRs.
2. Its **SSRF implementation is the most rigorous of the three**: DNS answers validated with `ipaddress.is_global`, connections pinned to the validated IP, redirects re-validated, byte caps (`app/fetch_security.py`, MIT).
3. Its `SPEC.md` (a 2026-08-06 security repair spec, rules R1–R25 plus fixture answer keys) reads like a threat model for our exact problem space. Examples: R1–R3 say untrusted feedback must never mutate blocklists, and R8–R9 require provenance for alternate-source content.

## Architecture sketch
```text
agent (MCP client) ──stdio──► agent-search-mcp (AGPL, httpx client) ──HTTP──► FastAPI :3939 (MIT)
                                                                              │
              ┌──────────────────────────────────────────────────────────────┤
              ▼                         ▼                          ▼          ▼
     SearXNG :8080 (JSON)     direct providers (12,      kill chain (direct → readability →  SQLite
     25 engines enabled        no key; app/search_         UA rotation → Wayback → Google      query_log,
     searxng/settings.         providers.py)               cache → search-about → adapters →   content_cache,
     example.yml                                           PDF → YouTube; app/killchain.py)    fetch_log
                                                                     │
                                         fetch-proxy container (egress gate) + CoreDNS (DoT)
                                         browser renderer container (Chromium, sandboxed)
```
- The Compose stack is hardened: images pinned by `@sha256` digest, `read_only: true`, `cap_drop: [ALL]`, `pids_limit`, `mem_limit`, and CoreDNS as the only resolver (`docker-compose.yml` lines 1–60).
- `scripts/prepare-searxng.sh` generates `searxng/settings.yml` from the example, injecting a random `secret_key` and setting `chmod 0600`. The example enables `formats: [html, json]` and `limiter: false` (`searxng/settings.example.yml` lines 17–23; `searxng/limiter.toml`).

## Key modules and data flow
| Module (license) | Role |
|---|---|
| `app/main.py` (MIT) | All routes: `/search`, `/search/strategy`, `/search/deep`, `/search/extract`, `/search/policy`, `/search/sources`, `/news`, `/search/jobs`, `/read`, `/read/batch`, `/providers/browser/fetch`, `/adapt/*`, `/live`, `/ready`, `/health`, `/providers/stats`, `/providers/health`, `/engines`. It also holds the auth and rate-limit middleware. |
| `app/dedup.py` (MIT) | URL normalization, `deduplicate_with_scoring` (the merge formula). |
| `app/domain_trust.py` (MIT) | `evaluate_trust(url) → TrustResult{domain, tier, score, reasons, https, domain_age_days, lookalike_of}`. |
| `app/fetch_security.py` (MIT) | `validate_public_url`, `SafeAsyncNetworkBackend` (pinned connect), `safe_httpx_get` (manual redirects plus byte cap). |
| `app/killchain.py` (MIT) | Escalating extraction, plus trust gating and tagging and provenance (`FetchedContent{content, fetched_url}`). |
| `app/scrubber.py` (MIT) | 73 detection regexes (48 injection, 11 exfiltration, 6 impersonation, 8 XSS; the module docstring says "70+") plus 7 XSS-specific redaction patterns, over injection, exfiltration, impersonation and XSS, then encoding normalization, risk score and **redaction**. |
| `app/search_providers.py` (MIT) | The `SearchProvider` base class plus 12 direct providers (MDN, GitHub, Docker Hub, PyPI, Wikipedia, Wikidata, Hacker News, Reddit, arXiv, Crossref, OpenAlex, Semantic Scholar). No strategy mode uses Reddit. |
| `app/query_expansion.py` (MIT) | Rule-based query variations for `/search/deep` (no LLM). |
| `app/evolver.py` (MIT) | Fetch-failure analysis. Since SPEC R2 it is **analysis-only**. |
| `mcp-server/agent_search_mcp/server.py` (AGPL) | A low-level MCP `Server` with a hand-written tool list. Each call maps to one HTTP request against the API, and the JSON response is returned as text. |

`/search` flow (`app/main.py` lines 1014–1094):
1. Validate the query (non-empty, ≤ 500 chars) and resolve `engines` against the live `/config` catalog.
2. Check the in-memory TTL cache, keyed by query, engines, count, domain, excludes and fetch (`app/cache.py`, `ttl = 3600`).
3. If `domain` is set *and* every selected engine is in category `general`/`web` (or no engines were selected), prepend `site:<domain>` (`_supports_site_search`, `_domain_scoped_query`).
4. Call `_query_searxng(count*2)`, which keeps `results[:count*3]`, i.e. a **retention cap of 6×** the requested count. This is only a slice limit: SearXNG is sent just `q`, `format=json`, `pageno=1` and optional `engines`/`categories`, never a result count, so the real over-fetch is whatever SearXNG's first page holds (and one SearXNG page will usually hold far fewer than 6×`count` rows (inferred; not measured).
5. Run `deduplicate_with_scoring`, then `_filter_search_results` (include/exclude by exact-or-subdomain match), then `[:count]`.
6. With `fetch=true`, run `kill_chain_batch(max_concurrent=5)`.
7. Write `query_log`, set the cache, and return `SearchResponse{results, meta}`.

## Data model and storage
- **SQLite, raw `sqlite3`, WAL** (`app/database.py` lines 36–64): `query_log(id, query, timestamp, engine, result_count, response_time_ms)` with **one row per engine per query**, plus indices on `(query, timestamp)` and `engine`. If the DB is read-only, `disabled = True` and logging is skipped silently.
- `app/content_cache.py` lines 64–103:
  - `content_cache(url_hash PK sha256, url, content, strategy, chars, created_at, expires_at, fetched_url, derived_from)` with **per-strategy TTLs**.
  - `fetch_log(id, url, domain, strategy, success, chars, strategies_tried, error, timestamp)`.
  - **Migrations are ad hoc**: read `PRAGMA table_info`, then `ALTER TABLE … ADD COLUMN` if the column is missing.
- In-memory only: the search TTL cache and the provider attempt stats (`ProviderAttemptStats{attempts, successes, degraded, errors, empty, total_raw_results, latencies_ms[≤200], last_status, last_error, last_attempt_at, last_success_at}`, `app/main.py` lines 293–308, 515–555). Both are lost on restart.
- Response models (`app/models.py`):
  - `SearchResult{title, url, snippet, engines[], score, position, content?}`
  - `SearchMeta{query, total, engines_used, cached, response_time_ms, queries_used, mode, engine_attempts[], fallback_reason, upstream_status ok|degraded|error, upstream_errors[], unresponsive_engines[], network_route direct|tor}`

## Config format
- Env vars: `SEARXNG_URL` (default `http://searxng:8080`), `AGENT_SEARCH_TOKEN` (enables bearer auth, compared with `secrets.compare_digest`; `/health`, `/live` and `/ready` are exempt), `GLOBAL_RATE_LIMIT` (300 req/min), `DATA_DIR`, `ADAPTERS_DIR`, `NETWORK_ROUTE` (`app/main.py` lines 77, 196–217; `app/killchain.py` line 61). See also `.env.example` and `docs/secrets.md`.
- SearXNG engine selection lives in `searxng/settings.example.yml` (instance config).
- MCP server (AGPL, described): CLI flags for host, port, base URL and token. It finds the token from env vars or two per-user credential file paths under the home directory (deliberately **not** the working directory; SPEC R20). It refuses to send a bearer token over plaintext HTTP to a non-loopback host unless an explicit insecure flag is set (SPEC R19; `tests/test_mcp_contract.py` "test_mcp_transport_policy").

## Extension points (plugins, hooks)
- **Disk-loaded Python adapters**: `ADAPTERS_DIR` modules loaded with `importlib` and keyed by "obstacle type" (`adapters/403_forbidden.py`, `cloudflare_bypass.py`, `medium.py`, `empty_content.py`, `parse_error.py`, `safe_fetch.py`; `app/killchain.py` `_load_adapter`, `strategy_adapter`). This is arbitrary code execution by design. Fine for a self-hosted server, wrong for a plugin.
- **Strategy packs** (`SEARCH_STRATEGY_MODES`, `app/main.py` lines 351–393): each mode is an ordered tuple of `SearchStrategyPack(source='searxng', engines=(…))` or `(source='provider', provider=…)`. Examples: `code` = github, mdn, docker_hub, pypi; `academic` = arxiv, crossref, openalex, semantic_scholar; `general` = bing → duckduckgo+brave → wikipedia → wikidata → hackernews, **stopping early once `count` results exist**.
- **Direct-provider base class** (`app/search_providers.py`): subclasses implement `_search(client, query, count)`. The base `search()` **never raises**: an exception becomes `ProviderResponse(results=[], upstream_status='error', upstream_errors=[…], unresponsive_engines=[engine_name])` with timing.

## Rules / lists: parsing and compilation
- No user rule language. The lists are **hard-coded Python sets**:
  - `ESTABLISHED_DOMAINS` (~60 news, think-tank, government, academic, tech and reference domains)
  - `TRUSTED_TLDS = {.gov, .edu, .mil, .int, .museum}`
  - `SUSPICIOUS_TLDS` (24, e.g. `.tk .ml .ga .cf .gq .xyz .top .click .loan`)
  - `KNOWN_BRANDS` (22)
  - `PLATFORM_DOMAINS` (`github.io, gitlab.io, pages.dev, netlify.app, vercel.app, readthedocs.io, gitbook.io, sourceforge.net`)

  These are in `app/domain_trust.py` lines 43–96. `BLOCKED_FETCH_DOMAINS` (URL shorteners plus four "0 % success" hosts) appears in **both** `app/killchain.py` lines 98–105 and `app/fetch_policy.py`, so it is duplicated and can drift. There is also an operator-managed `data/blocked_domains.txt`, re-read from disk (`_load_dynamic_blocklist`).
- **Matching semantics** (`app/url_utils.py`, MIT; SPEC R10): normalize the hostname (lowercase, strip the trailing dot and `www.`, IDNA-encode), then match **exact domain or `.`-suffix only**. The fixture `tests/fixtures/security/hostname_spoof*.json` pins that `rand.org.evil.example` and `evil-rand.org.attacker.example` do **not** match `rand.org`, while `reports.rand.org` does.
- **Untrusted feedback never edits lists** (SPEC R1–R3). `/adapt/report` records feedback, and `/adapt/evolve` only recommends. Fixture `evolver_poison.expected.json` asserts `actions_taken: []`, `blocklist_created: false` and `fetch_behavior_changed: false` after five fabricated failure reports.

## Testing strategy
- **pytest**, 113 test functions across 11 files (106 module-level plus 7 class methods in `test_scrubber.py`; `tests/test_api.py` has 47; `test_live_docker.py` 18; `test_security_repairs.py` 8; …). SearXNG is mocked, so the default run needs no Docker (`README.md` "Verify").
- **Fixture answer keys**: `tests/fixtures/security/{direct_fetch, evolver_poison, ssrf_targets, derived_content, hostname_spoof, ranking_edges, browser_limits, client_contracts}.json` plus `*.expected.json`. SPEC §5 says the expected files "must not be weakened merely to make implementation pass". The `ssrf_targets` cases are: public v4, public v6, CGNAT `100.64.0.1`, loopback, private, **mixed answers**, **DNS failure** and a **rebind case** (`answers: 8.8.8.8`, `connect_answer: 127.0.0.1` → must block).
- **Opt-in live tiers**: `AGENTSEARCH_INTEGRATION=1` (a local instance) and `AGENTSEARCH_DOCKER_INTEGRATION=1` (the direct and Tor stacks, including "observes a Tor exit" and "direct-egress probe denied", SPEC R16).
- **MCP contract** (`tests/test_mcp_contract.py`, MIT, since it lives in `tests/`): it pins the MCP SDK to the verified `1.27.x` line, checks the transport/token policy, and checks that **unknown tools and connection failures come back as protocol-level tool errors** (SPEC R22). It also asserts that the source never offers a CWD token file.
- CI: `.github/workflows/test.yml`, `codeql.yml` and Dependabot.

## UX patterns worth copying
- **Provenance as first-class fields** (SPEC §3, R8): `url` (requested), `fetched_url` (actual source), `derived_from` (set when content came from an alternate source such as Wayback or "search-about"), and a separate `trust` and `requested_trust`. Our receipts need exactly this split. "Opened X but the bytes came from archive.org" must be visible.
- **Upstream health in every response**: `upstream_status` (`ok`/`degraded`/`error`), `unresponsive_engines` (parsed from SearXNG's `unresponsive_engines` JSON), `engine_attempts[]` with per-pack raw counts and latency, and `fallback_reason` (`no_results`/`insufficient_results`) (`app/main.py` `_normalize_upstream_diagnostics`, `_upstream_metadata`). This maps directly onto our receipt line "one engine down: fell back".
- **A trust tag in-band for low tiers only**: `format_trust_tag` → `[🔴 suspicious source: domain ⚠️ possible typosquat of 'x']`, prepended only when the tier is `suspicious` or `new` (`app/killchain.py` `_tag_content`, lines 874–878). Quiet for normal sources, loud for bad ones.
- **Liveness vs readiness**: `/live` is cheap, and `/ready` is bounded (one 5 s probe of SearXNG `/healthz`) and returns 503 (SPEC R17 asks for "bounded/cached", but the code does not cache it). This pattern fits our `doctor` and dashboard health endpoint.

## Performance tricks
- Keep up to 6× the requested count from SearXNG's single first page, then dedup and filter (`_query_searxng`, `results[:count*3]` with `count*2` passed in). It is a slice cap, not a request-size multiplier, so our "over-fetch 2–3×" must be done by asking each engine for more results or more pages.
- `kill_chain_batch(max_concurrent=5)` for inline content. The browser renderer has a bounded global queue (SPEC R15).
- WHOIS is skipped for platform hosts and, in practice, everywhere: every real call passes `check_whois=False` (`app/killchain.py` lines 854, 887; `app/browser_renderer.py` lines 191, 196).
- Caps everywhere:
  - `DEFAULT_MAX_RESPONSE_BYTES = 5 MiB`, checked against the declared `Content-Length` and then the streamed decoded bytes (`app/fetch_security.py` lines 17, 213–229)
  - PDFs ≤ 20 MiB
  - extracted text `MAX_CONTENT_CHARS = 15_000` (~3.75k tokens)
  - snippets ≤ 2,000 chars and other text ≤ 1,000 (`app/search_providers.py` `_safe_text`/`_clean_snippet`)
  - redirects ≤ 5
  - fetch timeout 15 s
- Weak spots: the unused legacy `deduplicate()` recomputes the engine denominator inside the loop (O(n²), `app/dedup.py` lines 136–139); the live `deduplicate_with_scoring` computes it once (lines 184–189). The provider stats live only in process memory.

## License and what it means for us
- **Root (MIT):** we may borrow ideas *and* short code with attribution from `app/`, `adapters/`, `sdk/`, `tests/` and the fixtures. The trust heuristics, URL normalization, SSRF design and fixture shapes are all borrowable. Our code is TypeScript, so in practice we re-implement.
- **`mcp-server/` (AGPL-3.0):** **never copy** its code, tool descriptions or schemas (master plan §10). We can only learn facts about its *surface* from reading: tool names, counts and measured lengths, protocol behaviour. The note below sticks to that. Calling the MIT HTTP API from a separate process would be fine, but we don't need to.

## Implications for search-hole
- [mcp-tool-surface] **16 tools** in the AGPL MCP server. Below are names and my own measurements only. I parsed the tool literals with Python `ast` (no execution) and measured compact JSON, with tokens estimated as chars/4:

  | Tool | Desc chars | Params | JSON chars | Tool | Desc chars | Params | JSON chars |
  |---|---|---|---|---|---|---|---|
  | `health` | 73 | 0 | 155 | `policy_search` | 97 | 3 | 448 |
  | `engines` | 58 | 0 | 141 | `source_search` | 83 | 3 | 421 |
  | `providers_stats` | 71 | 0 | 162 | `source_institutions` | 76 | 1 | 238 |
  | `providers_health` | 66 | 0 | 158 | `read_url` | 169 | 3 | 494 |
  | `search` | 101 | 7 | 803 | `browser_fetch` | 128 | 4 | 548 |
  | `search_strategy` | 105 | 6 | 716 | `read_batch` | 63 | 2 | 339 |
  | `search_extract` | 58 | 4 | 502 | `news` | 88 | 3 | 420 |
  | `deep_search` | 98 | 2 | 347 | `search_jobs` | 35 | 3 | 329 |

  Descriptions total **1,369 chars**, and the full `tools/list` JSON is **≈ 6,221 chars ≈ 1.55k tokens**. The descriptions are short, but **4 of the 16 tools are ops/admin endpoints** (health, engines, provider stats/health, ≈ 616 chars) that the model never needs. Params are loosely typed (comma-separated strings for engines and domains, a free-text `mode` with no enum, `count` with no bounds), and there are no annotations, `outputSchema` or `structuredContent` (no matches for `annotations|outputSchema|structured` in the server file). Our surface (`search`, `fetch`, `receipt`, `suggest_rule`, plus the app-only `apply_rule`) moves health into the dashboard and `doctor` and keeps typed enums.
- [mcp-tool-surface] **Output limits**: the MCP layer returns the API JSON pretty-printed (indent 2) with no MCP-side cap. Bounds come only from the API (snippets ≤ 2k chars, extraction ≤ 15k chars, `max_chars` 200–50,000 on browser fetch). With `search(fetch=true, count=50)`, the response could reach ~750k chars (50 × 15k, inferred). There is no pagination or cursor. A plain `[:max_chars]` slice is the only truncation. We need the §4 budgets and a `cursor`.
- [merge-algorithm] **Their formula** (`app/dedup.py: deduplicate_with_scoring`, MIT): `score = 0.4·(engines_containing_url / distinct_engines_in_batch) + 0.3·domain_authority + 0.3·1/(1 + best_index/10)`. `domain_authority` is a 9-entry table (arxiv and wikipedia 0.9; github, stackoverflow, docs.python.org and MDN 0.8; medium 0.5; reddit 0.4; quora 0.3; default 0.2). Two problems. `best_index` is the index in the **concatenated** raw list, so for `/search/deep` the later query variations are penalized just for coming later (inferred from `app/main.py` lines 1146–1153). And a static authority table hard-codes editorial opinion into ranking. Our RRF uses per-engine rank (`1/(k+rank)`), and authority comes from *user rules and lists* (raise/lower), not code constants. That keeps "explain everything" true.
- [merge-algorithm] **Coverage guarantee** (`_ensure_strategy_coverage`, `app/main.py` lines 797–834): after ranking, every source pack that returned results but has no representative in the top `count` gets its best result swapped in for the lowest-ranked slot. For our `deep` depth, a "≥ 1 result per responding engine" diversity rule is cheap and explainable. Record it as a decision reason (`kept: coverage`).
- [merge-algorithm] **URL normalization for dedup** (`app/dedup.py` `clean_result_url`, `_normalize_url`; SPEC R11): drop 16 tracking keys (`fbclid, gclid, igshid, mc_cid, mc_eid, mkt_tok, msclkid, ref, ref_src, spm, utm_*, ved`), **sort the remaining query params** but keep them (so `youtube.com/watch?v=AAA` ≠ `?v=BBB`; fixture `ranking_edges`), strip `www.` and the trailing slash, and on a merge **keep the longest snippet** and union the engines. Adopt this as the baseline for §5 step 5. Note that it never lowercases the path and has no AMP/mobile handling, which we add.
- [rule-format-precedence] **Exact-or-dot-suffix hostname matching on IDNA-normalized names** (`app/url_utils.py: hostname_matches`), with spoof fixtures (`rand.org.evil.example`). Our domain rules must use this semantics, never substring or `endsWith` without the dot. Port the fixture cases into our property tests.
- [rule-format-precedence] Their include filter is both pushed down (`site:` only when every engine is general/web) *and* applied locally afterwards. Exclude is local only. That matches §5 step 3: push down where the engine supports it, always enforce locally.
- [lists-subscriptions] **Domain-trust heuristics** (`app/domain_trust.py`, MIT):
  - Scoring starts at 0.5. Established domain or subdomain → 1.0. Trusted TLD → ≥ 0.9. Suspicious TLD → ≤ 0.2. Platform host → ≥ 0.6. HTTPS → +0.05, but no HTTPS → ≤ 0.3. Lookalike → ≤ 0.1. WHOIS age < 30 d → ≤ 0.15, < 180 d → ≤ 0.35, > 3 y → +0.15.
  - Tiers: ≥ 0.85 `established`, ≥ 0.5 `standard`, ≥ 0.3 `new`, > 0 `suspicious`, else `unknown`. `unknown` is effectively unreachable, because the only 0.0 path returns early as `suspicious` (inferred, lines 231–235).
  - **Typosquat detection**: Levenshtein of the *first label* against 22 brands (threshold 1 for brands of ≤ 5 chars, else 2), "brand embedded with ≤ 8 extra chars", and a guarded prefix near-match (the "brc" vs "bbc" regression in `tests/test_domain_trust.py`).

  For us these are good **typed seed lists** (`official`, `platform-hosted`, `suspicious-tld`) and a "lookalike" *warning* in receipts. They should not be ranking constants.
- [lists-subscriptions] **The heuristics false-positive, and they hard-block.** `kill_chain` refuses to fetch any URL with `lookalike_of` set, unless the TLD is in `.gov/.edu/.mil/.int`. The code comment there admits that `congress.gov` was flagged as `cnn` (`app/killchain.py` lines 856–872); `evaluate_trust` now skips the lookalike check for its established list and trusted TLDs, so that exact case is patched around, not the detector. `is_safe_url` (`app/fetch_policy.py`) also refuses any host ending in one of 10 hard-coded "suspicious" TLDs (`.tk .ml .ga .cf .gq .buzz .top .xyz .work .click`). The "embedded brand" rule would also flag ordinary names like `purchase…` → `chase` or `applesauce` → `apple` (inferred; untested). Since only the first label is checked, `login.paypa1.com` → base `login` is missed (inferred). For search-hole: heuristic signals **annotate and warn, never hide**. Only explicit user rules or subscribed lists hide results (Principle 2, "explain everything").
- [lists-subscriptions] **SPEC R1–R3**: untrusted feedback can never directly or indirectly mutate a runtime blocklist, and recommendation endpoints are analysis-only. This is independent confirmation of our `suggest_rule` → inbox → user approval model (§12.4). Copy the `evolver_poison` fixture idea: N fabricated model suggestions ⇒ zero rule changes.
- [security] **SSRF technique, the gold standard of the three** (`app/fetch_security.py`, MIT):
  - (1) Scheme must be `http`/`https`. (2) **Reject userinfo** (`user:pass@host`). (3) Hostname is lowercased, the trailing dot stripped, and it is **IDNA-encoded**, failing closed on error.
  - (4) `getaddrinfo(AF_UNSPEC)`. **Every** answer must pass `_public_address`; mixed, empty or failed answers raise.
  - (5) **Connection pinning**: a custom `httpcore` network backend runs validation inside `connect_tcp` and connects to the validated numeric address, so there is no gap between the check and the connect. Each new connection (including each redirect hop's) re-resolves and re-validates on its own; the pin is per connection, not one resolution reused across hops. Unix sockets are refused.
  - (6) `safe_httpx_get` follows redirects manually (`follow_redirects=False`, max 5), re-validating each `Location`.
  - (7) A streamed 5 MiB cap is enforced against both the declared `Content-Length` and the actual decoded bytes.
  - (8) Optional: all egress goes through a separate `fetch-proxy` container with CoreDNS (`docker-compose.yml`).

  The address check is 6 lines (MIT, `app/fetch_security.py` lines 37–42):
  ```python
  def _public_address(value: str) -> str:
      address = ipaddress.ip_address(value)
      if (not address.is_global or address.is_multicast or address.is_reserved
              or address.is_unspecified or "%" in value):
          raise UnsafeURLError(f"Non-global destination blocked: {address}")
      return address.compressed
  ```
  Node port: an undici `Agent({connect: {lookup}})` whose `lookup` calls `dns.lookup(host, {all: true})`, normalizes each answer with `ipaddr.process()` (which unwraps IPv4-mapped addresses), requires `range() === 'unicast'` for every answer (checked against ipaddr.js `main` on 2026-10-29: its special-range tables include CGNAT, `198.18.0.0/15`, `64:ff9b::/96` and `2002::/16`, so those are rejected too; the tables are version-dependent, so pin the version and test it), and returns only validated addresses. Add `maxRedirections: 0` with a manual loop, `headersTimeout`/`bodyTimeout` and a streamed byte counter. Port their `ssrf_targets` fixture, *including the rebind case*, into our mock-engine scenarios (§12.3 "SSRF attempts").
- [security] **Prompt-injection scrubber** (`app/scrubber.py`): 73 detection regexes (plus 7 XSS redaction patterns), encoding normalization (base64, hex, URL, homoglyphs, zero-width), a weighted risk score, then **in-place redaction to `[REDACTED]`**, and above risk 0.8 a warning header plus truncation to 3,000 chars. Rewriting content breaks our receipts' fidelity ("what the AI actually saw") and the dashboard's raw view. We should **flag** instruction-like spans as receipt warnings (master plan §12.4 "later") and wrap all external text as untrusted, not mutate it. Their regex list is MIT and could seed our detector's test corpus.
- [security] Access logs write the **raw query string at INFO level** (`rate_limit_middleware`, `app/main.py` lines 226–235), which includes the user's search queries. That is the kind of leak our §12.4 query hygiene and pino redaction must prevent.
- [security] The kill chain fetches **third-party mirrors** (Wayback CDX, Google Cache, "search-about" coverage on other sites) and rotates **browser user agents** (`USER_AGENTS` in `app/killchain.py` and `app/fetch_policy.py`). It does **no robots.txt** handling (`grep robots` → none). That conflicts with our Principle 8 and §12.4 (honest UA, robots). If we ever offer archive fallbacks, they must be opt-in and recorded as `derived_from` in the receipt.
- [date-extraction] Engine dates are mostly dropped. `SearchResult` has no date field, and SearXNG's `publishedDate` is read only in `/news` and `source_tracer.py` (`app/main.py` line 1594; `app/source_tracer.py` lines 535, 579). Our results table and adapters must carry `published_at`/`updated_at` from the engine as step 1 of the §7 chain.
- [engine-adapter] **The never-throw adapter contract** (`app/search_providers.py: SearchProvider.search`): an adapter always returns `{results, provider, upstream_status, upstream_errors, unresponsive_engines, response_time_ms}`. Errors become data, so fan-out code never needs try/except per engine, and receipts and health get uniform input. Adopt this for our engine port, plus a typed `errorKind` (`timeout | http_4xx | http_429 | quota | malformed | offline`) for the §5.1 matrix.
- [engine-adapter] They parse SearXNG's own `unresponsive_engines` and `errors` fields out of the JSON response (`_normalize_upstream_diagnostics`). Our SearXNG adapter should do the same, so per-upstream-engine CAPTCHA and 429 problems inside SearXNG appear in our health table (§5.1 "SearXNG at agent volume").
- [dashboard-process-model] Their provider stats (rolling 200 latencies, avg and p95, empty/error rates, last error, last success; `_provider_stats_row`, `app/main.py` lines 557–600) are in-memory per process (`_provider_attempt_stats`). With many gateway processes that model breaks, which supports our "gateways write `engine_health` rows to SQLite" design (§4 key-storage paragraph).
- [upgrades-migrations] Their DB evolution uses a `PRAGMA table_info` probe and `ALTER TABLE ADD COLUMN`, and logging is silently disabled when the DB is read-only (`app/database.py` lines 62–66, `app/content_cache.py` lines 77–83). That is simple, but there is no version table, no lock and no "newer schema ⇒ read-only" rule. We need `PRAGMA user_version` (or a migrations table) under a lock, as §4 requires.
- [dual-protocol] The MCP server (AGPL) uses Python `mcp>=1.27.2,<1.28.0` with the low-level `Server` plus `stdio_server` and `create_initialization_options`: a 2025-era `initialize` handshake (`mcp-server/pyproject.toml`). SPEC R21 explicitly bars "MCP 2.x" until a separate migration, and a test pins the line. Errors are returned as tool results with `isError` set and a short human-readable cause: a hint that the API may not be running, a timeout notice, or the HTTP status plus a truncated body (described, not quoted), per SPEC R22. That is the right failure UX for us too: a tool error with a cause and a next step (`searchhole doctor`), never a successful-looking text.
- [testing] Borrow the **answer-key fixture discipline** (input JSON plus expected JSON that "must not be weakened") for SSRF, hostname spoofing, ranking edges (missing or empty `engines` must not divide by zero, SPEC R12) and evolver poisoning. Borrow the **opt-in live tiers** behind env flags too. That fits §12.3 ("no network in CI; nightly optional live check with keys").
- [session-definition] There is no session concept anywhere. Logs are per query with no client or conversation id (`query_log`). It confirms that no competitor offers per-session receipts. Our session ADR is greenfield.
- [distribution] `mcp-server/server.json` uses `registryType: "oci"` (a GHCR image) for the MCP Registry, and the API ships as Docker Compose plus a native script (`scripts/install-native.sh`). Their onboarding needs Docker plus SearXNG prep before the first query works, which is the friction our §13 Q3 no-Docker first-run path must avoid.
- [ui-ux] Engine/strategy modes (`general/code/academic/news/private/reference/community`) map closely onto our **profiles**. The `code` pack (GitHub, MDN, Docker Hub, PyPI) is a ready list of key-less "official source" verticals for the `coding` profile. Their APIs are public and need no keys (`app/search_providers.py`). They are candidates for later adapters, each with its own ToS check.

## Borrow / avoid
**Borrow**
- The SSRF design: `is_global`-style validation of *all* answers, rejecting userinfo, IDNA normalization, pinning the connection to the validated IP, manual redirect re-validation, and a streamed byte cap (`app/fetch_security.py`). Also the SSRF fixture set, including mixed answers, DNS failure and rebind (`tests/fixtures/security/ssrf_targets*.json`).
- The provenance fields `url / fetched_url / derived_from / trust / requested_trust` (SPEC §3, R8–R9) for our `fetches` table and receipts.
- Upstream diagnostics in every response (`upstream_status`, `unresponsive_engines`, `engine_attempts`, `fallback_reason`).
- The never-throw adapter contract with timing.
- Exact-or-dot-suffix hostname matching with spoof fixtures.
- Tracking-param stripping with sorted, retained meaningful params.
- The coverage-guarantee step for `deep`.
- Typed seed lists derived from their sets (platform hosts, suspicious TLDs, an established-domain starter set), with license attribution and curation.
- SPEC R1–R3 ("feedback never mutates lists") as an explicit rule in our threat model, with a poisoning fixture.
- Refusing to send a bearer token over non-loopback plain HTTP, and never reading credentials from the CWD (SPEC R19–R20, described from the spec).

**Avoid**
- Copying anything from `mcp-server/` (AGPL).
- Hard-coded authority constants in the ranking formula, and position bias from concatenated lists.
- Heuristic hard-blocking (lookalike → refuse fetch). WHOIS lookups, which send network calls to hosts the user never chose.
- Content rewriting by the scrubber (redaction or truncation of what the model sees without a raw record).
- UA rotation, cache/archive scraping by default, and no robots handling.
- 16 tools including ops endpoints, loosely typed comma-string params, and pretty-printed unbounded JSON output.
- In-process-only health stats, ad hoc `ALTER TABLE` migrations without versioning, and raw queries in access logs.
- Disk-loaded executable adapters in anything that ships as a plugin.

## Verification
- Date: 2026-10-29. Checked against `research/refs/agent-search` @ f65b7a3. Claims checked: 131 (license header and section, every Implications bullet, and the mechanism claims they rely on: merge formula and tables, URL normalization, domain-trust scoring and tiers, SSRF flow and fixtures, strategy modes, SQLite schemas, scrubber, tool-list measurements, SPEC rules).
- License confirmed: root `LICENSE` is MIT ("Copyright (c) 2026 AgentSearch Contributors"; `pyproject.toml` and `sdk/pyproject.toml` say MIT); `mcp-server/LICENSE` is a 4-line AGPL-3.0 stub and `mcp-server/pyproject.toml`/`README.md` say AGPL-3.0. Only those two LICENSE files exist, and no other directory carries a license header. No AGPL code or verbatim strings are in this note: from `mcp-server/` it uses only tool names, counts and lengths (re-measured with a read-only `ast` parse, no code run) and facts also stated in the MIT `SPEC.md`. The one code excerpt (`_public_address`) is MIT and attributed.
- Re-measured and confirmed unchanged: 16 tools, 1,369 description chars, ≈ 6,221 JSON chars, 616 chars of ops tools, per-tool counts; the 0.4/0.3/0.3 score formula; the 9-entry authority table; the 16 tracking keys; domain-trust set sizes (61 / 5 / 24 / 22 / 8) and every score rule; the SSRF steps (1)–(8) and the `ssrf_targets` cases.
- Corrections:
  1. "Over-fetching 6×" (twice) was misleading: `count*3` on `count*2` is a retention slice, and SearXNG is never sent a result count (only `q`, `format`, `pageno=1`, optional `engines`/`categories`). Reworded, including the consequence for our "over-fetch 2–3×" plan.
  2. "11 direct providers": the code registers 12 (README counts 11; Reddit is in no strategy mode). Fixed in three places.
  3. "85 regexes": the scrubber has 73 detection regexes (48/11/6/8) plus 7 XSS redaction patterns. Fixed in two places.
  4. "106 test functions across 10 files": 113 across 11 (106 module-level plus 7 class methods). Fixed.
  5. "`/ready` is bounded and cached": the code is bounded (5 s probe) but not cached; only SPEC R17 asks for caching. Fixed.
  6. "`deduplicate()` is O(n²)": that function is unused legacy code; the live `deduplicate_with_scoring` computes the denominator once. Fixed.
  7. Pinning description: validation and connect are atomic per connection, but each connection and redirect hop re-resolves; it is not one resolution reused across hops. Fixed.
  8. `site:` push-down also applies when no engines are selected. Added.
  9. Added: `is_safe_url` hard-blocks 10 hard-coded TLDs, and `evaluate_trust` already skips the lookalike check for its established list and trusted TLDs (the `congress.gov` comment describes a case that is now patched around).
  10. Node-port claim `range() === 'unicast'` checked against ipaddr.js `main`: it covers CGNAT, `198.18.0.0/15`, NAT64 and 6to4 (version-dependent). Added.
