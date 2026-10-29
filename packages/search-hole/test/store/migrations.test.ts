// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  type Migration,
  migrationHash,
  validateMigrations,
} from '../../src/store/migrations/index.ts'
import { MIGRATION_MANIFEST } from '../../src/store/migrations/manifest.ts'

describe('migration manifest (ADR-0006 point 1)', () => {
  it('pins the SHA-256 of every released migration; a released migration never changes', () => {
    expect(MIGRATION_MANIFEST.map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id))
    for (const m of MIGRATIONS) {
      const entry = MIGRATION_MANIFEST.find((e) => e.id === m.id)
      expect(entry?.name, `manifest entry for ${m.name}`).toBe(m.name)
      expect(migrationHash(m.sql), `${m.name} changed after release; add a new migration instead`).toBe(
        entry?.sha256,
      )
    }
  })

  it('has contiguous ids and the latest schema version matches the list', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1))
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length)
  })

  it('migrations never manage transactions (the migrator wraps them in one)', () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i)
    }
  })
})

describe('validateMigrations (the compatibility window, ADR-0006 point 2)', () => {
  it('accepts the real list', () => {
    expect(validateMigrations(MIGRATIONS)).toEqual([])
  })

  const base: Migration = {
    id: 1,
    name: 'a',
    sql: '',
    introducedIn: '0.1.0',
    minWriterVersion: '0.0.0',
    minReaderVersion: '0.0.0',
  }

  it('expand in Y, contract in Y+1: a release may require at most the previous minor', () => {
    expect(validateMigrations([{ ...base, introducedIn: '0.5.0', minWriterVersion: '0.4.0' }])).toEqual([])
    const bad = validateMigrations([{ ...base, introducedIn: '0.5.0', minWriterVersion: '0.5.0' }])
    expect(bad.join('\n')).toMatch(/expand in Y, contract in Y\+1/)
    expect(validateMigrations([{ ...base, introducedIn: '1.0.0', minWriterVersion: '0.9.0' }])).toEqual([])
    expect(validateMigrations([{ ...base, introducedIn: '1.0.0', minWriterVersion: '1.0.0' }])).not.toEqual(
      [],
    )
  })

  it('raising min_reader_version needs a major release', () => {
    const minor = validateMigrations([{ ...base, introducedIn: '0.5.0', minReaderVersion: '0.2.0' }])
    expect(minor.join('\n')).toMatch(/major release/)
    expect(validateMigrations([{ ...base, introducedIn: '2.0.0', minReaderVersion: '1.0.0' }])).toEqual([])
  })

  it('rejects gaps, duplicate names, decreasing minimums and backwards releases', () => {
    const gap = validateMigrations([base, { ...base, id: 3, name: 'c' }])
    expect(gap.join('\n')).toMatch(/id must be 2/)
    expect(validateMigrations([base, { ...base, id: 2 }]).join('\n')).toMatch(/duplicate name/)
    const decreasing = validateMigrations([
      { ...base, introducedIn: '0.3.0', minWriterVersion: '0.2.0' },
      { ...base, id: 2, name: 'b', introducedIn: '0.4.0', minWriterVersion: '0.1.0' },
    ])
    expect(decreasing.join('\n')).toMatch(/minWriterVersion decreases/)
    const backwards = validateMigrations([
      { ...base, introducedIn: '0.4.0' },
      { ...base, id: 2, name: 'b', introducedIn: '0.3.0' },
    ])
    expect(backwards.join('\n')).toMatch(/goes backwards/)
  })

  it('rejects non-semver fields', () => {
    expect(validateMigrations([{ ...base, minWriterVersion: 'soon' }]).join('\n')).toMatch(/must be semver/)
  })
})
