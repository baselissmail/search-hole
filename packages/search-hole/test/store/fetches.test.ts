// SPDX-License-Identifier: Apache-2.0
// Fetch rows keep the page URL (migration 0002) so receipts rebuilt elsewhere show the page.
import { describe, expect, it } from 'vitest'
import { autoClose, clock, open, tempDir } from './helpers.ts'

describe('fetches (migration 0002)', () => {
  it('stores and returns the requested and final URL', async () => {
    const dir = tempDir()
    const t = clock()
    const store = autoClose(await open(dir, t))
    expect(
      store.fetches.record({
        receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA',
        urlHash: 'h1',
        url: 'https://react.dev/learn',
        finalUrl: 'https://react.dev/learn/',
        host: 'react.dev',
        decision: 'opened',
      }),
    ).toBe(true)
    store.fetches.record({ receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA', urlHash: 'h2', decision: 'opened' })
    const rows = store.fetches.byReceipt('rcpt_AAAAAAAAAAAAAAAAAAAAAA')
    expect(rows.map((r) => [r.url, r.finalUrl])).toEqual([
      ['https://react.dev/learn', 'https://react.dev/learn/'],
      [null, null],
    ])
  })
})
