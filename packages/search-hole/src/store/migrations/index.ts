// SPDX-License-Identifier: Apache-2.0
/**
 * The migration list. Migrations are forward-only TS modules that export SQL text (so they
 * bundle into the single artifact). A released migration never changes: `manifest.ts` pins
 * the SHA-256 of each one and a test fails on any difference (ADR-0006 point 1).
 */
import { createHash } from 'node:crypto'
import { compareSemver, parseSemver } from '../version.ts'
import { sql as sql0001 } from './0001_init.ts'
import { sql as sql0002 } from './0002_fetch_urls.ts'
import { sql as sql0003 } from './0003_lists.ts'

export interface Migration {
  /** Contiguous from 1. The schema version after applying it. */
  readonly id: number
  readonly name: string
  readonly sql: string
  /** App version that first ships this migration (ADR-0006 point 2). */
  readonly introducedIn: string
  /** `meta.min_writer_version` after this migration (app semver). Older writers go read-only. */
  readonly minWriterVersion: string
  /** `meta.min_reader_version` after this migration. Raising it needs a major version. */
  readonly minReaderVersion: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: '0001_init',
    sql: sql0001,
    introducedIn: '0.1.0',
    minWriterVersion: '0.0.0',
    minReaderVersion: '0.0.0',
  },
  {
    id: 2,
    name: '0002_fetch_urls',
    sql: sql0002,
    introducedIn: '0.1.1',
    minWriterVersion: '0.0.0',
    minReaderVersion: '0.0.0',
  },
  {
    id: 3,
    name: '0003_lists',
    sql: sql0003,
    introducedIn: '0.3.0',
    minWriterVersion: '0.0.0',
    minReaderVersion: '0.0.0',
  },
]

/** The schema version this binary produces. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0)

/** Hex SHA-256 of a migration's SQL text (UTF-8). */
export function migrationHash(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/** The highest schema version in a migration list. */
export function latestSchemaOf(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.id), 0)
}

/**
 * Checks a migration list against the compatibility rules of ADR-0006 point 2. Returns a list
 * of violations (empty when valid). CI runs this on the real list.
 *
 * - ids are contiguous from 1 and names are unique;
 * - `introducedIn` never goes backwards;
 * - expand in Y, contract in Y+1: `minWriterVersion` is strictly below `introducedIn`'s
 *   major.minor (a release vX.Y may require at most vX.(Y-1));
 * - minimums never decrease;
 * - raising `minReaderVersion` needs a major release (`X.0.0`, X >= 1).
 */
export function validateMigrations(migrations: readonly Migration[]): string[] {
  const problems: string[] = []
  const names = new Set<string>()
  let prevIntroduced = '0.0.0'
  let reader = '0.0.0'
  let writer = '0.0.0'
  migrations.forEach((m, index) => {
    const at = `migration ${m.id} (${m.name})`
    if (m.id !== index + 1) problems.push(`${at}: id must be ${index + 1}`)
    if (names.has(m.name)) problems.push(`${at}: duplicate name`)
    names.add(m.name)
    const intro = parseSemver(m.introducedIn)
    const w = parseSemver(m.minWriterVersion)
    const r = parseSemver(m.minReaderVersion)
    if (!intro || !w || !r) {
      problems.push(`${at}: introducedIn, minWriterVersion and minReaderVersion must be semver`)
      return
    }
    if (compareSemver(m.introducedIn, prevIntroduced) < 0) problems.push(`${at}: introducedIn goes backwards`)
    if (!(w.major < intro.major || (w.major === intro.major && w.minor < intro.minor)))
      problems.push(
        `${at}: minWriterVersion ${m.minWriterVersion} must be below ${intro.major}.${intro.minor}.0 (expand in Y, contract in Y+1)`,
      )
    if (compareSemver(m.minWriterVersion, writer) < 0) problems.push(`${at}: minWriterVersion decreases`)
    if (compareSemver(m.minReaderVersion, reader) < 0) problems.push(`${at}: minReaderVersion decreases`)
    if (
      compareSemver(m.minReaderVersion, reader) > 0 &&
      !(intro.minor === 0 && intro.patch === 0 && intro.major >= 1)
    )
      problems.push(`${at}: raising minReaderVersion requires a major release`)
    prevIntroduced = m.introducedIn
    reader = m.minReaderVersion
    writer = m.minWriterVersion
  })
  return problems
}
