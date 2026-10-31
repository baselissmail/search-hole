// SPDX-License-Identifier: Apache-2.0
/**
 * Shared state of one App instance: roots and file layout (ADR-0015 point 1), effective
 * settings (ADR-0015 point 2), the logger (stderr only) and the lazy store. Building a
 * context reads `settings.yaml` and checks a few paths; it creates nothing.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { isSearchHoleError, SearchHoleError } from '../shared/errors.ts'
import { createLogger, type Logger } from '../shared/log.ts'
import { type RootLayout, type Roots, type RootsInput, resolveRoots, rootLayout } from '../shared/paths.ts'
import {
  DEFAULT_SETTINGS,
  describeSettingsWarning,
  type LoadedSettings,
  loadSettings,
  type Settings,
} from '../shared/settings.ts'
import { readTextIfExists } from './fsutil.ts'
import { StoreGate } from './storegate.ts'
import type { AppOptions, AppSeams, HostProfile, SearchMode } from './types.ts'

/** Environment override for the Claude Code mode (ADR-0018). */
export const MODE_ENV = 'SEARCHHOLE_MODE'
const MODES: readonly SearchMode[] = ['auto', 'builtin', 'engines']

const hostModeSchema = z.object({
  hosts: z
    .object({
      'claude-code': z.object({ mode: z.enum(['auto', 'builtin', 'engines']).optional() }).optional(),
    })
    .optional(),
})

/** Reads `hosts.claude-code.mode` from settings text (not yet part of the settings schema). */
export function hostModeFromText(text: string | undefined): SearchMode | undefined {
  if (text === undefined) return undefined
  try {
    const parsed = hostModeSchema.safeParse(parseYaml(text))
    return parsed.success ? parsed.data.hosts?.['claude-code']?.mode : undefined
  } catch {
    return undefined
  }
}

export interface SettingsState {
  settings: Settings
  loaded?: LoadedSettings
  /** Why settings.yaml could not be used (the defaults apply meanwhile). */
  error?: SearchHoleError
  /** `hosts.claude-code.mode` from the file. */
  fileMode?: SearchMode
  /** One line per settings warning, unknown `hosts.*` keys excluded (they are read here). */
  warnings: string[]
}

/** Loads settings.yaml; an invalid file falls back to the defaults and is reported by `doctor`. */
export function loadSettingsState(file: string, env: AppOptions['env']): SettingsState {
  let text: string | undefined
  try {
    text = readTextIfExists(file)
  } catch (cause) {
    return {
      settings: DEFAULT_SETTINGS,
      error: new SearchHoleError('config_invalid', `Cannot read ${file}.`, {
        fix: 'Check the file permissions.',
        cause,
      }),
      warnings: [],
    }
  }
  try {
    const loaded = loadSettings(text, { env })
    const warnings = loaded.warnings
      .filter((w) => !(w.kind === 'unknown_key' && (w.path === 'hosts' || w.path.startsWith('hosts.'))))
      .map(describeSettingsWarning)
    const state: SettingsState = { settings: loaded.settings, loaded, warnings }
    const mode = hostModeFromText(text)
    if (mode !== undefined) state.fileMode = mode
    return state
  } catch (e) {
    const error = isSearchHoleError(e)
      ? e
      : new SearchHoleError('config_invalid', 'settings.yaml could not be loaded.', { cause: e })
    return { settings: DEFAULT_SETTINGS, error, warnings: [] }
  }
}

export interface AppContext {
  readonly host: HostProfile
  readonly version: string
  readonly env: AppOptions['env']
  readonly cwd: string
  readonly now: () => number
  readonly platform: NodeJS.Platform
  readonly homedir: string
  readonly rootsInput: RootsInput
  readonly roots: Roots
  readonly layout: RootLayout
  readonly seams: AppSeams
  readonly logger: Logger
  readonly store: StoreGate
  /** Random per process; names this gateway in `gateways` and sessions. */
  readonly gatewayId: string
  readonly startedAt: number
  settings: SettingsState
}

/** Builds the context. Throws `config_invalid` only when no roots can be resolved at all. */
export function createContext(opts: AppOptions): AppContext {
  const seams = opts.seams ?? {}
  const now = opts.now ?? Date.now
  const platform = seams.platform ?? process.platform
  const home = seams.homedir ?? homedir()
  const rootsInput: RootsInput = { env: opts.env, platform, homedir: home, exists: existsSync }
  const roots = resolveRoots(rootsInput)
  const layout = rootLayout(roots, platform)
  const logger = createLogger({ env: opts.env, bindings: { host: opts.host } })
  const store = new StoreGate({
    dataDir: roots.data,
    dbPath: layout.db,
    appVersion: opts.version,
    now,
    busyTimeoutMs: seams.storeBusyTimeoutMs ?? (opts.host === 'cli' ? 5000 : 100),
    migrateOnRead: opts.host === 'cli',
    logger,
  })
  return {
    host: opts.host,
    version: opts.version,
    env: opts.env,
    cwd: opts.cwd,
    now,
    platform,
    homedir: home,
    rootsInput,
    roots,
    layout,
    seams,
    logger,
    store,
    gatewayId: `gw_${randomBytes(8).toString('hex')}`,
    startedAt: now(),
    settings: loadSettingsState(layout.settings, opts.env),
  }
}

/** The configured Claude Code mode: `SEARCHHOLE_MODE`, else settings, else `auto` (ADR-0018). */
export function configuredMode(ctx: AppContext): SearchMode {
  const raw = ctx.env[MODE_ENV]?.trim().toLowerCase()
  const fromEnv = MODES.find((m) => m === raw)
  return fromEnv ?? ctx.settings.fileMode ?? 'auto'
}
