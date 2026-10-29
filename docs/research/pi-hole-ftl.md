# pi-hole/FTL
> Ref: `research/refs/pi-hole-ftl` @ 29c8b13 (2026-10-17) · License: **EUPL-1.2** for FTL's own code (root `LICENSE`). Vendored third-party code keeps its own licence:
> - `src/dnsmasq/` is GPL-2.0-only OR GPL-3.0-only (header of `dnsmasq.c` plus `COPYING-v3`)
> - `src/tre-regex/` is BSD-2-Clause (`src/tre-regex/LICENSE`, TRE by Ville Laurikari)
> - `src/config/tomlc17/` is MIT (`LICENSE`)
> - `src/webserver/civetweb/` is MIT (header of `civetweb.c`)
> - `src/webserver/cJSON/` is MIT (header of `cJSON.c`)
> - `src/lua/` is MIT (Lua.org notice in `lua.h`)
> - `src/zip/miniz/`: `miniz.c` opens with an MIT-style permission notice (RAD Game Tools / Valve) and ends with an Unlicense public-domain dedication; `miniz.h` calls itself public domain
> - `src/database/sqlite3.c`, `shell.c` and `sqlite3_rsync.c` are SQLite (their headers carry SQLite's "author disclaims copyright" dedication, i.e. public domain)
>
> **FTL's own files: ideas only.** Nothing from them is pasted here.

## Purpose
`pihole-FTL` ("Faster Than Light") is Pi-hole's single C daemon. It embeds:
- dnsmasq (DNS and DHCP)
- the blocking engine
- two SQLite databases (lists in `gravity.db`; query log in `pihole-FTL.db` plus an in-memory copy)
- CivetWeb, which serves the **v6 REST API** and the web UI's Lua server pages, so v6 needs no lighttpd or PHP
- Lua, a `sqlite3` shell and the blocklist parser
- the manager of the single `pihole.toml` config

Why it matters to search-hole: it is a mature reference for:
- a local daemon that owns a SQLite query log and also serves a dashboard (§4 "Runtime topology", ADR `dashboard-process-model`)
- auth for a local web UI with no password, including CSRF and DNS-rebinding defences (`security`)
- server-side paging of a huge live log (`ui-ux`)
- a "why was this blocked" reason stored per row (`merge-algorithm`, receipts)
- one config file with env overrides that lock fields in the UI (`key-storage`, config)
- regex rules from untrusted lists running on a non-backtracking engine (`rule-format-precedence`, `security`)

## Architecture sketch
```
pihole-FTL (one process, several threads; dnsmasq forks a child per TCP DNS connection)
├─ main / dnsmasq loop ── per query: check_domain_blocked()  (src/dnsmasq_interface.c)
│     └─ shared memory (/dev/shm, lock_shm) holds queries, domains, clients and a per-(domain,client) decision cache  (src/shmem.c)
├─ DB thread (src/database/database-thread.c: DB_thread, 100 ms loop)
│     ├─ every 1 s: queries_to_database()  shm → in-memory SQLite `query_storage` (REPLACE; updates of the last 30 s re-copied)
│     ├─ every 100 ms pass: gravity_updated() stat(gravity.db): new inode → RELOAD_GRAVITY;
│     │                     once per second also: info.updated changed → RELOAD_GRAVITY
│     ├─ every database.DBinterval (60 s): export_queries_to_disk()  memdb → ATTACHed `disk` = pihole-FTL.db (WAL)
│     ├─ nightly 03:10-03:50 (random minute): delete rows older than database.maxDBdays (91 d), 10,000 per loop pass
│     ├─ weekly (first run 1-2 h after start, random): ANALYZE
│     └─ events: RELOAD_GRAVITY → FTL_reload_all_domainlists(); PARSE_NEIGHBOR_CACHE; REIMPORT_ALIASCLIENTS
├─ GC thread (src/gc.c): every 600 s drop in-memory queries older than webserver.api.maxHistory (24 h);
│     polls inotify for pihole.toml edits → reread_config()
└─ CivetWeb threads (src/webserver/webserver.c)
      /api/**  → api_handler() route table (src/api/api.c)
      **.lp    → Lua server pages (web UI), the only server-side scripts allowed
      **       → static files from webserver.paths.webroot
```

## Key modules and data flow
- **Multi-call binary** (`src/args.c`). `pihole-FTL sqlite3 …` (embedded shell, also reachable via a symlink named `sqlite3`), `lua`, `gravity|antigravity parseList <file> <db> <id> <url>`, `gravity checkList`, `--config [-q] key [value]`, `regex-test`, `--teleporter`, `sigrtmin`, `idn2`, `sha256sum`, `verify`, `--totp`, `create-default-config`, `--complete`. The core scripts (`pi-hole.md`) need *no* system sqlite3, idn or TOML tools, because everything comes from one versioned binary.
- **Blocking decision order** (`src/dnsmasq_interface.c`: the caller of `check_domain_blocked` near L2085-2130, then `check_domain_blocked`):
  1. per-(domain, client) cached decision
  2. exact allowlist, then regex allowlist; if either matches, stop as allowed
  3. "special domains" (Mozilla canary, iCloud Private Relay, …)
  4. exact denylist (`QUERY_DENYLIST`)
  5. **antigravity**, i.e. allow-type adlists: exact, then ABP suffixes; a match means allowed
  6. **gravity**, i.e. block adlists: exact, then ABP suffixes (`QUERY_GRAVITY`)
  7. if any lookup returned "list not available", apply `dns.replyWhenBusy` (ALLOW / REFUSE / DROP / BLOCK; `QUERY_DBBUSY`)
  8. regex denylist (`QUERY_REGEX`)

  CNAME targets are re-checked and give the `*_CNAME` statuses. User exact/regex allow beats everything, and user exact deny beats list *allows*.
- **Reason encoding** (`check_domain_blocked`, comment at the antigravity branch). `list_id ≥ 0` is a `domainlist` row id (exact or regex rule). `−1` means none. `−(adlist_id + 2)` is an adlist, so `−2` is list 0. The value is cached in the per-client DNS cache and written to `query_storage.list_id`.
- **Gravity lookups** (`src/database/gravity-db.c`):
  - **one persistent read connection** with persistent prepared statements against the *views* (`vw_gravity`, `vw_antigravity`, `vw_allowlist`, `vw_denylist`, `vw_regex_*`)
  - the client's group ids are bound with SQLite's **`carray()`**, and rebinding is skipped when the client hasn't changed (`bind_client_groups`)
  - empty tables are detected once (`gravity_check_list_presence`), so their lookups are skipped
  - the ABP flag in `info.abp_domains` gates suffix lookups (`gravity_check_ABP_format`)
- **ABP matching = suffix probes** (`gen_abp_offsets`, `in_gravity`). After an exact miss, FTL computes every label suffix of the query name (TLD first) and looks up the literal string `||<suffix>^` (or `@@||<suffix>^`) in the same indexed `domain` column. There is no trie, just one B-tree probe per label.
- **Reload** (`src/datastructure.c: FTL_reload_all_domainlists`):
  - reopen `gravity.db` and refresh counts into shm
  - bump a shared **generation counter** (`counters->regex_change`) so forks recompile regexes lazily
  - check inaccessible adlists and restored-gravity flags, which become UI messages
  - **reset the per-client decision cache**
- **Query log write path** (`src/database/query-table.c`):
  - the in-memory DB (`:memory:`, or a temp file with `database.forceDisk`) has indexes on nearly every column
  - the disk DB is `ATTACH`ed as `disk`; export is one `INSERT INTO disk.query_storage SELECT … WHERE id > max(disk.id)` that stops before any row still inside the update window, plus incremental copies of the four lookup tables
  - on start, recent history is imported from disk into memory (`DB_read_queries`, `database.DBimport`)
- **API** (`src/api/*.c`). The route table maps (URI prefix, parameter pattern, handler, flags, require_auth, method bitmask) (`src/api/api.c: api_request[]`). The dispatcher handles OPTIONS with an `Allow` header, returns 405 with `Allow`, a JSON 404, and a 64 KiB payload cap (`MAX_PAYLOAD_BYTES`, `src/webserver/http-common.h`).
- **Streaming actions** (`src/api/action.c: run_and_stream_command`). `POST /api/action/gravity` forks `pihole -g` and relays stdout as **HTTP chunked `text/plain`** (`mg_send_chunk`). An atomic flag returns **409 `gravity_running`** for a second concurrent run.

## Data model and storage
**`pihole-FTL.db`** (schema version 22, `MEMDB_VERSION` in `src/database/query-table.h`; asserted by `test/test_suite.bats` "pihole-FTL.db schema is as expected"):

| Table | Content |
|---|---|
| `query_storage` | id (AUTOINCREMENT), timestamp, type, status (enum), domain→`domain_by_id`, client→`client_by_id`(ip, name), forward→`forward_by_id`, additional_info→`addinfo_by_id`(type, content), reply_type, reply_time REAL, dnssec, **list_id**, ede |
| `queries` (VIEW) | `query_storage` LEFT-JOINed back to text (v22 replaced correlated subqueries with JOINs for speed: `replace_queries_view_with_joins`) |
| `ftl` | (id, value, description) properties incl. DB version |
| `counters` | persistent totals |
| `network`, `network_addresses`, `aliasclient` | device inventory |
| `message` | (id, timestamp, type, message, blob1..blob5): typed admin notices such as `INACCESSIBLE_ADLIST_MESSAGE`, `GRAVITY_RESTORED_MESSAGE`, `RATE_LIMIT_MESSAGE`, `DISK_MESSAGE` (`src/enums.h: enum message_type`; `src/database/message-table.c`) |
| `session` | (id, login_at, valid_until, remote_addr, user_agent, sid, csrf, tls_login, tls_mixed), so sessions survive restarts (`src/database/session-table.c`; `webserver.session.restore` = true) |

- **Normalisation** into `*_by_id` dictionary tables cuts row size. A process-local open-addressing cache (1024 slots, Knuth hash) avoids `INSERT OR IGNORE` plus SELECT on every row (`query-table.c`, `addinfo_id_cache`).
- **Status enum** (`src/enums.h: enum query_status`): UNKNOWN, GRAVITY, FORWARDED, CACHE, REGEX, DENYLIST, EXTERNAL_BLOCKED_{IP,NULL,NXRA,EDE15}, GRAVITY_CNAME, REGEX_CNAME, DENYLIST_CNAME, RETRIED, RETRIED_DNSSEC, IN_PROGRESS, DBBUSY, SPECIAL_DOMAIN, CACHE_STALE. Statuses are stored as ints and the API maps them to strings.
- **Retention**: in memory `webserver.api.maxHistory` = 86,400 s (max 24 h; `MAXLOGAGE`), GC every 600 s (`src/gc.c`). On disk `database.maxDBdays` = 91 days (`365/4`; 0 disables the DB), deleted nightly in batches of `DATABASE_DELETE_BATCH` 10,000 so other DB tasks and shutdown aren't blocked (`database-thread.c`). `misc.privacylevel` 0-3, and at level 3 nothing is stored (`queries_to_database`).
- **`gravity.db`** schema is owned by the core repo (`pi-hole.md`). FTL reads it with `PRAGMA temp_store=MEMORY` and `mmap_size=256 MiB`, plus `posix_fadvise(WILLNEED)` pre-warming after each (re)open (`gravityDB_open`).

## Config format
- **One file**: `/etc/pihole/pihole.toml` (parsed by the vendored tomlc17). Every option is a `struct conf_item` in a registry (`src/config/config.h`): dotted key, path, **env name**, help text, allowed values (JSON), type (bool/int/uint/string/password/enum…/IP/JSON array), **flags**, value, default and a validator function. The registry drives TOML I/O, the API (`GET /api/config?detailed=true`, `/api/config/_properties`), the CLI (`--config`) and the web settings UI.
- **Flags** (`config.h`): `RESTART_FTL`, `PSEUDO_ITEM` (e.g. `webserver.api.password` is write-only and hashed into `webserver.api.pwhash`), `INVALIDATE_SESSIONS`, `WRITE_ONLY`, `ENV_VAR` (forced), `CONF_IMPORTED`, `API_READ_ONLY` (settable only through the CLI or the file, for options whose values make Pi-hole run external code), `API_CLI_READ_ONLY` (file or env only). `misc.readOnly` locks the whole config.
- **Writer** (`src/config/toml_writer.c: writeFTLtoml`):
  - writes *every* option with its help as comments, plus `### CHANGED, default = …` (and `(env)`) on non-defaults
  - a footer gives totals and lists the "N entries forced through environment"
  - to install: take an exclusive `flock` on `pihole.toml.lock`, a path that is never renamed, write `pihole.toml.tmp`, compare it with the live file ignoring the first 8 header lines, rotate backups (`rotate_files`), `rename()`, store a sha256
  - the inotify watcher is paused during the write, and the checksum stops FTL reloading its own write (`src/config/inotify.c`; `config.c: last_checksum`)
- **Load order** (`config.c: readFTLconf`):
  1. defaults
  2. collect `FTLCONF_*` env vars
  3. parse `pihole.toml`; if it is invalid, try rotated backups newest-first; if none parse, move the bad file to `.broken` and write defaults
  4. **rewrite** the file, so new options appear with their docs after an upgrade
- **Env override** (`src/config/env.c`, `config.c` ~L1720). The name is `FTLCONF_` plus the key with `.`→`_` (e.g. `FTLCONF_webserver_api_password`), matched case-insensitively. A forced item gets `FLAG_ENV_VAR`. It is then read-only for the API, for the CLI (exit code 5, `ENV_VAR_FORCED`) and in the UI (inputs disabled with a badge; `pi-hole-web.md`). If the variable later disappears, the item **resets to default**: the previous forced set is read back from the TOML footer (`read_forced_vars`). `printFTLenv` logs used, invalid and ignored env vars, and `suggest.c` gives "did you mean" for unknown keys.
- **v5 → v6 migration** (`config.c: migrate_config_v6`): import `pihole-FTL.conf` (`legacy_reader.c`), `setupVars.conf` (`setupVars.c`), static DHCP, CNAME and `custom.list` files. Move the legacy files to a migration directory, run **all validators** on the result (a bad value is reset to default and logged), then write the TOML. Old double-SHA256 password hashes keep working beside the new BALLOON-SHA256 PHC hashes (`password.c`, `verify_password`).

## Extension points (plugins, hooks)
- **Lua server pages**: the web UI is `.lp` files evaluated by the embedded Lua with a `pihole.*` helper table (`src/webserver/lua_web.c`, `src/lua/ftl_lua.c`). `lua_script_pattern` and `ssi_pattern` are pinned empty so only `.lp` runs (`webserver.c` options comment).
- **REST API**: documented by an embedded **OpenAPI 3.0.2** spec split per tag (`src/api/docs/content/specs/*.yaml`, served at `/api/docs`). `GET /api/endpoints` lists the route table itself. App passwords exist for third-party clients.
- **Regex extensions**, appended after `;` (`src/regex.c: compile_regex`): `querytype=A,AAAA` / `!AAAA`, `invert`, `reply=NXDOMAIN|NODATA|REFUSED|IP|<ipv4>|<ipv6>|NONE|CNAME,<target>`. Unknown options are rejected.
- **Signals**: SIGHUP flushes the cache, SIGRTMIN reloads lists (`pi-hole.md`).

## Rules / lists: parsing and compilation
**Parser** (`src/tools/gravity-parseList.c: gravity_parseList`, run once per list). Per line it:
- strips a UTF-8 BOM, CR/LF and trailing whitespace
- skips lines starting with `!` (ABP comment), `#`, `;` or `[` (ABP header)
- drops cosmetic and scriptlet rules (`##`, `#$#`, `#@#`, `#?#`, `#%#`) and cuts inline `#` comments
- splits on whitespace, so the hosts format works: IPv4/IPv6 tokens are skipped via `inet_pton`
- removes a trailing dot and lowercases

Each token is then classified:
- **exact**: a valid FQDN: `[a-z0-9._-]`, labels 1-63, total ≤ 255, at least one dot, TLD not starting or ending with `-`. IDN names are converted to **punycode** with libidn2 and validated in that form.
- **ABP**: `||domain^` for block lists, `@@||domain^` for allow lists. The literal pattern is stored and single-label names are allowed. Any other ABP syntax (options `$third-party`, paths, wildcards) is not recognised, so it lands in the invalid count.
- **invalid**: counted, and the first 5 distinct samples are printed. Samples are suppressed for `file:` sources so local files can't be exfiltrated via the API. A false-positive list (`localhost`, `broadcasthost`, `ip6-*`, …) is ignored without counting.

Inserts go through one prepared statement in one transaction, with `journal_mode=OFF` and `synchronous=OFF` on the temp DB. Progress prints every 5% for files over 10 MB. At the end it writes `adlist.number` (exact + ABP), `invalid_domains`, `abp_entries` and the `info.abp_domains` flag.

**User rules** (API `src/api/list.c`):
- domains are converted to punycode and validated (single-label allowed)
- regexes are **compiled at insert time** and the whole batch fails fast on the first invalid one
- `\r`/`\n` are rejected in any input (header-injection guard)
- batch adds return `processed: {success: [...], errors: [{item, error}]}` for partial success

**Regex engine** (`src/regex.c`, `src/regex_r.h` sets `USE_TRE_REGEX`):
- **TRE**, POSIX ERE compiled with `REG_EXTENDED | REG_ICASE | REG_NOSUB`
- TRE matches with a tagged-NFA *parallel* matcher, which its source documents as linear in the length of the text and non-backtracking. `regexec.c` switches to the **backtracking** matcher when the pattern has back-references (`tre_have_backrefs` → `tre_tnfa_run_backtrack`) and to a separate **approximate-matching** matcher when it uses TRE's fuzzy `{~N}` syntax (`TRE_APPROX` is defined in `tre-config.h`; BATS "Regex Test 15-23" exercise it). FTL rejects neither, and no per-regex length cap appears in `compile_regex` or `list.c` (verified by reading; inferred absence). The only bound is the 64 KiB request-payload cap (`MAX_PAYLOAD_BYTES`).
- regexes run as a linear scan over all compiled filters, with a per-client enable bitmap and a **query-type bitmask prefilter** before `regexec`; results are memoised in the per-(domain, client) cache
- compiled regexes are per process and rebuilt when the shared generation counter moves (`match_regex`)

## Testing strategy
- `test/test_suite.bats` has about 211 `@test`s and runs a real FTL against a fixture `gravity.db.sql`, `pihole-FTL.db.sql` and `pihole.toml`, querying it with `dig`. It covers:
  - blocking semantics: gravity vs exact allow, regex allow, antigravity, ABP suffix (`a.b.c.d.special.gravity.ftl`)
  - 53 numbered "Regex Test N" cases via `pihole-FTL regex-test` (including back-reference, approximate-matching and `;querytype` / `;reply` option cases)
  - punycode storage
  - an exact assertion on the DB schema dump
  - concurrency regressions such as "Gravity: API write waits for a concurrent reader instead of failing"
- `test/api/` uses Python and pytest:
  - `checkAPI.py` diffs the endpoints in the OpenAPI specs against `GET /api/endpoints`, both ways
  - `openapi-enforcer.js` validates real responses against the spec
  - `test_api.py` covers HTTP errors, CORS, config validation by type and validator, env-protected config, domain search
  - `test_m_mutations.py` covers PUT, DELETE and batchDelete for groups, domains, clients and lists, config PATCH round-trip, regex array validation
  - `test-rate-limit.py` checks login rate limiting
- C regression programs for parsers (`gzip_regression.c`, `tar_regression.c`, `ptr_response_regression.c`, `txt_stat_regression.c`).

## UX patterns worth copying
- **Self-describing API**: `/api/endpoints`, an embedded OpenAPI viewer at `/api/docs`, and `took` (seconds) on every JSON reply. Errors are `{error: {key, message, hint}}`, where `key` is machine-readable (e.g. `gravity_running`, `api_seats_exceeded`, `rate_limiting`) and `hint` is actionable (e.g. "increase webserver.api.max_sessions") (`src/webserver/http-common.c`, `json_macros.h`).
- **Config that documents itself**: every option is written with its help text, allowed values and "CHANGED, default = x" markers, so editing the file by hand is safe and diffable.
- **Typed admin messages** (`message` table) surface background problems: a list unreachable, gravity restored from backup, disk nearly full, rate limiting. They show in the UI as a badge and a page, not just in logs.
- **Pause blocking with a timer**: `POST /api/dns/blocking {blocking:false, timer:N}` (`src/api/dns.c`; the web sidebar offers 10 s, 30 s, 5 min, custom or indefinitely).
- **Explain endpoint**: `GET /api/search/{domain}?partial=&N=` returns matching user rules, gravity hits (with list address, type, counts, status, groups), antigravity hits and every regex that matches (`src/api/search.c`).

## Performance tricks
- Hot path: an in-process per-(domain, client) decision cache in shm, invalidated by a generation counter on list reload (`FTL_reset_per_client_domain_data`).
- Persistent prepared statements (`SQLITE_PREPARE_PERSISTENT`) with `carray()` binding, rebinding skipped for the same client. Lookups skip empty tables and skip ABP probes unless any list has ABP rules.
- The authors measured, and rejected, precomputing per-client adlist ids against the base table: about 4x faster, but stale after group or list toggles. They chose correctness through views (`gravityDB_open` comment block).
- `gravity.db` is replaced, never rewritten in place: mmap 256 MiB, `posix_fadvise(WILLNEED)` warm-up after a swap, busy handler set to 0 on the read connection so DNS lookups never wait (`dns.replyWhenBusy` decides instead).
- Query log: hot data lives in `:memory:` (fast UI paging over 24 h); disk writes are batched every 60 s; `PRAGMA disk.synchronous=NORMAL` under WAL. The code comment argues WAL plus NORMAL can't corrupt, and loses at most one flush interval on power loss. `SQLITE_DEFAULT_JOURNAL_SIZE_LIMIT` is 32 MiB so `-wal` doesn't grow unbounded, `mmap_size` 256 MiB on the disk DB, no pre-warm, because the query DB can be gigabytes.
- SQLite compile flags (`src/CMakeLists.txt` L27-46): `DEFAULT_MEMSTATUS=0`, `OMIT_SHARED_CACHE`, `DQS=0`, `DEFAULT_FOREIGN_KEYS=1`, `DEFAULT_SYNCHRONOUS=1`, cache 4096 pages, `ENABLE_CARRAY`, `MAX_PREPARE_RETRY=200`.
- Busy handling: a custom busy callback with a delay table of 1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50 and 100 ms, capped at `DATABASE_BUSY_TIMEOUT` = 1000 ms (`src/database/common.c: sqliteBusyCallback`).

## License and what it means for us
FTL's code is EUPL-1.2, so we take **ideas only**: no code, SQL strings, schema text or comments. The vendored permissive libraries are fine to use as libraries but irrelevant to a TypeScript project. The relevant one is TRE (BSD-2), which shows that POSIX ERE without back-references or fuzzy syntax can be matched in time linear in the input, but we'd pick an RE2-style engine for JS. dnsmasq is GPL, so stay away. The mechanisms described here (per-row reason id, cursor paging, memdb plus periodic export, flock plus rename config writes, Sec-Fetch-Site and Host checks) are not copyrightable expression, so re-implementing them from this description is fine.

## Implications for search-hole
- [dashboard-process-model] FTL is a **long-running daemon that owns the DB, the API and the UI**, and list and rule writers (CLI, web) go through its API. Two writers bypass it: `gravity.sh` builds and swaps `gravity.db` on its own, and `pihole-FTL --config` edits `pihole.toml` directly under an flock (`src/config/cli.c`, `toml_writer.c`). search-hole's gateways are many short-lived stdio processes, so copying this would force a daemon or IPC. Keep §4's default (every gateway writes SQLite directly under WAL; the dashboard is an on-demand reader and writer). Borrow FTL's *internal* pattern of a dedicated writer loop with batched flushes. Evidence: `src/database/database-thread.c: DB_thread`; `pi-hole.md` api.sh.
- [dashboard-process-model] Live updates in Pi-hole are **polling only**: no WebSocket or SSE use in FTL's own code under `src/webserver` or `src/api` (a case-insensitive grep for websocket and event-stream hits only the vendored CivetWeb sources). The query log polls `/api/queries` every 2 s with a cursor, and logs poll `/api/logs/*?nextID=` every 0.5 s. That is evidence our planned "tail `rowid > last` + SSE" is a strict improvement. Keep a polling fallback built on the same cursor contract (`src/api/logs.c` returns `nextID` plus `pid` so clients detect a restart and reset).
- [sqlite-driver] Use WAL plus `synchronous=NORMAL` plus a journal size limit (e.g. `journal_size_limit` 32 MiB) for the log DB, and a busy handler or `busy_timeout` of about 1 s for writers. Evidence: `query-table.c: init_memory_database` (WAL, NORMAL), `src/CMakeLists.txt` (`DEFAULT_JOURNAL_SIZE_LIMIT`), `common.c: sqliteBusyCallback`.
- [sqlite-driver] Pi-hole keeps **hot rows in an in-memory SQLite and exports every 60 s** for UI speed on a Raspberry Pi. Our volume (hundreds of searches a day, not thousands of DNS queries a second) doesn't justify a memdb: write straight to the WAL DB in one transaction per search. Revisit only if the dashboard is slow on 100k+ rows. Evidence: `query-table.c: export_queries_to_disk`.
- [merge-algorithm] Store the *reason* as a compact typed reference on every result row, like FTL's `list_id` (≥0 user rule id, ≤−2 list id). For us: `decision` plus `rule_id` plus `list_id` plus `scope`, and an `explain` JSON for multi-rule cases. Unlike Pi-hole's UI, **resolve it to a name and link in the log itself**. Pi-hole only shows "search lists" (`pi-hole-web.md` `queries.js: formatInfo`). Evidence: `dnsmasq_interface.c: check_domain_blocked`, `query_storage.list_id`.
- [rule-format-precedence] Pi-hole's precedence, which we can cite in the ADR table: user exact or regex **allow** > special > user exact **deny** > list **allow** (antigravity) > list **block** > user regex deny. So a user allow beats every list, and a user deny beats a list allow. That matches §6 "A user's `allow` always beats any list rule". Note that Pi-hole evaluates user *regex deny last*, after lists; for blocking, order doesn't change the outcome, only which reason is recorded. Evidence: `dnsmasq_interface.c` L2085-2130 and `check_domain_blocked`.
- [rule-format-precedence] Record **one** winning reason per row (first match in a fixed order) and make the order part of the documented contract, so "explain" is deterministic. FTL's `/api/search` gives the *all-matches* view separately (`src/api/search.c`). We want both: the winning rule on the row, all matches in `--explain`.
- [lists-subscriptions] Compile domain lists to an exact set plus ABP-style suffix entries, and match by **probing every label suffix of the host** (TLD first) against one set or index: O(labels) lookups, no trie. That fits the "<300 ms startup / 418k rules" goal as a SQLite indexed table or a serialised hash set. Evidence: `gravity-db.c: gen_abp_offsets, in_gravity`; `tools/gravity-parseList.c: valid_abp_domain`.
- [lists-subscriptions] Count and report what we **can't** express. Pi-hole lumps unsupported ABP syntax (`$options`, paths) into "invalid", which confuses users. We should split `invalid` from `unsupported` (e.g. cosmetic, `$third-party`) per list and show both. Evidence: `gravity-parseList.c` (comment and cosmetic skip, then everything else is invalid).
- [lists-subscriptions] Normalise hosts with IDN→punycode before both storing and matching, lowercase them and strip the trailing dot (`gravity-parseList.c: check_domain, valid_idn`; test "Gravity stores internationalized domains as punycode").
- [security] Regex from subscribed lists needs a linear-time engine. FTL relies on TRE's non-backtracking matcher but still allows back-references (which fall back to backtracking) and TRE's fuzzy-match syntax (a third matcher), and sets no length cap. For search-hole: an RE2-class engine (WASM RE2 or a Thompson-NFA JS library), **reject back-references, lookaround and fuzzy-match syntax at import**, cap length and per-list count, compile at import time and reject the whole rule with a clear error (as FTL's API fails a batch fast). Evidence: `src/regex.c: compile_regex`; `src/tre-regex/regexec.c`; `src/api/list.c`.
- [security] For a password-less local dashboard on 127.0.0.1, copy FTL's two checks for when no password is set: (1) a **cross-site check**: refuse if `Sec-Fetch-Site` isn't `same-origin` or `none` (allow `navigate` GETs), falling back to an `Origin`-vs-`Host` comparison; (2) a **Host allow-list** (IP literal, `localhost`, configured names) to defeat **DNS rebinding**. Evidence: `src/api/auth.c: cross_site_request, known_host, check_client_auth`. Add a random per-start token in the dashboard URL as a stronger default (our design choice).
- [security] Session design for when auth is on: 128-bit random sid in an `HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` on TLS), a sliding timeout (1800 s), a **separate CSRF token** required in `X-CSRF-TOKEN` only for cookie-authenticated API calls, constant-time comparisons, and a slot limit (16) with a 429 hint (`auth.c`, `auth.h: FTL_SET_COOKIE`). App passwords whose sessions can't change config unless `app_sudo`, and ephemeral CLI passwords whose sessions can't change config at all, are a good model for capability-scoped tokens (`config/password.c: verify_login`; enforced in `src/api/config.c` ~L1273-1282 and `src/api/teleporter.c`).
- [security] Mark side-effecting endpoints and expose a kill-switch (`webserver.api.allow_destructive`). Ship strict default headers: CSP `default-src 'none'` with explicit `connect-src 'self'`, `frame-ancestors 'none'`, nosniff, a strict-origin referrer policy (`config.c` `webserver.headers` defaults).
- [key-storage] Env-var override semantics worth copying for API keys and settings. A value forced by the environment is **shown as locked** in the UI and CLI ("set via environment"), never written back, and reverts cleanly when the variable goes away. The dashboard gets per-field `flags.env_var` metadata. Evidence: `config/env.c: readEnvValue, read_forced_vars`; `toml_writer.c` "(env)" markers; web `settings.js` disabling inputs.
- [upgrades-migrations] Config robustness: write to a temp file, then rename, under an flock on a never-renamed lock path; keep rotated backups; on parse failure fall back to the newest valid backup and quarantine the bad file as `.broken`; rewrite after load so new options appear. Use a content checksum to ignore your own writes in the file watcher. Evidence: `toml_writer.c: writeFTLtoml`; `config.c: readFTLconf`; `inotify.c`.
- [upgrades-migrations] Migration of legacy config should run **all validators** and reset bad values to defaults with a log line, never abort (`config.c: migrate_config_v6`). Keep the old file in a migration directory.
- [mcp-tool-surface] Machine-readable error keys plus a human hint plus timing on every response (`{error:{key,message,hint}}`, `took`) map well onto MCP tool errors and `structuredContent`. Evidence: `src/webserver/http-common.c`.
- [testing] Contract tests that diff the declared endpoints (OpenAPI) against the live route table, and validate real responses against the schema (`test/api/checkAPI.py`, `openapi-enforcer.js`). For us: diff MCP tool schemas and dashboard API zod schemas against the handlers, and snapshot-assert the SQLite schema dump as FTL's BATS does.
- [ui-ux] Server-side paging contract for the live log: `length` capped at 10,000, `start`, and a **`cursor` = max id at first load**, so new rows don't shift pages while you browse, plus `recordsTotal` and `recordsFiltered`. Filters are allow-listed columns, never raw SQL. Evidence: `src/api/queries.c: api_queries` (`API_QUERIES_MAX_ROWS`, the cursor branch).
- [runtime-packaging] FTL bundles its own `sqlite3` shell, parser and config CLI in one binary, so scripts depend only on that binary's version. A compiled `searchhole` binary (bun `--compile`) could likewise expose `searchhole db shell` and `searchhole lists parse --check` for debugging without a system sqlite3. Evidence: `src/args.c`.

## Borrow / avoid
**Borrow**
- Per-row typed reason id plus a separate all-matches "search/explain" endpoint.
- Suffix-probe domain matching against one index, and ABP detection by a flag so plain lists skip suffix work.
- Compile and validate regexes at insert time, fail the batch fast, reject CR/LF everywhere.
- Generation counter to invalidate caches across processes after a list reload (our gateways can poll `lists.generation` in SQLite).
- WAL plus `synchronous=NORMAL` plus journal size limit plus a busy handler with a capped backoff; batched writes; nightly retention delete in bounded batches at a random minute; weekly ANALYZE.
- Cursor-frozen server-side paging with capped page size and allow-listed filters.
- No-password local mode guarded by Sec-Fetch-Site/Origin plus Host allow-list; HttpOnly SameSite cookie plus separate CSRF header; scoped tokens (app or CLI) that can't change config.
- Self-documenting config file, env-forced fields locked in UI/CLI, flock plus rename plus backups plus `.broken` quarantine.
- Typed admin "messages" table for background failures, shown in the UI.
- OpenAPI/route-table parity test plus response schema enforcement.

**Avoid**
- A monolithic daemon owning everything (needs root-ish install, service manager). Our gateways are per-client stdio processes.
- Polling-only live UI (2 s query-log refresh) when SSE is cheap for us.
- Lumping unsupported list syntax into "invalid domains".
- Allowing regex back-references (backtracking fallback) and fuzzy matching, and having no per-rule length or count caps.
- Showing only "Query was blocked, search lists" instead of the actual rule or list name in the log row.
- An in-memory shadow DB plus 60 s export (complex, and loses up to a minute on crash). Unnecessary at our volume.

## Verification
Checked 2026-10-29 against `research/refs/pi-hole-ftl` @ 29c8b13 (read-only; nothing was built or run). Claims checked: about 85. They cover the licence header (root `LICENSE`, `src/tre-regex/LICENSE`, `src/config/tomlc17/LICENSE`, `COPYING-v3`, and the headers of the other vendored directories, plus a scan for files outside them that lack the EUPL notice), all 21 "Implications for search-hole" bullets, and the mechanisms they rely on: the blocking decision order and `list_id` encoding, ABP suffix probing, the parser rules and counters, TRE matcher dispatch, the DB thread loop and its constants, the busy-callback delay table, SQLite pragmas and compile flags, session, cookie, CSRF, `Sec-Fetch-Site` and Host checks, CLI password lifecycle, config writer (flock, tmp file, rename, checksum), env-forced fields, API paging cap and error shape, and the absence of WebSocket or SSE in FTL's own code.

Corrections made:
- Dashboard process model: "every other writer goes through the API" was too strong. `gravity.sh` builds and swaps `gravity.db` itself, and `pihole-FTL --config` edits `pihole.toml` directly under an flock (`config/cli.c` calls the TOML writer).
- Regex safety: TRE does not switch matchers "only" on back-references. It also uses a third, approximate-matching matcher for fuzzy `{~N}` syntax (`TRE_APPROX` is on; tests 15-23 cover it). The note now says to reject fuzzy syntax too, and that the only length bound is the 64 KiB request payload.
- Test counts: 53 numbered regex tests (not 35); about 211 `@test`s (not 212).
- "No WebSocket or SSE" was qualified: the vendored CivetWeb sources contain WebSocket code, FTL's own code does not use it.
- Licence header: miniz carries an MIT-style notice in `miniz.c` plus an Unlicense dedication (`miniz.h` says public domain); the SQLite files (`sqlite3.c`, `shell.c`, `sqlite3_rsync.c`) carry SQLite's public-domain dedication, so "inferred" was removed.
- Licence hygiene: one quoted FTL source comment was paraphrased as prose.

Confirmed unchanged: EUPL-1.2 for FTL's own code, dnsmasq as GPL-2.0-only OR GPL-3.0-only, TRE as BSD-2-Clause; the precedence order (user allow, special, exact deny, list allow, list block, regex deny); `list_id` of at least 0 for a rule row and `-(adlist_id + 2)` for a list; polling-only live updates.
