// SPDX-License-Identifier: Apache-2.0
/**
 * `searchhole ui`: one on-demand dashboard process per machine (ADR-0004 points 2–3).
 *
 * - Discovery: `<run>/ui.json` (0600 in a 0700 dir) holds port, pid, nonce, version and the
 *   login secret. A second `searchhole ui` checks `GET /health` for the same nonce and reuses
 *   that instance; a file that fails the check is removed.
 * - Startup races are guarded by `<run>/ui.lock` (O_EXCL, stale after 30 s or a dead pid).
 * - Port 7341 by default; a port taken by something else is an error with `--port` advice,
 *   never a silent random port (bookmarks and the session origin depend on it).
 * - The process exits after `ui.idleMinutes` with no API call and no open stream, unless
 *   `--stay`. Only an explicit user command starts it; gateways never do.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdaptorServer } from '@hono/node-server'
import { z } from 'zod'
import type { App, DashboardApi } from '../app/types.ts'
import { SearchHoleError } from '../shared/errors.ts'
import type { Logger } from '../shared/log.ts'
import { atomicWriteFile } from '../shared/paths.ts'
import { createUiServer, type UiServer } from './server.ts'

const LOCK_STALE_MS = 30_000
const HEALTH_TIMEOUT_MS = 1_500
const IDLE_CHECK_MS = 30_000

const uiJsonSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  nonce: z.string().min(16),
  version: z.string(),
  startedAt: z.number(),
  loginSecret: z.string().min(32),
})
export type UiJson = z.output<typeof uiJsonSchema>

export interface UiPaths {
  uiJson: string
  uiLock: string
}

/** The running instance described by `ui.json`, if it answers with the same nonce. */
export async function findRunningUi(paths: UiPaths): Promise<UiJson | null> {
  let info: UiJson
  try {
    info = uiJsonSchema.parse(JSON.parse(readFileSync(paths.uiJson, 'utf8')))
  } catch {
    return null
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    const body = (await res.json()) as { nonce?: unknown }
    if (res.ok && body.nonce === info.nonce) return info
  } catch {
    // Not answering: stale.
  }
  rmSync(paths.uiJson, { force: true })
  return null
}

/** A one-time sign-in URL from a running instance (asks it for a login code). */
export async function signInUrl(info: UiJson): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${info.port}/api/login-code`, {
    method: 'POST',
    headers: { authorization: `Bearer ${info.loginSecret}` },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  })
  if (!res.ok)
    throw new SearchHoleError('internal', `The dashboard refused a sign-in code (HTTP ${res.status}).`)
  const { code } = (await res.json()) as { code: string }
  return `http://127.0.0.1:${info.port}/#c=${code}`
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes `ui.lock`, breaking a stale one. Returns a release function, or null if it is held. */
function takeLock(path: string, now: () => number): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }))
      closeSync(fd)
      return () => rmSync(path, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let stale = true
      try {
        const held = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; at?: number }
        stale = !pidAlive(held.pid ?? -1) || now() - (held.at ?? 0) > LOCK_STALE_MS
      } catch {
        stale = now() - statSync(path).mtimeMs > LOCK_STALE_MS
      }
      if (!stale) return null
      rmSync(path, { force: true })
    }
  }
  return null
}

/** Opens a URL in the default browser, without a shell. Failures only print. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['explorer.exe', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/** The built dashboard next to the bundle (`dist/ui`), or in the repo when running from source. */
export function defaultAssetsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    join(here, 'ui'),
    join(here, '..', '..', '..', '..', 'apps', 'dashboard', 'dist'),
  ]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}

export interface StartUiOptions {
  app: App & { dashboard: DashboardApi }
  paths: UiPaths
  port: number
  idleMinutes: number
  stay: boolean
  version: string
  logger: Logger
  assetsDir: string | null
  now?: () => number
}

export interface RunningUi {
  info: UiJson
  server: UiServer
  /** Resolves when the process should exit (idle, a signal, or `stop`). */
  done: Promise<void>
  stop(): Promise<void>
}

/** Starts the dashboard in this process. Throws when the port is taken or another start holds the lock. */
export async function startUi(o: StartUiOptions): Promise<RunningUi> {
  const now = o.now ?? Date.now
  const dir = dirname(o.paths.uiJson)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const release = takeLock(o.paths.uiLock, now)
  if (release === null) {
    throw new SearchHoleError('config_locked', 'Another `searchhole ui` is starting right now.', {
      fix: 'Wait a moment and run it again.',
    })
  }
  try {
    const info: UiJson = {
      port: o.port,
      pid: process.pid,
      nonce: randomBytes(16).toString('base64url'),
      version: o.version,
      startedAt: now(),
      loginSecret: randomBytes(32).toString('base64url'),
    }
    const server = createUiServer({
      app: o.app,
      port: o.port,
      version: o.version,
      nonce: info.nonce,
      loginSecret: info.loginSecret,
      assetsDir: o.assetsDir,
      now,
      logger: o.logger,
    })
    const http = createAdaptorServer({ fetch: server.fetch }) as Server
    await new Promise<void>((resolve, reject) => {
      http.once('error', (e: NodeJS.ErrnoException) => {
        reject(
          e.code === 'EADDRINUSE'
            ? new SearchHoleError('invalid_argument', `Port ${o.port} is in use by another program.`, {
                fix: `Run \`searchhole ui --port ${o.port + 1}\`, or set ui.port in settings.yaml.`,
              })
            : e,
        )
      })
      http.listen(o.port, '127.0.0.1', () => resolve())
    })
    atomicWriteFile(o.paths.uiJson, `${JSON.stringify(info)}\n`, { mode: 0o600 })

    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((r) => {
      resolveDone = r
    })
    let stopping: Promise<void> | undefined
    const idle = setInterval(() => {
      const idleMs = o.idleMinutes * 60_000
      if (!o.stay && idleMs > 0 && server.streams() === 0 && now() - server.lastActivity() > idleMs) {
        o.logger.info('dashboard idle; exiting')
        void stop()
      }
    }, IDLE_CHECK_MS)
    idle.unref()

    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        clearInterval(idle)
        server.close()
        await new Promise<void>((r) => {
          http.close(() => r())
          http.closeAllConnections()
        })
        try {
          const current = uiJsonSchema.parse(JSON.parse(readFileSync(o.paths.uiJson, 'utf8')))
          if (current.nonce === info.nonce) rmSync(o.paths.uiJson, { force: true })
        } catch {
          // Already gone or replaced.
        }
        await o.app.close().catch(() => undefined)
        resolveDone()
      })()
      return stopping
    }
    return { info, server, done, stop }
  } finally {
    release()
  }
}

/** Starts `searchhole ui` in a detached child and waits until it answers. */
export async function startDetached(
  paths: UiPaths,
  args: readonly string[],
  timeoutMs = 8_000,
): Promise<UiJson> {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? '', 'ui', ...args], {
    stdio: 'ignore',
    detached: true,
    env: process.env,
  })
  child.unref()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const found = await findRunningUi(paths)
    if (found !== null) return found
  }
  throw new SearchHoleError('internal', 'The dashboard did not start in time.', {
    fix: 'Run `searchhole ui` in the foreground to see why.',
  })
}
