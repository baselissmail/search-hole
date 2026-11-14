// SPDX-License-Identifier: Apache-2.0
// Which results of a logged search were opened (ADR-0025): same session, else the same receipt.
import { describe, expect, it } from 'vitest'
import { canonicalKey } from '../../src/core/url.ts'
import { openDb } from '../../src/store/driver.ts'
import { type Store, urlHash } from '../../src/store/index.ts'
import { OPENED_FETCHES_SQL } from '../../src/store/queries/opened.ts'
import { clock, open, recorded, searchInput, tempDir } from './helpers.ts'

/** The hash both writers store: SHA-256 of the canonical key (app/fetch.ts, store/record.ts). */
const hashOf = (url: string): string => urlHash(canonicalKey(url) ?? url)

const kept = (url: string) => recorded(url, {}, { canonicalKey: canonicalKey(url) ?? url })
const hidden = (url: string) =>
  recorded(url, { visibility: 'hidden', reason: 'rule' }, { canonicalKey: canonicalKey(url) ?? url })

function search(store: Store, o: { receiptId: string; sessionId?: string; urls: string[]; hide?: string[] }) {
  const r = store.recordSearch(
    searchInput({
      receiptId: o.receiptId,
      ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }),
      keptCount: o.urls.length,
      hiddenCount: o.hide?.length ?? 0,
      results: [...o.urls.map(kept), ...(o.hide ?? []).map(hidden)],
    }),
  )
  if (r.status !== 'recorded') throw new Error(`not recorded: ${r.status}`)
  return r.searchId
}

function fetched(
  store: Store,
  o: { receiptId: string; sessionId?: string; url: string; finalUrl?: string; decision?: string },
): void {
  store.fetches.record({
    receiptId: o.receiptId,
    ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }),
    urlHash: hashOf(o.url),
    url: o.url,
    ...(o.finalUrl === undefined ? {} : { finalUrl: o.finalUrl, finalUrlHash: hashOf(o.finalUrl) }),
    decision: o.decision ?? 'opened',
  })
}

describe('searchLog.openedHashes / openedCounts', () => {
  it('marks a result opened by the requested or the final URL of a fetch in the same session', async () => {
    const store = await open(tempDir(), clock())
    const id = search(store, {
      receiptId: 'rcpt_turn1',
      sessionId: 's1',
      urls: ['https://react.dev/learn', 'https://example.com/final', 'https://example.org/never'],
    })
    // Another turn of the same session (its own receipt), a tracking parameter and `www.` on the way.
    fetched(store, {
      receiptId: 'rcpt_turn2',
      sessionId: 's1',
      url: 'https://www.react.dev/learn?utm_source=x',
    })
    // A redirect: the requested URL is not a result, the final one is.
    fetched(store, {
      receiptId: 'rcpt_turn2',
      sessionId: 's1',
      url: 'https://short.example/abc',
      finalUrl: 'https://example.com/final',
    })
    const opened = store.searchLog.openedHashes([id]).get(id)
    expect(opened?.has(hashOf('https://react.dev/learn'))).toBe(true)
    expect(opened?.has(hashOf('https://example.com/final'))).toBe(true)
    expect(opened?.has(hashOf('https://example.org/never'))).toBe(false)
    expect(store.searchLog.openedCounts([id])).toEqual(new Map([[id, 2]]))
  })

  it('ignores refused fetches, other sessions and hidden results', async () => {
    const store = await open(tempDir(), clock())
    const id = search(store, {
      receiptId: 'rcpt_a',
      sessionId: 's1',
      urls: ['https://a.example/1', 'https://b.example/2'],
      hide: ['https://hidden.example/3'],
    })
    fetched(store, { receiptId: 'rcpt_a', sessionId: 's1', url: 'https://a.example/1', decision: 'refused' })
    fetched(store, { receiptId: 'rcpt_other', sessionId: 's2', url: 'https://b.example/2' })
    // Another session filing a fetch under this session's receipt is still another session.
    fetched(store, { receiptId: 'rcpt_a', sessionId: 's2', url: 'https://b.example/2' })
    expect(store.searchLog.openedHashes([id]).size).toBe(0)
    expect(store.searchLog.openedCounts([id]).size).toBe(0)
    // The hidden result's page opened in the session: the hash is known, the count stays 0.
    fetched(store, { receiptId: 'rcpt_a', sessionId: 's1', url: 'https://hidden.example/3' })
    expect(store.searchLog.openedHashes([id]).get(id)?.has(hashOf('https://hidden.example/3'))).toBe(true)
    expect(store.searchLog.openedCounts([id]).size).toBe(0)
  })

  it('falls back to the receipt for a search without a session', async () => {
    const store = await open(tempDir(), clock())
    const id = search(store, {
      receiptId: 'rcpt_nosession',
      urls: ['https://a.example/1', 'https://b.example/2'],
    })
    fetched(store, { receiptId: 'rcpt_nosession', url: 'https://a.example/1' })
    fetched(store, { receiptId: 'rcpt_elsewhere', url: 'https://b.example/2' })
    expect(store.searchLog.openedCounts([id])).toEqual(new Map([[id, 1]]))
    expect(store.searchLog.openedHashes([id]).get(id)?.has(hashOf('https://b.example/2'))).toBe(false)
  })

  it('answers many searches in one call, each within its own session', async () => {
    const store = await open(tempDir(), clock())
    const a = search(store, {
      receiptId: 'rcpt_a',
      sessionId: 's1',
      urls: ['https://a.example/1', 'https://shared.example/x'],
    })
    const b = search(store, { receiptId: 'rcpt_b', sessionId: 's2', urls: ['https://shared.example/x'] })
    const c = search(store, { receiptId: 'rcpt_c', sessionId: 's3', urls: ['https://c.example/1'] })
    fetched(store, { receiptId: 'rcpt_a', sessionId: 's1', url: 'https://a.example/1' })
    fetched(store, { receiptId: 'rcpt_a', sessionId: 's1', url: 'https://shared.example/x' })
    expect(store.searchLog.openedCounts([a, b, c, 999])).toEqual(new Map([[a, 2]]))
    expect(store.searchLog.openedCounts([])).toEqual(new Map())
  })

  it('reaches fetches through the receipt indexes, never by scanning the table', async () => {
    const dir = tempDir()
    const store = await open(dir, clock())
    search(store, { receiptId: 'rcpt_a', sessionId: 's1', urls: ['https://a.example/1'] })
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    const plan = raw
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${OPENED_FETCHES_SQL}`)
      .all({ sessions: '["s1"]', receipts: '["rcpt_a"]' })
      .map((r) => r.detail)
      .join('\n')
    raw.close()
    expect(plan).toContain('fetches_by_receipt')
    expect(plan).toContain('receipts_by_session')
    expect(plan).not.toMatch(/SCAN (f|fetches|receipts)\b/)
  })
})
