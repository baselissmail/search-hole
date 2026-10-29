// SPDX-License-Identifier: Apache-2.0
/**
 * Migration 0001: the initial schema (ADR-0003 point 5).
 *
 * Conventions: timestamps are INTEGER epoch milliseconds (UTC); enumerations are TEXT codes
 * validated in code, never CHECK (x IN ...) (a new code must not need a table rebuild);
 * JSON columns carry CHECK (json_valid(...)). Migrations never manage transactions: the
 * migrator wraps them all in one BEGIN EXCLUSIVE.
 */
import { META_SQL } from './meta-sql.ts'

const MUTABLE = `
-- Generic key/value state (install secret for key_fp, housekeeping markers).
CREATE TABLE meta_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Session-scope rules (ADR-0008); die with the session key.
CREATE TABLE rules_session (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  rule_json  TEXT NOT NULL CHECK (json_valid(rule_json)),
  created_at INTEGER NOT NULL,
  until      INTEGER
);
CREATE INDEX rules_session_by_session ON rules_session (session_id, created_at, id);

-- Last good compiled user rules, keyed by file content hash (ADR-0008).
CREATE TABLE rules_lastgood (
  source_path      TEXT NOT NULL,
  content_sha256   TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  compiled_json    TEXT NOT NULL CHECK (json_valid(compiled_json)),
  saved_at         INTEGER NOT NULL,
  PRIMARY KEY (source_path, content_sha256)
) WITHOUT ROWID;

-- A project's .searchhole.yaml applies only after its content hash is trusted (ADR-0008).
CREATE TABLE project_trust (
  path           TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  trusted_at     INTEGER NOT NULL
) WITHOUT ROWID;

-- Subscribed and bundled lists. Compiled artifacts are files under <data>/lists/, not blobs.
CREATE TABLE lists (
  id                    TEXT PRIMARY KEY,
  url                   TEXT,
  format                TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  mode                  TEXT NOT NULL DEFAULT 'enforce',
  license               TEXT,
  update_interval_hours INTEGER,
  etag                  TEXT,
  last_modified         TEXT,
  content_sha256        TEXT,
  compiler_version      TEXT,
  rule_count            INTEGER,
  previous_rule_count   INTEGER,
  fetched_at            INTEGER,
  checked_at            INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) WITHOUT ROWID;

-- Rule proposals queued by the model; only the user approves them (Principle 3).
CREATE TABLE suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  receipt_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  rule_json   TEXT NOT NULL CHECK (json_valid(rule_json)),
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX suggestions_by_status ON suggestions (status, resolved_at);

-- Shared engine health (ADR-0009 point 4). key_fp '' = key-independent (shared) state;
-- sub_engine '' = the engine itself.
CREATE TABLE engine_health (
  engine              TEXT NOT NULL,
  key_fp              TEXT NOT NULL DEFAULT '',
  sub_engine          TEXT NOT NULL DEFAULT '',
  state               TEXT NOT NULL,
  reason_class        TEXT,
  until               INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ewma_success        REAL,
  p50_ms              INTEGER,
  p95_ms              INTEGER,
  last_success_at     INTEGER,
  last_error_redacted TEXT,
  key_present         INTEGER NOT NULL DEFAULT 0,
  key_source          TEXT,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (engine, key_fp, sub_engine)
) WITHOUT ROWID;

-- Spend-cap counters (ADR-0009 point 6). This table never takes a writer-breaking change,
-- so even read-only processes (ADR-0006 point 5) can reserve.
-- period_kind 'day' | 'month'; period_start 'YYYY-MM-DD' | 'YYYY-MM' (UTC).
CREATE TABLE engine_usage (
  engine       TEXT NOT NULL,
  key_fp       TEXT NOT NULL DEFAULT '',
  period_kind  TEXT NOT NULL,
  period_start TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (engine, key_fp, period_kind, period_start)
) WITHOUT ROWID;

-- Background-job leases with fencing (ADR-0006 point 7).
CREATE TABLE jobs (
  name             TEXT PRIMARY KEY,
  owner_gateway_id TEXT,
  owner_version    TEXT,
  lease_until      INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     INTEGER,
  status           TEXT NOT NULL DEFAULT 'idle',
  progress_json    TEXT CHECK (progress_json IS NULL OR json_valid(progress_json)),
  last_error       TEXT,
  lease_epoch      INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Running gateways (ADR-0004), refreshed at most every 30 s.
CREATE TABLE gateways (
  id                   TEXT PRIMARY KEY,
  pid                  INTEGER NOT NULL,
  host_profile         TEXT NOT NULL,
  client_name          TEXT,
  client_version       TEXT,
  app_version          TEXT NOT NULL,
  schema_version_known INTEGER,
  started_at           INTEGER NOT NULL,
  last_seen_at         INTEGER NOT NULL
);
CREATE INDEX gateways_by_last_seen ON gateways (last_seen_at);

-- Install registry for skew reporting (ADR-0006 point 10).
CREATE TABLE installs (
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  version    TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (kind, path)
) WITHOUT ROWID;

-- Sessions (ADR-0005).
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  host_profile    TEXT NOT NULL,
  host_key        TEXT,
  key_source      TEXT NOT NULL,
  client_name     TEXT,
  client_version  TEXT,
  protocol_era    TEXT,
  project_dir     TEXT,
  gateway_id      TEXT,
  open_receipt_id TEXT,
  turn_open       INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE INDEX sessions_by_last_seen ON sessions (last_seen_at);

-- Receipts: a handle naming a set of searches and fetches (ADR-0005).
CREATE TABLE receipts (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  search_count INTEGER NOT NULL DEFAULT 0,
  fetch_count  INTEGER NOT NULL DEFAULT 0,
  duplicate_of TEXT
);
CREATE INDEX receipts_by_session ON receipts (session_id, created_at);
CREATE INDEX receipts_by_updated ON receipts (updated_at);

-- Daily rollups, upserted on write. engine '*' is the whole-search row. day is 'YYYY-MM-DD' (UTC).
CREATE TABLE daily_stats (
  day              TEXT NOT NULL,
  engine           TEXT NOT NULL,
  searches         INTEGER NOT NULL DEFAULT 0,
  results_returned INTEGER NOT NULL DEFAULT 0,
  kept             INTEGER NOT NULL DEFAULT 0,
  hidden           INTEGER NOT NULL DEFAULT 0,
  errors           INTEGER NOT NULL DEFAULT 0,
  latency_ms_total INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, engine)
) WITHOUT ROWID;
`

const EVENTS = `
-- Append-only, retention-pruned events. searches.id is the live-tail cursor (ADR-0004):
-- AUTOINCREMENT, so ids are never reused after deletes.
CREATE TABLE searches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id           TEXT NOT NULL,
  session_id           TEXT,
  query_redacted       TEXT NOT NULL,
  profile              TEXT NOT NULL,
  depth                TEXT NOT NULL,
  engines_json         TEXT NOT NULL CHECK (json_valid(engines_json)),
  latency_ms           INTEGER NOT NULL,
  kept_count           INTEGER NOT NULL,
  hidden_count         INTEGER NOT NULL,
  pushed_rule_ids_json TEXT CHECK (pushed_rule_ids_json IS NULL OR json_valid(pushed_rule_ids_json)),
  tool_use_id          TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX searches_by_created ON searches (created_at, id);
CREATE INDEX searches_by_receipt ON searches (receipt_id, id);
CREATE INDEX searches_by_session ON searches (session_id, id);

-- One row per merged result, kept or hidden. engine/raw_rank are the best (lowest) raw rank;
-- positions_json holds every engine's rank. canonical_key is NULL when any engine in the group
-- stores decisions only (ADR-0009 point 9): url_hash is then the only URL trace.
CREATE TABLE results (
  id                   INTEGER PRIMARY KEY,
  search_id            INTEGER NOT NULL REFERENCES searches (id) ON DELETE CASCADE,
  engine               TEXT NOT NULL,
  raw_rank             INTEGER NOT NULL,
  positions_json       TEXT NOT NULL CHECK (json_valid(positions_json)),
  canonical_key        TEXT,
  url_hash             TEXT NOT NULL,
  registrable_domain   TEXT NOT NULL,
  decision             TEXT NOT NULL,
  reason               TEXT,
  rule_id              TEXT,
  tier                 TEXT,
  list_id              TEXT,
  rule_text            TEXT,
  flags_json           TEXT NOT NULL CHECK (json_valid(flags_json)),
  source_type          TEXT NOT NULL,
  dates_json           TEXT NOT NULL CHECK (json_valid(dates_json)),
  effective_date       TEXT,
  effective_kind       TEXT,
  effective_confidence TEXT,
  out_rank             INTEGER,
  fused                REAL,
  adjusted             REAL,
  created_at           INTEGER NOT NULL
);
CREATE INDEX results_by_search ON results (search_id);
CREATE INDEX results_by_rule ON results (rule_id, created_at);
CREATE INDEX results_by_created ON results (created_at);

-- Bulky or term-restricted content, one row per engine with its own expiry (ADR-0009 point 9).
CREATE TABLE result_payloads (
  id         INTEGER PRIMARY KEY,
  result_id  INTEGER NOT NULL REFERENCES results (id) ON DELETE CASCADE,
  engine     TEXT NOT NULL,
  title      TEXT NOT NULL,
  snippet    TEXT NOT NULL,
  url        TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX result_payloads_by_result ON result_payloads (result_id, engine);
CREATE INDEX result_payloads_by_expiry ON result_payloads (expires_at);

-- Fetch metadata and dates only; page text is never stored (ADR-0015).
CREATE TABLE fetches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id           TEXT NOT NULL,
  session_id           TEXT,
  tool_use_id          TEXT,
  url_hash             TEXT NOT NULL,
  final_url_hash       TEXT,
  host                 TEXT,
  registrable_domain   TEXT,
  status               INTEGER,
  content_type         TEXT,
  bytes                INTEGER,
  title                TEXT,
  decision             TEXT,
  reason               TEXT,
  rule_id              TEXT,
  dates_json           TEXT CHECK (dates_json IS NULL OR json_valid(dates_json)),
  effective_date       TEXT,
  effective_kind       TEXT,
  effective_confidence TEXT,
  latency_ms           INTEGER,
  created_at           INTEGER NOT NULL
);
CREATE INDEX fetches_by_created ON fetches (created_at, id);
CREATE INDEX fetches_by_receipt ON fetches (receipt_id, id);
`

/** Migration 0001 SQL: meta (idempotent), the mutable family, then the append-only family. */
export const sql = `${META_SQL}${MUTABLE}${EVENTS}`
