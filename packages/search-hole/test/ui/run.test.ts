// SPDX-License-Identifier: Apache-2.0
// `searchhole ui` process lifecycle (ADR-0004 points 2–3): discovery, lock, port, cleanup.
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { App, DashboardApi } from '../../src/app/types.ts'
import { parseCommand } from '../../src/cli/args.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { createLogger } from '../../src/shared/log.ts'
import { findRunningUi, signInUrl, startUi } from '../../src/ui/run.ts'
import { onCleanup, setup } from '../app/helpers.ts'

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

async function start(port: number, run = mkdtempSync(join(tmpdir(), 'searchhole-run-'))) {
  const h = await setup({ host: 'cli' })
  const paths = { uiJson: join(run, 'ui.json'), uiLock: join(run, 'ui.lock') }
  const ui = await startUi({
    app: h.app as App & { dashboard: DashboardApi },
    paths,
    port,
    idleMinutes: 30,
    stay: false,
    version: '0.1.1',
    logger: createLogger({ env: { SEARCHHOLE_LOG: 'silent' } }),
    assetsDir: null,
  })
  onCleanup(() => ui.stop())
  return { ui, paths, run }
}

describe('searchhole ui lifecycle', () => {
  it('writes ui.json 0600, is found by nonce, signs in, and cleans up on stop', async () => {
    const port = await freePort()
    const { ui, paths } = await start(port)
    // POSIX modes only: Windows has ACLs, not mode bits (docs/release.md, Windows).
    if (process.platform !== 'win32') expect(statSync(paths.uiJson).mode & 0o777).toBe(0o600)
    const found = await findRunningUi(paths)
    expect(found?.nonce).toBe(ui.info.nonce)
    const url = await signInUrl(ui.info)
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#c=[A-Za-z0-9_-]{22}$`))
    const code = url.split('#c=')[1]
    const session = await fetch(`http://127.0.0.1:${port}/session`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
    expect(session.status).toBe(200)
    expect(existsSync(paths.uiLock)).toBe(false)
    await ui.stop()
    expect(existsSync(paths.uiJson)).toBe(false)
    await ui.done
  })

  it('a stale ui.json (nobody answering) is removed', async () => {
    const run = mkdtempSync(join(tmpdir(), 'searchhole-run-'))
    const uiJson = join(run, 'ui.json')
    const port = await freePort()
    writeFileSync(
      uiJson,
      JSON.stringify({
        port,
        pid: 1,
        nonce: 'n'.repeat(22),
        version: 'x',
        startedAt: 0,
        loginSecret: 's'.repeat(43),
      }),
    )
    expect(await findRunningUi({ uiJson, uiLock: join(run, 'ui.lock') })).toBeNull()
    expect(existsSync(uiJson)).toBe(false)
  })

  it('a dashboard that is alive but slow to answer keeps its ui.json', async () => {
    const run = mkdtempSync(join(tmpdir(), 'searchhole-run-'))
    const uiJson = join(run, 'ui.json')
    // Accepts connections and never answers, like a dashboard whose event loop is busy.
    const sockets = new Set<import('node:net').Socket>()
    const busy = createServer((socket) => void sockets.add(socket))
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
    onCleanup(() => {
      for (const s of sockets) s.destroy()
      busy.close()
    })
    const addr = busy.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    const info = (pid: number) =>
      JSON.stringify({
        port,
        pid,
        nonce: 'n'.repeat(22),
        version: 'x',
        startedAt: 0,
        loginSecret: 's'.repeat(43),
      })
    const paths = { uiJson, uiLock: join(run, 'ui.lock') }
    writeFileSync(uiJson, info(process.pid))
    expect(await findRunningUi(paths, 50)).toBeNull()
    expect(existsSync(uiJson)).toBe(true)
    // The same silence from a process that no longer exists is a stale file.
    writeFileSync(uiJson, info(2 ** 22 + 12345))
    expect(await findRunningUi(paths, 50)).toBeNull()
    expect(existsSync(uiJson)).toBe(false)
  })

  it('a port taken by another program is a clear error, never a random port', async () => {
    const port = await freePort()
    const blocker = createServer().listen(port, '127.0.0.1')
    onCleanup(() => new Promise<void>((r) => blocker.close(() => r())))
    await new Promise((r) => blocker.once('listening', r))
    const err = await start(port).catch((e: unknown) => e)
    expect(isSearchHoleError(err) && err.why).toContain(`Port ${port} is in use`)
    expect(isSearchHoleError(err) && err.fix).toContain('--port')
  })

  it('a live startup lock refuses a second start', async () => {
    const run = mkdtempSync(join(tmpdir(), 'searchhole-run-'))
    writeFileSync(join(run, 'ui.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    const err = await start(await freePort(), run).catch((e: unknown) => e)
    expect(isSearchHoleError(err) && err.code).toBe('config_locked')
  })
})

describe('ui command line', () => {
  it('parses flags and validates the port', () => {
    expect(parseCommand(['ui'])).toEqual({ name: 'ui', open: false, detach: false, stay: false })
    expect(parseCommand(['ui', '--open', '--detach', '--port', '7400'])).toEqual({
      name: 'ui',
      port: 7400,
      open: true,
      detach: true,
      stay: false,
    })
    expect(() => parseCommand(['ui', '--port', '80'])).toThrow(/1024 to 65535/)
    expect(() => parseCommand(['ui', '--port', 'abc'])).toThrow(/1024 to 65535/)
  })
})
