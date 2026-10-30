// SPDX-License-Identifier: Apache-2.0
/**
 * The managed SearXNG container (ADR-0015 point 5, ADR-0017). Only user actions reach
 * Docker (`searchhole searxng up | down | status | apply`); gateways never call it.
 *
 * One container, `search-hole-searxng`, from an image pinned by digest, published on
 * 127.0.0.1 only. Its settings overlay lives in `<data>/searxng/settings.yml` (mode 0600,
 * secret key generated once). Docker is always run with an argument array, never a shell.
 * Every side effect goes through `SearxngDeps`, so tests drive it with a fake runner.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { SearchHoleError } from '../shared/errors.ts'
import { atomicWriteFile, ensureDir } from '../shared/paths.ts'

/** The container this module owns. */
export const SEARXNG_CONTAINER = 'search-hole-searxng'
/** The official image, pinned by digest (spikes §3). A digest reference cannot also carry a tag. */
export const SEARXNG_IMAGE =
  'searxng/searxng@sha256:c4e8448495ef3b0175eb6c97a19c1ac7cc0a5c907d581ab3877f3cb430e81b86'
/** Shown before the first pull. */
export const SEARXNG_PULL_SIZE = '~380 MB'
/** SearXNG listens here inside the container. */
export const SEARXNG_INTERNAL_PORT = 8080
/** Where the overlay directory is mounted in the container. */
export const SEARXNG_CONFIG_MOUNT = '/etc/searxng'
/** Marks containers created by this tool. */
export const SEARXNG_LABEL = 'io.search-hole.managed=searxng'
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 500

// ── Docker runner ────────────────────────────────────────────────────────

export interface DockerResult {
  /** Exit code; null when docker did not run (see `error`). */
  code: number | null
  stdout: string
  stderr: string
  /** `ENOENT` (no docker binary), `timeout`, or another spawn error code. */
  error?: string
}

export interface DockerRunOptions {
  timeoutMs?: number
  /** Receives output as it arrives (pull progress). */
  onOutput?: (chunk: string) => void
}

/** Runs `docker <args>`. Never throws; failures are in the result. */
export type DockerRunner = (args: readonly string[], opts?: DockerRunOptions) => Promise<DockerResult>

const MAX_CAPTURE = 64 * 1024

/** The real docker runner: `child_process.spawn('docker', args)` with no shell. */
export const nodeDockerRunner: DockerRunner = (args, opts = {}) =>
  new Promise<DockerResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child: ReturnType<typeof spawn> | undefined
    const finish = (result: { code: number | null; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child?.kill('SIGKILL')
    }, opts.timeoutMs ?? 30_000)
    try {
      child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      finish({ code: null, error: e instanceof Error && 'code' in e ? String(e.code) : 'spawn_failed' })
      return
    }
    const take = (which: 'out' | 'err') => (data: Buffer) => {
      const text = data.toString('utf8')
      if (which === 'out' && stdout.length < MAX_CAPTURE) stdout += text
      if (which === 'err' && stderr.length < MAX_CAPTURE) stderr += text
      opts.onOutput?.(text)
    }
    child.stdout?.on('data', take('out'))
    child.stderr?.on('data', take('err'))
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, error: e.code ?? 'spawn_failed' }))
    child.on('close', (code) => finish(timedOut ? { code: null, error: 'timeout' } : { code }))
  })

// ── Argument construction ────────────────────────────────────────────────

export interface RunSpec {
  name: string
  image: string
  port: number
  /** Host directory holding `settings.yml`, mounted read-write at /etc/searxng. */
  dataDir: string
  /** `uid:gid` to run as (Linux, so the 0600 overlay is readable by the container user). */
  user?: string
}

/** `docker run` arguments: detached, loopback-only port, no implicit pull, overlay mounted. */
export function buildRunArgs(spec: RunSpec): string[] {
  return [
    'run',
    '-d',
    '--name',
    spec.name,
    '--restart',
    'unless-stopped',
    '--pull',
    'never',
    '--label',
    SEARXNG_LABEL,
    '-p',
    `127.0.0.1:${spec.port}:${SEARXNG_INTERNAL_PORT}`,
    '-v',
    `${spec.dataDir}:${SEARXNG_CONFIG_MOUNT}`,
    ...(spec.user === undefined ? [] : ['--user', spec.user]),
    spec.image,
  ]
}

/** The docker commands, as argument arrays, for tests and for `--help`. */
export const dockerArgs = {
  version: ['version', '--format', '{{.Server.Version}}'],
  imageInspect: (image: string): string[] => ['image', 'inspect', '--format', '{{.Id}}', image],
  pull: (image: string): string[] => ['pull', image],
  inspect: (name: string): string[] => ['container', 'inspect', name],
  start: (name: string): string[] => ['start', name],
  remove: (name: string): string[] => ['rm', '-f', name],
  logs: (name: string): string[] => ['logs', '--tail', '8', name],
} as const

// ── Settings overlay ─────────────────────────────────────────────────────

const OVERLAY_HEADER = `# Managed by search-hole: \`searchhole searxng apply\` rewrites this file and keeps the secret key.
# Edit searchhole's settings.yaml (searxng.port) instead of this file.
`

/** A fresh 256-bit hex secret. */
export function newSecretKey(): string {
  return randomBytes(32).toString('hex')
}

function existingSecret(file: string): string | undefined {
  try {
    const parsed: unknown = YAML.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('server' in parsed)) return undefined
    const server = parsed.server
    if (typeof server !== 'object' || server === null || !('secret_key' in server)) return undefined
    const key = server.secret_key
    return typeof key === 'string' && key.length >= 32 && key !== 'ultrasecretkey' ? key : undefined
  } catch {
    return undefined
  }
}

/** The overlay text for a secret key (use_default_settings, JSON on, limiter and image proxy off). */
export function renderOverlay(secretKey: string): string {
  return (
    OVERLAY_HEADER +
    YAML.stringify({
      use_default_settings: true,
      server: { secret_key: secretKey, limiter: false, image_proxy: false },
      search: { formats: ['html', 'json'] },
    })
  )
}

export interface OverlayResult {
  path: string
  /** True when a new secret key was generated. */
  secretCreated: boolean
  /** True when the file was created or its content changed. */
  changed: boolean
}

/**
 * Writes `<dataDir>/settings.yml` (0600) with the overlay, keeping an existing secret key.
 * Leaves the file alone when it already has the right content.
 */
export function writeOverlay(dataDir: string, newSecret: () => string = newSecretKey): OverlayResult {
  ensureDir(dataDir)
  const path = join(dataDir, 'settings.yml')
  const kept = existsSync(path) ? existingSecret(path) : undefined
  const secret = kept ?? newSecret()
  const text = renderOverlay(secret)
  const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
  const changed = current !== text
  if (changed) atomicWriteFile(path, text, { mode: 0o600 })
  else if (process.platform !== 'win32') chmodSync(path, 0o600)
  return { path, secretCreated: kept === undefined, changed }
}

// ── Container state ──────────────────────────────────────────────────────

export type DockerState = 'ok' | 'missing' | 'daemon_down'

export interface ContainerInfo {
  running: boolean
  image: string
  hostIp?: string
  hostPort?: number
}

const inspectSchema = z
  .array(
    z.object({
      State: z.object({ Running: z.boolean().optional(), Status: z.string().optional() }),
      Config: z.object({ Image: z.string().optional() }).optional(),
      HostConfig: z
        .object({
          PortBindings: z
            .record(
              z.string(),
              z
                .array(z.object({ HostIp: z.string().optional(), HostPort: z.string().optional() }))
                .nullable(),
            )
            .nullable()
            .optional(),
        })
        .optional(),
    }),
  )
  .min(1)

const lastLine = (text: string): string => {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const line = lines[lines.length - 1] ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** Parses `docker container inspect` output. Exported for tests. */
export function parseInspect(stdout: string): ContainerInfo | undefined {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const parsed = inspectSchema.safeParse(json)
  if (!parsed.success) return undefined
  const c = parsed.data[0]
  if (c === undefined) return undefined
  const binding = c.HostConfig?.PortBindings?.[`${SEARXNG_INTERNAL_PORT}/tcp`]?.[0]
  const port = binding?.HostPort === undefined ? undefined : Number(binding.HostPort)
  return {
    running: c.State.Running === true,
    image: c.Config?.Image ?? '',
    ...(binding?.HostIp === undefined ? {} : { hostIp: binding.HostIp }),
    ...(port === undefined || Number.isNaN(port) ? {} : { hostPort: port }),
  }
}

// ── Orchestration ────────────────────────────────────────────────────────

export interface SearxngContext {
  /** `<data>/searxng`. */
  dataDir: string
  /** `searxng.port` from settings. */
  port: number
  /** `searxng.managed` from settings. */
  managed: boolean
  /** `engines.searxng.url` from settings, to point out a mismatch with the port. */
  engineUrl: string | null
}

export interface SearxngDeps {
  docker: DockerRunner
  /** True when GET `<url>` answers 2xx. */
  probeHealth(url: string): Promise<boolean>
  sleep(ms: number): Promise<void>
  now(): number
  /** Progress lines for the person at the terminal (stderr). */
  say(line: string): void
  /** Resolves true to download the image. Throws when it cannot ask and was not told to. */
  confirmPull(): Promise<boolean>
  /** `uid:gid` to run the container as; set on Linux only. */
  user?: string
  newSecret?: () => string
  healthTimeoutMs?: number
  pollMs?: number
}

export interface SearxngStatus {
  name: string
  docker: DockerState
  container: 'running' | 'stopped' | 'absent'
  imageMatches: boolean
  portMatches: boolean
  port: number
  url: string
  dataDir: string
  healthy: boolean
  managed: boolean
}

export type UpResult =
  | { kind: 'already-running'; url: string; notes: string[] }
  | { kind: 'started'; url: string; pulled: boolean; secretCreated: boolean; notes: string[] }
  | { kind: 'declined' }

export type ApplyResult =
  | { kind: 'recreated'; url: string; notes: string[] }
  | { kind: 'files-only'; path: string; secretCreated: boolean; reason: 'no-docker' | 'not-created' }

export type DownResult = { kind: 'removed' } | { kind: 'absent' }

const baseUrl = (port: number): string => `http://127.0.0.1:${port}`

function dockerProblem(state: DockerState, detail?: string): SearchHoleError {
  return state === 'missing'
    ? new SearchHoleError('engine_failed', 'Docker is not installed (no `docker` command found).', {
        fix: 'Install Docker Desktop, or skip it and use a free Tavily key: searchhole keys set tavily',
      })
    : new SearchHoleError(
        'engine_failed',
        `Docker is installed but its daemon is not answering${detail === undefined || detail === '' ? '' : ` (${detail})`}.`,
        { fix: 'Start Docker Desktop (or the docker service), then run this again.' },
      )
}

/** Checks that the docker CLI exists and its daemon answers. */
export async function dockerState(docker: DockerRunner): Promise<{ state: DockerState; detail: string }> {
  const r = await docker(dockerArgs.version, { timeoutMs: 15_000 })
  if (r.error === 'ENOENT') return { state: 'missing', detail: '' }
  if (r.code === 0) return { state: 'ok', detail: '' }
  return { state: 'daemon_down', detail: r.error ?? lastLine(r.stderr) }
}

async function requireDocker(docker: DockerRunner): Promise<void> {
  const s = await dockerState(docker)
  if (s.state !== 'ok') throw dockerProblem(s.state, s.detail)
}

async function inspect(docker: DockerRunner, name: string): Promise<ContainerInfo | undefined> {
  const r = await docker(dockerArgs.inspect(name))
  if (r.code === 0) {
    const info = parseInspect(r.stdout)
    if (info === undefined) {
      throw new SearchHoleError(
        'engine_failed',
        'Docker returned container details in a shape this version does not understand.',
        {
          fix: `Remove the container and start again: docker rm -f ${name}; searchhole searxng up`,
        },
      )
    }
    return info
  }
  if (/no such (container|object)/i.test(r.stderr)) return undefined
  throw new SearchHoleError(
    'engine_failed',
    `Docker could not inspect ${name}: ${r.error ?? lastLine(r.stderr)}`,
    {
      fix: 'Run `searchhole searxng status` and check that Docker is running.',
    },
  )
}

function matches(info: ContainerInfo, port: number): { image: boolean; port: boolean } {
  return {
    image: info.image === SEARXNG_IMAGE,
    port: info.hostIp === '127.0.0.1' && info.hostPort === port,
  }
}

/** A hint when the engine URL in settings does not point at the managed container. */
function urlNote(ctx: SearxngContext): string | undefined {
  if (ctx.engineUrl === null) return undefined
  const want = baseUrl(ctx.port)
  return ctx.engineUrl.replace(/\/+$/, '') === want
    ? undefined
    : `settings.yaml sets engines.searxng.url to ${ctx.engineUrl}, but this container answers at ${want}. Set engines.searxng.url to match.`
}

/** Reports docker, container and health state without changing anything. */
export async function searxngStatus(ctx: SearxngContext, deps: SearxngDeps): Promise<SearxngStatus> {
  const url = baseUrl(ctx.port)
  const base = {
    name: SEARXNG_CONTAINER,
    port: ctx.port,
    url,
    dataDir: ctx.dataDir,
    managed: ctx.managed,
  }
  const d = await dockerState(deps.docker)
  if (d.state !== 'ok') {
    return {
      ...base,
      docker: d.state,
      container: 'absent',
      imageMatches: false,
      portMatches: false,
      healthy: false,
    }
  }
  const info = await inspect(deps.docker, SEARXNG_CONTAINER)
  if (info === undefined) {
    return {
      ...base,
      docker: 'ok',
      container: 'absent',
      imageMatches: false,
      portMatches: false,
      healthy: false,
    }
  }
  const m = matches(info, ctx.port)
  const healthy = info.running ? await deps.probeHealth(`${url}/healthz`) : false
  return {
    ...base,
    docker: 'ok',
    container: info.running ? 'running' : 'stopped',
    imageMatches: m.image,
    portMatches: m.port,
    healthy,
  }
}

async function waitHealthy(ctx: SearxngContext, deps: SearxngDeps): Promise<void> {
  const url = `${baseUrl(ctx.port)}/healthz`
  const deadline = deps.now() + (deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
  for (;;) {
    if (await deps.probeHealth(url)) return
    const info = await inspect(deps.docker, SEARXNG_CONTAINER)
    if (info === undefined || !info.running) {
      const logs = await deps.docker(dockerArgs.logs(SEARXNG_CONTAINER))
      throw new SearchHoleError(
        'engine_failed',
        `SearXNG stopped right after it started${lastLine(logs.stdout + logs.stderr) === '' ? '' : ` (last log line: ${lastLine(logs.stdout + logs.stderr)})`}.`,
        { fix: `Read the logs with: docker logs ${SEARXNG_CONTAINER}` },
      )
    }
    if (deps.now() >= deadline) {
      throw new SearchHoleError(
        'engine_failed',
        `SearXNG is running but did not answer ${url} within ${Math.round((deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS) / 1000)} seconds.`,
        { fix: `Check the logs with: docker logs ${SEARXNG_CONTAINER}` },
      )
    }
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS)
  }
}

async function ensureImage(deps: SearxngDeps): Promise<'present' | 'pulled' | 'declined'> {
  const have = await deps.docker(dockerArgs.imageInspect(SEARXNG_IMAGE))
  if (have.code === 0) return 'present'
  if (!(await deps.confirmPull())) return 'declined'
  deps.say(`Downloading the SearXNG image (${SEARXNG_PULL_SIZE})…`)
  const pulled = await deps.docker(dockerArgs.pull(SEARXNG_IMAGE), {
    timeoutMs: 15 * 60_000,
    onOutput: (chunk) => deps.say(chunk.replace(/\s+$/, '')),
  })
  if (pulled.code !== 0) {
    throw new SearchHoleError(
      'engine_failed',
      `Docker could not download the SearXNG image: ${pulled.error ?? (lastLine(pulled.stderr) || 'unknown error')}.`,
      {
        fix: 'Check your network connection and that Docker is signed in if your registry needs it, then run this again.',
      },
    )
  }
  return 'pulled'
}

async function createContainer(ctx: SearxngContext, deps: SearxngDeps): Promise<void> {
  const args = buildRunArgs({
    name: SEARXNG_CONTAINER,
    image: SEARXNG_IMAGE,
    port: ctx.port,
    dataDir: ctx.dataDir,
    ...(deps.user === undefined ? {} : { user: deps.user }),
  })
  const r = await deps.docker(args, { timeoutMs: 60_000 })
  if (r.code === 0) return
  const why = r.error ?? lastLine(r.stderr)
  if (/port is already allocated|address already in use|bind for/i.test(r.stderr)) {
    throw new SearchHoleError('engine_failed', `Port ${ctx.port} is already in use on 127.0.0.1.`, {
      fix: 'Set searxng.port in settings.yaml (and engines.searxng.url to match), then run: searchhole searxng apply',
    })
  }
  throw new SearchHoleError('engine_failed', `Docker could not start SearXNG: ${why}.`, {
    fix: `Run \`docker logs ${SEARXNG_CONTAINER}\` or \`searchhole searxng status\` for detail.`,
  })
}

function requireManaged(ctx: SearxngContext): void {
  if (!ctx.managed) {
    throw new SearchHoleError(
      'config_invalid',
      'Managed SearXNG is turned off in settings.yaml (searxng.managed: false).',
      {
        fix: 'Set searxng.managed to true, or run your own SearXNG and set engines.searxng.url.',
      },
    )
  }
}

/**
 * Starts the container: writes the overlay, downloads the image once (asking first), runs
 * it, and waits for `/healthz`. A matching running container is left as it is. With
 * `recreate`, an existing container is replaced (used by `apply`).
 */
export async function searxngUp(
  ctx: SearxngContext,
  deps: SearxngDeps,
  opts: { recreate?: boolean } = {},
): Promise<UpResult> {
  requireManaged(ctx)
  await requireDocker(deps.docker)
  const overlay = writeOverlay(ctx.dataDir, deps.newSecret)
  const url = baseUrl(ctx.port)
  const notes: string[] = []
  const note = urlNote(ctx)
  if (note !== undefined) notes.push(note)

  const info = await inspect(deps.docker, SEARXNG_CONTAINER)
  const fit = info === undefined ? undefined : matches(info, ctx.port)
  const reusable = fit?.image === true && fit.port && !overlay.changed && opts.recreate !== true
  if (info !== undefined && reusable) {
    if (info.running) {
      await waitHealthy(ctx, deps)
      return { kind: 'already-running', url, notes }
    }
    const started = await deps.docker(dockerArgs.start(SEARXNG_CONTAINER))
    if (started.code === 0) {
      await waitHealthy(ctx, deps)
      return { kind: 'started', url, pulled: false, secretCreated: overlay.secretCreated, notes }
    }
    // A container that will not start is replaced below.
  }

  const image = await ensureImage(deps)
  if (image === 'declined') return { kind: 'declined' }
  if (info !== undefined) {
    const removed = await deps.docker(dockerArgs.remove(SEARXNG_CONTAINER))
    if (removed.code !== 0) {
      throw new SearchHoleError(
        'engine_failed',
        `Docker could not replace the old ${SEARXNG_CONTAINER} container: ${removed.error ?? lastLine(removed.stderr)}.`,
        { fix: `Remove it yourself: docker rm -f ${SEARXNG_CONTAINER}` },
      )
    }
  }
  await createContainer(ctx, deps)
  await waitHealthy(ctx, deps)
  return { kind: 'started', url, pulled: image === 'pulled', secretCreated: overlay.secretCreated, notes }
}

/** Stops and removes the container. The overlay files stay. */
export async function searxngDown(deps: SearxngDeps): Promise<DownResult> {
  await requireDocker(deps.docker)
  const info = await inspect(deps.docker, SEARXNG_CONTAINER)
  if (info === undefined) return { kind: 'absent' }
  const r = await deps.docker(dockerArgs.remove(SEARXNG_CONTAINER))
  if (r.code !== 0) {
    throw new SearchHoleError(
      'engine_failed',
      `Docker could not remove ${SEARXNG_CONTAINER}: ${r.error ?? lastLine(r.stderr)}.`,
      {
        fix: `Remove it yourself: docker rm -f ${SEARXNG_CONTAINER}`,
      },
    )
  }
  return { kind: 'removed' }
}

/**
 * Rewrites the overlay and replaces the container so new settings (port, overlay) take
 * effect. Without Docker, or without a container, only the files are written.
 */
export async function searxngApply(ctx: SearxngContext, deps: SearxngDeps): Promise<ApplyResult> {
  requireManaged(ctx)
  const d = await dockerState(deps.docker)
  if (d.state !== 'ok') {
    const o = writeOverlay(ctx.dataDir, deps.newSecret)
    return { kind: 'files-only', path: o.path, secretCreated: o.secretCreated, reason: 'no-docker' }
  }
  const info = await inspect(deps.docker, SEARXNG_CONTAINER)
  if (info === undefined) {
    const o = writeOverlay(ctx.dataDir, deps.newSecret)
    return { kind: 'files-only', path: o.path, secretCreated: o.secretCreated, reason: 'not-created' }
  }
  const up = await searxngUp(ctx, deps, { recreate: true })
  if (up.kind === 'declined') {
    throw new SearchHoleError('engine_failed', 'The SearXNG image is missing and was not downloaded.', {
      fix: 'Run `searchhole searxng up` to download it.',
    })
  }
  return { kind: 'recreated', url: up.url, notes: up.notes }
}

// ── Real dependencies ────────────────────────────────────────────────────

/** GET with a short timeout; true for any 2xx. */
export async function probeHealthHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

/** `uid:gid` of this process on Linux (so the 0600 overlay is readable inside the container); undefined elsewhere. */
export function currentUser(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'linux') return undefined
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`
}
