// SPDX-License-Identifier: Apache-2.0
/** Test harness for the App facade: temp roots (SEARCHHOLE_HOME), a file key store, a fixed clock. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { createApp } from '../../src/app/index.ts'
import type { App, AppSeams, HostProfile, RequestCtx } from '../../src/app/types.ts'
import { createInsecureFileStore } from '../../src/shared/keys/file.ts'
import type { CommandResult } from '../../src/shared/keys/types.ts'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()?.()
    } catch {
      // Best effort.
    }
  }
})

/** Registers a cleanup to run after the current test. */
export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn)
}

/** 2026-10-30 12:00:00 UTC. */
export const NOW = Date.parse('2026-10-30T12:00:00Z')

/** A fake Tavily key (only ever placed in the environment). */
export const TAVILY_KEY = 'tvly-test-key-0123456789abcdef'

export interface Harness {
  app: App
  home: string
  project: string
  clock: { now: () => number; set: (ms: number) => void; advance: (ms: number) => void }
  /** Recreates the app on the same roots (another process, or a restart). */
  reopen: (over?: Partial<SetupOptions>) => Promise<App>
}

export interface SetupOptions {
  settings?: string
  rules?: string
  /** `.searchhole.yaml` content for the project directory. */
  projectRules?: string
  env?: Record<string, string>
  host?: HostProfile
  version?: string
  seams?: AppSeams
  /** Pre-existing home directory (to share roots between apps). */
  home?: string
}

/** A fake `docker info` that reports Docker as missing. */
export const noDocker = async (): Promise<CommandResult> => ({
  code: null,
  stdout: '',
  stderr: '',
  error: 'ENOENT',
})

/** Creates temp roots, writes the given files and builds an app on them. */
export async function setup(o: SetupOptions = {}): Promise<Harness> {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'searchhole-app-'))
  if (o.home === undefined) onCleanup(() => rmSync(home, { recursive: true, force: true }))
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  if (o.settings !== undefined) writeFileSync(join(home, 'settings.yaml'), o.settings)
  if (o.rules !== undefined) writeFileSync(join(home, 'rules.yaml'), o.rules)
  if (o.projectRules !== undefined) writeFileSync(join(project, '.searchhole.yaml'), o.projectRules)
  let t = NOW
  const clock = {
    now: () => t,
    set: (ms: number) => {
      t = ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
  const keys = createInsecureFileStore({ dir: join(home, 'secrets') })
  const make = async (over: Partial<SetupOptions> = {}): Promise<App> => {
    const app = await createApp({
      host: over.host ?? o.host ?? 'claude-code',
      version: over.version ?? o.version ?? '0.1.0',
      env: { SEARCHHOLE_HOME: home, SEARCHHOLE_LOG: 'silent', ...(o.env ?? {}), ...(over.env ?? {}) },
      cwd: project,
      now: clock.now,
      seams: {
        keyStores: { write: keys, read: [keys] },
        runCommand: noDocker,
        homedir: home,
        ...(o.seams ?? {}),
        ...(over.seams ?? {}),
      },
    })
    onCleanup(() => app.close())
    return app
  }
  const app = await make()
  return { app, home, project, clock, reopen: make }
}

/** Settings pointing SearXNG and Tavily at the mock engines (Brave off). */
export function mockSettings(searxng: string, tavily: string, extra = ''): string {
  return `version: 1
engines:
  searxng: { url: "${searxng}" }
  tavily: { url: "${tavily}" }
  brave: { enabled: false }
${extra}`
}

/** A hook-keyed Claude Code session. */
export const hookSession = (key = 'session-1'): RequestCtx => ({ session: { key, source: 'hook' } })

/** A fallback-keyed session (hosts that do not identify chats). */
export const fallbackSession = (key = 'fallback:1'): RequestCtx => ({ session: { key, source: 'fallback' } })

/** Receipt id shape (ADR-0005). */
export const RECEIPT_RE = /^rcpt_[A-Za-z0-9_-]{22}$/
