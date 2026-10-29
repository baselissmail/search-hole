# AdguardTeam/AdGuardHome
> Ref: `research/refs/adguardhome` @ c0a81e9 (2026-10-27) · License: GPL-3.0 for the whole tree (the full v3 text is in `LICENSE.txt`, the only licence file, with no per-directory exceptions; no README or source header says "only" or "or later"; `client/` and `client_v2/` carry no separate LICENSE and declare no licence in their `package.json`). The rule-matching library `github.com/AdguardTeam/urlfilter v0.23.4` (`go.mod`) is a separate repo that is **not in refs**. Its licence is unverified here (likely GPL-3.0, inferred). **Ideas only: no code copied into this note.**

## Purpose
AdGuard Home is a self-hosted, network-wide DNS sinkhole. It runs as a DNS server (plain/DoH/DoT/DoQ/DNSCrypt) that applies AdBlock-style filtering rules and subscribed blocklists to every DNS query from every device. It has per-client settings, a query log that says "blocked by rule X from list Y", hourly statistics, and an embedded web admin UI with a first-run wizard, all in one Go binary. For search-hole it is the closest working example of the product loop we want: **subscribe to lists → compile → match per request with client context → log the decision with the rule and list → one-click block/unblock from the log row → check-a-host sandbox**. Its config-migration chain is a strong model for the upgrades ADR.

## Architecture sketch
- **One process, one binary.** `main.go` embeds the prebuilt frontend (`//go:embed build`, served via `fs.Sub(..., "build/static")` in `internal/home/home.go: newWeb`; `--local-frontend` serves from disk for development). `home.Main → run` wires the TLS manager, client storage, the filtering module, DNS server, query log, stats, updater and web API into a global context (`internal/home/home.go: run`).
- **First run.** If the config file is absent (`home.go: detectFirstRun`, a plain `os.Stat`), only the web UI starts and it serves the install wizard. DNS starts only once the wizard has written the config (`controlinstall.go: finalizeInstall → startMods`).
- **DNS request pipeline.** An ordered slice of stage functions, each returning a result code (`internal/dnsforward/requesthandler.go`): initial → DDR → DHCP hosts → **filteringBeforeRequest** → upstream → **filteringAfterResponse** (re-checks CNAMEs/IPs/HTTPS hints in the answer, so "CNAME cloaking" can't bypass a block: `dnsforward/filter.go: filterDNSResponse`) → ipset → **queryLogsAndStats**.
- **Filtering module** (`internal/filtering/filtering.go: DNSFilter`). Two compiled urlfilter engines: `filteringEngineAllow` (from subscribed *allowlists*) and `filteringEngine` (user rules + subscribed *blocklists*). Around them is a first-match-wins chain of host checkers: legacy rewrites → `/etc/hosts` → rule filtering → blocked services → safe browsing → parental → safe search (`filtering.go: New`, the `hostCheckers` slice; `CheckHost`).
- **Next-gen rewrite in progress.** `internal/next/` (new `configmgr`, `websvc`, RFC 7396 JSON Merge Patch in `next/jsonpatch`, `schema_version: 100` in `next/AdGuardHome.example.yaml`). `internal/filtering/rulelist/` has a new `Storage` (allow/block/custom engines, UUIDv7 list UIDs). Its `Filter` type carries a TODO saying it is not yet used, and `rulelist.NewStorage` is not called outside tests at this commit.
- **Frontend.** `client/` is the legacy React + Redux app. `client_v2/` is the new SolidJS app, and the Makefile now builds it by default (`Makefile: CLIENT_DIR = client_v2`).

## Key modules and data flow
| Path | Role |
|---|---|
| `internal/filtering/filtering.go` | `DNSFilter`, `matchHost` (allow engine first, then main engine), `initFiltering` (builds new engines off-lock, swaps them under `engineLock`), `updatesLoop`/`periodicallyRefreshFilters` |
| `internal/filtering/filter.go` | Subscription lifecycle: `FilterYAML`, `filterAdd`, `listsToUpdate`, `refreshFiltersIntl`, `updateIntl`, `readFromHTTP`, `finalizeUpdate`, `load`, `enableFiltersLocked` |
| `internal/filtering/rulelist/parser.go` | Streaming pre-parser: strips comments and blank lines, rejects HTML and binary, extracts `! Title:`, counts rules and computes CRC-32 over rule lines only |
| `internal/filtering/rulelist/rulelist.go` | List ID scheme: `APIIDCustom=0`, `EtcHosts=-1`, `BlockedService=-2`, `ParentalControl=-3`, `SafeBrowsing=-4`, `SafeSearch=-5`; `DefaultMaxRuleListSize = 256 MB`; `NewUID` = UUIDv7 |
| `internal/filtering/result.go`, `reason.go` | `Result{Rules[]{Text, IP, FilterListID}, Reason, IsFiltered, ServiceName, CanonName, IPList, DNSRewriteResult}`; a `Reason` enum with 12 values stored as integers |
| `internal/filtering/http.go` | REST: `/control/filtering/{status,add_url,remove_url,set_url,refresh,set_rules,config,check_host}`; `ValidateUpdateIvl` (≤ 365×24 h) |
| `internal/client/{index,storage,persistent}.go` | Persistent client index (ClientID/IP/CIDR/MAC → UID), `ApplyClientFiltering` |
| `internal/querylog/*` | Ring buffer → JSON-lines file, rotation, reverse reader with timestamp binary search, search criteria, a legacy-tolerant decoder |
| `internal/stats/*` | Hourly aggregate units in bbolt (`stats.db`) |
| `internal/configmigrate/*` | `schema_version` migration chain v0→v34 |
| `internal/home/{auth,authhttp,authratelimiter,control,controlinstall}.go` | Sessions, login, CSRF content-type guard, install wizard |
| `internal/updater/updater.go` | Self-update with backup and `--check-config` preflight |

Query-log read API (`querylog/http.go`):
- `GET /control/querylog` takes `older_than` (an RFC 3339 cursor), `limit`, `offset`, `search` (term over host, client or answer), and **either** `response_status` (`all|filtered|blocked|blocked_services|blocked_safebrowsing|blocked_parental|whitelisted|rewritten|safe_search|processed`, `searchcriterion.go`) **or** `reason`, never both.
- It returns `{data[], oldest}`. Each entry carries `reason` (a string name), `rules[{filter_list_id,text}]` (plus the legacy single `rule`/`filterId` for back-compat, `json.go`), `client_info`, `upstream`, `elapsedMs`, `cached`, `answer`/`original_answer` and `service_name`.
- Other routes: `POST /control/querylog_clear` and `GET/PUT /control/querylog/config`.

Data flow for one query: the DNS request comes in → `clientRequestFilteringSettings` resolves the client and fills `filtering.Settings` (global flags overridden by the persistent client's, plus `ClientName`, `ClientTags`, `ClientIP`) → `CheckHost` builds a `urlfilter.DNSRequest{Hostname, ClientTags, ClientIP, ClientIdentifiers, DNSType}` → `Result` → `querylog.Add(AddParams{Result,...})` and `stats.Update(Entry{Result code, Domain, Client})`.

## Data model and storage
Data directory layout (all created `0600`/`0700`: `internal/aghos/os.go: DefaultPermFile/DefaultPermDir`; `internal/permcheck` checks and *migrates* looser permissions at startup, `home.go: checkPermissions`):
- `AdGuardHome.yaml` is the single source of truth for settings, users (bcrypt hashes), list metadata (id/url/name/enabled), user rules and persistent clients.
- `data/filters/<id>.txt` holds each list after normalisation, with comments and blank lines removed (`filter.go: FilterYAML.Path`). **The file's mtime is the list's "last checked" time.** `load` sets `LastUpdated` from `st.ModTime()`. An update that finds no change only calls `os.Chtimes`, and so does one that *fails*: `update` stamps the time and touches the file whenever nothing changed, errors included (`filter.go: update`), so after a restart a list whose refresh failed looks freshly checked. Rule count and checksum are recomputed by re-parsing at load, so the YAML stores no list state.
- `data/userfilters/` is the default allowed location for local file lists (migration `configmigrate/v29.go`).
- `data/querylog.json` plus at most one rotated `querylog.json.1`, in JSON-lines with short keys (`querylog/entry.go: logEntry`): `T` time, `QH` host, `QT` type, `QC` class, `CP` proto, `CID` ClientID, `IP`, `ECS`, `Upstream`, `Answer`/`OrigAnswer` (packed DNS wire bytes), `Result` (the whole `filtering.Result` incl. `Rules[{Text, FilterListID, IP}]`, `Reason` as an int), `Elapsed`, `Cached`, `AD`.
- `data/stats.db` (bbolt, pure Go): one bucket per hour, named by the 8-byte big-endian "hours since epoch" unit id (`stats/unit.go: idToUnitName`). Each unit stores gob-encoded `unitDB` with `NResult[]`, `Domains`, `BlockedDomains`, `Clients`, `UpstreamsResponses`, `UpstreamsTimeSum`, `NTotal` and `TimeSum`. Each top-N map is **truncated to the 100 largest entries** at flush (`unit.go: maxDomains/maxClients/maxUpstreams = 100`, `convertMapToSlice`).
- `data/sessions.db` (bbolt): web sessions keyed by the **raw** 16-byte token (`aghuser/session.go: SessionTokenLength = 16`; `aghuser/sessionstorage.go`, which uses `bkt.Put(s.Token[:], ...)`).

**Explaining a match.** The log stores only the rule *text* and the numeric `FilterListID`, not the list name. The UI resolves id → name at render time from the *current* filter config. A deleted list therefore shows `unknown_filter` (`client/src/helpers/helpers.tsx: getFilterName`). Special negative ids map to fixed names ("Custom filtering rules", "/etc/hosts", "Blocked services"...).

**Retention.** Query log: `checkAndRotate` runs hourly. It reads the first record's `"T"` from the head of `querylog.json`, and if that is older than `interval` it renames the file to `.1`, overwriting the previous `.1` (`querylog/querylogfile.go`). Effective retention is therefore between 1× and 2× the interval. Allowed UI values are 6 h/1 d/7 d/30 d/90 d (`qlog.go: checkInterval`); the validator accepts 1 h–1 y; the default is 90 d (`home/config.go` defaults). Stats default to 24 h. On each hourly flush the bucket `id − limit` is deleted (`stats/stats.go: flushDB`).

**Upgrade tolerance in logs.** Old entries with single `Rule`/`FilterID` keys still decode into today's `Rules[]` (`querylog/decode.go: resultHandlers`). Logs are never migrated; the reader stays backward-compatible. Because `Reason` is persisted as an int, the enum is append-only, and the API list ids are annotated as fixed values (`rulelist/rulelist.go`).

## Config format
YAML (`go.yaml.in/yaml/v4`), a single file, encoded with indent 2 and written atomically with `renameio/v2/maybe.WriteFile` (`home/config.go: configuration.write`). Top-level keys (struct `configuration`, whose doc comment warns that field order matters): `http` (address default `0.0.0.0:3000`, `session_ttl` 30 d, `doh.routes`), `users`, `auth_attempts`, `block_auth_min`, `http_proxy`, `language`, `theme`, `dns`, `tls`, `querylog` (`enabled`, `file_enabled`, `interval`, `size_memory`, `ignored`, `ignored_enabled`, `dir_path`), `statistics`, `filters`, `whitelist_filters`, `user_rules` (list of strings), `dhcp`, `filtering` (`protection_enabled`, `protection_disabled_until`, `filtering_enabled`, `filters_update_interval` [hours], `blocked_services{ids, schedule}`, `safe_search{...}`, `safe_fs_patterns`, `max_http_size`, `rewrites`...), `clients{runtime_sources{whois,arp,rdns,dhcp,hosts}, persistent[]}`, `log`, `os`, `schema_version`.

Handling is "parse, then validate and repair". An invalid `filters_update_interval` is silently reset to 24 (`config.go: validateConfig`). An unknown `language` is cleared with a warning. With no users, authentication is disabled with a warning. There is a YAML-pitfall hint for unquoted IPv6 with a trailing colon (`logIPHint`). `--check-config` validates without starting (`home/options.go`).

**Migrations** (`internal/configmigrate/`):
- `LastSchemaVersion = 34`.
- `Migrator.Migrate` unmarshals into an untyped map (`yobj`) and reads `schema_version`. It validates that current ≤ target ≤ last. **current > target is a hard error (reported as an unknown current version)**; `home.go` then exits with a failure code, so the process refuses to start and there is no read-only fallback.
- It runs `upgrades[current:target]`, a fixed array of `migrateToN` functions. Each sets `schema_version = N` itself and documents the change as a `# BEFORE:` / `# AFTER:` YAML diff in its doc comment (e.g. `v34.go` moves `tls.allow_unencrypted_doh` into `http.doh`).
- It re-encodes the result and the caller writes it back immediately (`home/config.go: parseConfig`).
- Helpers include `fieldVal[T]`, `moveVal` and `moveSameVal` (`yaml.go`).
- Migrations may touch the filesystem: `v1.go` deletes `dnsfilter.txt`, `v2.go` deletes `Corefile`, `v29.go` adds `safe_fs_patterns` under `dataDir/userfilters/*`.
- There is no locking; it relies on being a single process. The optional `--pidfile` flag only records the PID (`home.go: writePIDFile`) and is not a lock.

## Extension points (plugins, hooks)
There is no plugin system. The extension surfaces are:
- rule lists (any URL or allowed local path)
- `$dnsrewrite` rules
- per-client upstreams
- **Blocked services:** a generated catalog (`filtering/servicelist.go`, 3.4k lines, produced by `scripts/blocked-services`). Each entry has an `ID`, `Name`, `IconSVG`, `GroupID` and a set of urlfilter `Rules` (e.g. `||9gag.com^`). It can be toggled with one click and has a weekly `schedule` (`filtering/blocked.go`, `ApplyAdditionalFiltering`).
- **Vetted lists catalog:** `scripts/vetted-filters/main.go` turns the HostlistsRegistry `filters.json` (`downloadUrl`, `filterKey`, `homepage`, `name`, `tags`) into a UI catalog with categories general/security/regional/other. It is generated into `client/src/helpers/filters/filters.ts`, and `home/config.go` says the default filters must stay in sync with it.
- The HTTP API, specified in OpenAPI (`openapi/openapi.yaml` 3.4k lines; `openapi/next.yaml` for the rewrite) with `openapi/CHANGELOG.md` tracking breaking changes. The API takes cookie or HTTP Basic auth.

## Rules / lists: parsing and compilation
**Syntax as exercised in this repo.** The matching semantics live in urlfilter (not in refs), so this table is limited to what AGH tests and UI text show:
| Form | Behaviour (evidence) |
|---|---|
| `\|\|example.org^` | Blocks the domain and all subdomains; does not match `testexample.org` or `example.org.ru` (`filtering_internal_test.go: TestMatching` "sanity"/"blocking") |
| `@@\|\|test.example.org` | Exception: unblocks the domain and its subdomains (TestMatching "allowlist") |
| `\|\|x^$important` | Beats `@@` in the same engine: with `@@\|\|example.org^` + `\|\|test.example.org^$important`, `test.example.org` is blocked and `example.org` allowed (TestMatching "important") |
| `/example\.org/` | Regex, **unanchored on the hostname** (it matches `testexample.org`) |
| `test*.example.org^`, `exam*.com` | Wildcard masks, unanchored on the left (`exam*.com` matches `onemoreexamsite.com`, not `example.co.uk`) |
| `127.0.0.1 example.org` | Hosts-file syntax: answers 127.0.0.1 for exactly that host and not its subdomains, per the UI's example text (`client/src/__locales/en.json: example_meaning_host_block`); exposed as `HostRulesV4/V6` (`filtering.go: resultFromHostRules`) |
| `$client=name` | Per-client rule (`http_internal_test.go: blockedRuleCliFmt`); the UI escapes `' " , \|` in client names (`client/src/actions/index.tsx: toggleBlockingForClient`) |
| `$ctag=` | Per-tag rule; tags come from a fixed vocabulary `device_*`, `os_*`, `user_*` (`internal/client/storage.go: allowedTags`), passed as `ClientTags` in `DNSRequest` |
| `$dnstype=AAAA`, `$dnstype=~CNAME` | Record-type scoping (TestMatching "dnstype"; `servicelist.go`) |
| `$denyallow=a\|b` | Block except the listed domains (`servicelist.go` qq.com entry; the CHANGELOG records the modifier being added) |
| `$dnsrewrite=NOERROR;CNAME;host` | Rewrite (`filtering/safesearch/rules/*.txt`; e.g. DuckDuckGo → `safe.duckduckgo.com`) |
| `! …` / `# …` | Comments (parser drops lines starting `!` or `#`) |
| `$badfilter` | **Not referenced anywhere in this repo.** Only urlfilter can implement it; unverifiable here |

**Precedence (current production path), `filtering.go: matchHost` and the `CheckHost` chain:**
1. **The allowlist-subscription engine (`whitelist_filters`) is queried first.** Any match there short-circuits to `NotFilteredAllowList`, so it also skips blocked services, safe browsing and parental checks (`Reason.Matched()` is true for allow). In allowlist *lists*, the list's role defines the meaning: a plain `||x^` in an allowlist means "allow" (`matchHostProcessAllowList` ignores the rule's `@@`).
2. Otherwise the main engine runs. It holds **user rules (list id 0, inserted first)** and all enabled blocklists in one `RuleStorage` (`filter.go: enableFiltersLocked`). urlfilter resolves `$important` > `@@` > block within it (TestMatching).
3. Consequence: a subscribed allowlist beats even the user's own `||x^$important`. The next-gen `rulelist.Storage` is meant to reverse this: the doc comment on `StorageConfig.CustomRules` gives custom rules priority over both the allow and block lists (`rulelist/storage.go`). `Storage` has no match method yet, so the relative order of allow versus block there is not defined in refs.
4. **One-click Block** from the log appends `||domain^$important` to user rules; **Unblock** appends `@@||domain^$important`. If the inverse rule is already present, it is *removed* instead of stacking a new one (`client/src/actions/index.tsx: toggleBlocking`). "Block for this client only" uses `$client='Name'`.

**Compile and load.**
- `newRuleStorage` wraps each list as `filterlist.NewFile` on Unix (urlfilter reads rule text from the file on demand; inferred from the Windows comment) or `filterlist.NewBytes` on Windows (a code comment notes a file in use is hard to replace there), always with `IgnoreCosmetic: true` (`filtering.go: ruleListFromFilter`).
- New engines are built **outside** the lock, then swapped under `engineLock`, followed by `debug.FreeOSMemory()` (`initFiltering`).
- Lookups hold an RLock while using the returned rules.

**Subscription update** (`filter.go`):
- *Schedule.* `updatesLoop` first ticks 5 s after start, then every 1 h. Each enabled list refreshes when `LastUpdated + filters_update_interval` (default 24 h; 0 disables; max 1 year) has passed. A manual refresh uses `force=true`. `refreshLock.TryLock` means a concurrent manual refresh returns an "already running" error (HTTP 500).
- *Download and parse.* Plain `GET` with **no conditional request**: there is no ETag or If-Modified-Since anywhere in `internal/` (grep). The User-Agent is `AdGuardHome/<ver>`. The client timeout is 5 min (`home/httpclient.go`, `web.go: writeTimeout`), DNS goes through AGH's own resolver, and the body is capped by `max_http_size` (256 MB default). The body is streamed through the parser into a `renameio` pending file. A non-200 status, a first line of `<html`/`<!doctype`, or any control byte → error (`rulelist/parser.go: ErrHTML`, `likelyBinary`).
- *Change detection.* CRC-32 over trimmed rule lines only, so comment or whitespace churn doesn't count. On no change: discard the temp file and touch the mtime. On change: atomically rename over `<id>.txt`, then rebuild the engines.
- *Failure.* The old file stays in place and keeps serving (last-good behaviour by construction). If *every* list fails it is a "network error" and the next interval doubles. The code uses `max(ivl, 1h)` rather than a cap, so the backoff grows without bound until a success resets it to 1 h (`filtering.go: periodicallyRefreshFilters`; looks like an unintended max/min, inferred). When only *some* lists fail in a batch, `syncUpdatedFilters` still copies each list's fresh timestamp back, including the failed ones, so a failed list is not retried until its interval elapses again (inferred from reading `filter.go`).
- *Missing guards.* There is no shrink guard: a list that drops to 10 rules is accepted.
- *Next-gen difference.* In `rulelist/engine.go: process` a list that fails to refresh is **left out** of the rebuilt engine, rather than keeping its previous `ruleList`.
- *Adding a list.* `add_url` validates the URL; local paths must match `safe_fs_patterns` globs (`filtering/path.go: pathMatchesAny`). It downloads synchronously, rejects a list that yields no change against the empty checksum, i.e. no rules (the error suggests a blank page), and replies `OK N rules` (`http.go: handleFilteringAddURL`). Duplicate URLs are rejected across both block and allow lists.
- *List ids.* Legacy ids are seeded from Unix time and incremented (`filtering.go: newIDGenerator(time.Now().Unix())`). The next-gen code uses UUIDv7 (`rulelist.NewUID`).
- *Ignore lists.* The `querylog.ignored` and `statistics.ignored` domain lists are compiled with the same urlfilter engine, so "don't log these" uses the full rule syntax (`aghnet/ignore.go: NewIgnoreEngine`).

**Per-client settings and identity.**
- Lookup order is ClientID → exact IP → first CIDR containing the IP → MAC via the DHCP lease (`client/storage.go: ApplyClientFiltering`; `index.go: findByIP`).
- ClientID comes from the DoH path `/dns-query/{ClientID}` or the DoT/DoQ SNI subdomain (`dnsforward/clientid.go`).
- A persistent client (`home/clients.go: clientObject`) has `name`, `ids[]` (IP/CIDR/MAC/ClientID), `tags[]`, `upstreams[]`, `use_global_settings`, `filtering_enabled`, `parental_enabled`, `safebrowsing_enabled`, `safe_search`, `use_global_blocked_services` + `blocked_services`, `ignore_querylog`, `ignore_statistics` and `uid`.
- *Runtime* clients are auto-discovered from ARP, rDNS, WHOIS, DHCP and hosts. They provide names only, no settings.
- Rules stay global; client scoping lives inside rule text (`$client`, `$ctag`) and is resolved by one shared engine at match time.

## Testing strategy
- 155 `_test.go` files against 307 Go source files under `internal/`. Tests are table-driven and colocated (`_internal_test.go` for white-box tests). `TestMatching` is the precedence truth table (rules × host → reason, isFiltered).
- **Golden migration fixtures:** `configmigrate/testdata/TestMigrateConfig_Migrate/vN/{input.yml,output.yml}` for each version, plus special cases (`migrator_test.go: TestMigrateConfig_Migrate_v29` with dataDir-dependent paths).
- **Fuzz:** `rulelist/parser_test.go: FuzzParser_Parse`. **Benchmarks:** 8 of them, each with a pasted block of recent results recording ns/op, B/op and allocs (e.g. the parser at 53.7 ns/op, 1 alloc/op).
- `go test --race` toggle (`scripts/make/go-test.sh`); `internal/aghtest` fake upstreams and interfaces.
- **Frontend:** Vitest + `@solidjs/testing-library` for unit tests. Playwright e2e runs against a real backend: `client_v2/tests/e2e/globalSetup.ts` clicks through the 6-step install wizard by element ids (`#install_get_started`, `#install_username`...), then the specs cover user rules, query log, clients, blocked services and rewrites.
- Lint for Markdown, shell and text (`scripts/make/*-lint.sh`), plus translation checks.

## UX patterns worth copying
- **Two-line reason cell** in the log: a label ("Blocked by filter" / "Custom filtering rules" / "Allowlist" / "Blocked services") with a muted second line naming the list(s) (`client_v2/src/components/QueryLog/blocks/LogTable/blocks/ReasonCell.tsx`; `QueryLog/helpers.ts: getQueryReasonKey`). A list id of 0 turns "blocked by filter" into "custom filtering rules".
- **Details popover:** rule texts grouped under their list name (`helpers.tsx: getRulesToFilterList`), plus upstream, elapsed, cached and original-vs-rewritten response.
- **Row action menu:** Block/Unblock (label flips with the current state), "Block for this client only", "Disallow this client", "Add persistent client" (`QueryLog/blocks/ActionsMenu/ActionsMenu.tsx`). Toasts confirm the exact rule text that was added or removed.
- **Check-a-host sandbox** next to the rule editor: enter a host (and optionally a client or qtype) and get a tone (blocked/allowed/rewritten/processed), the rule, the source list and its type, and *contextual fix actions*. Examples: "add to allowlist", or "disable this filter" when a list rule matched (`client_v2/src/components/UserRules/checkResultHelpers.tsx`; API `GET /control/filtering/check_host?name=&client=&qtype=`).
- **Pause protection** for 30 s, 1 min, 10 min, 1 h or until tomorrow, with a live countdown (`client_v2/src/helpers/constants.ts: DISABLE_PROTECTION_TIMINGS`; config `filtering.protection_disabled_until`).
- **Teaching empty state:** "logging is disabled → Enable" links to Settings with a scroll-target query param (`QueryLog/blocks/EmptyState/EmptyState.tsx`).
- Rule editor with an examples panel (block, unblock, hosts, comment, regex) and a "learn more" link (`UserRules/blocks/Examples.tsx`).
- Lists: catalog picker by category, or a custom URL. Each list shows name, URL, rule count and last updated. A global update-interval modal (`FilterLists/blocks/FilterUpdateModal`).
- The query log uses infinite scroll with an `older_than` cursor and 20 rows per page (`constants.ts: QUERY_LOGS_PAGE_LIMIT`). **There is no live push**; refresh is pull-based.
- The first-run wizard is a separate HTML entry. Steps: greeting → admin user (password-requirements block) → web/DNS interface and port with a live port-availability check (`/control/install/check_config`, which can auto-fix systemd-resolved's stub listener) → setup guide → done.

## Performance tricks
- File-backed rule lists on Unix keep only urlfilter's index in RAM, not the rule text (inferred from `ruleListFromFilter`). Combined with an atomic rename, old engines keep reading the old inode while new ones are built.
- Build-then-swap engines under a short write lock; `debug.FreeOSMemory()` after the swap; a `syncutil.Pool` of 1 KB parse buffers (`filtering.go: New`, `bufPool`). The scanner buffer can grow to `bufio.MaxScanTokenSize` for huge lines from compressed lists (`parser.go`, issue #6003).
- Query log: an in-memory ring buffer of `size_memory` entries (default 1000), flushed in a goroutine when full. Searches read the files **backwards** with a 100-entry window, binary-search by timestamp for `older_than` (`qlogreader.go: seekTS`), and cap scanned entries per request (`maxFileScanEntries`) so the UI returns quickly.
- Stats are pre-aggregated per hour with top-100 truncation, so storage is bounded regardless of traffic.
- `CGO_ENABLED=0` by default (`scripts/make/go-build.sh`) and pure-Go bbolt give a fully static per-platform binary.

## License and what it means for us
- GPL-3.0 for the whole repo, both Go and both frontends. **We may not copy code, tests, fixtures, locale strings or the services catalog.** search-hole is MIT/Apache, so any copied code would make it a derivative work.
- Ideas, algorithms, API shapes, file layouts and UX patterns are free to reimplement from prose.
- Do **not** copy `servicelist.go` data (icons and rule bundles) or the `en.json` example texts.
- The HostlistsRegistry index and the individual blocklists have their own licences; check each before bundling (plan §15 B).
- urlfilter itself is not in refs. Do not vendor or port it; write our own matcher.

## Implications for search-hole
- [rule-format-precedence] Make our tier order explicit, and different from AGH's current one: **user scopes (session > project > global) are evaluated as a tier above all subscribed lists**. A list's `$important` only reorders rules *within* the list tier. This matches plan §6 ("user's allow always beats any list rule") and AGH's own next-gen direction (the `rulelist/storage.go` doc comment puts custom rules above both lists; the order of allow versus block is not defined there yet). Avoid AGH's production behaviour, where a subscribed allowlist silently overrides the user's `$important` block (`filtering.go: matchHost`).
- [rule-format-precedence] Encode the observable semantics of AGH/ABP imports as a property-test table modelled on `TestMatching`: `||d^` covers subdomains but not `xd`; `@@` beats a plain block; `$important` beats `@@`; regex is unanchored over the host; masks are unanchored on the left; hosts lines are exact-host only. Treat `$client`/`$ctag`/`$dnstype`/`$dnsrewrite`/`$denyallow` as **skipped with a counted warning** in v1. `$badfilter` must be handled by our own importer (cancel the identical rule) since AGH gives no evidence for it.
- [rule-format-precedence] Use AGH's "list role defines meaning" idea for typed lists. A subscription has a `kind` (block/allow/official-docs/content-farm), so a plain-domain list can be used as an allowlist or a source-type list without rewriting its syntax.
- [lists-subscriptions] Keep AGH's good mechanics: stream into a temp file, normalise (strip comments), CRC/hash over rule lines only for change detection, reject HTML/binary/oversize (256 MB cap → we should use a much smaller cap), atomic rename, last-good on failure, synchronous validation on add with an "OK, N rules" reply, duplicate-URL rejection, `! Title:` → default name. Add what AGH lacks: ETag/If-None-Match + If-Modified-Since, a shrink guard (>50%), capped exponential backoff with jitter (AGH's `max(ivl,1h)` grows unbounded), and per-list error state in the DB.
- [lists-subscriptions] Store `last_checked` and `last_changed` separately in SQLite. AGH overloads file mtime and only shows "last updated", which hides "checked, unchanged" from "failed".
- [lists-subscriptions] Adopt a **registry index** like HostlistsRegistry `filters.json` → a vetted catalog with categories, homepage, licence and download URL. For us that means a `search-hole-lists` index with first-party lists (official-docs, content-farms) shown as a one-click catalog. AGH's "blocked services" (named bundle + icon + group + schedule) maps to one-click **site groups** ("Pinterest", "Quora clones").
- [upgrades-migrations] Borrow the migration *shape*: an ordered array of `migrateToN` steps, each idempotent on its own version bump, with BEFORE/AFTER documented in the doc comment and a golden `vN/{input,output}` fixture per step. For SQLite, use `PRAGMA user_version` with one transaction per step, under an exclusive lock.
- [upgrades-migrations] Do **not** copy AGH's newer-schema behaviour. It hard-fails startup when the config's schema version is newer than the binary's (`configmigrate/migrator.go: validateVersion`). With multiple installs (plugin/npx/.mcpb) we need: newer schema → read-only mode that still serves searches.
- [upgrades-migrations] Before migrating, back up the DB (AGH's updater first runs the *new* binary with `--check-config` against a copy of the config, then backs up config and exe to `agh-backup/`, then swaps; `updater/updater.go: check/backup`). Add `searchhole doctor --check-config` and dry-run migrations against a copy.
- [upgrades-migrations] For the append-only log, follow AGH: a tolerant reader accepts legacy shapes (`querylog/decode.go` maps old `Rule`/`FilterID` to `Rules[]`), and persisted enums are append-only. Store decisions and reasons as **stable string codes**, not ints.
- [sqlite-driver] AGH avoided native deps entirely (pure-Go bbolt, `CGO_ENABLED=0`) to keep one static binary. That supports our zero-native-deps preference (bun:sqlite in compiled binaries or `node:sqlite`) over `better-sqlite3` prebuilds.
- [dashboard-process-model] AGH is a single long-running daemon: one writer, a global `controlLock` serialising every mutating API call (`home/control.go: ensure`), the whole YAML rewritten on each change, and only an optional PID file (not a lock). Its simplicity depends on there being one process, which our per-session gateways can't give. Keep rules/config writes in one place (CLI/dashboard writing YAML atomically, with a file lock), and keep SQLite for logs. Also note that AGH's UI has no live tail at all (pull and infinite scroll), so our SSE tail is a differentiator, not table stakes.
- [session-definition] AGH identity is a resolution chain over the identifiers it actually sees: explicit ClientID → IP → CIDR → MAC. Apply the same idea: explicit session marker (Claude Code `session_id`) → MCP `clientInfo` + process id → idle-gap heuristic. Show "runtime" (auto-discovered) clients separately from "persistent" (configured) ones, as AGH does.
- [ui-ux] Snapshot the list **name and version/hash** into each result's decision row, not just `list_id`. AGH's id-only log shows "unknown filter" once a list is removed (`helpers.tsx: getFilterName`). Use stable list UIDs (AGH is moving from time-seeded ints to UUIDv7).
- [ui-ux] Copy the interaction set: a two-line reason cell; rules grouped by list in the details view; Block/Unblock that **removes the inverse user rule before adding** (no rule pile-up); "for this client/profile only"; a check-a-query sandbox with tone, rule, source and contextual fix actions; "pause filtering for 10 min / 1 h"; empty states that deep-link to the setting.
- [ui-ux] client_v2 confirms a typed client generated from an OpenAPI spec (`client_v2/orval.config.ts` → `src/api/generated.ts` via a `customFetch` mutator) and separate HTML entries for install/login. For us, Hono RPC or a Zod schema shared with the React dashboard gives the same type safety without codegen.
- [security] Borrow the CSRF guard: every POST/PUT/DELETE must carry `Content-Type: application/json`, or have no body *and* no content type (`home/control.go: ensureContentType`). This forces a CORS preflight for cross-site requests; pair it with our token and Host allowlist.
- [security] Avoid AGH's gaps: first-run wizard on `0.0.0.0:3000` without auth; raw session tokens as DB keys (hash them); no CSP or Host-header check found in `internal/home`. Keep 127.0.0.1 binding, a random URL token, a Host allowlist and a strict CSP.
- [security] Borrow `safe_fs_patterns` for `file://` list subscriptions (an allowlist of glob paths, `filtering/path.go`). Borrow the startup permission check that tightens the data dir and DB to `0700`/`0600` (`internal/permcheck`).
- [security] Borrow per-client privacy switches (`ignore_querylog`, `ignore_statistics`) and an "ignored domains" list compiled with the same matcher (`aghnet/ignore.go`). Map them to per-client/per-profile "don't log" settings and a never-log list.
- [engine-adapter] AGH's DNS pipeline is an ordered slice of stage functions with result codes (`dnsforward/requesthandler.go`). It includes a **post-response re-check** (CNAME uncloaking, `filterDNSResponse`). For `fetch`, re-apply rules to the final URL after redirects and to canonical links, so a blocked site can't come in through a redirector.
- [testing] Reuse the test portfolio shape: a precedence truth table, golden migration fixtures per version, fuzzing on every list parser (ABP, uBlacklist, hosts, Goggles), benchmarks with recorded baselines in comments, and a Playwright e2e global setup that drives the real first-run flow.
- [distribution] AGH ships one static binary per OS/arch with the UI embedded, plus a `--local-frontend` dev flag, a service installer (`-s install`, kardianos/service), `install.sh`, snap and docker, and a self-updater with channels (`version.json`). A Bun-compiled `searchhole` binary with dashboard assets embedded would mirror this. Prefer host-managed updates (plugin/npm) over self-update.
- [mcp-tool-surface] AGH's `check_host` (name, client, qtype → reason, rules[], list ids) is the model for `searchhole search --explain` and the dashboard's "test a query". Expose it to the CLI and dashboard, not as an extra MCP tool.

## Borrow / avoid
**Borrow**
- Two-tier evaluation with a fixed order: allow before block, first match wins, and the allow result short-circuits downstream checks. But put **user rules above lists** (AGH next-gen order).
- One compiled matcher with context-scoped rules (`$client`/`$ctag` → our `client:`/`profile:`), compiled once and given the request context at match time.
- List update pipeline: temp file → normalise → hash rule lines → atomic rename → rebuild the matcher off-lock → swap. Keep the last good list on failure. Validate synchronously when a list is added.
- `schema_version` migration chain with BEFORE/AFTER docs and golden fixtures; backup plus a "check config with the new version" preflight.
- Tolerant log reader for old row shapes; append-only, stable decision codes.
- Pre-aggregated hourly stats with top-N truncation for the Overview; ring-buffered log writes.
- UX: reason cell, rules-by-list details, toggle Block/Unblock that removes the inverse rule, per-client block, check-host sandbox with fix actions, timed pause, teaching empty states, a vetted list catalog by category, site-group bundles.
- Security: JSON-only mutations as CSRF defence, `safe_fs_patterns`, permission self-check, login rate limiting (not needed with a token, but useful if we add a password).

**Avoid**
- Hard failure on a newer schema; we need read-only mode.
- Subscribed allowlists overriding the user's explicit block.
- Logging only a numeric list id. Snapshot the name and hash.
- Re-downloading full lists every interval with no ETag/Last-Modified; uncapped backoff; no shrink guard.
- Next-gen behaviour of dropping a list from the engine when its refresh fails.
- Using file mtime as list state; time-seeded integer list ids.
- Unauthenticated first-run wizard on all interfaces; raw session tokens at rest; no CSP or Host check.
- A single global mutation lock and whole-file config rewrites as the coordination model. These only work for a single daemon, which we are not.
- Query-log rotation that keeps only `.1` (retention between 1× and 2× the interval, imprecise). Use time-based `DELETE` in SQLite with per-table retention.

## Verification
Checked 2026-10-29 against `research/refs/adguardhome` @ c0a81e9 (read-only; nothing was built or run). Claims checked: about 95. They cover the licence header (`LICENSE.txt`, a search for other licence files and headers, README and `package.json` files), all 24 "Implications for search-hole" bullets, and the mechanisms they rely on: the `matchHost` and `CheckHost` order, the `TestMatching` truth table, the `Reason` enum and list ids, the subscription lifecycle (schedule, plain GET with no conditional headers, CRC-32 over rule lines, temp file and rename, size cap, backoff code, add-URL checks), migration chain (`LastSchemaVersion` 34, hard failure on newer config, golden fixtures), updater order, query-log and stats retention, client identity resolution, CSRF content-type guard, the absence of CSP, Host checks and live push, session token storage, test counts, and the next-gen `rulelist` code. The urlfilter library is not in refs, so its licence and the `$badfilter` semantics remain unverified (a grep confirms `badfilter` appears nowhere in the repo).

Corrections made:
- Precedence (rule-format-precedence): the note said AGH's next-gen direction is "custom > allow > block". The only evidence is a doc comment putting custom rules above both lists, and the new `Storage` type has no match method, so the allow-versus-block order there is undefined. Reworded in two places.
- List state: a failed download also touches the list file's mtime (`update` does it whenever nothing changed, errors included), and in a batch where only some lists fail, the failed ones still get a fresh timestamp. So AGH can show a failed list as freshly checked; this strengthens the case for separate `last_checked`, `last_changed` and per-list error state.
- PID file: it is written only when `--pidfile` is passed and is never used as a lock; two places that implied it guards against a second instance were fixed.
- Updater order: the new binary's `--check-config` runs first against a copy of the config, then backup, then swap.
- Licence header: "GPL-3.0-only" became "GPL-3.0" because no file states "only" or "or later". The conclusion (copyleft, copy nothing) is unchanged.
- Licence hygiene: paraphrased several short quotations of source comments, error strings, a locale string and a changelog line.

Confirmed unchanged: allowlist-subscription engine is queried before the user-rule engine, so a subscribed allowlist beats the user's `$important` block; no ETag or If-Modified-Since; no shrink guard; unbounded backoff; newer config schema is a hard failure; no CSP or Host-header check; raw 16-byte session tokens as DB keys; no live push in either frontend.
