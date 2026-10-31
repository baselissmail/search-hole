// SPDX-License-Identifier: Apache-2.0
/**
 * The CLI driver: parse argv, run one command against the App facade, print, and map
 * failures to exit codes. `main.ts` wires the real process in; tests pass a fake `CliIo`
 * and fake `CliDeps`. The CLI talks to the app only through `src/app/types.ts`.
 */
import { resolve } from 'node:path'
import type { AddRuleInput, App, AppOptions, HostProfile, RequestCtx, SearchArgs } from '../app/types.ts'
import { SearchHoleError } from '../shared/errors.ts'
import { envValue } from '../shared/keys/unset.ts'
import { scrub } from '../shared/keys/validate.ts'
import { type Command, parseCommand } from './args.ts'
import { debugStack, describeError, exitCodeFor } from './errors.ts'
import { resolveActor, withActorNote } from './gate.ts'
import type { CliIo } from './io.ts'
import {
  type RenderOpts,
  renderDoctor,
  renderKeysStatus,
  renderLog,
  renderLogDetail,
  renderMode,
  renderRuleAdded,
  renderRules,
  renderRulesRemoved,
  renderSearch,
  renderSearxngStatus,
  renderSuggestions,
  renderUrlExplain,
} from './render.ts'
import type { SearxngContext, SearxngDeps } from './searxng.ts'
import { colorEnabled, createStyle } from './style.ts'
import { hasHelp, usageText } from './usage.ts'
import { VERSION } from './version.ts'

/** A running gateway: `closed` resolves once stdin has ended and resources are released. */
export interface GatewayRun {
  readonly closed: Promise<void>
}

/** What `mcp` hands the gateway (the gateway agent's `startGateway`). */
export interface GatewayStartOptions {
  host: HostProfile
  version: string
  env: Readonly<Record<string, string | undefined>>
  cwd: string
}

/** Everything the CLI reaches outside itself, replaceable in tests. */
export interface CliDeps {
  /** Opens the application facade (lazy: `help` and `version` never load it). */
  openApp(opts: AppOptions): Promise<App>
  /** Starts the stdio MCP gateway; resolves once it is serving, with a handle to wait on. */
  startGateway(opts: GatewayStartOptions): Promise<GatewayRun | undefined>
  /** Overrides for the Docker side of `searxng`. */
  searxng?: Partial<Omit<SearxngDeps, 'say' | 'confirmPull'>>
  /** IANA zone for times in output (default: local). */
  timeZone?: string
  now?: () => number
}

/** The production dependencies: the app and gateway load on first use. */
export const defaultDeps: CliDeps = {
  openApp: async (opts) => (await import('../app/index.ts')).createApp(opts),
  startGateway: async (opts) => (await import('../gateway/index.ts')).startGateway(opts),
}

/**
 * The result of one invocation. `keepAlive` is true only when the gateway is still serving
 * (`startGateway` returned no handle to wait on), so the caller must not force an exit.
 */
export interface CliOutcome {
  code: number
  keepAlive: boolean
}

const line = (io: CliIo, text: string): void => io.stdout.write(`${text}\n`)
const json = (io: CliIo, value: unknown): void => line(io, JSON.stringify(value, null, 2))

function renderOpts(io: CliIo, deps: CliDeps): RenderOpts {
  return {
    style: createStyle(colorEnabled(io.env, io.stdout.isTTY)),
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
  }
}

/** The request context the CLI gives the app: Claude Code's session (when run from a slash command) and project. */
export function requestCtx(io: Pick<CliIo, 'env' | 'cwd' | 'signal'>): RequestCtx {
  const key = envValue(io.env, 'CLAUDE_CODE_SESSION_ID')
  return {
    projectDir: envValue(io.env, 'CLAUDE_PROJECT_DIR') ?? io.cwd,
    client: { name: 'searchhole-cli', version: VERSION },
    ...(key === undefined ? {} : { session: { key, source: 'env' as const } }),
    ...(io.signal === undefined ? {} : { signal: io.signal }),
  }
}

async function withApp<T>(io: CliIo, deps: CliDeps, fn: (app: App) => Promise<T>): Promise<T> {
  const app = await deps.openApp({ host: 'cli', version: VERSION, env: io.env, cwd: io.cwd })
  try {
    return await fn(app)
  } finally {
    await app.close().catch(() => undefined)
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

async function runSearch(
  cmd: Extract<Command, { name: 'search' }>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const args: SearchArgs = {
    query: cmd.query,
    ...(cmd.depth === undefined ? {} : { depth: cmd.depth }),
    ...(cmd.profile === undefined ? {} : { profile: cmd.profile }),
    ...(cmd.engines.length === 0 ? {} : { engines: cmd.engines }),
    ...(cmd.maxAgeDays === undefined ? {} : { maxAgeDays: cmd.maxAgeDays }),
    ...(cmd.limit === undefined ? {} : { limit: cmd.limit }),
  }
  const outcome = await withApp(io, deps, (app) => app.search(args, requestCtx(io)))
  if (cmd.json) json(io, outcome)
  else line(io, renderSearch(outcome, renderOpts(io, deps), cmd.explain))
  return 0
}

async function runRule(cmd: Extract<Command, { name: 'rule' }>, io: CliIo, deps: CliDeps): Promise<number> {
  const actor = resolveActor(io, cmd.yes, 'your rules')
  const ctx = requestCtx(io)
  if (cmd.scope === 'session' && ctx.session === undefined) {
    throw new SearchHoleError('invalid_argument', 'There is no Claude Code session to attach this rule to.', {
      fix: 'Use --session from a Claude Code slash command, or choose --global or --project.',
    })
  }
  const note = withActorNote(cmd.note, actor)
  const input: AddRuleInput = {
    match: cmd.match,
    action: cmd.action,
    scope: cmd.scope,
    ...(cmd.weight === undefined ? {} : { weight: cmd.weight }),
    ...(cmd.profile === undefined ? {} : { profile: cmd.profile }),
    ...(cmd.important ? { important: true } : {}),
    ...(cmd.until === undefined ? {} : { until: cmd.until }),
    ...(note === undefined ? {} : { note }),
  }
  const rule = await withApp(io, deps, (app) => app.rules.add(input, ctx))
  if (cmd.json) json(io, rule)
  else line(io, renderRuleAdded(rule, renderOpts(io, deps)))
  return 0
}

async function runUnrule(
  cmd: Extract<Command, { name: 'unrule' }>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  resolveActor(io, cmd.yes, 'your rules')
  const removed = await withApp(io, deps, (app) =>
    app.rules.remove(cmd.target, cmd.scope === undefined ? undefined : { scope: cmd.scope }),
  )
  if (removed.length === 0) {
    throw new SearchHoleError('invalid_argument', 'No rule has that id or match text.', {
      fix: 'List your rules with `searchhole rules`.',
    })
  }
  if (cmd.json) json(io, removed)
  else line(io, renderRulesRemoved(removed, renderOpts(io, deps)))
  return 0
}

/** Rebuilds an error with `secret` removed from its text, in case a lower layer echoed it. */
function withoutSecret(error: unknown, secret: string): unknown {
  const clean = (text: string): string => scrub(text, secret)
  if (error instanceof SearchHoleError) {
    if (!`${error.why}${error.fix ?? ''}`.includes(secret)) return error
    return new SearchHoleError(
      error.code,
      clean(error.why),
      error.fix === undefined ? {} : { fix: clean(error.fix) },
    )
  }
  return error instanceof Error && error.message.includes(secret) ? new Error(clean(error.message)) : error
}

async function runKeysSet(
  cmd: Extract<Command, { name: 'keys-set' }>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  // The value comes from a hidden prompt or from stdin, never from argv (ADR-0007 point 3).
  const raw = io.stdinIsTTY
    ? await io.promptHidden(`Paste the ${cmd.engine} API key (input is hidden): `)
    : await io.readStdin()
  const key = raw.trim()
  if (key === '') {
    throw new SearchHoleError('invalid_argument', 'No key was entered.', {
      fix: io.stdinIsTTY
        ? 'Run the command again and paste the key.'
        : `Pipe the key in, for example: pbpaste | searchhole keys set ${cmd.engine}`,
    })
  }
  if (/[\r\n]/.test(key)) {
    throw new SearchHoleError(
      'invalid_argument',
      'The input has more than one line, so it is not a single key.',
      {
        fix: 'Provide only the key itself.',
      },
    )
  }
  const { backend } = await withApp(io, deps, (app) => app.keys.set(cmd.engine, key)).catch((e: unknown) => {
    throw withoutSecret(e, key)
  })
  line(
    io,
    `${renderOpts(io, deps).style.green('✓')} Stored the ${cmd.engine} key in ${backend}. Test it with: searchhole doctor --probe`,
  )
  return 0
}

async function runMode(cmd: Extract<Command, { name: 'mode' }>, io: CliIo, deps: CliDeps): Promise<number> {
  const opts = renderOpts(io, deps)
  if (cmd.mode !== undefined) {
    const mode = cmd.mode
    resolveActor(io, cmd.yes, 'your search mode')
    const info = await withApp(io, deps, async (app) => {
      await app.settings.setMode(mode)
      return app.searchMode()
    })
    if (cmd.json) json(io, info)
    else if (info.configured !== mode) {
      line(
        io,
        `${opts.style.yellow('⚠')} Saved ${mode} in settings.yaml, but SEARCHHOLE_MODE=${info.configured} in the environment overrides it. Unset it to use the saved mode.`,
      )
    } else line(io, `${opts.style.green('✓')} Mode set. ${renderMode(info, opts)}`)
    return 0
  }
  const info = await withApp(io, deps, (app) => app.searchMode())
  if (cmd.json) json(io, info)
  else line(io, renderMode(info, opts))
  return 0
}

async function runDoctor(
  cmd: Extract<Command, { name: 'doctor' }>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const report = await withApp(io, deps, (app) => app.doctor(cmd.probe ? { probe: true } : undefined))
  if (cmd.json) json(io, report)
  else line(io, renderDoctor(report, renderOpts(io, deps)))
  // A failing check is a finding, not a crash: exit 0 so a slash command still shows the report
  // (a non-zero exit aborts a Claude Code skill's shell injection). `--strict` exits 1 for scripts.
  return cmd.strict && report.checks.some((c) => c.status === 'fail') ? 1 : 0
}

async function searxngContext(
  io: CliIo,
): Promise<{ ctx: SearxngContext; settingsFile: string; offer: string }> {
  const { resolveRoots, rootLayout, systemRootsInput } = await import('../shared/paths.ts')
  const { readSettingsFile } = await import('../shared/settings.ts')
  const layout = rootLayout(resolveRoots({ ...systemRootsInput(), env: io.env }))
  const { settings } = readSettingsFile(layout.settings, { env: io.env })
  return {
    ctx: {
      dataDir: layout.searxng,
      port: settings.searxng.port,
      managed: settings.searxng.managed,
      engineUrl: settings.engines.searxng.url,
    },
    settingsFile: layout.settings,
    offer: settings.searxng.offer,
  }
}

async function runSearxng(
  cmd: Extract<Command, { name: 'searxng' }>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const sx = await import('./searxng.ts')
  const { ctx, settingsFile, offer } = await searxngContext(io)
  const opts = renderOpts(io, deps)
  const { style } = opts
  const say = (text: string): void => {
    if (text !== '') io.stderr.write(`${text}\n`)
  }
  const real = deps.searxng ?? {}
  const user = real.user ?? sx.currentUser()
  const sdeps: SearxngDeps = {
    docker: real.docker ?? sx.nodeDockerRunner,
    probeHealth: real.probeHealth ?? sx.probeHealthHttp,
    sleep: real.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: real.now ?? Date.now,
    say,
    confirmPull: async () => {
      if (cmd.yes) return true
      if (io.stdinIsTTY) {
        return io.confirm(`Download the SearXNG image (${sx.SEARXNG_PULL_SIZE}) from Docker Hub?`, true)
      }
      throw new SearchHoleError(
        'invalid_argument',
        `The SearXNG image (${sx.SEARXNG_PULL_SIZE}) is not downloaded yet and there is no terminal to ask you.`,
        { fix: 'Run `searchhole searxng up --yes` to download it.' },
      )
    },
    ...(user === undefined ? {} : { user }),
    ...(real.newSecret === undefined ? {} : { newSecret: real.newSecret }),
    ...(real.healthTimeoutMs === undefined ? {} : { healthTimeoutMs: real.healthTimeoutMs }),
    ...(real.pollMs === undefined ? {} : { pollMs: real.pollMs }),
  }
  const remember = async (answer: 'accepted' | 'declined'): Promise<void> => {
    if (offer === answer) return
    try {
      const { setSettingsFileValue } = await import('../shared/settings.ts')
      await setSettingsFileValue(settingsFile, ['searxng', 'offer'], answer)
    } catch {
      // Remembering the answer is a convenience; never fail the command over it.
    }
  }

  switch (cmd.sub) {
    case 'status': {
      const status = await sx.searxngStatus(ctx, sdeps)
      if (cmd.json) json(io, status)
      else line(io, renderSearxngStatus(status, opts))
      return 0
    }
    case 'down': {
      const result = await sx.searxngDown(sdeps)
      if (cmd.json) json(io, result)
      else if (result.kind === 'removed') {
        line(
          io,
          `${style.green('✓')} Stopped and removed ${sx.SEARXNG_CONTAINER}. Its settings stay in ${ctx.dataDir}.`,
        )
      } else line(io, `Nothing to stop: ${sx.SEARXNG_CONTAINER} does not exist.`)
      return 0
    }
    case 'up': {
      const result = await sx.searxngUp(ctx, sdeps)
      if (result.kind === 'declined') {
        await remember('declined')
        if (cmd.json) json(io, result)
        else
          line(
            io,
            'Not started. Run `searchhole searxng up` when you want a private search engine, or add a free Tavily key: searchhole keys set tavily',
          )
        return 0
      }
      await remember('accepted')
      if (cmd.json) json(io, result)
      else {
        line(
          io,
          result.kind === 'already-running'
            ? `${style.green('✓')} SearXNG is already running at ${result.url}.`
            : `${style.green('✓')} SearXNG is running at ${result.url} (container ${sx.SEARXNG_CONTAINER}, 127.0.0.1 only).`,
        )
        for (const n of result.notes) line(io, `  Note: ${n}`)
        line(io, 'Next: searchhole doctor --probe')
      }
      return 0
    }
    case 'apply': {
      const result = await sx.searxngApply(ctx, sdeps)
      if (cmd.json) json(io, result)
      else if (result.kind === 'recreated') {
        line(io, `${style.green('✓')} Settings applied; SearXNG was recreated and answers at ${result.url}.`)
        for (const n of result.notes) line(io, `  Note: ${n}`)
      } else {
        line(
          io,
          `${style.green('✓')} Wrote ${result.path}. ${result.reason === 'no-docker' ? 'Docker is not available, so no container was changed.' : 'There is no container yet; run `searchhole searxng up` to start one.'}`,
        )
      }
      return 0
    }
  }
}

async function execute(
  cmd: Command,
  io: CliIo,
  deps: CliDeps,
  state: { keepAlive: boolean },
): Promise<number> {
  const opts = renderOpts(io, deps)
  switch (cmd.name) {
    case 'help':
      if (cmd.topic !== undefined && !hasHelp(cmd.topic)) {
        throw new SearchHoleError('invalid_argument', 'There is no help page for that command.', {
          fix: 'Run `searchhole help` for the list of commands.',
        })
      }
      line(io, usageText(cmd.topic))
      return 0
    case 'version':
      if (cmd.json) json(io, { version: VERSION, node: process.version })
      else line(io, VERSION)
      return 0
    case 'search':
      return runSearch(cmd, io, deps)
    case 'rule':
      return runRule(cmd, io, deps)
    case 'unrule':
      return runUnrule(cmd, io, deps)
    case 'rules': {
      const rules = await withApp(io, deps, (app) =>
        app.rules.list(cmd.scope === undefined ? undefined : { scope: cmd.scope }),
      )
      if (cmd.json) json(io, rules)
      else line(io, renderRules(rules, opts))
      return 0
    }
    case 'explain': {
      const result = await withApp(io, deps, (app) =>
        app.rules.explain(cmd.url, cmd.profile === undefined ? undefined : { profile: cmd.profile }),
      )
      if (cmd.json) json(io, result)
      else line(io, renderUrlExplain(cmd.url, result, opts))
      return 0
    }
    case 'log': {
      const entries = await withApp(io, deps, (app) =>
        app.log.recent({ limit: cmd.limit ?? 20, ...(cmd.hidden ? { hiddenOnly: true } : {}) }),
      )
      if (cmd.json) json(io, entries)
      else line(io, renderLog(entries, opts))
      return 0
    }
    case 'log-show': {
      const detail = await withApp(io, deps, (app) => app.log.detail(cmd.searchId))
      if (detail === undefined) {
        throw new SearchHoleError('invalid_argument', `There is no search #${cmd.searchId} in the log.`, {
          fix: 'List recent searches with `searchhole log`.',
        })
      }
      if (cmd.json) json(io, detail)
      else line(io, renderLogDetail(detail, opts))
      return 0
    }
    case 'suggestions': {
      const items = await withApp(io, deps, (app) => app.suggestions.list())
      if (cmd.json) json(io, items)
      else line(io, renderSuggestions(items, opts))
      return 0
    }
    case 'approve': {
      resolveActor(io, cmd.yes, 'your rules')
      const rule = await withApp(io, deps, (app) => app.suggestions.approve(cmd.id))
      if (cmd.json) json(io, rule)
      else line(io, renderRuleAdded(rule, opts))
      return 0
    }
    case 'reject': {
      resolveActor(io, cmd.yes, 'your suggestions')
      await withApp(io, deps, (app) => app.suggestions.reject(cmd.id))
      if (cmd.json) json(io, { rejected: cmd.id })
      else line(io, `${opts.style.green('✓')} Rejected suggestion #${cmd.id}.`)
      return 0
    }
    case 'trust': {
      resolveActor(io, cmd.yes, 'which projects are trusted')
      const dir = resolve(io.cwd, cmd.dir ?? requestCtx(io).projectDir ?? io.cwd)
      const result = await withApp(io, deps, (app) => app.rules.trust(dir))
      if (cmd.json) json(io, result)
      else
        line(
          io,
          `${opts.style.green('✓')} Trusted ${result.path} (sha256 ${result.sha256.slice(0, 12)}…). Trust it again after you edit it.`,
        )
      return 0
    }
    case 'mode':
      return runMode(cmd, io, deps)
    case 'keys-set':
      return runKeysSet(cmd, io, deps)
    case 'keys-status': {
      const rows = await withApp(io, deps, (app) => app.keys.status())
      if (cmd.json) json(io, rows)
      else line(io, renderKeysStatus(rows, opts))
      return 0
    }
    case 'keys-remove': {
      resolveActor(io, cmd.yes, 'your stored keys')
      await withApp(io, deps, (app) => app.keys.remove(cmd.engine))
      line(
        io,
        `${opts.style.green('✓')} Removed the stored ${cmd.engine} key. Keys set through the environment are not affected.`,
      )
      return 0
    }
    case 'doctor':
      return runDoctor(cmd, io, deps)
    case 'searxng':
      return runSearxng(cmd, io, deps)
    case 'mcp':
      // stdout belongs to the MCP protocol from here on; the CLI prints nothing to it.
      {
        const gateway = await deps.startGateway({
          host: cmd.host,
          version: VERSION,
          env: io.env,
          cwd: io.cwd,
        })
        if (gateway === undefined) state.keepAlive = true
        else await gateway.closed
      }
      return 0
  }
}

/**
 * Runs one invocation. `argv` excludes the node and script entries. Resolves with an exit
 * code; never throws.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  deps: CliDeps = defaultDeps,
): Promise<CliOutcome> {
  const state = { keepAlive: false }
  try {
    const cmd = parseCommand(argv, (deps.now ?? Date.now)())
    const code = await execute(cmd, io, deps, state)
    return { code, keepAlive: state.keepAlive }
  } catch (e) {
    if (io.signal?.aborted === true) {
      io.stderr.write('Cancelled.\n')
      return { code: 130, keepAlive: false }
    }
    const style = createStyle(colorEnabled(io.env, io.stderr.isTTY))
    io.stderr.write(`${style.red('error:')} ${await describeError(e)}\n`)
    if (/^(debug|trace)$/i.test(io.env.SEARCHHOLE_LOG ?? '')) {
      const stack = await debugStack(e)
      if (stack !== '') io.stderr.write(`${stack}\n`)
    }
    return { code: exitCodeFor(e), keepAlive: false }
  }
}
