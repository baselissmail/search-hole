# searxng/searxng
> Ref: `research/refs/searxng` @ c360868 (2026-10-28) · License: AGPL-3.0-or-later (root `LICENSE`; 353 of 356 Python files under `searx/` carry `SPDX-License-Identifier: AGPL-3.0-or-later`; `engines/github_code.py` has a typo'd variant, and `searx/cache.py` and `enginelib/__main__.py` have no header, so the root LICENSE covers them; `client/simple/package.json` says `AGPL-3.0`; the container label in `container/Dockerfile` says `AGPL-3.0-or-later`; `git ls-files` shows no other LICENSE/COPYING/NOTICE file, so no per-directory licence exceptions. Caveat: third-party data under `searx/data/` (e.g. the fastText model `lid.176.ftz`, Wikidata/DuckDuckGo-bang/Ahmia-derived JSON and text) states no licence of its own in the repo, so do not assume AGPL is the whole story for those files; we copy none of them)

**License hygiene:** everything below is prose and maths that describes mechanisms, with file and symbol citations. No SearXNG code is copied. API parameter names for third-party engines (Brave, Exa, Kagi, Mojeek) are facts about those APIs. They are not SearXNG expression.

## Purpose
SearXNG is a self-hosted metasearch engine (Flask app, served by Granian in the container). It sends one query to many upstream engines in parallel, then merges, dedupes and scores the results. It renders HTML or returns `json`/`csv`/`rss`. For search-hole it plays two roles. First, it is the **default no-key engine** (§5.2): we call it over HTTP (`/search?format=json`), so we only use the network API. Second, it is the **closest prior art** for our engine adapter interface, per-engine timeouts, health and suspension, result merging, and host-based rules (hostnames plugin). At this commit it has 251 engine modules (`searx/engines/*.py` minus `__init__.py`) and 352 engine entries in `searx/settings.yml`.

## Architecture sketch
```
HTTP /search (webapp.py: search)
  ├─ format check: output_format not in settings.search.formats → 403            (webapp.py:655)
  ├─ limiter (before_request) if server.limiter|public_instance                  (limiter.py: filter_request)
  ├─ webadapter.get_search_query_from_webapp → SearchQuery(engineref_list, lang, safesearch, pageno, time_range, timeout_limit)
  │     └─ query.py RawTextQuery parses !engine / !!bang / :lang / <timeout tokens out of q
  └─ search.SearchWithPlugins.search()
        ├─ plugins.pre_search
        ├─ Search._get_requests: per engine → processor.get_params (skip if unsupported/suspended)
        ├─ Search.search_multiple_requests: 1 thread per engine; join(remaining budget)
        │     └─ OnlineProcessor.search → engine.request(query, params) → network.request (curl_cffi on 1 asyncio loop thread)
        │                              → engine.response(resp) → EngineResults
        │                              → ResultContainer.extend(engine, results) ── plugins.on_result per result (hostnames, tracker remover…)
        ├─ plugins.post_search
        └─ ResultContainer.close(): score every merged result; get_ordered_results(): sort + category grouping
```
State is in process memory: the engine registry, `SUSPENDED_STATUS`, metrics counters and histograms. SQLite holds only caches (`searx/cache.py`, `searx/sqlitedb.py`). Valkey is used by the limiter/bot-detection only (plus an optional `valkey_server` engine module).

## Key modules and data flow
**Engine adapter contract** (`searx/enginelib/__init__.py: Engine`, loader `searx/engines/__init__.py`):
- An engine is a **Python module whose module-level attributes are its capability and config record**. `load_engine()` loads the module, then overlays the YAML entry from `settings.yml` (`update_engine_attributes`), then fills gaps from `ENGINE_DEFAULT_ARGS`. Those defaults are: `engine_type="online"`, `paging=False`, `max_page=0`, `time_range_support=False`, `safesearch=False`, `language_support=False`, `categories=["general"]`, `language=""`, `region=""`, `enable_http=False`, `shortcut="-"`, `timeout=outgoing.request_timeout`, `display_error_messages=True`, `disabled=False`, `inactive=False`, `about=EngineAbout()`, `using_tor_proxy=False`, `send_accept_language_header=True`, `tokens=[]`, `weight=1.0`.
- `EngineAbout` (website, wikidata_id, official_api_documentation, `use_official_api`, `require_api_key`, `results` format, description) is descriptive metadata shown in the UI.
- **Required attributes:** any public attribute left as `None` makes the engine fail to load (`is_missing_required_attributes`). Keyed engines instead default `api_key = ""` and raise inside `setup()` (`searx/engines/braveapi.py: setup`, `exaapi.py: setup`, `kagi.py: setup`). A failed load marks the entry `inactive`.
- **Lifecycle:** `setup(engine_settings)` runs synchronously for cheap validation. `init(engine_settings)` runs asynchronously in a thread for remote bootstrapping (`searx/search/processors/abstract.py: EngineProcessor.initialize`). A processor registers only if init succeeds (`processors/__init__.py: ProcessorMap.register_processor`).
- **Online contract** (`processors/online.py`):
  - The processor first builds `params` by merging `RequestParams` (query, pageno, safesearch 0/1/2, time_range day/week/month/year, engine_data, searxng_locale) with `default_request_params()` (method GET, headers, data, json, content, url, cookies, `allow_redirects=False`, `max_redirects=0`, `soft_max_redirects=0`, auth, verify, `raise_for_httperror=True`).
  - `engine.request(query, params)` **only mutates `params`**: url, method, headers, json body, cookies. An empty `url` means "skip this engine".
  - The processor does the HTTP itself. `engine.response(resp)` then parses the response into an `EngineResults` list (`searx/result_types/__init__.py: EngineResults`, with `res.types.MainResult/Video/Image/Paper/...`).
  - So adapters do no I/O, and their parsing can be tested with fixtures.
- Other processor types: `offline` (`search()` method), `online_dictionary`, `online_currency`, `online_url_search` (`processors/__init__.py: ProcessorType`).
- **Pre-filtering of engines** (`abstract.py: EngineProcessor.get_params`) returns `None`, so the engine is **skipped, not called unfiltered**, when:
  - `pageno>1` and the engine has no paging;
  - `pageno > max_page` (engine value or `search.max_page`);
  - the query has a `time_range` and the engine lacks `time_range_support`.

**Result shape** (`searx/result_types/_base.py: Result, MainResult, LegacyResult`):
- Fields: `url`, `engine`, `parsed_url`, `template` (default `default.html`), `title`, `content`, `img_src`, `iframe_src`, `audio_src`, `thumbnail`, `publishedDate` (datetime|None), `pubdate` (string), `length`, `views`, `author`, `metadata`, `priority` (`""|"high"|"low"`), `engines` (set), `positions` (list[int]), `score` (float), `category`, `open_group`, `close_group`.
- Legacy engines still return plain dicts, which are wrapped in `LegacyResult`.
- Normalisation, done on `extend`:
  - Whitespace is collapsed.
  - Title is cut at 200 chars and content at 1200, at word boundaries with an ellipsis (`MAXIMUM_TITLE_LENGTH_CHARS`, `MAXIMUM_CONTENT_LENGTH_CHARS`).
  - `content` is cleared if it equals `title`.
  - A missing scheme becomes `http`.
  - A netloc starting with `xn--` is IDNA-decoded to Unicode.
  - `publishedDate` is dropped if `strftime` raises `ValueError`, which the code comment attributes to pre-1900 dates (`_normalize_date_fields`). Checked on Python 3.13 (macOS, stdlib only): `strftime` accepts years 1, 500, 1850 and 1899 without error, so on a modern Python this guard probably never fires. Do not rely on it as a range check.

**Orchestration and timeouts** (`searx/search/__init__.py: Search._get_requests, search_multiple_requests`):
- The search budget starts as `default_timeout = max(engine.timeout over selected engines)`. With `max_request_timeout` (M) and the user's `timeout_limit` (Q) it becomes:
  - neither set: `default_timeout`
  - only Q: `min(default_timeout, Q)`
  - only M: `min(default_timeout, M)`
  - both: `min(Q, M)`

  Without M, a client can only *lower* the budget. Defaults: `request_timeout: 3.0`; `max_request_timeout` unset (`searx/settings.yml` outgoing; schema in `settings_defaults.py`).
- **One Python thread per engine** is started with a shared `search_id` name. The main thread joins each one with `max(0, budget − elapsed)`. A thread still alive is marked `_timeout`, and the engine is reported as `unresponsive` with `'timeout'`. If it finishes later, `extend_container` drops its results and records a timeout error without suspending (`abstract.py: extend_container`).
- Per-HTTP-call timeout: `searx/network/__init__.py: _get_timeout` = thread timeout + 0.2 s overhead − time already used in this thread. The thread timeout is the search budget above (`search_multiple_requests` passes `actual_timeout` to every engine thread), not the engine's own `timeout`. An engine's own `timeout` only feeds the `max()` that sets the default budget. Calls with no timeout get 120 s.
- When both M and Q are set the budget is `min(Q, M)`, which can be larger than every selected engine's `timeout`. So with M set, a client can also *raise* the budget.
- **Network layer** (`searx/network/network.py: Network`, `client.py: new_client`):
  - All HTTP goes through **one asyncio loop thread** (`client.py: init`) using `curl_cffi` `AsyncSession`, with browser TLS fingerprint impersonation on by default (`DEFAULT_IMPERSONATE="chrome"`).
  - HTTP/2 is on by default and HTTP/3 is opt-in per engine. Cookies are discarded. HTTPS only, unless `enable_http`.
  - `max_clients = pool_connections` (100).
  - One `Network` exists per engine, or is shared through `network: <name>` references (e.g. qwant, yandex, mojeek variants in `settings.yml`).
  - Clients are cached per key: (verify, max_redirects, local_address, proxies, impersonate, curl_opts, http3).
  - **Source IPs and proxies rotate round-robin** per client fetch (`get_ipaddress_cycle`, `get_proxy_cycles`).
  - **Retries** (`call_client`): `outgoing.retries` (default 0), and `retry_on_http_error` may be a bool, a status code or a list. Each retry uses a fresh client, so the next IP or proxy. A server disconnect (`CurlConnectionError`) gets one free reconnect that does not use up a retry.

**HTTP status mapping** (`searx/network/raise_for_httperror.py: raise_for_httperror`), applied for any status ≥ 400:
1. Cloudflare challenge (only when the response `Server` header starts with `cloudflare`: 429/503 with `__cf_chl_jschl_tk__` or the challenge-platform markers, or 403 with `__cf_chl_captcha_tk__`) → `SearxEngineCaptchaException` with `cf_SearxEngineCaptcha` time.
2. Cloudflare firewall (same `Server` header condition; 403 + error code 1020) → `AccessDenied` with `cf_SearxEngineAccessDenied` time.
3. 503 + `google.com/recaptcha` → Captcha with `recaptcha_SearxEngineCaptcha` time.
4. 402/403 → `SearxEngineAccessDeniedException`.
5. 429 → `SearxEngineTooManyRequestsException`.
6. Anything else → a generic HTTPError.

Engines add their own detection. Examples:
- Google `sorry.google.com`, a 302, or a <2000-byte body containing `/sorry/` (`engines/google.py` ~L262-280).
- DuckDuckGo CAPTCHA, or a missing `vqd` on page>1, raises CAPTCHA with `suspended_time=0` ("ddg does not block the IP") (`engines/duckduckgo.py` ~L405-477).
- xprivo maps 400/429 to TooManyRequests (`engines/xprivo.py: response`).
- Startpage raises CAPTCHA when its "Anubis" proof-of-work is too hard (`engines/startpage.py` ~L193-265).

**Suspension** (`abstract.py: SuspendedStatus, handle_exception`; exceptions in `searx/exceptions.py`):
- Errors that suspend the engine (`suspend=True`): `ssl.SSLError`, timeouts, `RequestException`, Captcha, TooManyRequests and AccessDenied (`online.py: OnlineProcessor.search`). Any other exception, such as a parse error, is counted but **does not suspend**.
- Duration: an AccessDenied subclass carries its own `suspended_time`, and `0` means no suspension. Otherwise the duration is `min(max_ban_time_on_fail, ban_time_on_fail)`, which is `min(120, 5) = 5 s`.
- `continuous_errors` is incremented but **not used** in that calculation, so there is **no exponential backoff at this commit**.
- Any successful response calls `resume()`, which resets the status.
- The status is keyed by `id(network)`, so engines sharing a `network:` reference are suspended together.
- While suspended, the engine is skipped and listed in `unresponsive_engines` with `suspended=True` (`extend_container_if_suspended`).
- Effective times in the shipped `searx/settings.yml` (the base when `use_default_settings: true`):

  | Error | Suspension |
  |---|---|
  | AccessDenied 180 s (402/403) | 3 min |
  | Captcha 3600 s | 1 h |
  | TooManyRequests 180 s (429) | 3 min |
  | Cloudflare CAPTCHA 1 296 000 s | 15 days |
  | Cloudflare firewall 86 400 s | 1 day |
  | reCAPTCHA 604 800 s | 7 days |

  The schema fallbacks in `settings_defaults.py` and `docs/admin/settings/settings_search.rst` are larger: 86400/86400/3600. The shipped YAML wins.

**Metrics** (`searx/metrics/__init__.py`, `error_recorder.py`), all in memory:
- Counters per engine: `search.count.sent`, `successful`, `error`, and `score`.
- Histograms: result count per request (1-wide, 100 buckets); `time.http` and `time.total` (0.1 s buckets, size `1.5·max_timeout/0.1`).
- Errors are grouped by `ErrorContext`: file, function, line, code, exception class, log message, log params, and a `secondary` flag (soft-redirect warnings are secondary).
- Per-context share: `round(20·count/sent)·5`, i.e. rounded to 5 % steps.
- **Reliability = 100 − Σ shares of non-secondary error contexts** (`get_reliabilities`).
- Exposed at `/stats` (HTML), `/stats/errors` (JSON) and `/metrics` (OpenMetrics, Basic-auth password `general.open_metrics`).
- Each response also carries a `Server-Timing` header with `total_<i>_<engine>;dur=ms` and `load_<i>_<engine>;dur=ms` per upstream engine (`webapp.py: post_request`).

**Checker:** not present at this commit. There is no `searx/search/checker`. The processor `get_tests`/`get_default_tests` are marked "deprecated!" (`abstract.py` L306-312), and `tests/__init__.py` still has a stale comment mentioning `searx.search.checker`. Health is purely passive: suspension plus the reliability metric.

## Data model and storage
- **No search log.** Queries and results live only for the length of a request (`ResultContainer`). Privacy is a core value: the limiter stores only hashed IPs (`valkeylib.py: incr_sliding_window`). The `botdetection/ip_limit.py` docstring says "a maximum of 10 minutes", but the same file's constants are a 20 s burst window, a 10 min long window, a 1 h window for non-HTML formats (`API_WINDOW`) and a 30-day window for IPs flagged suspicious (`link_token` on).
- **SQLite caches** via `searx/sqlitedb.py: SQLiteAppl`:
  - WAL journal mode, connect `timeout=3.0`, `check_same_thread` off only when sqlite threadsafety is "serialized", `cached_statements=0` to work around CPython issues 118172/123873.
  - A `properties` table holds `DB_SCHEMA`. A version mismatch raises `sqlite3.DatabaseError` (`sqlitedb.py: SQLiteAppl.init`). Nothing in the tree migrates or recreates the file; the docstring only says a schema bump requires the DB to be recreated or migrated. The default cache files live in `/tmp/sxng_cache_<name>.db`, so they are throwaway by design (acceptable for caches only).
  - `ExpireCacheSQLite` (`searx/cache.py`) is a key/value store with expiry and one table per context. Keys can be HMAC-hashed with `server.secret_key`. If the secret changes, all cache tables are truncated on the next init (the `hash_token` property in `ExpireCacheSQLite.init`). Maintenance runs `PRAGMA wal_checkpoint(TRUNCATE)`.
  - `ENGINES_CACHE` holds at most 7 days, runs maintenance hourly and sets `MAX_VALUE_LEN = 1024*1024*1024` (the inline comment says "1MB", the arithmetic is 1 GiB; the generic default in `cache.py` is 10 KB) (`enginelib/__init__.py`). Engines store tokens there. Examples: the DuckDuckGo `vqd`, keyed by a hash of the query; the Mojeek ALTCHA cookie `chllg` (`engines/mojeek.py: _captcha_token`); the Startpage auth cookie.
- **Valkey** holds limiter sliding windows (`searx/valkeylib.py: incr_sliding_window`).
- **Static data** in `searx/data/*.json` (engine traits, external bangs, user agents, …) is regenerated by `searxng_extra/update/*.py` scripts at development time.

## Config format
- **`settings.yml`** (YAML). The schema is `searx/settings_defaults.py: SCHEMA`. Each leaf is a `SettingsValue(type-or-allowed-values, default, ENV_NAME)`, and errors are reported with dotted paths. Some sections are `msgspec.Struct`s.
- **Overlay rules** (`searx/settings_loader.py: update_settings`):
  - With `use_default_settings: true` the user file is deep-merged onto the shipped defaults. Dicts merge and lists replace.
  - `plugins:` **replaces the whole plugin map**.
  - `engines:` entries merge into defaults **by `name`**; unknown names are appended. Filters: `use_default_settings.engines.keep_only` / `.remove`.
- **Settings file location:** `SEARXNG_SETTINGS_PATH` (a file or folder), otherwise `/etc/searxng`.
- **Env overrides:** `SEARXNG_SECRET`, `SEARXNG_PORT`, `SEARXNG_BIND_ADDRESS`, `SEARXNG_BASE_URL`, `SEARXNG_LIMITER`, `SEARXNG_PUBLIC_INSTANCE`, `SEARXNG_IMAGE_PROXY`, `SEARXNG_METHOD`, `SEARXNG_VALKEY_URL`, `SEARXNG_DEBUG`.
- **Key sections for an API client like us:**
  - `search.formats`: the shipped `settings.yml` lists **only `html`** (the schema fallback in `settings_defaults.py` is all four). Requesting `json`, `csv` or `rss` while it is not listed gives **HTTP 403** (`webapp.py:655`). An unrecognised `format=` value silently falls back to `html` (`webapp.py:651-652`), so a typo gives HTML, not an error.
  - `server.secret_key`: the app **exits on start** if it is still `ultrasecretkey` and debug is off (`webapp.py: init` L1378-1382).
  - `server.limiter` (default false), `server.public_instance` (default false; forces the limiter and `link_token`).
  - `outgoing.request_timeout`, `max_request_timeout`, `pool_connections`, `retries`, `proxies`, `source_ips`, `networks`.
  - `search.ban_time_on_fail`, `max_ban_time_on_fail`, `suspended_times`, `max_page`.
- **Engine entry keys:** `name` (lowercase, no `_`), `engine` (module), `shortcut`, `categories`, `disabled` (off by default but loaded and selectable), `inactive` (not loaded), `timeout`, `weight`, `network`, `api_key`, `tokens` (private engine), `display_error_messages`, plus any module attribute.
- **`limiter.toml`** (TOML; the schema is the shipped `searx/limiter.toml`, overridden from `<settings dir>/limiter.toml`):
  - `botdetection.ipv4_prefix=32`, `ipv6_prefix=48`
  - `trusted_proxies` = 127.0.0.0/8 and ::1
  - `ip_limit.filter_link_local=false`, `link_token=false`
  - `ip_lists.block_ip`, `pass_ip`, `pass_searxng_org=true`
- **Container** (`container/`):
  - Image `docker.io/searxng/searxng:<tag>`, with tags like `2026.3.25-541c6c3cb` (`.env.example`).
  - Granian WSGI on `::` port 8080, with `GRANIAN_BLOCKING_THREADS=4`.
  - Volumes `/etc/searxng` (config) and `/var/cache/searxng` (data); files are `chown`ed to uid/gid 977. This Dockerfile has no `USER` line, so the runtime user comes from the base image (`searxng/base`) (unverified).
  - `entrypoint.sh` copies `settings.template.yml` (`use_default_settings: true`, `secret_key: ultrasecretkey`, `image_proxy: true`) **only when no `settings.yml` exists in the config volume**, and replaces the secret in that fresh copy with 24 random bytes (base64, non-alphanumerics stripped). It never touches a `settings.yml` we mount ourselves.
  - The compose file adds a Valkey service, which is only needed for the limiter.
  - The compose port mapping binds **all interfaces unless `SEARXNG_HOST` is set** (`docker-compose.yml` ports line).

## Extension points (plugins, hooks)
- **Engines:** drop-in modules (above), with per-engine `network`, `proxies` and `tokens` (private engines visible only to clients that hold a token: `preferences.validate_token`).
- **Plugins** (`searx/plugins/_core.py: Plugin, PluginStorage`):
  - Configured by fully qualified name under `plugins:` with `active: bool`.
  - Hooks: `init(app)` (return False to remove the plugin), `pre_search(request, search) → bool` (False stops the search), `on_result(request, search, result) → bool` (False drops the result), and `post_search(request, search)`.
  - `keywords` gate plugins that respond to special queries.
  - `PluginInfo` carries id, name, description and preference_section.
  - `PluginStorage.plugin_list` is a Python **set**, so hooks run in unspecified order (not registration order). The first False short-circuits. An exception inside a hook is logged and that plugin is skipped. Plugins like `hostnames` and `tracker_url_remover` therefore have no guaranteed relative order.
  - Each request's `user_plugins` = default-active plugins minus those the user disabled in cookie preferences (`webapp.py` ~L535-540). So API clients get the defaults.
- **`Result.filter_urls(fn)`** (`_base.py: _filter_urls`): one callback is applied to every URL field (`url`, `iframe_src`, `audio_src`, `img_src`, `thumbnail_src`, `thumbnail`, infobox `urls`, attribute images). It returns True to keep the URL, False to drop it, or a string to rewrite it. Exceptions are logged and the field is skipped. `parsed_url` is re-synced afterwards.
- Answerers (`searx/answerers/`), external bangs (`searx/external_bang.py`), result types (`searx/result_types/`).

## Rules / lists: parsing and compilation
**Hostnames plugin** (`searx/plugins/hostnames.py: SXNGPlugin`):
- **Config:** top-level `hostnames:` with four keys:
  - `replace`: a mapping regex → replacement host
  - `remove`: a list of regexes
  - `high_priority`: a list
  - `low_priority`: a list

  Any key may be a **filename** instead, loaded relative to the settings folder (`settings_loader.get_yaml_cfg`). If there is no `hostnames:` key, `init` returns False and the plugin disappears.
- **Compilation:** `re.compile` at init. Lists become **sets**, so iteration order is arbitrary; replace becomes an insertion-ordered dict.
- **Matching:** `pattern.search(parsed_url.netloc)`. The match is **unanchored at the start** and runs against the netloc as written (not lowercased), which can include `user@` and `:port`. The idiom in the module docstring (an optional subdomain prefix, then `facebook.com`, then an end anchor) therefore also matches `notfacebook.com`, because `search` finds the `facebook.com` plus end-anchor tail inside it, and the unescaped `.` matches any character.
- **Order inside `on_result`:**
  1. If any `remove` pattern matches the result's netloc, the result is dropped.
  2. `filter_urls(filter_url_field)` runs: in each URL field, `remove` drops just that field (e.g. a thumbnail), and the first matching `replace` rewrites the netloc via `pattern.sub`.
  3. Every `low_priority` match sets `priority="low"`.
  4. Every `high_priority` match sets `priority="high"`. High therefore **wins over low**, as documented in the module docstring.
- **Where it runs:** inside `ResultContainer.extend`, per incoming engine result, **before** dedupe and scoring. Rewritten URLs are therefore what gets hashed. Removed results are counted *before* `main_count` increments (`results.py` L95-102), so they **do not use up a rank position** for that engine's later results.
- **Scope:** instance-wide only. There is no per-request override, which confirms plan §5 step 3.
- **Tracker remover** (`plugins/tracker_url_remover.py`, `searx/data/tracker_patterns.py: TrackerPatternsDB`):
  - At first init it fetches ClearURLs rules from a **mirror fallback chain** (jsdelivr gh-pages → `rules2.clearurls.xyz` → `rules1…`, 3 s timeout each, first HTTP 200 wins), and fixes JS-regex escaping.
  - It stores (urlPattern, exceptions, rules) in the SQLite cache and loads them only once (property `"tracker_patterns loaded"`). A "F I X M E" comment says there is no refresh.
  - `clean_url` re-matches every rule, skips URLs that hit an exception, deletes query args that match `rules`, and stops early when no query is left.
  - This also runs before hashing, which improves dedupe.
- **Ahmia filter** (`plugins/ahmia_filter.py`): an offline-fetched list (`searxng_extra/update/update_ahmia_blacklist.py`; 59,303 lines in `searx/data/ahmia_blacklist.txt`) of **md5-hashed onion hostnames**. `ahmia_blacklist_loader` returns a Python **list**, so the check is a linear `in` scan, not a set lookup. The plugin only activates when `outgoing.using_tor_proxy` is set and only looks at results flagged `is_onion`. It is a shipped-blocklist pattern, not an efficient matcher to copy.

**Merging and scoring** (`searx/results.py`):
- **Dedupe key** = `MainResult.__hash__`: `template | netloc | path | params | query | fragment | img_src`.
  - The **scheme is excluded**, so http and https merge.
  - No case folding, no `www.` stripping (an older `netloc.replace("www.","")` is left commented out in `_normalize_url_fields`), no trailing-slash, default-port or query-order normalisation, and the fragment is kept.
  - Because `template` is part of the key, results rendered with different templates never merge. For example `braveapi` emits every web hit as `Video` (`engines/braveapi.py: response` → `brave.parse_video_result`, `template="videos.html"`), so the same URL from Brave API and DuckDuckGo stays duplicated.
- **Merge** (`merge_two_main_results`):
  - The longer `content` wins and the longer `title` wins.
  - `defaults_from` is meant to copy fields the kept result lacks, but the code only copies a field when the kept result does not have the attribute or key at all (an `UNSET` sentinel). Every field of a typed `MainResult` has a default (`""`, `None`, `0`), so by code reading nothing is ever copied for typed results; for dict-style `LegacyResult` only keys absent from the kept dict are copied (e.g. `author`, `length`), while `publishedDate` is pre-initialised to `None` and is not. An empty value in the *other* result is never copied. This is inferred from reading the code, not from running it.
  - The engine is added to the `engines` set.
  - The scheme is upgraded to https if the other result has it.
  - The new rank is appended to `positions`. The same engine returning the same URL twice therefore adds two positions.
- **Score** (`calculate_score`, run in `close()`). For a merged result r with engines E(r), positions P(r) (1-based rank within each engine's surviving list) and n = |P(r)|:

  W(r) = (Π_{e∈E(r)} weight_e) · n

  score(r) = Σ_{p∈P(r)} W(r)/p     if priority = ""
  score(r) = n · W(r)               if priority = "high" (the 1/p rank decay is removed)
  score(r) = 0                      if priority = "low"

  Examples:
  - One engine at rank 1: score = 1.
  - Two engines at ranks 1 and 3: W = 2, score = 2 + 2/3 ≈ 2.67.
  - "high" at rank 10, one engine: score = 1, which **only ties** a normal rank-1 hit. A two-engine normal hit at ranks 1 and 1 scores 4 and beats it. "High" is a boost, not a pin.

  The weights are **multiplied**: an engine with `weight<1` that agrees with another engine gives a *lower* merged score than the same agreement with a weight-1 engine (it can still beat the other engine's solo score). Examples in `settings.yml`: `wikidata` has `weight: 2` and several engines have `weight: 0.5`.
- **Ordering** (`get_ordered_results`):
  1. Sort by score, descending.
  2. A **category grouping pass** follows: results with the same `category:template:has-image` key are pulled together. After a group's first result, at most 8 further results are inserted next to it, and only while the group's insert point is fewer than 20 slots back. The final order, including the JSON `results` array, is therefore *not* pure score order.

  `category` = the first category of `res.engine`, the first engine that contributed the result.

## Testing strategy
- `tests/unit/` uses `aiounittest`. `SearxTestCase` sets `SEARXNG_SETTINGS_PATH` to a fixture YAML per test class (`TEST_SETTINGS`; fixtures in `tests/unit/settings/`, e.g. `test_result_container.yml` keeps only google and duckduckgo). It disables `/etc/searxng` via `SEARXNG_DISABLE_ETC_SETTINGS=1` and offers `setattr4test` for patch-with-cleanup (`tests/__init__.py`).
- **Covered:**
  - result container merge, including the http-vs-https merge where the longer title/content wins (`tests/unit/test_results.py: test_merge_url_result`)
  - timeout budget arithmetic for all four M/Q cases (`tests/unit/test_search.py: test_timeout_*`)
  - network retries and IP/proxy cycles (`tests/unit/network/test_network.py: test_retries_*`, `test_ipaddress_cycle`, `test_proxy_cycles`)
  - processor params (`tests/unit/processors/test_online.py`), query syntax (`test_query.py`), settings loader overlays (`test_settings_loader.py` with `user_settings_keep_only.yml`, `_remove.yml`), plugins (`test_plugins.py`)
- **Engine parser tests exist for only a handful of engines** (`test_engine_brave.py`, `test_engine_wikidata.py`, `test_engine_tineye.py`, `test_engine_github_code.py`, `tests/unit/engines/test_json_engine.py`, `test_xpath.py`). Most scrapers have no fixture tests, which matches the frequent engine-breakage commits (e.g. HEAD is "xprivo: properly detect ratelimits").
- Robot tests drive a live instance on port 11111 with `splinter` (`tests/robot/__main__.py`, `settings_robot.yml`, `request_timeout: 1.0`).
- The `Makefile` `test` target runs yamllint, black, pyright (modified files only), pylint, unit, robot, rst, shellcheck and shfmt.

## UX patterns worth copying
- **`/stats`** sorts engines by name, reliability or time. It shows p50/p80/p95 for total, HTTP and processing time, score per result, and a per-engine **error table with percentage share, exception class, file:line and code** (`webapp.py: stats`, `get_engine_errors`). Our dashboard's engine-health view should show the same things: reliability %, latency percentiles, and the error breakdown by class.
- **Error text for users:** the exception class maps to short phrases (`webutils.py: exception_classname_to_text`), for example "timeout", "CAPTCHA", "too many requests", "access denied", "parsing error", "HTTP connection error", "SSL error". A "Suspended: " prefix is added when the engine is suspended (`get_translated_errors`). It is a good small taxonomy for receipt lines like "Brave suspended (429) until 14:05".
- **`/config` JSON** (`webapp.py: config`) gives version, engine list (enabled, categories, paging, `time_range_support`, safesearch, timeout, languages), plugin states and limiter status. `/healthz` returns `OK` and skips the limiter. These suit `searchhole doctor`.
- Engine `about` metadata (official API or scraper, key required, results format) is displayed to users. We should show the same next to each engine.

## Performance tricks
- A single shared asyncio loop thread with pooled curl_cffi sessions keyed by connection traits. HTTP/2 by default. `pool_connections: 100` (`network/network.py: get_client`, `client.py`).
- Per-thread HTTP time accounting separates "http" from "processing" time (`network/__init__.py: _record_http_time`, `THREADLOCAL.total_time`).
- Result types use `msgspec.Struct`. Settings are validated through msgspec.
- The container image precompiles bytecode (`compileall --invalidation-mode=unchecked-hash`) and pre-compresses static files (gzip and brotli) (`container/Dockerfile`).
- Engine token caches in SQLite avoid re-bootstrapping (DuckDuckGo vqd, Mojeek ALTCHA solution, Google CSE token).
- An early `break` in tracker cleaning once no query string is left (`tracker_patterns.py: clean_url`).

## License and what it means for us
The root `LICENSE` (AGPL-3.0) is the repo's only licence file and the SPDX headers cover the Python, docs and frontend sources. Third-party data files under `searx/data/` (see the header caveat) state no licence of their own, so treat them as separately encumbered. **We copy no code, docs text or data files from it.** We describe ideas only, as done in this note. **Calling a SearXNG instance over HTTP is fine.** It is a separate program, and the AGPL network clause binds whoever runs a *modified* SearXNG for users. Our recommended bundled setup has three parts:
- a `compose.yaml` that pulls the upstream image;
- a settings overlay that we write ourselves, which is config, not SearXNG code;
- the instance bound to localhost.

That setup does not modify SearXNG. We should still link to SearXNG's source and license in our docs. If we ever ship a patched SearXNG image, we must publish those patches under AGPL. The ClearURLs rules that SearXNG downloads have their own license (believed LGPL-3.0; **verify** before reusing the list directly).

## Implications for search-hole
- [engine-adapter] **SearXNG adapter (P1):** `GET /search?q=…&format=json&language=all|<locale>&pageno=1&safesearch=0|1|2&categories=general[&engines=a,b][&time_range=day|week|month|year][&timeout_limit=N]` (`webadapter.py`, `docs/dev/search_api.rst`; the docs list only day/month/year for `time_range`, the code also accepts `week`; `engines` and `timeout_limit` are in the code, not in `search_api.rst`).
  - `engines` and `categories` are **unioned**, not intersected (`parse_generic`): `categories=general&engines=brave` queries every general engine plus brave. To restrict to named engines, send `engines=` **without** `categories`.
  - Unknown or unloaded engine names in `engines=` are **silently dropped**. If none are valid, the request falls back to the default categories (usually `general`) and still returns 200. Validate names against `/config` before sending.
  - Always send `language=` explicitly. If it is missing, the shipped `default_lang: "auto"` resolves to the client's `Accept-Language` locale, or `all` when there is none (`webadapter.py: get_search_query_from_webapp`, the `query_lang == 'auto'` branch), so a bare `Accept-Language: en` would pin results to English.
  - Parse `results[]`: url, title, content, engine, engines[], positions[], score, publishedDate (ISO string or null, via `webutils.JSONEncoder` `isoformat`), pubdate, category, template, priority, thumbnail, author.
  - Also parse `unresponsive_engines` (sorted `[name, message]` pairs), `suggestions`, `corrections`, `answers`, `infoboxes` (`webutils.py: get_json_response`). There is **no `number_of_results`** field at this commit.
- [engine-adapter] **Treat SearXNG as one engine in our fusion.** Use its rank by **`score` descending**, not array order, because the array includes the category-grouping pass (`results.py: get_ordered_results`). Store `engines[]` per result so receipts can say "via SearXNG (duckduckgo, brave)".
- [engine-adapter] **Freshness pushdown narrows the engine set:**
  - With `time_range`, SearXNG silently **skips** upstream engines without `time_range_support` (`abstract.py: get_params`). The receipt should note "freshness filter applied by n of m upstream engines".
  - It only offers day/week/month/year, so map `maxAgeDays` to the next bucket up and filter exactly on our side.
- [engine-adapter] **Timeouts:** our client timeout for SearXNG must exceed its own budget, plus ~0.2 s per-call overhead and render time. The budget is the 4-case table above: max(engine timeouts) when neither limit is set, `min(max, Q)` with only `timeout_limit` (Q), `min(max, M)` with only `max_request_timeout` (M), and `min(Q, M)` with both (which can exceed max(engine timeouts)). Pass `timeout_limit` explicitly (e.g. 4 s for `standard`) and set our HTTP timeout to timeout_limit + 1.5 s. Without `max_request_timeout` set in the instance, `timeout_limit` can only *lower* the budget, so the overlay needs M ≥ our largest Q (`search/__init__.py: _get_requests`). The 1.5 s margin is our own choice, not derived from SearXNG.
- [engine-adapter] **Concurrency:** the container runs Granian with `GRANIAN_BLOCKING_THREADS=4` (`container/Dockerfile`), so we infer about 4 concurrent searches per worker. Default our per-instance concurrency limit to ≤ 4 and queue the rest; `deep` fan-out would otherwise pile up (inferred).
- [engine-adapter] **Upstream health through SearXNG:**
  - Read `unresponsive_engines` and the `Server-Timing` header (`total_<i>_<engine>;dur=`) on every response (`webapp.py: post_request`).
  - Send `Accept-Language: en` so the message strings are stable English. They are gettext-localised from the browser locale (`webapp.py` ~L527-531).
  - Map the messages to our error classes, and detect the "Suspended: " prefix.
  - Write upstream health to `engine_health` as sub-rows under the SearXNG engine.
- [engine-adapter] **Adapter interface (TS):**
  - Keep SearXNG's split into a pure `buildRequest(query, ctx) → HttpRequest | null` and a pure `parseResponse(res, ctx) → RawResult[]`. The core owns transport: SSRF guard, timeouts, retries, metrics. Adapters are then fixture-testable with no network.
  - Add a typed `capabilities` record instead of module attributes: paging, maxPage, timeRange buckets or exact dates, safesearch, locale, domainInclude/Exclude, goggles, returnsPublishedDate, requiresKey, officialApi, resultsFormat, `retention`.
  - Add `setup()` (sync validation; a missing key means "inactive, explain why") and an optional async `init()`.
- [engine-adapter] **Suspension policy, better than SearXNG's:**
  - Keep per-error-class base durations (429 → honour `Retry-After`, else 180 s; CAPTCHA 1 h; 402/403 or auth 1 day, or until the key changes; timeout or network 5 s).
  - Add **exponential backoff on consecutive failures**. SearXNG increments `continuous_errors` but never uses it (`abstract.py: SuspendedStatus.suspend`).
  - Don't suspend on parse errors; flag them as "adapter broken".
  - Reset on success.
  - **Persist in SQLite** so all gateway processes share it, where SearXNG keeps it per process (`SUSPENDED_STATUS`).
- [engine-adapter] **Reliability metric for the dashboard:** reliability = 100 − Σ(share of each non-secondary error class), with shares in 5 % buckets (`metrics/__init__.py: get_engine_errors, get_reliabilities`), plus p50/p80/p95 total and HTTP latency per engine. All of it can be computed from our `searches` and `engine_health` rows.
- [merge-algorithm] **Don't adopt SearXNG's formula.** score = n·(Πw)·Σ1/p over-rewards agreement quadratically. Its multiplied weights mean a `weight<1` engine drags down the merged score of results it co-finds (relative to a weight-1 engine), and "high" priority only removes rank decay, so it is not a pin (`results.py: calculate_score`).
  - Use RRF: score = Σ_e w_e/(k + rank_e), with **additive** per-engine weights and k≈60.
  - Then apply raise/lower multipliers (1+0.15·N) and the separate pin tier from plan §5 step 6.
  - Borrow one idea: count multi-engine agreement as evidence.
- [merge-algorithm] **Canonical URL for dedupe must be stronger than SearXNG's**, whose key is template|netloc|path|params|query|fragment|img_src, with the scheme excluded and nothing else normalised (`_base.py: MainResult.__hash__`):
  - lowercase the host, strip `www.`, IDNA to Unicode or punycode consistently (SearXNG decodes only when the netloc starts with `xn--`), drop default ports and the fragment, sort query params, strip tracking params, normalise the trailing slash, collapse AMP/mobile variants;
  - **never include the presentation type in the key** (the braveapi Video-template duplicate problem).
- [merge-algorithm] **Merge-field policy to borrow (idea):** SearXNG's `merge_two_main_results` keeps the longer title and the longer snippet, unions the engines, keeps every rank in `positions`, and prefers https. It intends to fill missing fields from the duplicate, but by code reading that is effectively a no-op for typed results (see "Merge" above; inferred). SearXNG has **no date-merge logic**: "keep the earliest *known* publishedDate with its source recorded" is our own proposal, not borrowed behaviour.
- [rule-format-precedence] **Hostnames lessons:**
  - Use **label-boundary domain-suffix matching by default** (`pinterest.com` matches `pinterest.com` and `*.pinterest.com`, never `notpinterest.com`). SearXNG's unanchored `re.search` on netloc makes its documented optional-subdomain-prefix idiom for `facebook.com` also match `notfacebook.com` (`plugins/hostnames.py: on_result`). Offer regex only as an explicit `match: regex:` form.
  - Use deterministic precedence (pin > block > lower/raise, or whatever the ADR fixes) and a recorded rule id. SearXNG uses unordered sets, and "high beats low" happens only because high runs last.
- [rule-format-precedence] **Where rules run:** SearXNG applies host rules per result *before* merge, and removed results don't use up a position. For explainability we should record every hidden result with its **raw engine rank**, and compute RRF on raw ranks (pre-block) so blocking one site doesn't shift other results' evidence. Decide this in the merge ADR.
- [rule-format-precedence] **Pushdown into a managed SearXNG** (global rules only, §5.3):
  - Compile *remove* rules into `hostnames.remove` as **anchored, escaped, case-insensitive** regexes that tolerate a port, e.g. `(?i)^(.+\.)?pinterest\.com(:\d+)?$` (the plugin runs `search` on the raw netloc, which is not lowercased and can carry `:port` or `user@`; a bare `$`-anchored pattern would miss `Pinterest.com` and `pinterest.com:443`). Put them in an external file referenced from our overlay (a string value is loaded relative to the settings folder, `get_yaml_cfg`).
  - Never write `plugins:`, because it replaces the whole plugin map (`settings_loader.py: update_settings`).
  - Restart the container after changes.
  - Always re-filter locally, because SearXNG's `remove` does not tell us *which* results it dropped.
- [security] **Query-syntax tokens are interpreted anywhere in `q`** (`searx/query.py: RawTextQuery._parse_query`):
  - `!name` selects an engine or category;
  - `!!bang` (only when the bang exists in the external-bang data) turns into an **HTTP redirect to an external site even when `format=json`**, because the redirect is checked before the JSON branch (`webapp.py` L687-688);
  - `!!` alone is a "feeling lucky" redirect, but that is handled after the json/csv branches (`webapp.py` L719), so it only applies to html and rss output, not to `format=json`;
  - `:xx` sets the language (only if it parses as a valid language);
  - `<N` sets a timeout (e.g. "i <3 python" becomes a 3 s timeout; N below 100 is seconds, 100 or more is milliseconds). It feeds `timeout_limit`, so a stray `<1` shrinks the whole search budget. Recognised tokens are removed from the query text.

  So the adapter must:
  - neutralise recognised tokens (e.g. wrap the token in quotes, or drop the leading sigil and record that in the receipt);
  - pass engines and language only through form params;
  - use `redirect: 'manual'` and treat any 3xx from `/search` as an error.
- [security] **Bundled container hardening:**
  - Bind `127.0.0.1:8888:8080`. The upstream compose binds all interfaces unless `SEARXNG_HOST` is set, and the JSON API has no auth.
  - Generate `SEARXNG_SECRET` ourselves and pass it as an env var (it overrides `server.secret_key`). The entrypoint only randomises the secret when it creates a fresh `settings.yml` from its template; it does nothing for a `settings.yml` we mount. The app exits if the key is still `ultrasecretkey` (`container/entrypoint.sh: setup`; `webapp.py: init`).
  - Keep `server.limiter: false` and `public_instance: false` for a local instance.
- [security] **Limiter blocks API clients:** the limiter is installed only if `server.limiter` or `public_instance` is true **and** Valkey is reachable (with `limiter: true` but no Valkey it logs an error and silently does nothing; `public_instance` exits instead). Once on, requests whose `format` query arg is not `html` are limited to **`API_MAX = 4` requests per hour per IP** (`botdetection/ip_limit.py`). The following extra checks return 429, and the User-Agent check applies to **every route except `/healthz`**, not only `/search`:
  - `Accept` does not accept `text/html` (a `*/*` wildcard probably passes werkzeug's matching; not verified);
  - `Accept-Encoding` lacks both gzip and deflate;
  - `Accept-Language` is empty;
  - the User-Agent matches a bot regex (curl, python-requests, Go-http-client, HeadlessChrome, …), matched from the start of the UA string (`botdetection/http_*.py`, `limiter.py: filter_request`).
  - Only the Accept, Accept-Encoding, Accept-Language, Sec-Fetch and ip_limit checks are limited to `/search`.

  For user-supplied or public instances, `doctor` must detect three cases: 403 means json is disabled; 429 means the limiter is on (or the UA is on the bot list); `/config` reporting `limiter.enabled` means advise `pass_ip` or turning the limiter off. As a courtesy, always send a browser-like Accept/Accept-Encoding/Accept-Language.
- [distribution] **compose.yaml and doctor:**
  - Pin a dated image tag (`2026.x.y-<sha>`, not `latest`).
  - Mount our own `/etc/searxng/settings.yml`: `use_default_settings: true`, `search.formats: [html, json]`, `server.secret_key`, `server.limiter: false`, `outgoing.request_timeout: 3.0`, `outgoing.max_request_timeout: 8`, and optionally `use_default_settings.engines.keep_only`.
  - Skip Valkey.
  - Doctor checks: `GET /healthz` returns `OK`; `GET /config` gives version, limiter and engines with `enabled`; `GET /search?q=test&format=json` (403 means "enable json").
- [distribution] **Default engine reality at this commit:**
  - Of the general web engines, only `duckduckgo`, `brave` (HTML scrape) and `google cse` (a shared public cx, `engines/google_cse.py: CX`) are enabled, plus wikipedia/wikidata infoboxes.
  - `google`, `bing` and `qwant` are `disabled: true`.
  - `startpage` and `mojeek` are `inactive: true`, citing proof-of-work CAPTCHAs (`settings.yml` L2363, L2854).

  At agent volume these scrapers are exactly what gets CAPTCHA'd. The limiter docstring itself says SearXNG "is thus classified as a bot itself" (`limiter.py` docstring). Document this, keep per-upstream health, and recommend a keyed engine for heavy use (§5.1). Optionally ship an overlay that enables more scrapers with conservative timeouts.
- [date-extraction] **SearXNG gives few dates for web results:**
  - 101 of 251 engine modules mention `publishedDate`, but `duckduckgo.py`, `google.py` and `bing.py` have no mention at all.
  - `brave.py` (HTML scrape) feeds Brave's `page_age` field to dateutil for web results. That `page_age` is ISO is not shown in the SearXNG source (verify against Brave's docs).
  - `braveapi.py` emits every hit through `brave.parse_video_result`, which parses the human `age` string with dateutil and ignores `page_age`. dateutil probably cannot parse relative strings such as "2 days ago", which would give a null date (inferred). We should read `page_age` in our own Brave adapter.
  - `exaapi.py` uses `publishedDate`, and `kagi.py` uses ISO `time`.
  - `startpage.py: _parse_published_date` extracts a snippet prefix such as "2 Sep 2014 ... " or "5 days ago ... ".

  Consequences for us:
  - Fetch-time extraction from the page has to do most of the work.
  - Engine dates are a hint, with a source label.
  - Add a **snippet-prefix date** heuristic as a low-confidence fallback.
  - Treat timezone-naive ISO strings from `isoformat()` as unknown-TZ.
  - Discard dates before 1900 or in the future with our own explicit range check. SearXNG intends to drop pre-1900 dates via a `strftime` try/except, but that guard probably never fires on a modern Python (see "Result shape").
- [engine-adapter] **Facts for our keyed adapters, gathered from SearXNG's engines** (re-verify with vendor docs):
  - Brave: `GET https://api.search.brave.com/res/v1/web/search`, header `X-Subscription-Token`, `count`, `offset` (page index), `safesearch` off/moderate/strict, max 10 pages (`engines/braveapi.py`). SearXNG sends `time_range=past_day…`, while our plan says `freshness`. **Verify the param name.**
  - Exa: `POST https://api.exa.ai/search`, header `x-api-key`, body `query`, `type` (fast/auto/instant/deep…), `numResults` 1-100, `contents.highlights|text.maxCharacters`, `moderation`, `userLocation`; returns `publishedDate` and `author` (`engines/exaapi.py`).
  - Kagi: `POST https://kagi.com/api/v1/search`, `Authorization: Bearer`, body `query`, `page`, `workflow` search/news/images/videos, `safe_search`, `filters.after` (YYYY-MM-DD), `filters.region` (`engines/kagi.py`).
  - Mojeek: HTML endpoint `since=YYYYMMDD`, and `s=0` "triggers a rate-limit" (`engines/mojeek.py`). Our plan uses the official API, so check whether the same quirk applies.
- [lists-subscriptions] **Borrow (idea) the mirror fallback chain** for list downloads (try mirror 1, then 2, then 3, short timeout, first 200 wins) from `tracker_patterns.py: iter_clear_list`. **Avoid** its lack of refresh and versioning: we need ETag/Last-Modified checks, last-good retention, a single refresh owner and a compiled matcher. Consider ClearURLs (license permitting) as the source of our tracking-param stripping list. SearXNG fetches it at runtime; we would bundle a snapshot and refresh it.
- [upgrades-migrations] SearXNG's "schema int in a properties table; mismatch raises an error and nothing migrates or recreates the file" (`sqlitedb.py: SQLiteAppl`) is fine for **throwaway caches** only (its default cache files sit in `/tmp`). Our log DB needs forward migrations under a lock, plus read-only mode on a newer schema. Borrow the `properties` table idea, and WAL + `wal_checkpoint(TRUNCATE)` maintenance.
- [testing] **Copy the per-test settings fixture pattern** (`tests/__init__.py: SearxTestCase.TEST_SETTINGS`). Have **fixture tests for every adapter**: SearXNG's sparse parser tests explain its breakage rate. Fixtures for the SearXNG adapter:
  - a normal JSON response
  - JSON with `unresponsive_engines` (timeout, suspended CAPTCHA)
  - 403 (json disabled)
  - 429 (limiter)
  - a 302 from a `!!` bang
  - an empty-results response
  - a slow response beyond `timeout_limit`
- [mcp-tool-surface] Receipt and tool text can show upstream failures compactly using SearXNG's taxonomy, e.g. "SearXNG: 2 of 3 upstream engines failed (duckduckgo: CAPTCHA, suspended; google cse: timeout)". That is cheap in tokens and explains thin results.
- [key-storage] SearXNG keeps API keys in plaintext `settings.yml` per engine (`api_key:` in `kagi.py`, `braveapi.py` docs). If a user's SearXNG has keyed engines, those keys are outside our control. Our own keys follow §4's resolution order, and we never write keys into a SearXNG overlay.
- [other] **The config-overlay model** (defaults + deep-merged user file, lists replace, named entries merge by `name`, `keep_only`/`remove` filters; `settings_loader.py`) is a good, well-understood precedent for our global → project YAML layering. Avoid the special case where one key (`plugins`) silently replaces wholesale.

## Borrow / avoid
**Borrow**
- Pure request-builder and response-parser adapters, with transport, timeouts and metrics owned by the core (`processors/online.py`, `Engine.request/response`).
- A declarative capability record per engine with defaults, plus "missing required config means inactive with a reason" (`ENGINE_DEFAULT_ARGS`, `is_missing_required_attributes`, `setup` raising on empty `api_key`).
- Skip engines that can't honour a filter (time range, paging) instead of sending unfiltered requests, and report it.
- One budget per search (max engine timeout, capped by client and instance limits); late results are discarded and logged as timeouts.
- An error taxonomy mapped from HTTP and body signatures: 402/403 means denied, 429 means rate-limited, and Cloudflare/reCAPTCHA/vendor "sorry" pages mean CAPTCHA. Each class has its own suspension duration, and an adapter may override it (including 0).
- Reliability % from error-class shares; latency p50/p80/p95; a per-engine error table in the UI; `Server-Timing`-style per-engine timings.
- Merge policy: union engines, keep all ranks, the longer title or snippet wins, prefer https (SearXNG's missing-field fill is effectively inert for typed results; we would implement it for real).
- Strip tracking params *before* dedupe; a mirror fallback chain for list downloads.
- Doctor probes: `/healthz`, `/config`, a JSON test search with 403/429 interpretation.

**Avoid**
- SearXNG's score formula: multiplicative weights, quadratic agreement bonus, and "high priority" that is only a decay removal and not a pin.
- Weak dedupe keys: no host or www or slash or param normalisation, and template/presentation type inside the key.
- Unanchored regex host matching, unordered rule sets and an unordered plugin set. Rule outcomes must be deterministic and explainable.
- Process-local suspension and metrics state, and constant-time bans with no backoff (`continuous_errors` unused).
- Fetching rule lists at runtime with no refresh, versioning or last-good fallback.
- Trusting the order of the JSON `results` array (category grouping pass), and parsing localised error strings without pinning `Accept-Language`.
- Passing raw model queries into SearXNG without neutralising `!`, `!!`, `:`, `<N` tokens, and following redirects from `/search`.
- Scraping engines, TLS fingerprint impersonation (`curl_cffi` impersonate) and CAPTCHA/proof-of-work solving (`mojeek.py: _captcha_token`) inside search-hole. These conflict with Principle 8 and engine terms of service; we use official APIs only.
- Publishing the bundled container on all interfaces, or enabling the limiter on a local instance (API_MAX = 4/hour).

## Verification
Date: 2026-10-29. Checked against `research/refs/searxng` @ c360868 (read-only; no ref code was run; one stdlib-only `strftime` probe on Python 3.13). Claims checked: about 140 (licence header and section, every "Implications for search-hole" bullet, and the mechanisms they rely on: timeout budget, suspension, status mapping, score formula, dedupe key, hostnames plugin, plugin order, limiter, settings overlay, container, metrics, engine/date facts). No code was pasted from the repo; one regex quoted from the AGPL module docstring was rewritten as prose.

Corrections made:
- Licence header and section: "no per-directory exceptions" tightened. The only licence file is the root `LICENSE`, but third-party data under `searx/data/` (e.g. `lid.176.ftz`) states no licence of its own; "AGPL applies to the whole repo" narrowed to the source files.
- Engine module count 252 → 251 (the 252 included `__init__.py`). Date-field count reworded to "101 of 251 mention `publishedDate`".
- `format=`: 403 only for json/csv/rss when not enabled (`webapp.py:655`, not 654); an unrecognised value falls back to html. Schema fallback vs shipped YAML for `search.formats` stated.
- Per-HTTP-call timeout is derived from the search budget, not the engine's own `timeout`; with both `timeout_limit` and `max_request_timeout` the budget is `min(Q, M)`, which can exceed every engine timeout (a client can raise it). Timeouts bullet rewritten.
- Adapter URL: `engines=` and `categories=` are unioned (so `categories=general&engines=brave` is not a restriction); unknown `engines=` names are silently dropped with fallback to default categories; `language` should always be sent because the default resolves from `Accept-Language`.
- Plugin hooks run in unspecified (set) order, not registration order; exceptions are swallowed per plugin.
- Hostnames pushdown regex: netloc is not lowercased and may carry a port, so the recommended pattern gained `(?i)` and `(:\d+)?`. The AGPL docstring idiom was rewritten as prose.
- Merge: `defaults_from` fill-from-duplicate is effectively a no-op for typed results (inferred from code); "empty or None counts as unset" was wrong. "Earliest known publishedDate" is not SearXNG behaviour; relabelled as our own proposal. Category grouping is 1 + up to 8, not 8. The "weight<1 lowers" wording was tightened.
- Pre-1900 `publishedDate` guard probably never fires on modern Python (checked years 1, 500, 1850, 1899 on 3.13); date bullet now requires our own range check.
- Ahmia filter: list membership (linear), not a set lookup; only active with a Tor proxy.
- Container: the entrypoint randomises the secret only when it creates a fresh `settings.yml`; a mounted `settings.yml` is untouched, so pass `SEARXNG_SECRET`. "Runs as uid 977" is unverified (no `USER` line in this Dockerfile).
- Limiter: needs Valkey (otherwise silently inert, or exit for `public_instance`); User-Agent check applies to all routes except `/healthz`; UA regex is matched from the string start; `*/*` Accept handling unverified; IP retention is not "at most 10 minutes" (windows are 20 s, 10 min, 1 h, and 30 days for suspicious IPs).
- `!!` alone ("feeling lucky") does not redirect for `format=json`; only a valid `!!bang` does (`webapp.py:687-688`, feeling-lucky at L719). `<N` below 100 is seconds, otherwise milliseconds, and it feeds `timeout_limit`.
- Cloudflare detection requires a `Server: cloudflare` header. `ENGINES_CACHE` `MAX_VALUE_LEN` is 1 GiB by arithmetic (comment says 1MB). SQLite schema mismatch raises `DatabaseError` and nothing recreates the file; default cache files are in `/tmp`. Cache-reset property is `hash_token`, not `crypt_hash`. `Valkey only by the limiter` widened (optional `valkey_server` engine). Makefile test target list completed. Brave `page_age` ISO format and dateutil handling of relative `age` strings marked unverified/inferred.
