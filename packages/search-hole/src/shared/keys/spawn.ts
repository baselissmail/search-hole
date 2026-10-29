// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { atomicWriteFile, ensureDir } from '../paths.ts'
import type { CommandResult, KeyFs, RunCommand } from './types.ts'

const MAX_OUTPUT = 64 * 1024

/**
 * Runs a command with `child_process.spawn` (no shell), writes `opts.stdin` and closes it,
 * and collects up to 64 KiB of output. Never throws: failures are in `error`. Neither the
 * arguments nor stdin are ever logged or included in an error.
 */
export const nodeRunCommand: RunCommand = (cmd, args, opts = {}) =>
  new Promise<CommandResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (result: Omit<CommandResult, 'stdout' | 'stderr'>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }

    let child: ReturnType<typeof spawn>
    const timer = setTimeout(() => {
      timedOut = true
      child?.kill('SIGKILL')
    }, opts.timeoutMs ?? 10_000)

    try {
      child = spawn(cmd, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
        windowsHide: true,
      })
    } catch (e) {
      finish({ code: null, error: e instanceof Error && 'code' in e ? String(e.code) : 'spawn_failed' })
      return
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8')
    })
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, error: e.code ?? 'spawn_failed' }))
    child.on('close', (code) => finish(timedOut ? { code: null, error: 'timeout' } : { code }))
    child.stdin?.on('error', () => {
      // EPIPE when the child exits before reading stdin; the exit code tells the story.
    })
    child.stdin?.end(opts.stdin ?? '')
  })

/** Real file-system operations for key backends. */
export const nodeKeyFs: KeyFs = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, text) => atomicWriteFile(path, text, { mode: 0o600 }),
  remove: (path) => {
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  },
  ensureDir,
}
