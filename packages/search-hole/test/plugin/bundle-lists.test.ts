// SPDX-License-Identifier: Apache-2.0
// The built bundle ships the starter lists (dist/lists/) and finds them offline (ADR-0022).
// Runs only after `pnpm -C packages/search-hole build`; the build itself fails without the lists.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VENDORED_LISTS } from '../../src/lists/catalog.ts'
import { REPO_ROOT, tempDir } from './helpers.ts'

const DIST = join(REPO_ROOT, 'packages', 'search-hole', 'dist')
const built = existsSync(join(DIST, 'searchhole.mjs')) && existsSync(join(DIST, 'lists'))

describe.skipIf(!built)('the built bundle', () => {
  it('ships every vendored starter list next to it', () => {
    expect(readdirSync(join(DIST, 'lists')).sort()).toEqual(VENDORED_LISTS.map((v) => `${v.id}.txt`).sort())
  })

  it('`searchhole lists --json` loads the shipped copies with no network and no data yet', () => {
    const home = tempDir('searchhole bundle lists ')
    const res = spawnSync(process.execPath, [join(DIST, 'searchhole.mjs'), 'lists', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SEARCHHOLE_HOME: home, SEARCHHOLE_LOG: 'silent' },
      timeout: 20_000,
    })
    expect(res.status, res.stderr).toBe(0)
    const lists = JSON.parse(res.stdout) as Array<{
      id: string
      copy: string
      ruleCount: number
      source: string
    }>
    for (const v of VENDORED_LISTS) {
      const s = lists.find((l) => l.id === v.id)
      expect(s, v.id).toMatchObject({ source: 'vendored', copy: 'shipped' })
      expect(s?.ruleCount, v.id).toBeGreaterThan(0)
    }
  })
})
