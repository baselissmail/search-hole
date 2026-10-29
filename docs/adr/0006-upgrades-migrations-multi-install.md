# ADR-0006: Upgrades, migrations and multiple installs

- **Status:** Accepted (2026-10-30)
- **Related:** [0003](0003-sqlite-driver-and-access-layer.md), [0004](0004-dashboard-process-model.md), [0008](0008-rule-format-and-precedence.md)

## Context

§4 requires:
- migrations under a lock, backward-compatible for one minor version;
- read-only mode for a process that finds a newer schema;
- exactly one owner for background jobs;
- `uninstall --purge`.

The facts make version skew a normal state, not an edge case:

- **Old Claude Code plugin versions keep running.** Their old cache dir is deleted only 14 days after an update, and running sessions keep the old path until `/reload-plugins`. **Auto-update is off by default for third-party marketplaces** ([platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §A, §C).
- **Desktop auto-updates `.mcpb` extensions independently** ([mcpb.md](../research/mcpb.md)).
- **Duplicate copies are real.** Cursor also loads Claude marketplace plugins, and Codex can hold a directory copy and a marketplace copy ([nightshift.md](../research/nightshift.md)).
- **Probe siblings** (Desktop, SDK `auto` clients) start the gateway only to send `server/discover` ([mcp-typescript-sdk.md](../research/mcp-typescript-sdk.md)).

What the reference projects do:

| Project | Mechanism | Newer schema |
|---|---|---|
| Pi-hole | numbered SQL files, `info.version` | no lock, no handling |
| AdGuard Home | `migrateToN` steps + golden fixtures, backup before update | **hard-fails startup** |
| Uptime Kuma | three generations of migration systems, all still run | logs a warning, keeps writing |
| docker/mcp-gateway | file lock, dirty flag, 100-process race test | hard-fails ("database version … is ahead … upgrade") |
| uBlock Origin | magic-number invalidation of compiled caches | — |

Our answers to each problem are in the Decision below.

## Decision

### Schema migrations

1. **One forward-only system from day one.**
   - Migrations are numbered SQL files `NNNN_name.sql`, embedded in the bundle and applied in order.
   - There are no `down` files. Mistakes are fixed with a new forward migration.
   - CI checks a manifest of per-file SHA-256 hashes, so a released migration can never change. (Langfuse locks one hash over all its historical migrations; we hash each file for clearer failures.)
2. **Version bookkeeping** lives in a `meta` table: `schema_version`, `min_reader_version`, `min_writer_version`, `last_migrated_by`. Each migration declares its compatibility:
   - **additive** (new table or nullable column): leaves both minimums alone, so older binaries keep reading and writing (they use explicit column lists and ignore unknown columns);
   - **breaking for writers:** raises `min_writer_version`;
   - **breaking for readers:** raises `min_reader_version`, which is rare and needs an ADR.

   **The compatibility window ("backward-compatible for one minor version", §4):**
   - `min_*_version` values are **app semver**.
   - A release vX.Y may set `min_writer_version` no higher than vX.(Y−1): **expand in Y, contract in Y+1**. Raising `min_reader_version` requires a major version.
   - A CI check rejects a migration manifest that breaks this rule.
   - `min_writer_version` is **mirrored into `PRAGMA user_version`** (a 4-byte header read). **Every write transaction reads it right after `BEGIN IMMEDIATE`.** If it exceeds ours, it rolls back and switches the process to read-only. This also stops an *already running* old process the moment a newer binary contracts the schema.
3. **Mutual exclusion via SQLite itself, with an elected migrator:**
   1. **Fast path:** read `meta.schema_version` without a lock.
   2. **Elect:** if it is behind the binary, run `BEGIN IMMEDIATE; UPDATE meta SET migrating_pid=?, migrating_until=now+120s WHERE schema_version=?old AND (migrating_until IS NULL OR migrating_until < now); COMMIT`. Only the process whose update matched a row continues. The others poll until `schema_version` changes or the claim expires.
   3. **Back up:** the elected process runs `VACUUM INTO`, which can't run inside a transaction (point 4).
   4. **Migrate:**
      - run `PRAGMA foreign_keys=OFF` on that connection (it is a no-op inside a transaction, so it comes first);
      - `BEGIN EXCLUSIVE`;
      - apply every pending migration in this one transaction (SQLite DDL is transactional, so there is no "dirty" state);
      - `PRAGMA foreign_key_check`, and `ROLLBACK` if it returns rows;
      - write `meta`, then `COMMIT`;
      - run `PRAGMA foreign_keys=ON`.

   A CI test rebuilds a parent table that has child rows and asserts the child counts are unchanged.
4. **Before any migration, take a backup** with `VACUUM INTO <data>/backups/searchhole-v<from>-<timestamp>-<pid>.db`. Keep the last 3. `searchhole doctor --check-migrations` dry-runs the pending migrations against a copy.
5. **When the binary is older than the DB:**
   - **`schema_version` > ours but `min_writer_version` ≤ ours:** normal operation.
   - **`min_writer_version` > ours:** **read-only mode.** Searches still run with full rules. Logging is skipped and counted. Spend-cap reservations still happen, because `engine_usage` never takes a writer-breaking change (ADR-0009 point 6). Receipts come from process memory. Every receipt and `doctor` line says "search-hole v0.4 is older than your data (v0.6); update the plugin", with the upgrade command for this host.
   - **`min_reader_version` > ours:** history is unavailable as well. Searches still run, with YAML rules only.
   - It never hard-fails and never downgrades.
6. **Timing:**
   - A pending migration is **discovered** on the first real request (a `search`/`fetch` tools/call, a CLI command, or a UI start), **never at process spawn and never from a `hook` call**. Probe siblings and `tools/list` must stay side-effect free.
   - Backup plus migration then runs **as a lease job** (point 7), in the background.
   - The request that discovered it is served **without logging**: in memory, with YAML rules and an in-memory receipt. So is every request until the job finishes.
   - Long data migrations, such as backfills, run as resumable batches with a stored cursor, show progress in `doctor` and the dashboard, and never block the search path.
   - The P1 race test measures backup time on a 100k-search DB.

### Background jobs: one owner

7. **Jobs (list refresh, list compile, retention, vacuum and checkpoint) use a lease row:**
   - Table: `jobs(name PK, owner_gateway_id, owner_version, lease_until, heartbeat_at, status, progress_json, last_error)`.
   - **Acquire** in `BEGIN IMMEDIATE`, only if the lease has expired.
   - **Heartbeat** every 10 s with a 30 s lease. A takeover happens after expiry.
   - **Release** on clean exit, including **stdin EOF**, which is how a stdio gateway learns its host died (one-search-mcp's cleanup pattern).
   - Only a process whose `compiler_version` is ≥ the newest artifact's may compile lists (point 8).
   - Jobs are skipped while a process is read-only.
   - **Version gating:** a lease is acquired or renewed only if `owner_version ≥ meta.last_migrated_by`. A process with a higher version may take over an older owner's lease.
   - **Fencing:** `jobs.lease_epoch` increments on every acquire. Every job write is `UPDATE … WHERE name=? AND lease_epoch=?` and aborts if no row matches, so a stalled former owner can't clobber the new one.
   - **List compiles run in a `worker_threads` Worker**, so the heartbeat and the stdio loop keep running during a 418k-rule compile.
   - Compiles use **their own lease per list and compiler version**: `compile:<list_id>:<compiler_version>`. A gateway without the lease uses the last good artifact, or skips that list with a receipt warning ("list X compiling"), and picks the artifact up when it appears. Gateways never all compile at once.
8. **Compiled list artifacts are versioned, not invalidated** (uBlock's magic numbers, adapted to many processes):
   - Artifacts are keyed by `(list_id, content_sha256, compiler_version)`, each with a checksum.
   - A gateway uses the newest artifact it can read. If none exists, it falls back to the last good one, or builds its own for its own version under the compile lease (point 7).
   - Artifacts are stored as checksummed files under `<data>/lists/`, not as DB blobs.
   - **It never deletes an artifact with a newer `compiler_version`.**
   - A checksum failure means "rebuild", never "crash".

### Config files and installs

9. **User files** (`rules.yaml`, the list registry), via the `yaml` Document API (ADR-0008):
   - writes are atomic: temp file, fsync, rename;
   - a lock file guards against concurrent CLI and dashboard writers;
   - unknown keys and comments are preserved, so an older binary never strips a newer one's fields;
   - on a parse error, keep the last good compiled rules, surface the error, and **never overwrite the user's file**.
10. **Install registry:** `installs(kind: plugin|mcpb|npx|cursor|codex|other, version, path, first_seen, last_seen)` plus the `gateways` heartbeat (ADR-0004). `doctor` reports skew ("Desktop extension v0.5 and Claude Code plugin v0.4 share this DB"), duplicate copies serving one host, and "update available" (it compares the npm registry `latest` only when the user runs `doctor --check-updates`, since there's no background telemetry).
11. **Duplicate-copy guard:** if two gateways report the same host session key (ADR-0005), the second one marks its receipts `duplicate_of` and the Stop line is printed once.
12. **Stable codes:** decisions, reasons, engine ids and source types are stored as text codes and read tolerantly. A vocabulary only grows. A code's meaning never changes.
13. **Uninstall:**
    - `searchhole uninstall --purge` removes `~/.searchhole/` after listing exactly what it will delete.
    - `/search-hole:unenforce` removes any `WebSearch`/`WebFetch` deny rules that `:enforce` added, matched exactly by a marker comment key in settings.
    - `--purge` **also deletes every own-store key**: `security delete-generic-password -s search-hole -a <engine>` for each engine, `secret-tool clear service search-hole`, the DPAPI files, and any `--insecure-file`.
    - Its dry-run listing names **host-held secrets** with removal instructions: plugin `userConfig` (removed by `/plugin uninstall`) and Desktop extension settings.
    - A P8 test on all three OSes asserts that no `search-hole` keychain or Secret Service items remain.
    - **Plugin uninstall** deletes `${CLAUDE_PLUGIN_DATA}` (caches only; ADR-0015) **and any keys entered through plugin `userConfig`**, unless `--keep-data` is used. Keys in search-hole's own store, and everything in the ADR-0015 roots, survive. `doctor` and PRIVACY.md say so.

## Alternatives considered

- **Hard-fail on a newer schema** (AdGuard Home). Rejected: with several installs, it breaks the older host's search entirely.
- **A file lock (`.migrate.lock`) around migrations** (docker/mcp-gateway, context-forge). Rejected as the primary mechanism, because `BEGIN EXCLUSIVE` gives the same exclusion with fewer failure modes, such as stale lock files or NFS. File locks are still used for YAML writes, where SQLite isn't involved.
- **Recompiling lists at start** (uBlacklist does this for its user ruleset). Rejected for subscribed lists: the 418k-rule list would break the 300 ms startup target. User rules *are* recompiled at start, because they are small.
- **Down migrations.** Rejected. They are rarely tested, and the read-only rule plus backups covers rollback.

## Consequences

- Any mix of plugin, `.mcpb` and npx versions within the compatibility window works read-write. Outside it, the old version degrades to search-only with a clear message.
- Every additive migration must be additive in practice: insert with explicit column lists, and never reuse a column name with a new meaning. A CI test runs the previous release's query layer against the new schema.

## Validate early (P1)

- **Migration race test:** 50 processes start at once on an old DB. Exactly one migrates, all end up serving, and nobody sees a half-applied schema.
- **Two-version test:** v(n) and v(n+1) run against one DB with an additive migration and then a writer-breaking one. Assert that the old version is read-write and then read-only, as specified. This is the "two gateway versions sharing one DB" mock scenario from §12.3.
- **Lease test:** kill -9 the owner mid-refresh, then check that a takeover happens after 30 s and the last good list stays in force.
