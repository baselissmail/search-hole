// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import type { EngineId, EngineRetention, MergedResult } from '../../src/shared/types.ts'
import type { RecordedResult, RecordSearchInput, Store } from '../../src/store/index.ts'
import { openStore } from '../../src/store/index.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.()
    } catch {
      // Best effort.
    }
  }
})

/** A fresh temp data dir under os.tmpdir(), removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'searchhole-store-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Closes the store after the test. */
export function autoClose<T extends Store>(store: T): T {
  cleanups.push(() => store.close())
  return store
}

export interface Clock {
  (): number
  set(ms: number): void
  advance(ms: number): void
}

/** A manual clock starting at `start` (default 2026-10-30T12:00:00Z). */
export function clock(start = Date.UTC(2026, 9, 30, 12, 0, 0)): Clock {
  let t = start
  const fn = (() => t) as Clock
  fn.set = (ms) => {
    t = ms
  }
  fn.advance = (ms) => {
    t += ms
  }
  return fn
}

export const APP = '0.1.0'

export async function open(
  dataDir: string,
  now: () => number,
  extra: Partial<Parameters<typeof openStore>[0]> = {},
): Promise<Store> {
  return autoClose(await openStore({ dataDir, appVersion: APP, now, ...extra }))
}

export const FULL: EngineRetention = { log: 'full', payloadTtlHours: null }
export const DECISIONS_ONLY: EngineRetention = { log: 'decisions-only', payloadTtlHours: null }
export const RETENTION: Readonly<Partial<Record<EngineId, EngineRetention>>> = {
  searxng: FULL,
  tavily: FULL,
  brave: DECISIONS_ONLY,
  mojeek: { log: 'metadata', payloadTtlHours: 1 },
}

export function mergedResult(url: string, over: Partial<MergedResult> = {}): MergedResult {
  const host = new URL(url).hostname
  return {
    canonicalKey: `${host}${new URL(url).pathname}`,
    url,
    urls: [url],
    title: `Title of ${url}`,
    snippet: `Snippet for ${url}`,
    engines: ['searxng'],
    positions: { searxng: 1 },
    dates: [],
    sourceType: 'unknown',
    registrableDomain: host.replace(/^www\./, ''),
    fused: 0.5,
    adjusted: 0.5,
    decision: { visibility: 'kept', weight: { factor: 1 }, preferFactor: 1, matches: [] },
    flags: [],
    ...over,
  }
}

export function recorded(
  url: string,
  over: Partial<RecordedResult> = {},
  merged: Partial<MergedResult> = {},
): RecordedResult {
  const m = mergedResult(url, merged)
  return {
    merged: m,
    hits: m.engines.map((engine) => ({ engine, url, title: m.title, snippet: m.snippet })),
    visibility: 'kept',
    outRank: 1,
    ...over,
  }
}

export function searchInput(over: Partial<RecordSearchInput> = {}): RecordSearchInput {
  return {
    receiptId: 'rcpt_test',
    queryRedacted: 'how to parse yaml',
    profile: 'default',
    depth: 'standard',
    engines: [{ engine: 'searxng', status: 'ok', latencyMs: 120, returned: 10 }],
    latencyMs: 150,
    keptCount: 1,
    hiddenCount: 0,
    retention: RETENTION,
    results: [recorded('https://example.com/a')],
    ...over,
  }
}

export * from './migration-fixtures.ts'
