# ADR-0003: SQLite driver and access layer

- **Status:** Accepted (2026-10-30)
- **Related:** [0002](0002-runtime-and-packaging.md), [0004](0004-dashboard-process-model.md), [0006](0006-upgrades-migrations-multi-install.md)

## Context

Many gateway processes (one or more per host, plus probe siblings) and an on-demand dashboard share one SQLite file at `~/.searchhole/`. §4 prefers zero native dependencies. Facts as of 2026-10-29 ([platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §H):

| Driver | Status | Native? | Notes |
|---|---|---|---|
| `node:sqlite` (also present in Claude Desktop's Electron Node 24.22, verified by symbol inspection) | Unflagged from 22.13 (Stability 1.1, prints `ExperimentalWarning` on 22); **release candidate from 24.15** and on 26; Node 26.11 renamed `DatabaseSync` → `Database` (old name kept as an alias) | No | Also implemented by **Bun 1.4.4**, so one API covers Node 22/24/26 and a future Bun binary |
| `better-sqlite3` 13.0.3 | Stable; **moved to N-API**; 8 prebuilds inside the npm tarball; no install script | Yes (`.node` files, about 2 MB each) | Survives `--ignore-scripts`; a bundle must ship `prebuilds/` next to it and pass `nativeBinding` |
| `bun:sqlite` | Stable in Bun | No | Only if we ship Bun binaries (deferred, ADR-0002) |

The reference projects agree on the pragma set and on "one connection per process" ([uptime-kuma.md](../research/uptime-kuma.md), [toolhive.md](../research/toolhive.md), [mcp-context-forge.md](../research/mcp-context-forge.md), [agentgateway.md](../research/agentgateway.md), [pi-hole-ftl.md](../research/pi-hole-ftl.md)). The Go projects chose pure SQLite drivers to avoid native code, which is the same instinct as ours.

## Decision

1. **Driver: `node:sqlite`, behind a ~60-line port** `src/store/driver.ts`:
   ```ts
   interface Db { exec(sql): void; prepare<T>(sql): Stmt<T>; tx<R>(mode: 'immediate'|'exclusive', fn: () => R): R; close(): void }
   ```
   - The implementation resolves `Database ?? DatabaseSync` from `node:sqlite`.
   - The fallback implementation is better-sqlite3 13, which has the same shape. It is used only where the runtime lacks `node:sqlite`; the known candidate is Desktop's Electron, pending the ADR-0002 spike.
   - Driver selection is a startup probe. `doctor` reports which driver is in use.
2. **No ORM. Plain SQL plus typed query functions:** `src/store/queries/*.ts`, one function per query, with zod row decoders at the boundary. Kysely and Drizzle add bundle weight and have no first-class `node:sqlite` dialect. The query count is small and stable, and hand-written SQL keeps the keyset pagination, the `rowid` tail and the `BEGIN IMMEDIATE` discipline explicit.
3. **Connection setup** (one connection per process, opened lazily on the first real request, never at spawn; see ADR-0006 on probe processes):
   ```sql
   PRAGMA journal_mode = WAL;          PRAGMA synchronous = NORMAL;
   PRAGMA busy_timeout = 100;          PRAGMA foreign_keys = ON;   -- 5000 for migrations and CLI commands
   PRAGMA journal_size_limit = 33554432;   -- 32 MiB
   PRAGMA cache_size = -8000;          -- ~8 MB, not 64 MB per gateway
   ```
   - `auto_vacuum = INCREMENTAL` is set **when the file is created, before the first table** (setting it later has no effect without a `VACUUM`; Uptime Kuma's template DB gets this wrong).
   - Maintenance is owned by the background-job lease holder (ADR-0006): periodic `incremental_vacuum(N)`, `wal_checkpoint(PASSIVE)` and `PRAGMA optimize`. Clean shutdown runs `wal_checkpoint(TRUNCATE)` when this process is the last one connected.
4. **Write discipline:**
   - Each search is written in one `BEGIN IMMEDIATE` transaction: the search row, its result rows and their decisions. Writes are never interleaved with engine I/O.
   - **`node:sqlite` is synchronous, so a long busy wait would freeze the gateway's stdio loop.** The search path therefore uses `busy_timeout = 100 ms`.
   - On `SQLITE_BUSY`, the write goes to an **in-memory retry queue** flushed on a jittered timer, and is dropped with a counted warning after 10 s. Spend-cap reservations follow ADR-0009 point 6.
   - The search result is always returned. **Logging never blocks or fails a search** (§5.1).
   - Migrations and CLI commands use 5000 ms.
5. **Schema conventions:**
   - **Two table families in one file:**
     - **mutable config/state:** `rules_session`, `rules_lastgood` (persisted compiled user rules keyed by file hash, ADR-0008), `project_trust(path, content_sha256, trusted_at)`, `lists`, `suggestions`, `engine_health`, `engine_usage`, `jobs`, `gateways`, `installs`, `sessions`, `receipts`, `daily_stats`, `meta`;
     - **append-only, retention-pruned events:** `searches`, `results`, `result_payloads`, `fetches`.
   - **List artifacts** are checksummed files under `<data>/lists/`, not DB blobs (ADR-0006).
   - **The plan's `rules` table is replaced** by `rules.yaml` (global), `.searchhole.yaml` (project) and `rules_session`. A rule's provenance is a `source: suggestion:<id>` field on the YAML rule.
   - Retention per table is in ADR-0015.
   - **Bulky or term-restricted content in child tables**, for example `result_payloads(result_id … ON DELETE CASCADE)` holding title and snippet. Retention per engine terms can then delete content and keep decisions, ranks and counts (agentgateway's `request_log_payloads` pattern).
   - **Enumerations are `TEXT` codes validated by zod, not `CHECK (x IN …)`**, so a new decision code or engine needs no table rebuild. `CHECK (json_valid(x))` is fine.
   - **Keyset indexes:** `searches(created_at, id)`, `results(search_id)`, `results(rule_id, created_at)` for "what did this rule hide". Daily rollup tables (`daily_stats(day, engine, …)` upserted on write) keep Overview queries cheap at 100k+ rows.
   - **`rowid` is the live-tail cursor** (ADR-0004).
     - `searches.id` is declared **`INTEGER PRIMARY KEY AUTOINCREMENT`**: still a rowid table, but ids are never reused after deletes.
     - Every bulk delete, in any process, bumps **`meta.data_epoch`**, so tailers can send `reset`.
6. **Files:** the data dir (ADR-0015) is `0700` and the DB, WAL and SHM files are `0600`. The process umask is set before opening.

## Alternatives considered

- **better-sqlite3 as the primary driver.** Rejected. N-API prebuilds make it far less painful than the plan assumed, but it is still a native artifact (about 16 MB for all targets) that must ship beside the bundle. Kept as the fallback.
- **An in-memory hot DB with periodic export** (Pi-hole FTL). Rejected. Our volume (hundreds of searches a day) doesn't need it, it loses up to a minute of data on a crash, and it would hide rows from other processes.
- **Kysely or Drizzle.** Rejected for v1 (see point 2). Revisit if the query count grows past about 60.
- **A separate DB file per concern** (logs vs config). Rejected. One file keeps backups, `--purge` and migrations atomic. The two-family split inside one file gives the same retention freedom.

## Consequences

- No install step anywhere: the bundle runs on any Node ≥ 22.13.
- The driver port lets tests use `:memory:` databases and lets the Bun path work unchanged.
- We depend on a release-candidate API. The surface we use (`prepare`/`run`/`all`/`get`/`exec`) is the stable core, and the 26.11 rename is already handled.

## Validate early (P1)

- Concurrency test: 8 processes each writing 1,000 searches in `BEGIN IMMEDIATE`, with the dashboard tail reading concurrently. Assert no lost rows and p95 write latency under 20 ms.
- Run the same suite on Node 22, 24 and 26, and under Bun 1.4 (macOS uses Bun's system `libsqlite3`, so check WAL and `busy_timeout` behaviour there).
- Measure the cost of opening a connection, which must fit the 300 ms startup budget.
