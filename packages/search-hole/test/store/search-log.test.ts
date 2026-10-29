// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Warning } from '../../src/shared/types.ts'
import { openDb } from '../../src/store/driver.ts'
import { openStore } from '../../src/store/index.ts'
import { clock, FULL, open, recorded, searchInput, tempDir } from './helpers.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

describe('recordSearch', () => {
  it('writes the search, its results and per-engine payloads in one call', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    const hiddenRule = {
      ruleId: 'rule_7',
      tier: 'T2' as const,
      listId: 'ublacklist-farms',
      text: '*://*.example.net/*',
    }
    const result = store.recordSearch(
      searchInput({
        receiptId: 'rcpt_abc',
        sessionId: 'sess_1',
        toolUseId: 'toolu_9',
        pushedRuleIds: ['r1', 'r2'],
        engines: [
          { engine: 'searxng', status: 'ok', latencyMs: 90, returned: 5 },
          {
            engine: 'brave',
            status: 'error',
            errorClass: 'rate_limited',
            returned: 0,
            detail: 'resumes 14:05',
          },
        ],
        keptCount: 1,
        hiddenCount: 1,
        results: [
          recorded(
            'https://docs.example.com/guide',
            { outRank: 1 },
            {
              engines: ['searxng', 'tavily'],
              positions: { searxng: 3, tavily: 2 },
              sourceType: 'docs',
              flags: ['raised'],
              dates: [
                {
                  value: '2025-03-01T00:00:00Z',
                  kind: 'modified',
                  method: 'jsonld:dateModified',
                  confidence: 'high',
                  tzAssumed: false,
                },
              ],
              effectiveDate: {
                value: '2025-03-01T00:00:00Z',
                kind: 'modified',
                method: 'jsonld:dateModified',
                confidence: 'high',
                tzAssumed: false,
              },
              fused: 0.9,
              adjusted: 1.2,
            },
          ),
          recorded(
            'https://farm.example.net/spam',
            { visibility: 'hidden', reason: 'list' },
            {
              decision: {
                visibility: 'hidden',
                visibilityRule: hiddenRule,
                hiddenReason: 'list',
                weight: { factor: 1 },
                preferFactor: 1,
                matches: [hiddenRule],
              },
            },
          ),
        ],
      }),
    )
    expect(result).toEqual({ status: 'recorded', searchId: 1 })

    const search = store.getSearch(1)
    expect(search).toMatchObject({
      id: 1,
      receiptId: 'rcpt_abc',
      sessionId: 'sess_1',
      queryRedacted: 'how to parse yaml',
      profile: 'default',
      depth: 'standard',
      latencyMs: 150,
      keptCount: 1,
      hiddenCount: 1,
      toolUseId: 'toolu_9',
      pushedRuleIds: ['r1', 'r2'],
      createdAt: t(),
    })
    expect(search?.engines).toEqual([
      { engine: 'searxng', status: 'ok', latencyMs: 90, returned: 5 },
      { engine: 'brave', status: 'error', errorClass: 'rate_limited', returned: 0, detail: 'resumes 14:05' },
    ])

    const [kept, hidden] = store.listResults(1)
    expect(kept).toMatchObject({
      engine: 'tavily', // best (lowest) raw rank
      rawRank: 2,
      positions: { searxng: 3, tavily: 2 },
      canonicalKey: 'docs.example.com/guide',
      urlHash: sha('docs.example.com/guide'),
      registrableDomain: 'docs.example.com',
      decision: 'kept',
      reason: null,
      ruleId: null,
      flags: ['raised'],
      sourceType: 'docs',
      effectiveDate: '2025-03-01T00:00:00Z',
      effectiveKind: 'modified',
      effectiveConfidence: 'high',
      outRank: 1,
      fused: 0.9,
      adjusted: 1.2,
      createdAt: t(),
    })
    expect(kept?.dates).toHaveLength(1)
    expect(kept?.payloads.map((p) => p.engine)).toEqual(['searxng', 'tavily'])
    expect(hidden).toMatchObject({
      decision: 'hidden',
      reason: 'list',
      ruleId: 'rule_7',
      tier: 'T2',
      listId: 'ublacklist-farms',
      ruleText: '*://*.example.net/*',
      outRank: null,
    })
  })

  it('upserts the receipt and the daily rollups', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    store.recordSearch(searchInput({ receiptId: 'rcpt_same', sessionId: 'sess_1' }))
    t.advance(1000)
    store.recordSearch(
      searchInput({
        receiptId: 'rcpt_same',
        engines: [
          { engine: 'searxng', status: 'error', errorClass: 'timeout', returned: 0, latencyMs: 6000 },
        ],
        keptCount: 0,
        latencyMs: 6000,
      }),
    )
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    expect(raw.prepare('SELECT id, session_id, search_count FROM receipts').all()).toEqual([
      { id: 'rcpt_same', session_id: 'sess_1', search_count: 2 },
    ])
    const stats = raw
      .prepare('SELECT engine, searches, errors, latency_ms_total FROM daily_stats ORDER BY engine')
      .all()
    expect(stats).toEqual([
      { engine: '*', searches: 2, errors: 1, latency_ms_total: 6150 },
      { engine: 'searxng', searches: 2, errors: 1, latency_ms_total: 6120 },
    ])
    raw.close()
  })

  it('enforces engine retention: decisions-only engines never store title, snippet or URL', async () => {
    const dir = tempDir()
    const store = await open(dir, clock())
    const secretUrl = 'https://brave-only.example.org/very/secret/path?q=1'
    store.recordSearch(
      searchInput({
        results: [
          recorded(
            secretUrl,
            {},
            { engines: ['brave'], positions: { brave: 4 }, title: 'Secret Title', snippet: 'Secret Snippet' },
          ),
        ],
      }),
    )
    const [r] = store.listResults(1)
    expect(r).toMatchObject({
      engine: 'brave',
      rawRank: 4,
      canonicalKey: null,
      urlHash: sha('brave-only.example.org/very/secret/path'),
      registrableDomain: 'brave-only.example.org',
      decision: 'kept',
    })
    expect(r?.payloads).toEqual([])
    // Nothing recognisable anywhere in the file.
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    const tables = raw.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    for (const { name } of tables) {
      const dump = JSON.stringify(raw.prepare(`SELECT * FROM ${name}`).all())
      expect(dump, name).not.toContain('Secret Title')
      expect(dump, name).not.toContain('Secret Snippet')
      expect(dump, name).not.toContain('very/secret/path')
    }
    expect(raw.prepare<{ n: number }>('SELECT count(*) AS n FROM result_payloads').get()?.n).toBe(0)
    raw.close()
  })

  it('treats an engine without a declared retention as decisions-only', async () => {
    const store = await open(tempDir(), clock())
    store.recordSearch(searchInput({ retention: {}, results: [recorded('https://example.com/a')] }))
    const [r] = store.listResults(1)
    expect(r?.payloads).toEqual([])
    expect(r?.canonicalKey).toBeNull()
  })

  it('in a mixed group only the permissive engine keeps a payload, and the URL itself is not stored', async () => {
    const store = await open(tempDir(), clock())
    store.recordSearch(
      searchInput({
        results: [
          recorded(
            'https://example.com/shared',
            {
              hits: [
                {
                  engine: 'searxng',
                  url: 'https://example.com/shared',
                  title: 'S title',
                  snippet: 'S snippet',
                },
                {
                  engine: 'brave',
                  url: 'https://example.com/shared?utm=1',
                  title: 'B title',
                  snippet: 'B snippet',
                },
              ],
            },
            { engines: ['searxng', 'brave'], positions: { searxng: 2, brave: 1 } },
          ),
        ],
      }),
    )
    const [r] = store.listResults(1)
    expect(r?.canonicalKey).toBeNull()
    expect(r?.engine).toBe('brave')
    expect(r?.payloads).toEqual([
      expect.objectContaining({
        engine: 'searxng',
        title: 'S title',
        snippet: 'S snippet',
        url: 'https://example.com/shared',
      }),
    ])
  })

  it('gives each payload its own engine TTL, capped at retention.days, and hides expired ones', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    const base = t()
    store.recordSearch(
      searchInput({
        retention: {
          searxng: FULL,
          tavily: { log: 'full', payloadTtlHours: 24 * 400 },
          mojeek: { log: 'metadata', payloadTtlHours: 1 },
          exa: { log: 'metadata', payloadTtlHours: 0 },
        },
        retentionDays: 30,
        results: [
          recorded(
            'https://example.com/a',
            {
              hits: ['searxng', 'tavily', 'mojeek', 'exa'].map((engine) => ({
                engine: engine as 'searxng',
                url: 'https://example.com/a',
                title: `${engine} title`,
                snippet: `${engine} snippet`,
              })),
            },
            {
              engines: ['searxng', 'tavily', 'mojeek', 'exa'],
              positions: { searxng: 1, tavily: 1, mojeek: 1, exa: 1 },
            },
          ),
        ],
      }),
    )
    const expiry = (): Record<string, number> =>
      Object.fromEntries((store.listResults(1)[0]?.payloads ?? []).map((p) => [p.engine, p.expiresAt - base]))
    expect(expiry()).toEqual({ searxng: 30 * DAY, tavily: 30 * DAY, mojeek: HOUR }) // exa: 0 h TTL stores nothing
    t.advance(HOUR + 1)
    expect(Object.keys(expiry()).sort()).toEqual(['searxng', 'tavily']) // the mojeek payload has expired
  })

  it('stores at most one payload per engine, and clips oversized text', async () => {
    const store = await open(tempDir(), clock())
    store.recordSearch(
      searchInput({
        queryRedacted: 'q'.repeat(5000),
        results: [
          recorded('https://example.com/a', {
            hits: [
              {
                engine: 'searxng',
                url: 'https://example.com/a',
                title: 'T'.repeat(900),
                snippet: 'S'.repeat(5000),
              },
              { engine: 'searxng', url: 'https://example.com/a2', title: 'second', snippet: 'second' },
            ],
          }),
        ],
      }),
    )
    expect(store.getSearch(1)?.queryRedacted).toHaveLength(2000)
    const payloads = store.listResults(1)[0]?.payloads ?? []
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.title).toHaveLength(500)
    expect(payloads[0]?.snippet).toHaveLength(2000)
  })

  it('rolls the whole search back when any row fails, and reports a skipped warning', async () => {
    const dir = tempDir()
    const store = await open(dir, clock())
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    raw.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON results WHEN NEW.rule_id = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    )
    const rule = { ruleId: 'boom', tier: 'T2' as const, text: 'x' }
    const outcome = store.recordSearch(
      searchInput({
        results: [
          recorded('https://example.com/ok'),
          recorded(
            'https://example.com/bad',
            {},
            {
              decision: {
                visibility: 'kept',
                visibilityRule: rule,
                weight: { factor: 1 },
                preferFactor: 1,
                matches: [rule],
              },
            },
          ),
        ],
      }),
    )
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'error' })
    expect(outcome.status === 'skipped' && outcome.warning).toMatchObject({ code: 'logging_unavailable' })
    for (const table of ['searches', 'results', 'result_payloads', 'receipts', 'daily_stats']) {
      expect(raw.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n, table).toBe(0)
    }
    raw.close()
    // The store is still usable afterwards.
    expect(store.recordSearch(searchInput()).status).toBe('recorded')
  })

  it('uses createdAt when given, else the injected clock', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    store.recordSearch(searchInput({ createdAt: 12345 }))
    store.recordSearch(searchInput())
    expect(store.getSearch(1)?.createdAt).toBe(12345)
    expect(store.getSearch(2)?.createdAt).toBe(t())
  })
})

describe('openStore edge cases', () => {
  it('works fully in memory (no files, no backups)', async () => {
    const store = await open(':memory:', clock())
    expect(store.status()).toMatchObject({ mode: 'read-write', dbPath: ':memory:' })
    expect(store.recordSearch(searchInput())).toEqual({ status: 'recorded', searchId: 1 })
    expect(store.listResults(1)).toHaveLength(1)
    expect(store.engineUsage.reserve('brave', 'fp', { day: 1 }).ok).toBe(true)
  })

  it('rejects a malformed appVersion', async () => {
    await expect(
      openStore({ dataDir: ':memory:', appVersion: 'latest', now: clock() }),
    ).rejects.toMatchObject({
      code: 'invalid_argument',
    })
  })

  it('refuses a file that is not a database with store_unavailable', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'searchhole.db'), 'this is definitely not a sqlite database file '.repeat(20))
    await expect(openStore({ dataDir: dir, appVersion: '0.1.0', now: clock() })).rejects.toMatchObject({
      code: 'store_unavailable',
    })
  })

  it('a meta table in a layout this binary does not know means "newer": no history, no throw', async () => {
    const dir = tempDir()
    const first = await open(dir, clock())
    first.close()
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 1000 })
    raw.exec('ALTER TABLE meta RENAME COLUMN min_reader_version TO min_reader_semver')
    raw.close()
    const store = await open(dir, clock())
    expect(store.status()).toMatchObject({ mode: 'no-history', reason: 'reader_too_old' })
    expect(store.recordSearch(searchInput())).toMatchObject({ status: 'skipped', reason: 'no-history' })
  })
})

describe('the live tail', () => {
  it('lists searches after a cursor in id order and clamps the limit', async () => {
    const store = await open(tempDir(), clock())
    for (let i = 0; i < 5; i++) store.recordSearch(searchInput({ receiptId: `r${i}` }))
    expect(store.listSearchesAfter(0, 2).map((s) => s.id)).toEqual([1, 2])
    expect(store.listSearchesAfter(2, 100).map((s) => s.id)).toEqual([3, 4, 5])
    expect(store.listSearchesAfter(5, 10)).toEqual([])
    expect(store.listSearchesAfter(0, 0)).toHaveLength(1) // clamped to >= 1
    expect(store.listSearchesAfter(0, Number.NaN)).toHaveLength(1)
    expect(store.listSearchesAfter(0, 10_000)).toHaveLength(5)
    expect(store.tailState()).toEqual({ maxId: 5, epoch: 0 })
  })

  it('never reuses ids after deletes (AUTOINCREMENT) and bumps the epoch so tailers can reset', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    for (let i = 0; i < 3; i++) store.recordSearch(searchInput())
    const report = store.retention.prune(t() + 1000, { days: 0 })
    expect(report.deleted.searches).toBe(3)
    expect(report.epoch).toBe(1)
    expect(store.tailState()).toEqual({ maxId: 0, epoch: 1 }) // a cursor of 3 is now above max: reset
    expect(store.recordSearch(searchInput())).toEqual({ status: 'recorded', searchId: 4 })
  })
})

describe('in-memory retry queue (ADR-0003 point 4)', () => {
  async function busyStore() {
    const dir = tempDir()
    const t = clock()
    const warnings: Warning[] = []
    const store = await open(dir, t, {
      busyTimeoutMs: 10,
      retryIntervalMs: 20,
      onWarning: (w) => warnings.push(w),
    })
    const blocker = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 10 })
    return { dir, t, store, blocker, warnings }
  }

  it('parks a busy write, answers immediately, and writes it once the lock is free', async () => {
    const { store, blocker } = await busyStore()
    blocker.exec('BEGIN IMMEDIATE')
    const t0 = performance.now()
    expect(store.recordSearch(searchInput({ receiptId: 'parked' }))).toEqual({ status: 'queued' })
    expect(performance.now() - t0).toBeLessThan(1000) // bounded by busy_timeout, never the 5 s CLI value
    expect(store.stats()).toMatchObject({ queued: 1, pending: 1, recorded: 0, dropped: 0 })
    expect(store.flushRetries()).toEqual({ written: 0, dropped: 0, remaining: 1 }) // still locked
    blocker.exec('ROLLBACK')
    expect(store.flushRetries()).toEqual({ written: 1, dropped: 0, remaining: 0 })
    expect(store.stats()).toMatchObject({ recorded: 1, pending: 0 })
    expect(store.getSearch(1)?.receiptId).toBe('parked')
    blocker.close()
  })

  it('flushes on a jittered timer without being asked', async () => {
    const { store, blocker } = await busyStore()
    blocker.exec('BEGIN IMMEDIATE')
    store.recordSearch(searchInput())
    blocker.exec('ROLLBACK')
    await new Promise((r) => setTimeout(r, 300))
    expect(store.stats()).toMatchObject({ recorded: 1, pending: 0 })
    blocker.close()
  })

  it('drops the write after 10 s with a counted warning', async () => {
    const { store, blocker, t, warnings } = await busyStore()
    blocker.exec('BEGIN IMMEDIATE')
    store.recordSearch(searchInput())
    t.advance(9_000)
    expect(store.flushRetries()).toMatchObject({ dropped: 0, remaining: 1 })
    t.advance(1_001)
    expect(store.flushRetries()).toEqual({ written: 0, dropped: 1, remaining: 0 })
    expect(store.stats()).toMatchObject({ dropped: 1, pending: 0, recorded: 0 })
    expect(warnings).toEqual([{ code: 'logging_unavailable', detail: expect.stringContaining('dropped 1') }])
    blocker.exec('ROLLBACK')
    expect(store.listSearchesAfter(0, 10)).toEqual([])
    blocker.close()
  })

  it('preserves the original createdAt when a parked search is finally written', async () => {
    const { store, blocker, t } = await busyStore()
    blocker.exec('BEGIN IMMEDIATE')
    const first = t()
    store.recordSearch(searchInput())
    t.advance(3000)
    blocker.exec('ROLLBACK')
    store.flushRetries()
    expect(store.getSearch(1)?.createdAt).toBe(first)
    blocker.close()
  })

  it('close() makes one last attempt and counts what it still cannot write', async () => {
    const { store, blocker, warnings } = await busyStore()
    blocker.exec('BEGIN IMMEDIATE')
    store.recordSearch(searchInput())
    store.close()
    expect(store.stats()).toMatchObject({ dropped: 1, pending: 0 })
    expect(warnings.some((w) => w.code === 'logging_unavailable')).toBe(true)
    expect(store.recordSearch(searchInput())).toMatchObject({ status: 'skipped', reason: 'closed' })
    blocker.exec('ROLLBACK')
    blocker.close()
  })
})
