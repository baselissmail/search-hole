# pi-hole/pi-hole
> Ref: `research/refs/pi-hole` @ f503a65 (2026-10-17) · License: **EUPL-1.2** for the whole repo (root `LICENSE`). The only carve-out in that file is historical: "any commits made to the master branch prior to the release of version 3.0" keep their earlier licences. No per-directory licence files exist (`find -iname 'LICENSE*' -o -iname 'COPYING*'` returns only the root file). **Ideas only**: this note paraphrases and cites paths. It reproduces no script, SQL or comment text.

## Purpose
This is Pi-hole's "core" repo, almost all bash (`AGENTS.md` "Project overview"). It holds the installer (`automated install/basic-install.sh`), the `pihole` CLI dispatcher (`pihole`), the scripts behind each subcommand (`advanced/Scripts/*.sh`) and **gravity** (`gravity.sh`), which downloads blocklists and compiles them into `gravity.db`. The C daemon (FTL), which owns the DNS resolver, the REST API and the query log, lives in a separate repo (see `pi-hole-ftl.md`). The UI is in `pi-hole-web.md`.

Why it matters to search-hole:
1. Gravity is the closest real-world prior art for our **list subscription pipeline** (§6 "Lists", P6): it downloads conditionally, falls back to a cache, reports per-list health, compiles into SQLite, swaps atomically and keeps backups.
2. Since v6 the CLI is a **thin API client** of the daemon. That bears on whether our `searchhole` CLI writes to SQLite directly or goes through a gateway or dashboard process (§4 "Runtime topology").
3. Its schema-migration chain and v5→v6 upgrade path inform `upgrades-migrations`.

## Architecture sketch
```
cron (weekly, Sun, randomised 03-04h)  ┐
`pihole -g` (sudo)                     ├─► gravity.sh
FTL API POST /api/action/gravity ──────┘     (FTL forks `pihole -g`, streams stdout as chunked text)
   1. wait for DNS (getent raw.githubusercontent.com, then github.com, up to 40 x 1 s)
   2. build gravity.db_temp from the schema template (advanced/Templates/gravity.db.sql)
   3. ATTACH live gravity.db, copy user tables (groups, domainlist, adlist, clients + junctions)
         └─ on failure: try gravity_backups/gravity.db.1..10, record info.gravity_restored
   4. for each enabled adlist (view vw_adlist):
         curl --etag-compare/--etag-save + -z <cached file mtime> + --compressed
         200 → replace cache, sha1 compare → status 1 (changed) / 2 (same)
         304 → status 2, re-parse the cached file
         fail → cached copy? status 3 : status 4 (number=0)
         `pihole-FTL gravity|antigravity parseList <file> <temp db> <id> <url>`   (C parser, in FTL repo)
   5. info.updated = now; CREATE INDEX (domain, adlist_id) on gravity + antigravity
   6. counts → info.gravity_count / antigravity_count; ANALYZE
   7. swap: optional gravity_old.db copy (only if free disk > 2x db size);
            DROP gravity/antigravity + VACUUM on the old file → rotate to gravity_backups/gravity.db.1 (keep 10);
            mv gravity.db_temp → gravity.db           (rename = atomic switch)
   8. delete cache files of lists no longer configured
FTL polls stat() of gravity.db: new inode → reload lists (see pi-hole-ftl.md "gravity_updated")
```
The CLI side, for every subcommand except gravity and repair:
```
pihole allow|deny|-q|flush|api …  ─► advanced/Scripts/api.sh
     discover API URLs: DNS CHAOS TXT "local.api.ftl" @127.0.0.1 (FTL answers with its URL list)
     probe each URL's /api/auth: 200 = no password, 401 = need auth (+ whether TOTP is required)
     password = /etc/pihole/cli_pw (ephemeral, regenerated on each FTL start) or interactive prompt
     POST /api/auth → sid → call endpoint with header `sid:` → DELETE /api/auth (logout)
```

## Key modules and data flow
- **`pihole`**: a case dispatcher. Subcommands that need root (`-g`, `flush`, `reloaddns`, `reloadlists`, `setpassword`, `tail`, ...) are routed through a second case after the sudo check (`pihole`, bottom). `reloadlists` sends real-time signal **SIGRTMIN**, whose number it asks for with `pihole-FTL sigrtmin`, telling FTL to re-read lists without restarting. `reloaddns` sends SIGHUP to flush the cache (`pihole: reloadDNS`).
- **`gravity.sh`**: the whole compile pipeline above. Notable functions: `gravity_DownloadBlocklistFromUrl` (conditional GET, error-message table per HTTP code, cached fallback), `compareLists` (sha1 of the cache file decides "updated" vs "unchanged"), `database_adlist_status`/`database_adlist_number` (write status/number into the *temp* DB because the old one is about to be replaced), `gravity_build_tree`, `gravity_swap_databases`, `rotate_gravity_backup`, `try_restore_backup`, `database_recovery` (`PRAGMA integrity_check`, `foreign_key_check`, then `.recover` into `gravity.db.recovered`), `gravity_Cleanup` (also bound to Ctrl-C via `gravity_Trap`).
- **Self-hosting guard**: if a list's host would itself be blocked by Pi-hole, gravity resolves the host through the first configured upstream with `dig` and passes `curl --resolve` (`gravity.sh: gravity_DownloadBlocklistFromUrl`, the `dns.blocking.mode` switch). This is an "our own filter must not break our own updater" lesson.
- **Input hygiene on list URLs**: the URL is checked against an allowed-character class after stripping userinfo, and the scheme against an allow-list (http, https, file, ftp, ftps, sftp). A `file://` source is read as the unprivileged `pihole` user (`sudo -u pihole cat`), so root can't be tricked into reading files the daemon couldn't (`gravity.sh`, the `file:/` branch). There is a dedicated BATS test for that (`test/test_gravity.bats` "Gravity fails to read file not accessible by pihole user I/II").
- **`advanced/Scripts/api.sh`**: a POSIX-sh API client (`TestAPIAvailability`, `LoginAPI`, `Authentication`, `GetFTLData`, `PostFTLData`, `LogoutAPI`, `secretRead`). The CLI password path skips TOTP (`LoginAPI`).
- **`advanced/Scripts/list.sh`**: `pihole allow/deny/--regex/--wild/--allow-regex/--allow-wild` build a JSON array of domains and POST it to `/api/domains/{type}/{kind}`. They render the per-item `processed.success` / `processed.errors` from the reply, and map the UNIQUE-constraint error to "already in list". Removal uses `POST /api/domains:batchDelete`. `--wild` converts a domain into an anchored "dot-or-start … end" regex client-side (`list.sh: CreateDomainList`).
- **`advanced/Scripts/query.sh`**: `pihole -q domain [--partial] [--all]` calls `GET /api/search/{domain}?N=&partial=` and groups gravity hits by `(address, type)`, so the output reads "found in list URL X (block)". `--all` means N=10000, which the source labels a hard-coded FTL limit.
- **`advanced/Scripts/piholeLogFlush.sh`**: the nightly cron runs logrotate. Manual flush calls `POST /api/action/flush/logs`, and FTL drops the last 24 h of queries from memory and DB *while running* (no restart).
- **`advanced/Scripts/piholeDebug.sh`** (1,328 lines): the "doctor". It checks versions, OS, SELinux and firewalld, ports, name resolution, DB integrity (`database_integrity_check`) and gravity contents (`analyze_gravity_list`). It can **optionally upload** to tricorder.pi-hole.net after showing a disclaimer (`DISCLAIMER`, `upload_to_tricorder`).
- **`advanced/Scripts/database_migration/gravity-db.sh`**: `upgrade_gravityDB` reads `info.version` and applies `gravity/N_to_N+1.sql` in sequence (1→21). The migrations run at gravity start and via `gravity.sh -u`.

## Data model and storage
`gravity.db` schema version **21** (`advanced/Templates/gravity.db.sql`; summarised, not copied):

| Table | Purpose / notable columns |
|---|---|
| `group` | id, enabled, unique name, description, date_added/modified. **Group 0 "Default"** is re-created by a trigger if deleted |
| `domainlist` | user rules: `type` 0 exact-allow · 1 exact-deny · 2 regex-allow · 3 regex-deny; domain, enabled, comment, dates; UNIQUE(domain, type) |
| `adlist` | subscriptions: address, enabled, comment, `type` 0 block / 1 allow ("antigravity"), `date_updated`, `number`, `invalid_domains`, `abp_entries`, `status`; UNIQUE(address, type) |
| `gravity` / `antigravity` | compiled entries: (domain TEXT, adlist_id). No PK, and a **non-unique** index (domain, adlist_id) is created *after* the bulk load, because "poor quality adlists" contain duplicates (`gravity.sh: gravity_build_tree`) |
| `client`, `*_by_group` | per-client policy: client ↔ group ↔ list/domain junctions, `WITHOUT ROWID` with composite PK plus (group_id, x_id) index (migration `20_to_21.sql`) |
| `info` | key/value: `version`, `updated` (epoch of last successful run), `gravity_count`, `antigravity_count`, `abp_domains` (flag), `gravity_restored` (false / failed / backup filename) |

- **Views** (`vw_gravity`, `vw_antigravity`, `vw_allowlist`, `vw_denylist`, `vw_regex_allowlist`, `vw_regex_denylist`, `vw_adlist`) use LEFT JOINs to groups. An entry with no group rows applies to everyone, and the views **live-check** the `enabled` flags, so toggling a list or group takes effect without recompiling. The schema comments warn not to convert them to INNER JOIN (`gravity.db.sql`, comment above `vw_allowlist`).
- **Triggers**: inserts auto-assign to group 0, updates bump `date_modified`, deletes clean up junction rows.
- **Per-list status codes** (written by `gravity.sh`, read by FTL and the web UI): 0 unknown · 1 downloaded and changed · 2 unchanged (304 or same sha1) · 3 download failed, cached copy used · 4 failed with no cache (entries zeroed). `date_updated` moves only on status 1 (FTL `tools/gravity-parseList.c`, the final UPDATE).
- **On-disk artefacts**: `listsCache/list.<id>.<host>.domains` with sibling `.etag` and `.sha1` files. The cache lives next to `gravity.db` (`migrate_to_listsCache_dir` moved it there in v6). Other files: `gravity_backups/gravity.db.{1..10}` (user tables only, since gravity tables are dropped and VACUUMed first), `gravity_old.db` (full copy, removed at the next run), `migration_backup/` (pre-v5 flat files).
- **Ownership**: everything is chown'd `pihole:pihole`, mode 664 (`fix_owner_permissions`). Gravity refuses to run as root against pihole-owned paths (header comment, `gravity.sh` lines ~15-20).

## Config format
- The core scripts no longer parse config files. They call **`pihole-FTL --config -q <dotted.key>`** to read and `pihole-FTL --config <key> <value>` to write (`advanced/Scripts/utils.sh: getFTLConfigValue / setFTLConfigValue`). Exit code **5** means the value is forced by an environment variable and is read-only, and the script tells the user to unset it (`setFTLConfigValue`). This puts the single TOML config (`/etc/pihole/pihole.toml`, owned by FTL) behind one accessor. See `pi-hole-ftl.md`.
- Keys gravity reads: `files.gravity`, `files.gravity_tmp`, `dns.blocking.mode`, `dns.upstreams`, `dns.port` (`gravity.sh` top; `api.sh: TestAPIAvailability`).
- **Pre-v5 migration**: flat files `adlists.list`, `whitelist.txt`, `blacklist.txt`, `regex.list` are imported once into the DB and moved into `migration_backup/` (`gravity.sh: migrate_to_database`, `database_table_from_file`). The user-facing `-r recreate` re-imports from that backup.
- Scheduling is a cron file (`advanced/Templates/pihole.cron`): gravity weekly on Sunday, log flush daily at 00:00, update-check daily and at reboot. The template ships 01:59 and 17:59. The installer then **randomises** them with `sed` and `$RANDOM`: gravity at minute 1-58 of hour 3-4, the update check at minute 1-58 of hour 12-19 (`automated install/basic-install.sh` ~L1565-1569). The random spread stops every install from hitting list hosts at the same minute.

## Extension points (plugins, hooks)
- No plugin system. The extension points are **adlist URLs** (any http/https/ftp/file URL), **regex rules with FTL extensions** (see `pi-hole-ftl.md`), **groups/clients** for per-device policy, and the **REST API** that third-party tools use (app passwords).
- `file://` adlists let users plug in locally generated lists. Our analogue is a local `.searchhole.yaml` or a generated file.

## Rules / lists: parsing and compilation
- **Parsing is not in this repo**: gravity shells out to `pihole-FTL gravity parseList` (`gravity.sh`, three call sites in `gravity_DownloadBlocklistFromUrl`). The parser accepts hosts files, plain domains and ABP `||domain^` / `@@||domain^`, and counts invalid lines. The details are in `pi-hole-ftl.md` "Rules / lists".
- **Conditional download** (`gravity_DownloadBlocklistFromUrl`): it uses curl's `--etag-save`/`--etag-compare` when available (a capability probe of `curl --help all`) and **always** adds `-z <cached file>` (If-Modified-Since from the file mtime) as a fallback, noting that raw.githubusercontent.com honours ETag but not IMS. It uses `--compressed` when curl has libz, `--connect-timeout 10`, `-L` and `--fail`. A 304 re-parses the cached file.
- **Change detection** is belt-and-braces: HTTP 304 *or* an identical sha1 of the body → status 2 (`compareLists`).
- **Empty body** → treated as failure → cached fallback (`"Received empty file"` branch). An empty list never wipes the old one, but there is **no shrink guard**: a list that drops from 400k to 10 entries is accepted silently. Nothing compares the new `number` to the old (verified by reading `gravity_DownloadBlocklistFromUrl` and `gravity_swap_databases`; `grep -n shrink|threshold gravity.sh` finds nothing). Our planned "rollback if shrink > 50%" is stricter.
- **Atomic swap**: the build happens entirely in a separate file. The live file is replaced with `mv` (an atomic rename on the same filesystem), and the old one is rotated into `gravity_backups/` (keeping 10). The FTL side detects the swap by **inode change**, not by a signal.
- **Recovery ladder** on copy failure: try backups 1..10 → mark `info.gravity_restored` with the backup name → FTL logs a `GRAVITY_RESTORED_MESSAGE` that the UI shows (`try_restore_backup`; FTL `database/gravity-db.c: check_restored_gravity`).
- **Lost-update window (inferred)**: user tables are copied from the live DB at step 3, and the swap happens at step 7, possibly minutes later. An allow/deny added through the API *during* a gravity run is written to the old file and lost on swap. Nothing in `gravity.sh` locks against it. The FTL API refuses only a *second* concurrent gravity run, with 409 (`pi-hole-ftl` `src/api/action.c: api_action_gravity`). A cron run and an API run can still overlap, because `gravity.sh` has no flock (`grep flock` finds nothing).

## Testing strategy
- **BATS** suites run inside per-distro Docker images (`test/_debian_13.Dockerfile`, `_alpine_3_24`, `_fedora_44`, `_ubuntu_26`, ...; `test/run.sh --distro debian_12`; `AGENTS.md` "Testing instructions"). About 62 `@test`s.
- `test/test_gravity.bats` covers first-run DB creation, default and local adlists, invalid protocol, invalid target, non-resolvable host, missing host, connection refused (host or IP), a non-SSL host on an HTTPS URL, and three `file://` permission cases. It branches on the curl version (≥7.70 for ETag, ≥7.75 for `%{errormsg}`, ≥8.21 for the newest messages), because the output strings differ.
- `test/test_symlink_safety.bats` checks that prestart doesn't follow symlinks and that git `safe.directory` trusts only root-owned repos. These are security-regression tests for a root-running installer.
- CI enforces *differential* ShellCheck: only new findings fail (`.github/workflows/test.yml` "Differential ShellCheck"). Every commit needs a DCO sign-off (`.github/dco.yml`).

## UX patterns worth copying
- **Narrated pipeline output**: every step prints `[i] Doing X...` and is overwritten in place with `[✓]` or `[✗]` (`OVER` escape plus a tick/cross from `COL_TABLE`). The same stream is shown live in the web UI, which turns the ANSI codes into CSS classes (`pi-hole-web.md`). Our `searchhole lists update` can emit the same per-list lines: target, status, "No changes detected", parsed N, ignored M.
- **Specific failure messages** per HTTP code (403 Forbidden, 404, 408, 451 Unavailable For Legal Reasons, 5xx, Cloudflare 521/522) instead of a generic "failed", plus curl's own `errormsg` where available.
- **Health per list, persisted** (status 1-4, number, invalid, abp, date_updated), so the UI can show "List unavailable, Pi-hole used a local copy · check list".
- `pihole -q domain` answers "*which* list contains this?" across user rules and every subscribed list. This is the CLI form of our `search --explain`.
- `-t/--timeit` prints the duration of each step: cheap built-in profiling (`gravity.sh: timeit`).
- Repair is a first-class verb: `pihole -g -r recover [force]` or `recreate`, with honest help text about how fragile recovery is (`repairSelector`).

## Performance tricks
- The index is built **after** the bulk insert, not maintained during it (`gravity_build_tree` runs after all `parseList` calls). The parser inserts in one transaction with `journal_mode=OFF` and `synchronous=OFF` on the throwaway temp DB (FTL `tools/gravity-parseList.c`), which is safe because a crash just discards the temp file.
- `ANALYZE` with `analysis_limit=0` (full statistics) on the fresh DB before the swap (`gravity_optimize`).
- `gravity_ShowCount` runs **after** indexing so the COUNT(DISTINCT) queries use the index. The distinct count is cached in `info.gravity_count`, so the daemon and UI never count 400k rows at runtime.
- Backups drop the big tables and VACUUM first, so ten backups cost roughly ten copies of the *user* data, not ten copies of gravity.
- The old DB is copied only if free space is more than twice its size ("better be safe than sorry", `gravity_swap_databases`).

## License and what it means for us
EUPL-1.2 is copyleft. A derivative must stay EUPL or a listed compatible licence (the EUPL appendix lists GPL-2/3, AGPL-3, MPL-2, LGPL, EPL, CeCILL, OSL, LiLiQ, CC BY-SA 3.0). search-hole is MIT-or-similar, so **no code, SQL, schema text or comment text may be copied**. Everything here is described as mechanism. Re-implementing ideas (atomic file swap, ETag+IMS, status codes, per-list counts, backup rotation) is fine because they are not copyrightable expression. Don't ship Pi-hole's default adlist or reuse its CLI help text. The trademark rule from the plan header also applies: no "Pi-hole" in branding.

## Implications for search-hole
- [lists-subscriptions] Store per subscription: `etag`, `last_modified`, `sha256` of the body, `status` (Pi-hole's 4-state model: updated / unchanged / failed-using-cache / failed-no-cache), `rule_count`, `invalid_count`, `unsupported_count`, `date_updated` (only moves when content changed) and `date_checked`. Evidence: `gravity.sh: gravity_DownloadBlocklistFromUrl, compareLists`; adlist columns in `advanced/Templates/gravity.db.sql`.
- [lists-subscriptions] Send **both** `If-None-Match` and `If-Modified-Since`. GitHub raw honours ETag only, older servers IMS only (`gravity.sh`, the `modifiedOptions` comments). Treat an empty 200 as failure and keep the cache.
- [lists-subscriptions] Add the shrink guard Pi-hole lacks: compare the new `rule_count` with the previous one before swapping, reject a shrink over 50% (configurable), keep the old compiled list and set status "suspicious-shrink". Evidence that Pi-hole has none: `gravity.sh: gravity_swap_databases` swaps unconditionally.
- [lists-subscriptions] Build compiled list data off to the side (temp table or temp file), then switch with a single atomic step: a SQLite transaction flipping `lists.active_version`, or a rename of a versioned matcher file. Keep N previous versions for rollback. Evidence: `gravity.sh` steps 2→7 and `rotate_gravity_backup`.
- [upgrades-migrations] Avoid Pi-hole's lost-update window. Keep user rules in a *different* store (YAML plus a `rules` table) from compiled list data, so a list refresh never copies user tables. Evidence (inferred): `advanced/Templates/gravity_copy.sql` copies `domainlist` at the start of a run that later replaces the whole file.
- [upgrades-migrations] Use numbered forward-only migrations keyed off a `version` row and applied in sequence (`database_migration/gravity-db.sh`, 20 files). Add what Pi-hole lacks: a lock around migration and "newer schema → read-only" (MASTER_PLAN §4 "Upgrades").
- [dashboard-process-model] Pi-hole v6 funnels *all* writes except gravity through the daemon's API, and the CLI is an HTTP client that discovers the daemon (CHAOS TXT) and authenticates with an ephemeral **CLI password file** regenerated on each daemon start (`advanced/Scripts/api.sh`; FTL `config/password.c` CLI_PW_FILE). With no daemon, search-hole's CLI should write SQLite directly under WAL plus `busy_timeout`. If we later add a daemon, copy the discovery-file plus ephemeral-token idea (e.g. `~/.searchhole/ui.json` holding the port and a per-start token, mode 0600).
- [lists-subscriptions] One owner for refreshes: the FTL API rejects a concurrent gravity run with 409, but cron and the API can still overlap (`src/api/action.c: api_action_gravity`; no flock in `gravity.sh`). We need a DB lease (owner_pid, expires_at) that every gateway checks, as §4 already says.
- [security] When a list URL is `file://`, read it with the gateway's own permissions and never echo file contents into logs or the UI (FTL suppresses invalid-line samples for `file:` sources; `tools/gravity-parseList.c` `local_source`). Validate list URLs with a scheme allow-list (https only by default for us).
- [security] Our own rules must not block our own list updates or engine calls. Pi-hole works around blocking its own list host (`dig` via upstream plus `curl --resolve`). For us: list-host fetches and engine API calls bypass the result filter and only go through the SSRF guard.
- [testing] Test list ingestion against fixture servers that return 200, 304, 404, 451, an empty body, a timeout or a redirect, mirroring `test/test_gravity.bats`. Assert on the status code stored per list, not on log strings, because Pi-hole's string assertions had to branch on the curl version.
- [ui-ux] Stream list-update progress as lines (CLI) and as a live panel (dashboard), one line per list with a final summary: "N entries (M unique) · K invalid ignored". Evidence: `gravity.sh: gravity_ShowCount`; the web side is in `pi-hole-web.md` `gravity.js`.
- [other] `searchhole doctor` can follow `piholeDebug.sh`: versions, connectivity to each engine, DB integrity (`PRAGMA integrity_check`), list health, permissions. Any sharing must be explicit opt-in with a disclaimer (`DISCLAIMER`, `upload_to_tricorder`). By default we should only print a redacted report locally.
- [distribution] FTL ships as **per-arch static binaries** (`pihole-FTL-amd64|arm64|armv6|armv7|386|riscv64`) with `.sha1` sidecars, verified before install (`automated install/basic-install.sh: get_binary_name, FTLinstall, FTLcheckUpdate`). That is evidence for option (b) "standalone per-platform binaries plus checksum" (§4 runtime availability).

## Borrow / avoid
**Borrow**
- The four-state list health model plus per-list counts (entries, invalid, ABP-style) persisted next to the subscription.
- ETag plus If-Modified-Since, compressed transfer, cached fallback on any failure, sha check for "unchanged".
- Build aside and swap atomically, keep 10 rotated backups, plus a restore ladder that *records* that it restored and surfaces it in the UI.
- Index after the bulk load, full ANALYZE before the swap, cached distinct counts.
- A CLI that is a thin client of one config/DB authority with clear exit codes (5 = "forced by env, read-only").
- `pihole -q`-style "which list contains this domain" across user rules and every list.
- `--timeit` style step timing and explicit `repair recover|recreate` verbs.

**Avoid**
- No shrink or sanity guard on list updates.
- Copying user tables into a rebuilt DB file, which creates a lost-update window during long refreshes.
- Gravity concurrency protection that exists only in the API process, with no file lock.
- Asserting on human log strings in tests.
- Root-run bash pipelines with many external tools (`curl`, `dig`, `stat`, `sha1sum`, `awk`), which force capability probes for each tool version. Our TypeScript fetcher can do all of this in-process.
- A global weekly cron (even randomised at install time). Ours should be per-subscription `update: 7d`, with fresh random jitter on every run (as the installer's `$RANDOM` minute does once), run by the lease owner.
