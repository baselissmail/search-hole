// SPDX-License-Identifier: Apache-2.0
/**
 * SHA-256 of each released migration's SQL text. A released migration never changes (fix
 * mistakes with a new forward migration), so test/store/migrations.test.ts fails when the SQL
 * and this manifest disagree. Add one line per new migration; never edit an existing line
 * after a release.
 *
 * Compute a hash with:
 *   node -e "import('./src/store/migrations/index.ts').then(m => console.log(m.migrationHash(m.MIGRATIONS.at(-1).sql)))"
 */
export interface ManifestEntry {
  readonly id: number
  readonly name: string
  readonly sha256: string
}

export const MIGRATION_MANIFEST: readonly ManifestEntry[] = [
  {
    id: 1,
    name: '0001_init',
    sha256: '48122fc18072927065e7f2020d5b9352038fe3dd33597aaf12eecbb0221fe3a0',
  },
  {
    id: 2,
    name: '0002_fetch_urls',
    sha256: '429e18613dfe550aea649aba304cf53fbdb75a5d1ab9827940c61e4cbfe73914',
  },
  {
    id: 3,
    name: '0003_lists',
    sha256: 'd600cdfd7ed7878d4ce44743c02b5ea11427abd897e613cd72fbf3743da3a3a1',
  },
]
