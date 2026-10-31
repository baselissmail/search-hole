// SPDX-License-Identifier: Apache-2.0
// Migrations used to exercise upgrades, numbered after the real list. No vitest import: the
// child-process worker loads this file too.
import type { Migration } from '../../src/store/migrations/index.ts'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/store/migrations/index.ts'

/** Fixture migrations are numbered after the real ones. */
const N = LATEST_SCHEMA_VERSION

/** Additive: new column and table. Leaves both minimums alone. */
export const ADDITIVE: Migration = {
  id: N + 1,
  name: '0002_additive',
  introducedIn: '0.2.0',
  minWriterVersion: '0.0.0',
  minReaderVersion: '0.0.0',
  sql: `
    ALTER TABLE searches ADD COLUMN note TEXT;
    CREATE TABLE probe_additive (id INTEGER PRIMARY KEY, label TEXT);
  `,
}

/** Rebuilds `searches` (the parent of results) the way SQLite documents: new, copy, drop, rename. */
export const REBUILD_PARENT: Migration = {
  id: N + 2,
  name: '0003_rebuild_searches',
  introducedIn: '0.3.0',
  minWriterVersion: '0.0.0',
  minReaderVersion: '0.0.0',
  sql: `
    CREATE TABLE searches_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL,
      session_id TEXT,
      query_redacted TEXT NOT NULL,
      profile TEXT NOT NULL,
      depth TEXT NOT NULL,
      engines_json TEXT NOT NULL CHECK (json_valid(engines_json)),
      latency_ms INTEGER NOT NULL,
      kept_count INTEGER NOT NULL,
      hidden_count INTEGER NOT NULL,
      pushed_rule_ids_json TEXT CHECK (pushed_rule_ids_json IS NULL OR json_valid(pushed_rule_ids_json)),
      tool_use_id TEXT,
      created_at INTEGER NOT NULL,
      note TEXT,
      rebuilt INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO searches_new (id, receipt_id, session_id, query_redacted, profile, depth, engines_json,
                              latency_ms, kept_count, hidden_count, pushed_rule_ids_json, tool_use_id, created_at, note)
      SELECT id, receipt_id, session_id, query_redacted, profile, depth, engines_json,
             latency_ms, kept_count, hidden_count, pushed_rule_ids_json, tool_use_id, created_at, note
        FROM searches;
    DROP TABLE searches;
    ALTER TABLE searches_new RENAME TO searches;
    CREATE INDEX searches_by_created ON searches (created_at, id);
    CREATE INDEX searches_by_receipt ON searches (receipt_id, id);
    CREATE INDEX searches_by_session ON searches (session_id, id);
  `,
}

/** Writer-breaking: older writers (< 0.3.0) must go read-only. */
export const WRITER_BREAKING: Migration = {
  id: N + 3,
  name: '0004_contract',
  introducedIn: '0.4.0',
  minWriterVersion: '0.3.0',
  minReaderVersion: '0.0.0',
  sql: 'CREATE TABLE probe_contract (id INTEGER PRIMARY KEY);',
}

/** A migration that fails halfway, after creating a table. */
export const BROKEN: Migration = {
  id: N + 1,
  name: '0002_broken',
  introducedIn: '0.2.0',
  minWriterVersion: '0.0.0',
  minReaderVersion: '0.0.0',
  sql: 'CREATE TABLE probe_half (id INTEGER); INSERT INTO table_that_does_not_exist VALUES (1);',
}

/** A migration that leaves a dangling foreign key (rolled back by foreign_key_check). */
export const FK_VIOLATION: Migration = {
  id: N + 1,
  name: '0002_fk_violation',
  introducedIn: '0.2.0',
  minWriterVersion: '0.0.0',
  minReaderVersion: '0.0.0',
  sql: `
    INSERT INTO results (search_id, engine, raw_rank, positions_json, url_hash, registrable_domain, decision,
                         flags_json, source_type, dates_json, created_at)
    VALUES (999999, 'searxng', 1, '{}', 'h', 'example.com', 'kept', '[]', 'unknown', '[]', 1);
  `,
}

export const V1 = MIGRATIONS
export const V2: readonly Migration[] = [...MIGRATIONS, ADDITIVE]
export const V3: readonly Migration[] = [...V2, REBUILD_PARENT]
export const V4: readonly Migration[] = [...V3, WRITER_BREAKING]
