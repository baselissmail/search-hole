// SPDX-License-Identifier: Apache-2.0
// Child-process worker for the multi-process store tests. Run with process.execPath:
//   node worker.mjs <mode> <dataDir> <startAt> <options-json>
// It waits until `startAt` (epoch ms) so all workers start together, does its job and prints
// one JSON line to stdout. Node strips the types of the imported .ts files.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, dataDir, startAtArg, optionsJson] = process.argv.slice(2)
const options = JSON.parse(optionsJson ?? '{}')
const src = join(import.meta.dirname, '..', '..', 'src', 'store')
const { openStore } = await import(pathToFileURL(join(src, 'index.ts')).href)
const migrationLists = await import(pathToFileURL(join(import.meta.dirname, 'migration-fixtures.ts')).href)

const startAt = Number(startAtArg)
const wait = Math.max(0, startAt - Date.now())
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)

const retention = { searxng: { log: 'full', payloadTtlHours: null } }

function input(i) {
  const url = `https://example.com/${process.pid}/${i}`
  return {
    receiptId: `rcpt_${process.pid}`,
    queryRedacted: `query ${i}`,
    profile: 'default',
    depth: 'standard',
    engines: [{ engine: 'searxng', status: 'ok', latencyMs: 5, returned: 3 }],
    latencyMs: 10,
    keptCount: 3,
    hiddenCount: 0,
    retention,
    results: [1, 2, 3].map((rank) => ({
      merged: {
        canonicalKey: `example.com/${process.pid}/${i}/${rank}`,
        url: `${url}/${rank}`,
        urls: [`${url}/${rank}`],
        title: `T ${i}.${rank}`,
        snippet: `S ${i}.${rank}`,
        engines: ['searxng'],
        positions: { searxng: rank },
        dates: [],
        sourceType: 'unknown',
        registrableDomain: 'example.com',
        fused: 1 / rank,
        adjusted: 1 / rank,
        decision: { visibility: 'kept', weight: { factor: 1 }, preferFactor: 1, matches: [] },
        flags: [],
      },
      hits: [
        { engine: 'searxng', url: `${url}/${rank}`, title: `T ${i}.${rank}`, snippet: `S ${i}.${rank}` },
      ],
      visibility: 'kept',
      outRank: rank,
    })),
  }
}

const store = await openStore({
  dataDir,
  appVersion: options.appVersion ?? '0.1.0',
  now: () => Date.now(),
  busyTimeoutMs: options.busyTimeoutMs ?? 100,
  ...(options.migrations ? { migrations: migrationLists[options.migrations] } : {}),
  ...(options.migrationWaitMs ? { migrationWaitMs: options.migrationWaitMs } : {}),
})

const out = { pid: process.pid, status: store.status() }

if (mode === 'record') {
  const latencies = []
  for (let i = 0; i < options.count; i++) {
    const t0 = performance.now()
    store.recordSearch(input(i))
    latencies.push(performance.now() - t0)
    if (options.thinkMs) await new Promise((r) => setTimeout(r, Math.random() * options.thinkMs))
  }
  // Drain the retry queue: BUSY writes are parked, so wait until they are written or dropped.
  const deadline = Date.now() + 15000
  while (store.stats().pending > 0 && Date.now() < deadline) {
    store.flushRetries()
    await new Promise((r) => setTimeout(r, 20))
  }
  latencies.sort((a, b) => a - b)
  out.stats = store.stats()
  out.p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0
}

if (mode === 'reserve') {
  let granted = 0
  let denied = 0
  for (let i = 0; i < options.count; i++) {
    const r = store.engineUsage.reserve('brave', 'fp1', { day: options.cap })
    if (r.ok) granted++
    else if (r.reason === 'day_cap') denied++
  }
  out.granted = granted
  out.denied = denied
}

store.close()
process.stdout.write(`${JSON.stringify(out)}\n`)
