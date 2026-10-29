# louislam/uptime-kuma
> Ref: `research/refs/uptime-kuma` @ 2e8bf7d (2026-10-28) · License: **MIT** (`LICENSE`, "Copyright (c) 2021 Louis Lam"; `package.json` `"license": "MIT"`). Vendored modules carry their own licenses: `server/modules/ping/LICENSE` (MIT, Daniel Zelisko), `server/modules/axios-ntlm/LICENSE` (MIT, CatButtes) and `server/modules/prometheus-api-metrics/LICENSE` (**Apache-2.0**). Version on this branch: `3.0.0-beta.0`, `engines.node ">= 26.2.0"` (`package.json`).

## Purpose
Self-hosted uptime monitor: HTTP, ping, DNS, Docker, DB, MQTT, game servers and more, with about 111 notification providers and public status pages. It is the reference for **"live dashboard polish + one-command self-host + SQLite that survives years of upgrades"**. It matters to search-hole because:
- (1) its Socket.IO live-update design and login-burst optimizations are the counterpoint to our planned SSE tail
- (2) it has run **SQLite in WAL mode under a single Node process** for years and documents every pragma
- (3) it went through **three generations of migrations plus a long v1→v2 data migration**, the same upgrade risk our upgrades-migrations ADR must handle
- (4) on this branch it already **serves an MCP endpoint with the TypeScript SDK v2** (`server/routers/mcp-router.ts`)

## Architecture sketch
```
node server/server.js  (one long-running process; Docker CMD ["node","server/server.js"])
 ├─ SetupDatabase (temporary Express app) — only if db-config.json / kuma.db missing  → then closes
 ├─ Database.connect() — knex 3.3 + redbean-node ORM; better-sqlite3 12.11 | mysql2 (MariaDB) | embedded mariadbd child
 ├─ Database.patch() — legacy SQL patches → knex migrate.latest → v1→v2 aggregate data migration
 ├─ Express: REST api-router, status pages, better-auth router, /mcp (MCP SDK v2), SPA fallback
 ├─ socket.io 4.8 on the same HTTP server — rooms: <userID> and "dashboard"
 ├─ monitors: one timer loop per monitor → heartbeat row → UptimeCalculator (minutely/hourly/daily) → emit
 └─ croner jobs: clear-old-data "14 03 * * *", incremental-vacuum "*/5 * * * *"
Vue 3.5 SPA (Vite 8, Bootstrap 5.1.3, chart.js 4) ── socket.io-client (websocket first, polling fallback)
```

## Key modules and data flow
| Module | Role |
|---|---|
| `server/server.js` | Entry point; `io.on("connection")` (line 410), session from cookie or API key, then ~80 `socket.on(...)` RPC handlers across `server.js` (29) and `server/socket-handlers/*` (`add`, `editMonitor`, `pauseMonitor`, …) with ack callbacks; `afterLogin()` (line 1531) |
| `server/uptime-kuma-server.ts` | Singleton; builds the Socket.IO `Server` (line 145) with `perMessageDeflate.threshold: 1024`, `httpCompression.threshold: 1024`, an `allowRequest` WebSocket Origin check, and CORS only in dev |
| `server/database.js` | Data dir, DB config, connect, pragmas (`initSQLite`, line 466), migrations (`patch`, line 513), aggregate migration (line 913), `close()` with `wal_checkpoint(TRUNCATE)` (line 836) |
| `server/setup-database.js` | First-run DB chooser as a standalone Express app (`/setup-database-info`, `POST /setup-database`) that resolves and closes before the main server starts |
| `server/heartbeat-emit.ts` | `emitHeartbeat(io, payload)` emits to room `"dashboard"` **only if someone is connected**, because Socket.IO still serializes for empty rooms |
| `server/client.js` | `sendHeartbeatList` (last 100 beats of one monitor), `sendHeartbeatLists` (the **latest single beat** of every monitor in one event, queried in chunks of 500; the 100-beat history comes later per visible row via `getHeartbeatHistory`), `sendImportantHeartbeatList` (last 500), `sendInfo`, … |
| `server/login-lists.ts: DeferredListsSender` | Sends the heavy lists after the client reports `dashboardRendered`, with a 5 s fallback timer |
| `server/compact-monitor.ts` | Slim monitor payload ("toJSON() builds ~60 fields per monitor, which costs over a second for thousands of monitors at login") |
| `server/monitor-stats.ts` | Cached dashboard numbers (`uptime24/720/1y`, `avgPing`), refresh every 15 min, chunks of 500 |
| `server/uptime-calculator.js` | In-memory `LimitQueue`s: 24×60 minutely, 30×24 hourly, 365 daily buckets, persisted to `stat_minutely/hourly/daily` |
| `server/model/monitor.js` | Beat loop; `isImportantBeat` / `isImportantForNotification` state-transition tables (lines 1433-1500) |
| `server/notification.js` + `server/notification-providers/*.js` (111 files) | Provider registry keyed by `name`; base class `notification-provider.js: send(notification, msg, monitorJSON, heartbeatJSON)`; liquidjs templates |
| `server/routers/mcp-router.ts` | MCP over HTTP at `/mcp` |
| `src/mixins/socket.js` | Client socket setup and all live state (`heartbeatList`, `importantHeartbeatList`, `monitorList`, `stats`) |

**Live update flow.**
1. A monitor beat is built. `UptimeCalculator.update()` upserts the stat buckets, then `emitHeartbeat(io, bean.toJSON())` (`model/monitor.js:1083`), and only after that `R.store(bean)` writes the `heartbeat` row. The emit happens before the DB write.
2. The client pushes the beat to `heartbeatList[monitorID]` and shifts it at 150 entries (`src/mixins/socket.js:252-262`).
3. Important beats also raise a toast and land in the events list.
4. Counter recomputation is coalesced through `BeatVersionThrottle` (`src/beat-version-throttle.ts`, at most once per 1000 ms).

**Login burst.**
1. `sendMonitorList` (compact) goes out first.
2. The client paints, and in `$nextTick → requestAnimationFrame` emits `dashboardRendered` (`src/mixins/socket.js:186-199`).
3. The server then sends `heartbeatLists` (one event holding the latest beat of every monitor) and `stats` from cache (`server.js:1560-1585`). Full 100-beat histories are requested per visible row afterwards (`src/heartbeat-history.ts`).
4. Socket transports are `["websocket","polling"]`: "Prefer WebSocket so the large login payload is compressed by perMessageDeflate" (`src/mixins/socket.js:154-159`).

## Data model and storage
- **Driver**: `better-sqlite3 ~12.11.1` through `knex ~3.3.0` and `redbean-node ~0.4.0` (`package.json`). MariaDB goes through `mysql2 ~3.24.2`. better-auth uses its own separate connection (`Database.createAuthDatabase`, line 556).
- **Data dir**: `DATA_DIR` env or `--data-dir`, else `./data/`. It holds `kuma.db`, `upload/`, `screenshots/` and `docker-tls/` (`database.js: initDataDir`, line 150). **In dev, each non-master git branch gets its own data dir** at `./data/dev-data/<branch>/` (`getDevDataDir`, line 185; `master` and a detached `HEAD` use `./data/`).
- **First run** copies a template DB (`static templatePath = "./db/kuma.db"`, line 27, copied at line 314) and then migrates it. The template's SQLite header has auto-vacuum off (header bytes at offsets 52 and 64 are zero, journal mode bytes say rollback journal), so the per-connection `PRAGMA auto_vacuum = INCREMENTAL` does not change a file created this way; only a `VACUUM` (the manual "shrink") would apply it. `db-config.json` in the data dir records the DB type.
- **SQLite pragmas per connection** (`initSQLite`, lines 466-489):
  - `journal_mode=WAL` (MEMORY in test mode), `foreign_keys=ON`, `cache_size=-12000` (~12 MB)
  - `auto_vacuum=INCREMENTAL`, `busy_timeout=5000`, `synchronous=NORMAL`
  - `unsafeMode(true)`, needed for legacy patches using `writable_schema`
- **Pool**: SQLite defaults to a **single connection** (`min:1,max:1`) unless `UPTIME_KUMA_SQLITE_SINGLE_CONNECTION=false` (opt-in pool `min:0,max:20`, since WAL allows several connections), because "Multiple connection could run into SQLITE_BUSY: database is locked" (lines 317-330). MariaDB pool max is 10, capped at 100.
- **Core tables**:
  - `monitor`, `heartbeat(monitor_id, status, msg, time, ping, duration, important, …)`, `notification(config JSON)`, `setting(key, value, type)`
  - aggregates `stat_minutely`/`stat_hourly`/`stat_daily(monitor_id, timestamp unix-rounded, ping, up, down, UNIQUE(monitor_id,timestamp))` (`db/knex_migrations/2023-08-16-0000-create-uptime.js`, `2023-12-22-0000-hourly-uptime.js`)
  - `monitor_config` was added on 2026-10-27 (`2026-10-27-0000-add-monitor-config.js`)
- **Retention**:
  - `clearHeartbeatData()` (line 1047) deletes **non-important** beats older than 24 h but keeps the last 100 per monitor.
  - `jobs/clear-old-data.js` runs `clearHeartbeatData()` first, then deletes `heartbeat` and `stat_daily` rows older than `keepDataPeriodDays` (default 365; `< 1` disables), then runs `PRAGMA optimize` (SQLite). `stat_minutely`/`stat_hourly` are pruned separately by `UptimeCalculator` (at most once per hour per monitor).
  - `jobs/incremental-vacuum.js` runs `PRAGMA incremental_vacuum(200)` + `wal_checkpoint(PASSIVE)` every 5 min.
  - Settings also has a manual "shrink" (`VACUUM`, line 885).

## Config format
- Almost everything lives **in the DB** (`setting` table via `server/settings.js`) and is edited in the UI.
- Process-level settings come from CLI args or env vars (`server/config.js`):
  - `--host`/`UPTIME_KUMA_HOST`/`HOST`
  - `--port`/`UPTIME_KUMA_PORT`/`PORT` (default **3001**)
  - SSL key/cert
  - `UPTIME_KUMA_WS_ORIGIN_CHECK=bypass`
  - `UPTIME_KUMA_DB_*` (TYPE, HOSTNAME, PORT, NAME, SOCKET, USERNAME, PASSWORD, SSL, CA)
- Order is "env > db-config.json" (`setup-database.js` constructor comment).
- **`_FILE` variants for Docker secrets** come from `getEnvOrFile()` (`setup-database.js:13-35`), used for `UPTIME_KUMA_DB_USERNAME`, `…_PASSWORD` and `…_SSL`. Setting both the env var and `_FILE` is an error.
- Headless first admin: `UK_INITIAL_ADMIN_USERNAME` + `UK_INITIAL_ADMIN_PASSWORD`, which must be set together and are ignored once a user exists (`server/initial-admin.ts`).

## Extension points (plugins, hooks)
- **Monitor types**: a registry `UptimeKumaServer.monitorTypeList[type] = new XMonitorType()` (`uptime-kuma-server.ts:~100-133`) over `server/monitor-types/*`.
- **Notification providers**: one class per provider with `name` and `send()`, registered in `notification.js: init()` (line 124). The registry is checked for duplicate names (lines 241-250). Provider config is stored as one JSON blob.
- **MCP**: `server/routers/mcp-router.ts` bridges **every documented GET API route without a path parameter** into an MCP tool (`apiRouter.apiOperations`; routes with `:` params are skipped). It uses `createMcpHandler(createServer)` with a fresh `McpServer` per request ("so no state is shared") and `toNodeHandler(handler)` from `@modelcontextprotocol/node ~2.1.1`, passing the body express already parsed. It is gated by `requireApiKey`. Deps: `@modelcontextprotocol/server ~2.3.1` (`package.json`).
- No third-party plugin loading.

## Rules / lists: parsing and compilation
- n/a for block/allow lists. The closest analogue is **monitor conditions** (`server/monitor-conditions/`, `db/knex_migrations/2024-08-24-0000-conditions.js`): a stored JSON expression tree evaluated per beat. It is out of scope for us.
- The **state-transition table** that decides importance is effectively a rule table:
  - `isImportantBeat` marks first beat, UP→DOWN, PENDING→DOWN, DOWN→UP, and UP/DOWN→MAINTENANCE and MAINTENANCE→UP/DOWN as important. UP→PENDING, PENDING→UP and repeated statuses are not.
  - `isImportantForNotification` uses a stricter subset.

## Testing strategy
- **Backend**: `node:test` via `extra/run-backend-tests.mjs` (`npm run test-backend` with `--experimental-test-coverage`). Test files live in `test/backend-test/` and cover monitors, notification providers, heartbeat emit (`test-heartbeat-emit.ts`), MCP (`test-mcp.ts`) and initial admin.
- **Migration tests against real old databases**:
  - `test/backend-test/test-migration-v1-to-v3.ts` boots the server on a free port against `test/fixtures/v1-kuma.db.gz` and logs in over `socket.io-client`. The fixture password is deliberately one Have I Been Pwned reports as breached, to cover an auth path.
  - The fixture is produced by `extra/prepare-v1-test-db.mjs`: boot the **official `louislam/uptime-kuma:1.23.17` image**, let it create and patch the DB, then checkpoint the WAL so the file is standalone. There is a matching `extra/prepare-v2-test-db.mjs` and `test-migration-v2-to-v3.ts`.
- **Lint for migrations**: `extra/check-knex-filenames.mjs` enforces `YYYY-MM-DD-HHmm-description.js` and keeps an explicit exception list for two already-merged misnamed files.
- **E2E**: Playwright (`playwright.config.js`, `test/e2e/specs/*.spec.js`), plus `testcontainers ^12.2.1` for DB/MQ-backed monitors.
- **Testable UI timing**: `src/dashboard-progress.ts` is a loading-bar state machine with an injectable `ProgressClock`. It shows after 150 ms, creeps to 90 %, has a 15 s safety timeout and finishes 250 ms after done. `DeferredListsSender` also accepts injected timers.

## UX patterns worth copying
1. **Quick stats that stay calm** (`src/pages/DashboardHome.vue:5-35`): Up/Down/Maintenance/Unknown/Pause counts. Down and Maintenance are grey at 0 and take their state color only when > 0 (`:class="$root.stats.down > 0 ? 'text-danger' : 'text-secondary'"`). Up is grey only at 0, and Unknown and Pause are always grey.
2. **Status chip** (`src/components/Status.vue`): a pill badge with a translated word and a color per state (Down=danger, Up=primary, Pending=warning, Maintenance=maintenance). `src/beat-state.ts: beatStatusEntry()` centralizes text and color.
3. **Heartbeat bar on canvas** (`src/components/HeartbeatBar.vue`, 899 lines):
   - one `<canvas>` per row
   - beat sizes snapped to device pixels (`devicePixelRatio`, lines 357-365)
   - hover tooltip
   - 300 ms slide animation on new beats
   - an **aria-label summary** "Heartbeat history: N checks, X up, Y down" (`canvasAriaLabel`, line 285)
   - Re-requests history when a reconnect leaves only one beat (`src/heartbeat-history.ts: shouldRequestHistory`).
4. **Toasts only for important transitions** (`src/mixins/socket.js:266-282`): `[name] [DOWN] msg` (error toast, timeout configurable) and `[name] [Up]` (success).
5. **Connection banner**: "Cannot connect to the socket server. Reconnecting…" with a reverse-proxy guide link on `connect_error` (`src/mixins/socket.js:331-345`).
6. **First-run flow**:
   - (a) DB chooser page (`src/pages/SetupDatabase.vue`) with one-sentence explanations per option: SQLite is "A simple database file, recommended for small-scale deployments" (`src/lang/en.json:6`).
   - (b) Create the first admin (`src/pages/Setup.vue`).
   - (c) Empty dashboard.
   - The server tells the client to go to setup with a `setup` socket event (`server.js:413-416`).
7. **Migration progress page**: while a long data migration runs, `server/utils/simple-migration-server.js` serves a tiny page on the **same port** with a streaming `/migrate-status` text log ("[DON'T STOP] Migrating monitor … 42.00%"). The Docker healthcheck therefore doesn't kill the container mid-migration.
8. **Outdated-tag warning**: the legacy `latest`/`1` Docker images inject a full-screen overlay on `/setup` saying the tag is unmaintained, with a link to recommended tags (`extra/docker-latest-warning/docker-latest-warning.js`).
9. **Monitor list filters**: search text, status, active and tags (`src/components/MonitorList.vue:653-691`, `MonitorListFilter.vue`). They are kept in component state, **not the URL**, which is a gap we should not copy.

## Performance tricks
- **Skip emits to empty rooms** (`server/heartbeat-emit.ts`).
- **Compact payloads** for the initial list (`compact-monitor.ts`). Heavy lists wait for client paint, with a 5 s fallback (`login-lists.ts`).
- **One batched event** (`heartbeatLists`, the latest beat per monitor) instead of one query + event per monitor, with per-row lazy history (`server.js:1560`, `client.js`).
- `perMessageDeflate` and `httpCompression` at a 1 KiB threshold, with WebSocket preferred over polling (`uptime-kuma-server.ts:145-155`).
- **Client coalescing**: `BeatVersionThrottle` (1 s), per-monitor beat arrays capped at 150, and `applyBeat` updating in place for O(1) per beat (`src/beat-state.ts`).
- **Hand-rolled list windowing** for thousands of monitors (`src/monitor-list-window.ts`): measured heights with a `DEFAULT_ROW_HEIGHT = 58` fallback, cumulative offsets, `OVERSCAN = 300` px, and spacer heights so the scrollbar stays proportional.
- **Pre-aggregated stat tables** (minutely 24 h, hourly 30 d, daily 365 d) mean the dashboard never scans raw heartbeats (`uptime-calculator.js:34-47`). Stats are cached and refreshed every 15 min in chunks of 500 (`monitor-stats.ts`).
- Single SQLite connection with `busy_timeout=5000`; periodic `incremental_vacuum(200)`; `PRAGMA optimize` after bulk deletes.
- Index tuning lives in a dedicated migration (`2025-12-22-0121-optimize-important-indexes.js`).

## License and what it means for us
- MIT: we may copy short snippets (≤ 10 lines) with attribution ("© Louis Lam, MIT"), for example the pragma set, the `emitHeartbeat` guard idea or `DeferredListsSender`.
- `server/modules/prometheus-api-metrics` is Apache-2.0. If anything from it were ever reused (unlikely), NOTICE obligations apply.
- No copyleft anywhere in the parts we care about.

## Implications for search-hole
- [dashboard-process-model] Uptime Kuma *is* a daemon: one always-on Node process owns the DB, timers, Socket.IO and the SPA. Live updates are **in-process emits at write time**, not DB tailing. That works because the writer and the pusher are the same process. Our topology has many gateway processes writing and an on-demand dashboard reading, so in-process emits are impossible without IPC.
  - Kuma's design supports keeping our §4 default (no IPC; dashboard tails `rowid > last` about every 250 ms and pushes over SSE).
  - Borrow its client-side guards: coalesce UI recomputes to ≤ 1/s and cap in-memory arrays (150 per entity there; for us a ring of the latest ~2-5k searches).
- [dashboard-process-model] Borrow **paint first, then send heavy data**. The SSE stream starts with a compact summary (counts plus the latest ~50 rows). Older pages and per-search results load on demand, and the stream is skipped entirely when no browser is connected (our tailer only runs while ≥ 1 SSE client exists, like `emitHeartbeat`).
- [dual-protocol] [mcp-tool-surface] Real-world evidence that **MCP SDK v2 over HTTP can be mounted inside an existing Node web server**:
  - `createMcpHandler(factory)` with a fresh server per request (stateless)
  - `toNodeHandler(handler)` from `@modelcontextprotocol/node`, handed express's parsed body
  - an API-key middleware in front
  - Our v2 remote connector and an optional `searchhole ui` HTTP MCP endpoint can follow the same shape with the Hono adapter (`server/routers/mcp-router.ts`). The auto-bridging of GET routes into tools is the **opposite** of our "small surface" principle. Don't copy that part.
- [sqlite-driver] Kuma pins **better-sqlite3 (native)**. That is fine for a Docker image but is the install friction we want to avoid for plugins and npx. Copy the **pragma set** as our baseline, whatever driver we pick:
  - `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`, `cache_size=-12000`
  - `auto_vacuum=INCREMENTAL` with periodic `incremental_vacuum(N)` + `wal_checkpoint(PASSIVE)`, and `wal_checkpoint(TRUNCATE)` on clean shutdown (`database.js:466-489,836`; `jobs/incremental-vacuum.js`).
  - `auto_vacuum` must be set before the first table is created, at DB creation, or applied later with a `VACUUM` (SQLite semantics, not shown by Kuma's code). Kuma does **not** side-step this: its template DB (`db/kuma.db`) has auto-vacuum off in the file header, so `PRAGMA auto_vacuum = INCREMENTAL` on its connections does nothing for template-created files until a `VACUUM` runs. Treat Kuma as evidence for the other pragmas, not for incremental vacuum working, and create our DB with the pragma set on an empty file.
- [sqlite-driver] Kuma uses **one connection per process** because multiple connections hit `SQLITE_BUSY`. We have N processes × 1 connection. `busy_timeout` plus short write transactions (one `BEGIN IMMEDIATE` per search, inferred best practice) is the equivalent. Measure with the "two gateway versions sharing one DB" mock scenario (§12.3).
- [upgrades-migrations] Three generations show the cost of changing migration systems midway:
  - (1) `patchN.sql` gated by `setting.database_version` (`latestVersion = 10`)
  - (2) "Patch 2.0", a dependency map `patchList` gated by `setting.databasePatchedFiles`
  - (3) knex migrations in `db/knex_migrations/`
  - On SQLite all three still run in order on every boot (`database.js: patch()` → `patchSqlite()`, which itself ends by calling `patchSqlite2()` → `knex.migrate.latest` → `migrateAggregateTable`). MariaDB skips the two legacy systems. **Pick one forward-only system on day one**: numbered, dated SQL files plus a `schema_migrations` table, under a migration lock.
- [upgrades-migrations] Kuma's **downgrade/newer-schema handling is too lax for our multi-install case**:
  - A newer `database_version` only logs "Database version is newer than expected" (`database.js:611-612`).
  - knex's "the following files are missing" is downgraded to a warning, "you may be downgrading" (lines 541-546), and the server carries on read-write.
  - Our ADR: on an unknown newer schema, **switch to read-only** and keep serving searches (§4, §5.1). Add a `min_reader_version`/`min_writer_version` pair in a `meta` table so that additive migrations stay writable for N-1.
- [upgrades-migrations] Long data migrations need a **resumable state machine with visible progress**. Kuma's `migrateAggregateTableState` (`migrating` → `migrated`) refuses to restart after an interruption and needs a manual reset script (`extra/reset-migrate-aggregate-table-state.js`), and it runs outside a transaction. Do better:
  - batch in transactions with a stored cursor (resumable)
  - surface progress in `searchhole doctor` and the dashboard
  - never block the gateway's search path on it. Gateways serve searches without logging, or in read-only mode, until it finishes.
- [testing] Copy **real-old-DB upgrade fixtures**:
  - for every released schema, keep a gzipped DB produced by the *released artifact* (Kuma boots the official image; `extra/prepare-v1-test-db.mjs`)
  - test upgrade-in-place plus a smoke query (`test-migration-v1-to-v3.ts`)
  - add a lint that migration filenames follow a pattern (`extra/check-knex-filenames.mjs`)
- [upgrades-migrations] Retention follows the **important vs routine** split. Kuma keeps "important" beats (state transitions) forever (within `keepDataPeriodDays`) and prunes routine beats after 24 h, keeping the last 100 per monitor. Our analogue:
  - always keep `searches` rows (small) and **hidden-result decisions with rule ids**
  - prune bulky `results` snippets and `fetches` bodies sooner, and per engine terms (§5.2)
  - run deletes in a nightly job followed by `PRAGMA optimize`
- [ui-ux] Borrow:
  - **calm counters** (grey at zero, colored only when non-zero)
  - **status chips with word + color** from one `statusEntry()` helper
  - **toasts only for transitions** (engine went down or recovered, list update failed, new suggestion), never per search
  - a **reconnecting banner** when SSE drops
  - accessible canvas sparklines with an aria-label summary for per-engine health bars on the Engines page
- [ui-ux] Kuma keeps list filters in component state, not the URL. We must not (§8.4.4: the URL is the state).
- [distribution] The one-command self-host bar is `docker run -d --restart=always -p 3001:3001 -v uptime-kuma:/app/data --name uptime-kuma louislam/uptime-kuma:2` (`README.md:57`), a 9-line `compose.yaml` and `HEALTHCHECK` (`docker/dockerfile:48`). Our bundled-SearXNG `compose.yaml` should be equally short:
  - bind `127.0.0.1` explicitly (Kuma's README has to tell users to add `-p 127.0.0.1:3001:3001`)
  - name a data volume
  - include a healthcheck that `doctor` can read
- [distribution] Tag hygiene: Kuma had to inject an "outdated" overlay into its stale `latest`/`1` images. Decide **channel names on day one** (npm dist-tags, plugin marketplace versions) and have `doctor` warn when the running gateway is older than the DB's last writer.
- [security] Kuma binds **all interfaces by default** (no default host in `config.js`), checks only `Origin` vs `Host` for WebSocket and lets a WebSocket with no `Origin` header through (`uptime-kuma-server.ts:156-200`, `UPTIME_KUMA_WS_ORIGIN_CHECK` defaults to `cors-like`), and relies on CORS for polling. We need stricter defaults for the dashboard: bind `127.0.0.1`, random session token, **Host-header allowlist**, strict CSP and no CORS (§12.4).
- [key-storage] `getEnvOrFile()` (`setup-database.js:13-35`) supports `X` or `X_FILE` and errors if both are set (Kuma uses it only for the DB username, password and SSL flag). That is a cheap addition to our key resolution order (env → `*_FILE` → own store) that helps Docker and secret managers.
- [other] Dev ergonomics: a **per-git-branch dev data dir** (`database.js: getDevDataDir`) avoids corrupting your real `~/.searchhole` while testing migrations. Use `SEARCHHOLE_HOME` or an automatic `./.dev-data/<branch>/` when running from a checkout.
- [testing] Inject clocks and timers into UI state machines (`dashboard-progress.ts`, `login-lists.ts`) so timing behaviour is unit-tested without mounting the app.

## Borrow / avoid
**Borrow**
- SQLite pragma baseline, periodic incremental vacuum + passive checkpoint, TRUNCATE checkpoint on close (`server/database.js`, `server/jobs/*`).
- Skipping pushes when no client is connected; paint-first-then-heavy-data; batched list events; compact payloads (`heartbeat-emit.ts`, `login-lists.ts`, `compact-monitor.ts`).
- Client throttle of recomputes and capped arrays (`beat-version-throttle.ts`, `src/mixins/socket.js`).
- Pre-aggregated time buckets for overview charts (`uptime-calculator.js`, `stat_*` tables). For us: `daily_domain_stats`, `daily_engine_stats` upserted per search.
- Real-artifact upgrade fixtures and the migration filename lint (`extra/prepare-v1-test-db.mjs`, `test-migration-v1-to-v3.ts`, `extra/check-knex-filenames.mjs`).
- Migration progress page / status endpoint; `_FILE` env secrets; headless first-run via env; per-branch dev data dir.
- Calm counters, status chips, transition-only toasts, the reconnect banner, accessible canvas sparkline.
- The MCP SDK v2 HTTP mounting pattern (`server/routers/mcp-router.ts`).

**Avoid**
- Three stacked migration systems and lax downgrade handling (log-and-continue on a newer schema).
- A non-transactional, non-resumable data migration that needs a manual reset.
- A native SQLite driver for plugin/npx installs.
- Binding all interfaces by default; Origin-only WebSocket checks.
- Filter state outside the URL.
- Auto-bridging every API route into MCP tools (blows the token budget).
- Socket.IO itself: SSE + fetch is enough for one-way tailing and needs no client library.
- Bootstrap 5.1 / Vue options-API patterns, which don't match our stack.

## Verification
Date: 2026-10-29. Claims checked: 86 (license header and section incl. vendored module licenses, every "Implications for search-hole" bullet, and the mechanisms they rely on: pragmas, pool, retention jobs, emit path, login burst, migration generations, downgrade handling, MCP router and dependency versions, WebSocket origin check, bind default, README/compose/healthcheck, test fixtures, UI timings, template DB header, cited paths).

Corrections made:
- [sqlite-driver] The note said Kuma side-steps the "auto_vacuum must be set at creation" rule by copying a template DB. The template (`db/kuma.db`) has auto-vacuum off in its header (bytes at offsets 52 and 64 are zero), so `PRAGMA auto_vacuum = INCREMENTAL` and `incremental_vacuum(200)` do nothing for files created that way until a `VACUUM` runs. Kuma is no evidence that incremental vacuum works; the other pragmas are confirmed.
- Live update flow: `emitHeartbeat` runs before `R.store(bean)`, not after the row is written.
- Login burst: `sendHeartbeatLists` sends only the latest beat per monitor; the 100-beat history is fetched per visible row.
- Retention: `clear-old-data.js` deletes `heartbeat` and `stat_daily` rows only (plus `clearHeartbeatData()` first); minutely/hourly stats are pruned by `UptimeCalculator`.
- Migration chain: `patchSqlite2()` is called from inside `patchSqlite()`, and the two legacy systems run on SQLite only.
- `isImportantBeat`: maintenance transitions are UP/DOWN to and from MAINTENANCE only, not "any change".
- Calm counters: only Down and Maintenance follow the grey-at-zero rule; Up is grey only at 0, Unknown and Pause are always grey.
- Security: WebSocket connections with no `Origin` header are allowed; default `UPTIME_KUMA_WS_ORIGIN_CHECK` is `cors-like`.
- Smaller fixes: `io.on("connection")` is line 410; ~80 `socket.on` handlers are spread over `server.js` (29) and `socket-handlers/*`; opt-in SQLite pool is max 20; dev data dir applies to non-master branches only; README docker command includes `--name uptime-kuma`; `getEnvOrFile()` is used for DB username, password and SSL only; MCP bridge skips routes with path params.
- Verified, no change: MIT license, vendored licenses (ping MIT, axios-ntlm MIT, prometheus-api-metrics Apache-2.0), version and engines, pragma values, single connection default, `latestVersion = 10`, newer-schema log-and-continue, `migrateAggregateTableState` refusal after interruption, MCP SDK v2 mounting and versions, compose.yaml 9 lines, HEALTHCHECK line 48.
