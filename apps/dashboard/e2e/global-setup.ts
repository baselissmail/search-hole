// SPDX-License-Identifier: Apache-2.0
// Starts the real `searchhole ui` (the built bundle with dist/ui) on a temporary home.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { E2E_PORT } from './env.ts'

const REPO = resolve(import.meta.dirname, '..', '..', '..')
const BUNDLE = join(REPO, 'packages', 'search-hole', 'dist', 'searchhole.mjs')

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(REPO, 'packages', 'search-hole', 'dist', 'ui', 'index.html'))) {
    throw new Error('Build first: pnpm -C apps/dashboard build && pnpm -C packages/search-hole build')
  }
  const home = mkdtempSync(join(tmpdir(), 'searchhole-e2e-'))
  process.env.E2E_HOME = home
  const env = { ...process.env, SEARCHHOLE_HOME: home, SEARCHHOLE_LOG: 'silent' }
  const seed = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, 'seed.ts')],
    {
      env,
      encoding: 'utf8',
    },
  )
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr}`)
  const server: ChildProcess = spawn(process.execPath, [BUNDLE, 'ui', '--port', String(E2E_PORT), '--stay'], {
    env,
    stdio: 'ignore',
  })
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${E2E_PORT}/health`)
      if (res.ok) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('searchhole ui did not start')
    await new Promise((r) => setTimeout(r, 100))
  }
  return async () => {
    server.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    rmSync(home, { recursive: true, force: true })
  }
}
