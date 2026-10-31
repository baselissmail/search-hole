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

describe('sessions.claimTurn (ADR-0006 point 11: duplicate copies)', () => {
  const write = (gatewayId: string, openReceiptId: string) => ({
    id: 's1',
    hostProfile: 'claude-code',
    hostKey: 's1',
    keySource: 'hook',
    gatewayId,
    openReceiptId,
    turnOpen: true,
  })

  it('a second gateway opening the same turn within the window is a duplicate; the row stays the first', async () => {
    const t = clock()
    const store = autoClose(await open(tempDir(), t))
    expect(store.sessions.claimTurn(write('gw_a', 'rcpt_A'), 10_000)).toEqual({ kind: 'claimed' })
    t.advance(50)
    expect(store.sessions.claimTurn(write('gw_b', 'rcpt_B'), 10_000)).toEqual({
      kind: 'duplicate',
      of: 'rcpt_A',
    })
    expect(store.sessions.get('s1')).toMatchObject({
      gatewayId: 'gw_a',
      openReceiptId: 'rcpt_A',
      turnOpen: true,
    })
    expect(store.receipts.get('rcpt_B')?.duplicateOf).toBe('rcpt_A')
    expect(store.receipts.duplicatesSince(0)).toBe(1)
    // The same gateway's next prompt, or another gateway well after the window, claims normally.
    expect(store.sessions.claimTurn(write('gw_a', 'rcpt_C'), 10_000)).toEqual({ kind: 'claimed' })
    t.advance(10_001)
    expect(store.sessions.claimTurn(write('gw_b', 'rcpt_D'), 10_000)).toEqual({ kind: 'claimed' })
    expect(store.sessions.get('s1')?.gatewayId).toBe('gw_b')
  })

  it('a closed turn is never a reason to stay quiet (a plugin reload between prompts)', async () => {
    const t = clock()
    const store = autoClose(await open(tempDir(), t))
    store.sessions.claimTurn(write('gw_old', 'rcpt_A'), 10_000)
    store.sessions.upsert({ ...write('gw_old', 'rcpt_A'), turnOpen: false })
    t.advance(1_000)
    expect(store.sessions.claimTurn(write('gw_new', 'rcpt_B'), 10_000)).toEqual({ kind: 'claimed' })
  })
})
