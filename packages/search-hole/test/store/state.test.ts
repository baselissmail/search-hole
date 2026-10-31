// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import { openDb } from '../../src/store/driver.ts'
import type { AcquireResult, EngineHealthWrite, JobOwner, Lease } from '../../src/store/index.ts'
import { SHARED_KEY_FP } from '../../src/store/index.ts'
import { LATEST_SCHEMA_VERSION as L } from '../../src/store/migrations/index.ts'
import { clock, open, recorded, searchInput, tempDir } from './helpers.ts'

const DAY = 24 * 3_600_000

const health = (over: Partial<EngineHealthWrite> = {}): EngineHealthWrite => ({
  engine: 'brave',
  keyFp: 'a1b2c3d4e5f60718',
  subEngine: '',
  state: 'healthy',
  reasonClass: null,
  until: null,
  consecutiveFailures: 0,
  ewmaSuccess: 0.98,
  p50Ms: 210,
  p95Ms: 640,
  lastSuccessAt: 1_000,
  lastErrorRedacted: null,
  keyPresent: true,
  keySource: 'env',
  ...over,
})

describe('engineHealth (ADR-0009 point 4)', () => {
  it('stores one row per (engine, key_fp, sub_engine) and stamps updatedAt from the clock', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    expect(store.engineHealth.get('brave', 'fp1')).toBeUndefined()
    expect(store.engineHealth.put(health({ keyFp: 'fp1' }))).toBe(true)
    expect(store.engineHealth.get('brave', 'fp1')).toEqual({ ...health({ keyFp: 'fp1' }), updatedAt: t() })
    t.advance(5000)
    store.engineHealth.put(
      health({
        keyFp: 'fp1',
        state: 'unhealthy',
        reasonClass: 'rate_limited',
        until: t() + 180_000,
        consecutiveFailures: 2,
      }),
    )
    expect(store.engineHealth.get('brave', 'fp1')).toMatchObject({
      state: 'unhealthy',
      reasonClass: 'rate_limited',
      consecutiveFailures: 2,
      updatedAt: t(),
    })
    expect(store.engineHealth.list('brave')).toHaveLength(1) // an upsert, not an insert
  })

  it('keeps gateways with different keys apart, and key-independent state shared', async () => {
    const store = await open(tempDir(), clock())
    store.engineHealth.put(health({ keyFp: 'fpA', state: 'unhealthy', reasonClass: 'auth' }))
    store.engineHealth.put(health({ keyFp: 'fpB', state: 'healthy' }))
    store.engineHealth.put(health({ keyFp: SHARED_KEY_FP, state: 'unhealthy', reasonClass: 'timeout' }))
    expect(store.engineHealth.get('brave', 'fpA')?.reasonClass).toBe('auth')
    expect(store.engineHealth.get('brave', 'fpB')?.state).toBe('healthy')
    expect(store.engineHealth.get('brave', SHARED_KEY_FP)?.reasonClass).toBe('timeout')
    expect(store.engineHealth.list('brave').map((r) => r.keyFp)).toEqual([SHARED_KEY_FP, 'fpA', 'fpB'])
  })

  it('keeps SearXNG upstream problems as sub_engine rows', async () => {
    const store = await open(tempDir(), clock())
    store.engineHealth.put(health({ engine: 'searxng', keyFp: SHARED_KEY_FP, subEngine: '' }))
    store.engineHealth.put(
      health({
        engine: 'searxng',
        keyFp: SHARED_KEY_FP,
        subEngine: 'google',
        state: 'unhealthy',
        reasonClass: 'captcha',
      }),
    )
    expect(store.engineHealth.get('searxng', SHARED_KEY_FP)?.state).toBe('healthy')
    expect(store.engineHealth.get('searxng', SHARED_KEY_FP, 'google')).toMatchObject({
      reasonClass: 'captcha',
    })
    expect(store.engineHealth.list().map((r) => r.subEngine)).toEqual(['', 'google'])
  })

  it('redacted errors are clipped to 200 characters and unknown states read as unknown', async () => {
    const dir = tempDir()
    const store = await open(dir, clock())
    store.engineHealth.put(health({ lastErrorRedacted: 'x'.repeat(500) }))
    expect(store.engineHealth.get('brave', health().keyFp)?.lastErrorRedacted).toHaveLength(200)
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    raw.exec("UPDATE engine_health SET state = 'from-the-future'")
    raw.close()
    expect(store.engineHealth.get('brave', health().keyFp)?.state).toBe('unknown')
  })
})

describe('engineUsage (ADR-0009 point 6)', () => {
  it('reserves against day and month caps and then refuses', async () => {
    const store = await open(tempDir(), clock())
    const caps = { day: 3, month: 10 }
    for (let i = 1; i <= 3; i++) {
      expect(store.engineUsage.reserve('brave', 'fp', caps)).toMatchObject({
        ok: true,
        counts: { day: i, month: i },
      })
    }
    expect(store.engineUsage.reserve('brave', 'fp', caps)).toEqual({
      ok: false,
      reason: 'day_cap',
      counts: { day: 3, month: 3 },
    })
    expect(store.engineUsage.counts('brave', 'fp')).toEqual({ day: 3, month: 3 }) // a refusal reserves nothing
  })

  it('applies the month cap across days, and a day rollover resets only the day counter', async () => {
    const t = clock(Date.UTC(2026, 9, 30, 23, 59, 0))
    const store = await open(tempDir(), t)
    const caps = { day: 2, month: 3 }
    expect(store.engineUsage.reserve('brave', 'fp', caps).ok).toBe(true)
    expect(store.engineUsage.reserve('brave', 'fp', caps).ok).toBe(true)
    expect(store.engineUsage.reserve('brave', 'fp', caps)).toMatchObject({ ok: false, reason: 'day_cap' })
    t.advance(2 * 60_000) // 00:01 on Oct 31 (UTC)
    expect(store.engineUsage.counts('brave', 'fp')).toEqual({ day: 0, month: 2 })
    expect(store.engineUsage.reserve('brave', 'fp', caps)).toMatchObject({
      ok: true,
      counts: { day: 1, month: 3 },
    })
    expect(store.engineUsage.reserve('brave', 'fp', caps)).toMatchObject({ ok: false, reason: 'month_cap' })
    t.advance(DAY) // November 1
    expect(store.engineUsage.reserve('brave', 'fp', caps)).toMatchObject({
      ok: true,
      counts: { day: 1, month: 1 },
    })
  })

  it('takes an explicit now, and keeps keys and engines apart', async () => {
    const store = await open(tempDir(), clock())
    const caps = { day: 1 }
    expect(store.engineUsage.reserve('brave', 'fpA', caps).ok).toBe(true)
    expect(store.engineUsage.reserve('brave', 'fpA', caps).ok).toBe(false)
    expect(store.engineUsage.reserve('brave', 'fpB', caps).ok).toBe(true)
    expect(store.engineUsage.reserve('tavily', 'fpA', caps).ok).toBe(true)
    const tomorrow = Date.UTC(2026, 9, 31, 1, 0, 0)
    expect(store.engineUsage.reserve('brave', 'fpA', caps, tomorrow).ok).toBe(true)
  })

  it('counts without a cap, and a cap of 0 refuses everything', async () => {
    const store = await open(tempDir(), clock())
    expect(store.engineUsage.reserve('exa', 'fp', {})).toMatchObject({
      ok: true,
      counts: { day: 1, month: 1 },
    })
    expect(store.engineUsage.reserve('exa', 'fp', { day: null })).toMatchObject({
      ok: true,
      counts: { day: 2 },
    })
    expect(store.engineUsage.reserve('exa', 'fp', { day: 0 })).toMatchObject({ ok: false, reason: 'day_cap' })
  })

  it('refunds the buckets that were charged, even after midnight, and never below zero', async () => {
    const t = clock(Date.UTC(2026, 9, 30, 23, 59, 59))
    const store = await open(tempDir(), t)
    const r = store.engineUsage.reserve('brave', 'fp', { day: 5 })
    if (!r.ok) throw new Error('reservation failed')
    t.advance(5000) // now the next day
    expect(store.engineUsage.refund(r.reservation)).toBe(true)
    expect(store.engineUsage.refund(r.reservation)).toBe(true)
    expect(store.engineUsage.counts('brave', 'fp', t() - 5000)).toEqual({ day: 0, month: 0 })
  })
})

describe('jobs: leases with fencing and version gating (ADR-0006 point 7)', () => {
  const A: JobOwner = { gatewayId: 'gw-A', version: '0.1.0' }
  const B: JobOwner = { gatewayId: 'gw-B', version: '0.1.0' }
  const need = (r: AcquireResult): Lease => {
    if (!r.acquired) throw new Error(`not acquired: ${r.reason}`)
    return r.lease
  }

  it('grants one owner at a time, increments the epoch on every acquire, and takes over after expiry', async () => {
    const t = clock()
    const jobs = (await open(tempDir(), t)).jobs
    const a = need(jobs.acquire('retention', A, 30_000))
    expect(a).toMatchObject({ name: 'retention', epoch: 1, until: t() + 30_000 })
    expect(jobs.acquire('retention', B, 30_000)).toEqual({
      acquired: false,
      reason: 'held',
      heldBy: 'gw-A',
      until: t() + 30_000,
    })
    t.advance(30_000) // lease_until <= now: expired
    const b = need(jobs.acquire('retention', B, 30_000))
    expect(b.epoch).toBe(2)
    expect(jobs.get('retention')).toMatchObject({ ownerGatewayId: 'gw-B', leaseEpoch: 2, status: 'running' })
  })

  it('reports who it took the lease from', async () => {
    const t = clock()
    const jobs = (await open(tempDir(), t)).jobs
    jobs.acquire('j', A, 1000)
    t.advance(1000)
    expect(jobs.acquire('j', B, 1000)).toMatchObject({ acquired: true, tookOverFrom: 'gw-A' })
  })

  it('fences a stalled former owner: renew, update, release and fenced writes all abort', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    const jobs = store.jobs
    const stale = need(jobs.acquire('list-refresh', A, 30_000))
    t.advance(31_000)
    const fresh = need(jobs.acquire('list-refresh', B, 30_000))
    expect(fresh.epoch).toBe(stale.epoch + 1)

    expect(jobs.renew(stale, 30_000)).toEqual({ ok: false, reason: 'lease_lost' })
    expect(jobs.update(stale, { status: 'failed', lastError: 'clobbered' })).toEqual({
      ok: false,
      reason: 'lease_lost',
    })
    expect(jobs.release(stale, { status: 'idle' })).toEqual({ ok: false, reason: 'lease_lost' })
    let ran = false
    const fenced = jobs.fenced(stale, (db) => {
      ran = true
      db.exec("INSERT INTO meta_kv (key, value, updated_at) VALUES ('stale-write', 'x', 1)")
    })
    expect(fenced).toEqual({ ok: false, reason: 'lease_lost' })
    expect(ran).toBe(false)
    expect(store.meta.get('stale-write')).toBeUndefined()
    // The new owner is untouched.
    expect(jobs.get('list-refresh')).toMatchObject({
      ownerGatewayId: 'gw-B',
      leaseEpoch: fresh.epoch,
      status: 'running',
      lastError: null,
    })
    expect(jobs.renew(fresh, 30_000).ok).toBe(true)
  })

  it('lets the current owner write through fenced(), and rolls the whole transaction back if it throws', async () => {
    const store = await open(tempDir(), clock())
    const lease = need(store.jobs.acquire('compile:abp:3', A, 30_000))
    expect(
      store.jobs.fenced(
        lease,
        (db) => db.prepare("INSERT INTO meta_kv (key, value, updated_at) VALUES ('k', 'v', 1)").run().changes,
      ),
    ).toEqual({ ok: true, value: 1 })
    expect(store.meta.get('k')).toBe('v')
    expect(() =>
      store.jobs.fenced(lease, (db) => {
        db.exec("INSERT INTO meta_kv (key, value, updated_at) VALUES ('k2', 'v', 1)")
        throw new Error('job failed')
      }),
    ).toThrow('job failed')
    expect(store.meta.get('k2')).toBeUndefined()
  })

  it('renews (heartbeat), updates progress, and releases while keeping the epoch', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    const jobs = store.jobs
    const lease = need(jobs.acquire('vacuum', A, 30_000))
    t.advance(10_000)
    const renewed = jobs.renew(lease, 30_000)
    expect(renewed).toMatchObject({ ok: true, lease: { until: t() + 30_000, epoch: 1 } })
    expect(jobs.get('vacuum')).toMatchObject({ leaseUntil: t() + 30_000, heartbeatAt: t() })
    expect(jobs.update(lease, { progress: { done: 3, of: 10 } }).ok).toBe(true)
    expect(jobs.update(lease, { lastError: 'oops' }).ok).toBe(true)
    expect(jobs.get('vacuum')).toMatchObject({
      progress: { done: 3, of: 10 },
      lastError: 'oops',
      status: 'running',
    })
    expect(jobs.release(lease, { status: 'idle', lastError: null }).ok).toBe(true)
    expect(jobs.get('vacuum')).toMatchObject({
      ownerGatewayId: null,
      status: 'idle',
      lastError: null,
      leaseEpoch: 1,
      progress: { done: 3, of: 10 },
    })
    // Free immediately; the next acquire increments the epoch.
    expect(need(jobs.acquire('vacuum', B, 30_000)).epoch).toBe(2)
    expect(jobs.list().map((j) => j.name)).toEqual(['vacuum'])
  })

  it('refuses owners older than the version that last migrated (version gating)', async () => {
    const dir = tempDir()
    const t = clock()
    const store = await open(dir, t, { appVersion: '0.2.0' })
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    raw.exec("UPDATE meta SET last_migrated_by = '0.2.0'")
    raw.close()
    expect(store.jobs.acquire('j', { gatewayId: 'old', version: '0.1.9' }, 1000)).toEqual({
      acquired: false,
      reason: 'version_too_old',
    })
    const lease = need(store.jobs.acquire('j', { gatewayId: 'ok', version: '0.2.0' }, 30_000))
    const raw2 = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    raw2.exec("UPDATE meta SET last_migrated_by = '0.3.0'") // a newer binary migrates meanwhile
    raw2.close()
    expect(store.jobs.renew(lease, 30_000)).toEqual({ ok: false, reason: 'version_too_old' })
  })

  it('lets a higher version take over an older owner even before its lease expires', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    const old = need(store.jobs.acquire('j', { gatewayId: 'old', version: '0.1.0' }, 30_000))
    // Same version is refused, a lower one too.
    expect(store.jobs.acquire('j', { gatewayId: 'same', version: '0.1.0' }, 1000)).toMatchObject({
      acquired: false,
      reason: 'held',
    })
    const newer = store.jobs.acquire('j', { gatewayId: 'new', version: '0.2.0' }, 30_000)
    expect(newer).toMatchObject({ acquired: true, tookOverFrom: 'old' })
    expect(store.jobs.renew(old, 30_000)).toEqual({ ok: false, reason: 'lease_lost' })
    expect(store.jobs.acquire('j', { gatewayId: 'old2', version: '0.1.0' }, 1000)).toMatchObject({
      acquired: false,
      reason: 'held',
      heldBy: 'new',
    })
  })

  it('lets the same owner re-acquire, which invalidates its previous lease object', async () => {
    const store = await open(tempDir(), clock())
    const first = need(store.jobs.acquire('j', A, 30_000))
    const second = need(store.jobs.acquire('j', A, 30_000))
    expect(second.epoch).toBe(first.epoch + 1)
    expect(store.jobs.renew(first, 30_000)).toEqual({ ok: false, reason: 'lease_lost' })
  })
})

describe('meta', () => {
  it('stores generic values and returns a race-safe getOrInit', async () => {
    const dir = tempDir()
    const t = clock()
    const a = await open(dir, t)
    const b = await open(dir, t)
    expect(a.meta.get('install_secret')).toBeUndefined()
    expect(a.meta.getOrInit('install_secret', () => 'first')).toBe('first')
    expect(b.meta.getOrInit('install_secret', () => 'second')).toBe('first')
    expect(a.meta.set('install_secret', 'rotated')).toBe(true)
    expect(b.meta.get('install_secret')).toBe('rotated')
  })

  it('exposes the protocol row and the data epoch', async () => {
    const store = await open(tempDir(), clock())
    expect(store.meta.snapshot()).toEqual({
      schemaVersion: L,
      minReaderVersion: '0.0.0',
      minWriterVersion: '0.0.0',
      lastMigratedBy: '0.1.0',
      dataEpoch: 0,
    })
    expect(store.dataEpoch()).toBe(0)
    expect(store.bumpDataEpoch()).toBe(1)
    expect(store.bumpDataEpoch()).toBe(2)
    expect(store.dataEpoch()).toBe(2)
    expect(store.meta.snapshot()?.dataEpoch).toBe(2)
  })
})

describe('retention.prune (ADR-0015 point 3)', () => {
  type TestStore = Awaited<ReturnType<typeof open>>

  /** Records `n` one-result searches `ageDays` old; the result has a full-retention payload. */
  function seed(store: TestStore, now: number, ageDays: number, n: number, tag: string): void {
    for (let i = 0; i < n; i++) {
      store.recordSearch(
        searchInput({
          receiptId: `${tag}-${i}`,
          createdAt: now - ageDays * DAY,
          results: [recorded(`https://example.com/${tag}/${i}`)],
        }),
      )
    }
  }

  const count = async (dir: string, table: string): Promise<number> => {
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    try {
      return raw.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1
    } finally {
      raw.close()
    }
  }

  it('deletes rows older than retention.days with their results, payloads and receipts, and bumps the epoch', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    seed(store, t(), 100, 3, 'old')
    seed(store, t(), 10, 2, 'new')
    const report = store.retention.prune(t(), { days: 90 })
    expect(report.deleted).toMatchObject({
      result_payloads: 3,
      results: 3,
      searches: 3,
      receipts: 3,
      daily_stats: 0,
    })
    expect(report).toMatchObject({ totalDeleted: 12, epoch: 1 })
    expect(report.skipped).toBeUndefined()
    expect(report.interrupted).toBeUndefined()
    expect(store.dataEpoch()).toBe(1)
    expect(store.listSearchesAfter(0, 10).map((s) => s.receiptId)).toEqual(['new-0', 'new-1'])
    expect(store.listResults(4)).toHaveLength(1)
    expect(store.listResults(4)[0]?.payloads).toHaveLength(1)
    expect(await count(dir, 'results')).toBe(2)
    expect(await count(dir, 'result_payloads')).toBe(2)
    expect(await count(dir, 'receipts')).toBe(2)
  })

  it('does not bump the epoch when nothing was deleted', async () => {
    const t = clock()
    const store = await open(tempDir(), t)
    seed(store, t(), 1, 2, 'fresh')
    const report = store.retention.prune(t(), { days: 90 })
    expect(report).toMatchObject({ totalDeleted: 0 })
    expect(report.epoch).toBeUndefined()
    expect(store.dataEpoch()).toBe(0)
  })

  it('deletes in batches of batchSize, each batch its own transaction', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    seed(store, t(), 100, 5, 'old')
    const report = store.retention.prune(t(), { days: 90, batchSize: 2 })
    expect(report.deleted).toMatchObject({ result_payloads: 5, results: 5, searches: 5, receipts: 5 })
    expect(report.batches).toBeGreaterThanOrEqual(3 * 4) // 2+2+1 rows plus a closing batch, for several tables
    expect(await count(dir, 'searches')).toBe(0)
    expect(report.epoch).toBe(1) // one bump per prune, not per batch
  })

  it('expires payloads on their own schedule and keeps the decisions', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    store.recordSearch(
      searchInput({
        results: [
          recorded(
            'https://example.com/m',
            { hits: [{ engine: 'mojeek', url: 'https://example.com/m', title: 'T', snippet: 'S' }] },
            { engines: ['mojeek'], positions: { mojeek: 1 } },
          ),
        ],
      }),
    )
    t.advance(2 * 3_600_000)
    const report = store.retention.prune(t(), { days: 90 })
    expect(report.deleted).toMatchObject({ result_payloads: 1, results: 0, searches: 0 })
    const [result] = store.listResults(1)
    expect(result).toMatchObject({ decision: 'kept', canonicalKey: 'example.com/m', payloads: [] })
  })

  it('rolls daily_stats off after 400 days and keeps engine_usage for the current and previous period only', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    seed(store, t(), 500, 1, 'ancient')
    seed(store, t(), 5, 1, 'recent')
    const before = await count(dir, 'daily_stats')
    expect(before).toBe(4)
    const now = t()
    const at = (daysAgo: number): number => now - daysAgo * DAY
    for (const d of [3, 1, 0, 70, 40, 0]) store.engineUsage.reserve('brave', 'fp', {}, at(d))
    const report = store.retention.prune(now, { days: 36_500 }) // keep searches; test the rollups
    expect(report.deleted).toMatchObject({ daily_stats: 2, searches: 0 })
    expect(await count(dir, 'daily_stats')).toBe(2)
    // day rows older than yesterday and month rows older than last month are gone
    expect(store.engineUsage.counts('brave', 'fp', at(3)).day).toBe(0)
    expect(store.engineUsage.counts('brave', 'fp', at(1)).day).toBe(1)
    expect(store.engineUsage.counts('brave', 'fp', now)).toEqual({ day: 2, month: 4 })
    expect(store.engineUsage.counts('brave', 'fp', at(70)).month).toBe(0)
  })

  it('drops resolved suggestions after 30 days, stale gateways after 7 and old sessions with the searches', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    const now = t()
    const raw = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 100 })
    const sug = raw.prepare(
      "INSERT INTO suggestions (status, rule_json, created_at, resolved_at) VALUES (?, '{}', ?, ?)",
    )
    sug.run(['pending', now - 100 * DAY, null])
    sug.run(['approved', now - 100 * DAY, now - 40 * DAY])
    sug.run(['rejected', now - 100 * DAY, now - 5 * DAY])
    const gw = raw.prepare(
      "INSERT INTO gateways (id, pid, host_profile, app_version, started_at, last_seen_at) VALUES (?, 1, 'claude-code', '0.1.0', 0, ?)",
    )
    gw.run(['stale', now - 8 * DAY])
    gw.run(['live', now - 1 * DAY])
    const ses = raw.prepare(
      "INSERT INTO sessions (id, host_profile, key_source, started_at, last_seen_at) VALUES (?, 'claude-code', 'hook', 0, ?)",
    )
    ses.run(['old', now - 91 * DAY])
    ses.run(['young', now - 1 * DAY])
    raw.close()
    const report = store.retention.prune(now, { days: 90 })
    expect(report.deleted).toMatchObject({ suggestions: 1, gateways: 1, sessions: 1 })
    expect(await count(dir, 'suggestions')).toBe(2)
    expect(await count(dir, 'gateways')).toBe(1)
    expect(await count(dir, 'sessions')).toBe(1)
  })

  it("'delete all data' is the same job with days: 0", async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t)
    seed(store, t(), 0, 4, 'now')
    const report = store.retention.prune(t(), { days: 0, dailyStatsDays: 0 })
    expect(report.deleted).toMatchObject({
      searches: 4,
      results: 4,
      result_payloads: 4,
      receipts: 4,
      daily_stats: 2,
    })
    for (const table of ['searches', 'results', 'result_payloads', 'receipts', 'daily_stats']) {
      expect(await count(dir, table), table).toBe(0)
    }
    expect(report.epoch).toBe(1)
  })

  it('stops with interrupted: busy when another process holds the write lock', async () => {
    const t = clock()
    const dir = tempDir()
    const store = await open(dir, t, { busyTimeoutMs: 10 })
    seed(store, t(), 100, 2, 'old')
    const blocker = await openDb({ path: `${dir}/searchhole.db`, busyTimeoutMs: 10 })
    blocker.exec('BEGIN IMMEDIATE')
    const report = store.retention.prune(t(), { days: 90 })
    expect(report).toMatchObject({ interrupted: 'busy', totalDeleted: 0 })
    expect(report.epoch).toBeUndefined()
    blocker.exec('ROLLBACK')
    blocker.close()
    expect(store.retention.prune(t(), { days: 90 })).toMatchObject({ totalDeleted: 8 }) // 2 each of payloads, results, searches, receipts
  })
})

describe('maintenance', () => {
  it('runs checkpoint, incremental vacuum and optimize without error, and not after close', async () => {
    const store = await open(tempDir(), clock())
    store.recordSearch(searchInput())
    expect(() => {
      store.maintenance.checkpoint('PASSIVE')
      store.maintenance.checkpoint('TRUNCATE')
      store.maintenance.incrementalVacuum(10)
      store.maintenance.optimize()
    }).not.toThrow()
    expect(() => store.maintenance.checkpoint('BOGUS' as never)).toThrow(TypeError)
    expect(() => store.maintenance.incrementalVacuum(Number.NaN)).toThrow(TypeError)
    store.close()
    expect(() => store.maintenance.optimize()).not.toThrow()
  })
})
