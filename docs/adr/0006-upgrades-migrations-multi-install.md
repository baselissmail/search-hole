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
| docker/mcp-gateway | file lock, dirty flag, 100-process race test | — |
| uBlock Origin | magic-number invalidation of compiled caches | — |

Our answers to each problem are in the Decision below.

## Decision

### Schema migrations

1. **One forward-only system from day one.**
   - Migrations are numbered SQL files `NNNN_name.sql`, embedded in the bundle and applied in order.
   - There are no `down` files. Mistakes are fixed with a new forward migration.
   - CI checks a manifest of per-file SHA-256 hashes, so a released migration can never change (Langfuse's byte-lock, per file).
2. **Version bookkeeping** lives in a `meta` table: `schema_version`, `min_reader_version`, `min_writer_version`, `last_migrated_by`. Each migration declares its compatibility:
   - **additive** (new table or nullable column): leaves both minimums alone, so older binaries keep reading and writing (they use explicit column lists and ignore unknown columns);
   - **breaking for writers:** raises `min_writer_version`;
   - **breaking for readers:** raises `min_reader_version`, which is rare and needs an ADR.
3. **Mutual exclusion via SQLite itself:**
   - Fast path: read `meta.schema_version` without a lock.
   - If it is behind the binary: `BEGIN EXCLUSIVE`, re-read, apply every pending migration in the same transaction (SQLite DDL is transactional, so there is no "dirty" state), write `meta`, `COMMIT`.
   - Other processes wait on `busy_timeout` and then re-check. This is cross-platform and needs no file-lock library.
4. **Before any migration, take a backup** with `VACUUM INTO ~/.searchhole/backups/searchhole-v<from>-<timestamp>.db`. Keep the last 3. `searchhole doctor --check-migrations` dry-runs the pending migrations against a copy.
5. **When the binary is older than the DB:**
   - **`schema_version` > ours but `min_writer_version` ≤ ours:** normal operation.
   - **`min_writer_version` > ours:** **read-only mode.** Searches still run with full rules. Logging is skipped and counted. Receipts come from process memory. Every receipt and `doctor` line says "search-hole v0.4 is older than your data (v0.6); update the plugin", with the upgrade command for this host.
   - **`min_reader_version` > ours:** history is unavailable as well. Searches still run, with YAML rules only.
   - It never hard-fails and never downgrades.
6. **Timing:** migrations run on the **first real request** (`tools/call`, a CLI command, or a UI start), **never at process spawn**. Probe siblings and `tools/list` must stay side-effect free. Long data migrations, such as backfills, run as resumable batches with a stored cursor under the job lease, show progress in `doctor` and the dashboard, and never block the search path.

### Background jobs: one owner

7. **Jobs (list refresh, list compile, retention, vacuum and checkpoint) use a lease row:**
   - Table: `jobs(name PK, owner_gateway_id, owner_version, lease_until, heartbeat_at, status, progress_json, last_error)`.
   - **Acquire** in `BEGIN IMMEDIATE`, only if the lease has expired.
   - **Heartbeat** every 10 s with a 30 s lease. A takeover happens after expiry.
   - **Release** on clean exit, including **stdin EOF**, which is how a stdio gateway learns its host died (one-search-mcp's cleanup pattern).
   - Only a process whose `compiler_version` is ≥ the newest artifact's may compile lists (point 8).
   - Jobs are skipped while a process is read-only.
8. **Compiled list artifacts are versioned, not invalidated** (uBlock's magic numbers, adapted to many processes):
   - Artifacts are keyed by `(list_id, content_sha256, compiler_version)`, each with a checksum.
   - A gateway uses the newest artifact it can read. If none exists, it falls back to the last good one, or builds its own for its own version.
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
    - Plugin uninstall deletes only `${CLAUDE_PLUGIN_DATA}`, which we use only for caches (ADR-0007), so user data survives a plugin reinstall unless `--purge` is run.

## Alternatives considered

- **Hard-fail on a newer schema** (AdGuard Home). Rejected: with several installs, it breaks the older host's search entirely.
- **A file lock (`.migrate.lock`) around migrations** (docker/mcp-gateway, context-forge). Rejected as the primary mechanism, because `BEGIN EXCLUSIVE` gives the same exclusion with fewer failure modes, such as stale lock files or NFS. File locks are still used for YAML writes, where SQLite isn't involved.
- **Recompiling every list at every start** (uBlacklist). Rejected: the 418k-rule list would break the 300 ms startup target.
- **Down migrations.** Rejected. They are rarely tested, and the read-only rule plus backups covers rollback.

## Consequences

- Any mix of plugin, `.mcpb` and npx versions within the compatibility window works read-write. Outside it, the old version degrades to search-only with a clear message.
- Every additive migration must be additive in practice: insert with explicit column lists, and never reuse a column name with a new meaning. A CI test runs the previous release's query layer against the new schema.

## Validate early (P1)

- **Migration race test:** 50 processes start at once on an old DB. Exactly one migrates, all end up serving, and nobody sees a half-applied schema.
- **Two-version test:** v(n) and v(n+1) run against one DB with an additive migration and then a writer-breaking one. Assert that the old version is read-write and then read-only, as specified. This is the "two gateway versions sharing one DB" mock scenario from §12.3.
- **Lease test:** kill -9 the owner mid-refresh, then check that a takeover happens after 30 s and the last good list stays in force.
