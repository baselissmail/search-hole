// SPDX-License-Identifier: Apache-2.0
// After an upgrade the CLI reads an older database: it migrates first instead of showing "nothing logged".
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, openStore } from '../../src/store/index.ts'
import { NOW, setup } from './helpers.ts'

describe('CLI reads migrate a pending schema', () => {
  it('shows history written by the previous schema', async () => {
    const h = await setup({ host: 'cli' })
    const old = await openStore({
      dataDir: h.home,
      appVersion: '0.1.0',
      now: () => NOW,
      migrations: MIGRATIONS.slice(0, 1),
    })
    await old.runMigration()
    old.recordBuiltinSearch({
      receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA',
      queryRedacted: 'react compiler',
      profile: 'default',
      latencyMs: 3,
      results: [
        {
          url: 'https://react.dev/learn',
          rank: 1,
          visibility: 'kept',
          outRank: 1,
          flags: [],
          sourceType: 'official',
        },
      ],
    })
    old.close()

    const recent = await h.app.log.recent()
    expect(recent.map((e) => e.query)).toEqual(['react compiler'])
  })

  it('hosts keep reads side-effect free', async () => {
    const h = await setup({})
    const old = await openStore({
      dataDir: h.home,
      appVersion: '0.1.0',
      now: () => NOW,
      migrations: MIGRATIONS.slice(0, 1),
    })
    await old.runMigration()
    old.close()
    expect(await h.app.log.recent()).toEqual([])
  })
})
