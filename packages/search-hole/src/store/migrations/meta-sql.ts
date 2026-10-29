// SPDX-License-Identifier: Apache-2.0
/**
 * The `meta` table: one row of protocol state (ADR-0006). It is created by the elected
 * migrator before migration 0001 runs (the election itself needs this row) and repeated,
 * verbatim and idempotently, at the top of migration 0001 so the schema has one description.
 * Changing this text changes the 0001 hash, which the manifest test rejects.
 */
export const META_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version     INTEGER NOT NULL DEFAULT 0,
  min_reader_version TEXT    NOT NULL DEFAULT '0.0.0',
  min_writer_version TEXT    NOT NULL DEFAULT '0.0.0',
  last_migrated_by   TEXT    NOT NULL DEFAULT '0.0.0',
  data_epoch         INTEGER NOT NULL DEFAULT 0,
  migrating_pid      INTEGER,
  migrating_until    INTEGER
);
INSERT OR IGNORE INTO meta (id) VALUES (1);
`
