// SPDX-License-Identifier: Apache-2.0
// `lists` rows (migration 0003, ADR-0022): configuration, refresh outcomes, fencing, contribution.
import { describe, expect, it } from 'vitest'
import type { RuleRef } from '../../src/shared/types.ts'
import type { ListMetaWrite, Store } from '../../src/store/index.ts'
import { autoClose, clock, open, tempDir } from './helpers.ts'

const meta = (over: Partial<ListMetaWrite> = {}): ListMetaWrite => ({
  id: 'spam',
  name: 'Spam list',
  source: 'subscribed',
  url: 'https://lists.example/spam.txt',
  format: 'ublacklist',
  kind: 'block',
  mode: 'enforce',
  license: null,
  updateIntervalHours: 168,
  ...over,
})

const fetched = (ruleCount: number, sha = 'a'.repeat(64)) => ({
  kind: 'fetched' as const,
  etag: '"v1"',
  lastModified: 'Fri, 30 Oct 2026 10:00:00 GMT',
  contentSha256: sha,
  compilerVersion: '1',
  ruleCount,
  skippedCount: 2,
  license: 'CC0-1.0',
  nextCheckAt: 1000,
})

describe('lists rows (migration 0003)', () => {
  it('upserts configuration and records fetched, verified and failed outcomes', async () => {
    const t = clock()
    const store = autoClose(await open(tempDir(), t))
    expect(store.lists.upsertMeta(meta())).toBe(true)
    expect(store.lists.get('spam')).toMatchObject({
      name: 'Spam list',
      source: 'subscribed',
      failures: 0,
      ruleCount: null,
      lastError: null,
    })

    expect(store.lists.recordOutcome('spam', fetched(100))).toBe(true)
    t.advance(60_000)
    expect(store.lists.recordOutcome('spam', fetched(120, 'b'.repeat(64)))).toBe(true)
    expect(store.lists.get('spam')).toMatchObject({
      ruleCount: 120,
      previousRuleCount: 100,
      skippedCount: 2,
      contentSha256: 'b'.repeat(64),
      etag: '"v1"',
      license: 'CC0-1.0',
      fetchedAt: t(),
      verifiedAt: t(),
    })

    t.advance(60_000)
    store.lists.recordOutcome('spam', {
      kind: 'failed',
      error: 'shrink_guard',
      detail: 'too small',
      nextCheckAt: 5,
    })
    store.lists.recordOutcome('spam', { kind: 'failed', error: 'network', detail: 'offline', nextCheckAt: 6 })
    expect(store.lists.get('spam')).toMatchObject({
      ruleCount: 120,
      failures: 2,
      lastError: 'network',
      lastErrorDetail: 'offline',
      checkedAt: t(),
      nextCheckAt: 6,
    })

    t.advance(60_000)
    store.lists.recordOutcome('spam', { kind: 'verified', etag: '"v2"', nextCheckAt: 9 })
    expect(store.lists.get('spam')).toMatchObject({
      etag: '"v2"',
      failures: 0,
      lastError: null,
      verifiedAt: t(),
      ruleCount: 120,
      nextCheckAt: 9,
    })
  })

  it('a changed URL drops the validators; a missing row is not created by an outcome', async () => {
    const store = autoClose(await open(tempDir(), clock()))
    expect(store.lists.recordOutcome('nope', fetched(1))).toBe(false)
    store.lists.upsertMeta(meta())
    store.lists.recordOutcome('spam', fetched(10))
    store.lists.upsertMeta(meta({ mode: 'audit' }))
    expect(store.lists.get('spam')).toMatchObject({ etag: '"v1"', mode: 'audit' })
    store.lists.upsertMeta(meta({ url: 'https://lists.example/other.txt' }))
    expect(store.lists.get('spam')).toMatchObject({ etag: null, lastModified: null, ruleCount: 10 })
    expect(store.lists.list().map((r) => r.id)).toEqual(['spam'])
    expect(store.lists.remove('spam')).toBe(true)
    expect(store.lists.get('spam')).toBeUndefined()
  })

  it('a fenced outcome is refused once another process holds the refresh lease', async () => {
    const dir = tempDir()
    const t = clock()
    const a = autoClose(await open(dir, t))
    const b = autoClose(await open(dir, t))
    a.lists.upsertMeta(meta())
    const lease = a.jobs.acquire('lists:refresh', { gatewayId: 'gw_a', version: '0.1.0' }, 30_000)
    if (!lease.acquired) throw new Error('no lease')
    expect(a.lists.recordOutcome('spam', fetched(5), lease.lease)).toBe(true)
    t.advance(31_000)
    const taken = b.jobs.acquire('lists:refresh', { gatewayId: 'gw_b', version: '0.1.0' }, 30_000)
    expect(taken.acquired).toBe(true)
    expect(a.lists.recordOutcome('spam', fetched(500), lease.lease)).toBe(false)
    expect(a.lists.get('spam')?.ruleCount).toBe(5)
  })
})

describe('list contribution', () => {
  const ref = (listId: string): RuleRef => ({ ruleId: `l_${listId}_1`, tier: 'T4', listId, text: 'block x' })

  function log(store: Store, at: number): void {
    store.recordBuiltinSearch({
      receiptId: 'rcpt_AAAAAAAAAAAAAAAAAAAAAA',
      queryRedacted: 'q',
      profile: 'default',
      latencyMs: 1,
      createdAt: at,
      results: [
        {
          url: 'https://a.example/',
          rank: 1,
          visibility: 'hidden',
          reason: 'list',
          rule: ref('spam'),
          flags: [],
          sourceType: 'unknown',
        },
        {
          url: 'https://b.example/',
          rank: 2,
          visibility: 'hidden',
          reason: 'rule',
          rule: { ruleId: 'r_1', tier: 'T3', text: 'block b' },
          flags: [],
          sourceType: 'unknown',
        },
        {
          url: 'https://c.example/',
          rank: 3,
          visibility: 'kept',
          outRank: 1,
          auditRule: ref('ai'),
          flags: ['would_hide'],
          sourceType: 'unknown',
        },
      ],
    })
  }

  it('counts results a list hid and results an audit list would have hidden, since a time', async () => {
    const t = clock()
    const store = autoClose(await open(tempDir(), t))
    log(store, t() - 8 * 86_400_000)
    log(store, t() - 1000)
    log(store, t())
    const c = store.lists.contribution(t() - 7 * 86_400_000)
    expect(Object.fromEntries(c)).toEqual({
      spam: { hidden: 2, wouldHide: 0 },
      ai: { hidden: 0, wouldHide: 2 },
    })
  })
})
