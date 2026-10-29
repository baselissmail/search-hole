// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const WORKER = join(import.meta.dirname, 'worker.mjs')

export interface WorkerOutput {
  pid: number
  status: {
    mode: string
    reason: string
    migration: string
    schemaVersion?: number
    [key: string]: unknown
  }
  stats?: { recorded: number; queued: number; dropped: number; skipped: number; pending: number }
  p95?: number
  granted?: number
  denied?: number
}

export interface WorkerOptions {
  count?: number
  /** Random pause (up to this many ms) between writes, to model a human-driven rate. */
  thinkMs?: number
  cap?: number
  appVersion?: string
  busyTimeoutMs?: number
  migrations?: 'V1' | 'V2' | 'V3' | 'V4'
  migrationWaitMs?: number
}

/** Runs one worker script with process.execPath and parses its single JSON output line. */
function runWorker(
  mode: string,
  dataDir: string,
  startAt: number,
  options: WorkerOptions,
): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, mode, dataDir, String(startAt), JSON.stringify(options)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${err}`))
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() ?? '') as WorkerOutput)
      } catch (e) {
        reject(new Error(`bad worker output: ${out} ${err}`, { cause: e }))
      }
    })
  })
}

/**
 * Starts `n` workers that all begin their work at the same instant (`lead` ms from now, which
 * covers the Node start-up time) and resolves with every worker's output.
 */
export function runWorkers(
  n: number,
  mode: 'open' | 'record' | 'reserve',
  dataDir: string,
  options: WorkerOptions = {},
  lead = 1500,
): Promise<WorkerOutput[]> {
  const startAt = Date.now() + lead
  return Promise.all(Array.from({ length: n }, () => runWorker(mode, dataDir, startAt, options)))
}
