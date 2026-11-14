// SPDX-License-Identifier: Apache-2.0
/**
 * The gateway process (ADR-0012, ADR-0013): one per host connection, serving both protocol
 * eras over stdio through the SDK's `serveStdio`.
 *
 * - **The factory is cheap and side-effect free** (ADR-0013 point 3). `serveStdio` calls it
 *   for a discarded `server/discover` probe too, and `createMcpHandler` once per request, so
 *   it only builds an `McpServer` and registers tools. Every piece of state (the App, the
 *   session and turn state) lives on the `Gateway`, shared by all instances.
 * - **The App is created lazily** on the first tool call that needs it, and retried on the
 *   next call if creation failed. The guard's allow path never needs it.
 * - **stdout is the protocol channel.** Logs go to stderr via `shared/log.ts`.
 * - **stdin EOF** closes the transport; the gateway then closes the App so the process can
 *   exit on its own.
 * - `SEARCHHOLE_MCP_PROTOCOL=auto|legacy|modern` is the era escape hatch (ADR-0013 point 6).
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server'
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
import type { App, CreateApp, HostProfile } from '../app/types.ts'
import { createLogger, type Logger } from '../shared/log.ts'
import { resolveRoots } from '../shared/paths.ts'
import type { ProcessContext } from './context.ts'
import { engineLikelySetUp, hooksInstalled } from './engine-hint.ts'
import { dotDir, type ProtectedRoots } from './guard.ts'
import { refineHostProfile } from './host.ts'
import { MAX_INSTRUCTIONS_CHARS, serverInstructions } from './instructions.ts'
import { ActionTokens, registerPanelResource } from './panel.ts'
import { GatewaySessions } from './session.ts'
import { registerTools } from './tools.ts'

type Env = Readonly<Record<string, string | undefined>>

/** The MCP server name hosts see (`plugin:search-hole:search-hole` in Claude Code). */
export const SERVER_NAME = 'search-hole'

/** `tools/list` and `server/discover` cache lifetime (ADR-0012); development builds use 0. */
export const LIST_CACHE_TTL_MS = 3_600_000

/** What `searchhole mcp` passes in (the App facade's options, minus the clock). */
export interface GatewayOptions {
  host: HostProfile
  version: string
  env: Env
  cwd: string
}

/** Injected collaborators; tests pass a fake App factory and a capturing logger. */
export interface GatewayDeps {
  createApp: CreateApp
  logger?: Logger
  now?: () => number
  pid?: number
  home?: string
  platform?: NodeJS.Platform
  /** Replaces the start-up guess that an engine is set up (engine-hint.ts). */
  engineSetUp?: () => boolean
  /** Replaces the check that the plugin's hooks sit next to the bundle (engine-hint.ts). */
  hooksInstalled?: () => boolean
}

/** Which eras this process serves (ADR-0013 point 6). */
export type ProtocolMode = 'auto' | 'legacy' | 'modern'

/** Reads `SEARCHHOLE_MCP_PROTOCOL`; unknown values mean `auto`. */
export function protocolModeFromEnv(env: Env): ProtocolMode {
  const v = env.SEARCHHOLE_MCP_PROTOCOL?.trim().toLowerCase()
  return v === 'legacy' || v === 'modern' ? v : 'auto'
}

/** True for builds that must not be cached by hosts (ADR-0012: development builds use ttl 0). */
export function isDevelopmentVersion(version: string): boolean {
  return version === '0.0.0' || /[-+]dev/.test(version)
}

/** Shared state for every server instance this process builds. */
export class Gateway {
  readonly host: HostProfile
  readonly version: string
  readonly env: Env
  readonly log: Logger
  readonly sessions: GatewaySessions
  /** One-time tokens for the receipt panel's buttons (ADR-0021), shared by every server instance. */
  readonly tokens = new ActionTokens()
  readonly proc: ProcessContext
  readonly protocolMode: ProtocolMode
  /** Guessed once at start, so the instructions and the tool list stay byte-stable. */
  readonly engineSetUp: boolean
  /** True in Claude Code with the plugin's hooks: only then is the built-in search filtered. */
  readonly filtersBuiltin: boolean
  /** The server factory for `serveStdio` / `createMcpHandler`. */
  readonly factory: McpServerFactory

  private readonly createAppFn: CreateApp
  private readonly now: (() => number) | undefined
  private readonly platform: NodeJS.Platform
  private appPromise: Promise<App> | undefined
  private roots: ProtectedRoots | undefined
  private closing: Promise<void> | undefined

  constructor(opts: GatewayOptions, deps: GatewayDeps) {
    const refined = refineHostProfile(opts.host, opts.env)
    this.host = refined.host
    this.version = opts.version
    this.env = opts.env
    this.log =
      deps.logger ?? createLogger({ env: opts.env, bindings: { component: 'gateway', host: refined.host } })
    this.createAppFn = deps.createApp
    this.now = deps.now
    this.platform = deps.platform ?? process.platform
    const home = deps.home ?? homedir()
    this.proc = { env: opts.env, cwd: opts.cwd, home }
    this.protocolMode = protocolModeFromEnv(opts.env)
    this.engineSetUp = (
      deps.engineSetUp ?? (() => engineLikelySetUp({ env: opts.env, home, platform: this.platform }))
    )()
    this.filtersBuiltin = this.host === 'claude-code' && (deps.hooksInstalled ?? hooksInstalled)()
    this.sessions = new GatewaySessions({
      host: refined.host,
      pid: deps.pid ?? process.pid,
      env: opts.env,
      now: deps.now ?? Date.now,
    })
    if (refined.reason !== undefined) {
      this.log.info(
        { requested: opts.host, host: refined.host, reason: refined.reason },
        'host profile refined',
      )
    }
    this.factory = ({ era }) => this.buildServer(era)
  }

  /** Builds one server instance. Cheap and side-effect free (no App, no I/O). */
  buildServer(era: 'modern' | 'legacy'): McpServer {
    if (era === 'modern' && this.protocolMode === 'legacy') {
      throw new Error('2026-07-28 serving is off (SEARCHHOLE_MCP_PROTOCOL=legacy)')
    }
    const ttlMs = isDevelopmentVersion(this.version) ? 0 : LIST_CACHE_TTL_MS
    const server = new McpServer(
      { name: SERVER_NAME, version: this.version },
      {
        capabilities: { tools: {} },
        instructions: serverInstructions({
          host: this.host,
          engineSetUp: this.engineSetUp,
          hooks: this.filtersBuiltin,
        }).slice(0, MAX_INSTRUCTIONS_CHARS),
        cacheHints: {
          'tools/list': { ttlMs, cacheScope: 'private' },
          'server/discover': { ttlMs, cacheScope: 'private' },
        },
      },
    )
    registerTools(server, {
      host: this.host,
      engineSetUp: this.engineSetUp,
      filtersBuiltin: this.filtersBuiltin,
      version: this.version,
      tokens: this.tokens,
      era,
      log: this.log,
      sessions: this.sessions,
      getApp: () => this.getApp(),
      proc: this.proc,
      protectedRoots: () => this.protectedRoots(),
    })
    registerPanelResource(server, this.version)
    return server
  }

  /** The App, created on first use; a failed creation is retried by the next call. */
  getApp(): Promise<App> {
    if (this.closing !== undefined) return Promise.reject(new Error('the gateway is shutting down'))
    if (this.appPromise === undefined) {
      const opts = {
        host: this.host,
        version: this.version,
        env: this.env,
        cwd: this.proc.cwd,
        ...(this.now === undefined ? {} : { now: this.now }),
      }
      const started = this.createAppFn(opts)
      this.appPromise = started
      started.catch((err: unknown) => {
        this.log.error({ err }, 'could not start search-hole; the next tool call retries')
        if (this.appPromise === started) this.appPromise = undefined
      })
    }
    return this.appPromise
  }

  /** Config and data roots plus `~/.searchhole`, for the Edit/Write guard (computed once). */
  protectedRoots(): ProtectedRoots {
    if (this.roots !== undefined) return this.roots
    const home = this.proc.home ?? homedir()
    const dirs = [dotDir(home)]
    try {
      const roots = resolveRoots({
        env: this.env,
        platform: this.platform,
        homedir: home,
        exists: existsSync,
      })
      dirs.push(roots.config, roots.data)
    } catch (err) {
      this.log.warn({ err }, 'could not resolve the search-hole roots; guarding ~/.searchhole only')
    }
    this.roots = {
      dirs: [...new Set(dirs)],
      caseInsensitive: this.platform === 'darwin' || this.platform === 'win32',
      home,
    }
    return this.roots
  }

  /** Releases the App (store, HTTP agents). Idempotent. */
  close(): Promise<void> {
    if (this.closing === undefined) {
      const pending = this.appPromise
      this.appPromise = undefined
      this.closing = (async () => {
        if (pending === undefined) return
        try {
          await (await pending).close()
        } catch (err) {
          this.log.warn({ err }, 'closing search-hole failed')
        }
      })()
    }
    return this.closing
  }
}

/** A running stdio gateway. */
export interface GatewayHandle {
  /** Resolves once the connection has ended (stdin EOF or `close()`) and the App is closed. */
  readonly closed: Promise<void>
  /** Tears the connection down and releases resources. */
  close(): Promise<void>
}

/** A stdio transport that reports when it closes (stdin EOF, write failure or `close()`). */
class ObservedStdioTransport extends StdioServerTransport {
  private readonly onClosed: () => void
  private reported = false

  constructor(stdin: Readable, stdout: Writable, onClosed: () => void) {
    super(stdin, stdout)
    this.onClosed = onClosed
  }

  override async close(): Promise<void> {
    await super.close()
    if (this.reported) return
    this.reported = true
    this.onClosed()
  }
}

/** Optional streams for tests; production uses the process's stdin and stdout. */
export interface StdioStreams {
  stdin?: Readable
  stdout?: Writable
}

/** Serves the gateway on stdio in both eras (ADR-0013 point 1). */
export function serveGatewayStdio(gateway: Gateway, streams: StdioStreams = {}): GatewayHandle {
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const finish = (): void => {
    gateway.log.info('stdio connection closed; releasing resources')
    void gateway.close().then(resolveClosed, resolveClosed)
  }
  const transport = new ObservedStdioTransport(
    streams.stdin ?? process.stdin,
    streams.stdout ?? process.stdout,
    finish,
  )
  const handle = serveStdio(gateway.factory, {
    transport,
    ...(gateway.protocolMode === 'modern' ? { legacy: 'reject' as const } : {}),
    onerror: (err) => gateway.log.warn({ err }, 'mcp transport error'),
  })
  gateway.log.info({ version: gateway.version, protocol: gateway.protocolMode }, 'gateway serving on stdio')
  return {
    closed,
    close: async () => {
      await handle.close()
      await transport.close()
      await closed
    },
  }
}
