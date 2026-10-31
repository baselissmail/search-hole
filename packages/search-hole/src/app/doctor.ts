// SPDX-License-Identifier: Apache-2.0
/**
 * `searchhole doctor` (ADR-0006, ADR-0015, ADR-0017, ADR-0018): Node, roots, store mode,
 * settings and rules, project trust, engines with key sources and health, Docker, SearXNG
 * reachability and Claude Code hints. Every check is bounded in time and never throws.
 */
import { existsSync } from 'node:fs'
import { nodeRunCommand } from '../shared/keys/spawn.ts'
import { findPopulatedRoots } from '../shared/paths.ts'
import type { AppContext } from './context.ts'
import type { Engines } from './engines.ts'
import type { RulesService } from './rules.ts'
import type { DoctorCheck, DoctorReport, EngineStatus, SearchMode } from './types.ts'

/** ADR-0002 (amended): the bundled undici 8 needs zlib zstd, added in 22.19. */
const MIN_NODE = [22, 19] as const
const DOCKER_TIMEOUT_MS = 3000
const SEARXNG_TIMEOUT_MS = 2000
/** The oldest Claude Code with every hook feature search-hole uses (ADR-0014 point 7). */
export const MIN_CLAUDE_CODE = '2.1.296'

export interface DoctorDeps {
  ctx: AppContext
  engines: Engines
  rules: RulesService
  searchMode: () => Promise<{ configured: SearchMode; effective: 'engines' | 'builtin' }>
}

function nodeCheck(): DoctorCheck {
  const v = process.versions.node
  const [major = 0, minor = 0] = v.split('.').map((n) => Number.parseInt(n, 10))
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
  return ok
    ? { id: 'node', status: 'ok', title: `Node.js ${v}` }
    : {
        id: 'node',
        status: 'fail',
        title: `Node.js ${v} is too old`,
        fix: `Install Node.js ${MIN_NODE.join('.')} or newer.`,
      }
}

const SETUP_FIX: Readonly<Record<string, string>> = {
  searxng: 'Start a private engine with `searchhole searxng up` (needs Docker).',
  tavily: 'Add a free key (no card): `searchhole keys set tavily`.',
  brave: 'Add a key: `searchhole keys set brave`.',
}

function engineCheck(s: EngineStatus): DoctorCheck {
  const id = `engine:${s.engine}`
  const source = s.keySource === undefined ? '' : ` · key ${s.keySource}`
  if (!s.configured) {
    const why = s.inactiveReason === 'disabled' ? 'disabled in settings' : 'not set up'
    const check: DoctorCheck = { id, status: 'info', title: `${s.engine}: ${why}` }
    const fix = SETUP_FIX[s.engine]
    if (fix !== undefined && s.inactiveReason !== 'disabled') check.fix = fix
    return check
  }
  if (s.health === 'healthy') return { id, status: 'ok', title: `${s.engine}: healthy${source}` }
  if (s.health === 'unknown')
    return { id, status: 'info', title: `${s.engine}: configured, not used recently${source}` }
  const why = s.inactiveReason ?? s.lastError ?? 'last call failed'
  const check: DoctorCheck = { id, status: 'warn', title: `${s.engine}: unhealthy (${why})${source}` }
  if (s.suspendedUntil !== undefined) check.detail = `paused until ${s.suspendedUntil}`
  if (s.lastError === 'auth') check.fix = `Set a valid key: \`searchhole keys set ${s.engine}\`.`
  else if (s.engine === 'searxng') check.fix = 'Check it runs: `searchhole searxng status`.'
  return check
}

/** Runs every check. `probe` first probes engines whose health is unknown. */
/** How far back doctor looks for duplicate-copy turns. */
const DUPLICATE_LOOKBACK_MS = 7 * 24 * 60 * 60_000

export async function runDoctor(d: DoctorDeps, opts: { probe?: boolean } = {}): Promise<DoctorReport> {
  const { ctx } = d
  const checks: DoctorCheck[] = [nodeCheck()]

  // Roots.
  checks.push({
    id: 'paths',
    status: 'info',
    title: `Data in ${ctx.roots.data}`,
    detail: `config ${ctx.roots.config} · run ${ctx.roots.run} · chosen by ${ctx.roots.source}`,
  })
  try {
    const populated = findPopulatedRoots(ctx.rootsInput)
    if (populated.length > 1) {
      checks.push({
        id: 'paths:multiple',
        status: 'warn',
        title: 'More than one search-hole data folder exists',
        detail: populated.map((r) => r.data).join(' · '),
        fix: 'Set SEARCHHOLE_HOME to one folder for every host, or move the data into one.',
      })
    }
  } catch {
    // Roots were resolved once already; a second lookup failing is not news.
  }

  // Store.
  const store = await ctx.store.read()
  if (!store) {
    const why = ctx.store.unavailableReason
    checks.push(
      why === null || !existsSync(ctx.layout.db)
        ? {
            id: 'store',
            status: 'info',
            title: 'No search history yet',
            detail: 'The database is created on the first search.',
          }
        : {
            id: 'store',
            status: 'fail',
            title: 'The search history database is unavailable',
            detail: why,
            fix: 'Move the file aside and restart, or check permissions.',
          },
    )
  } else {
    const st = store.status()
    if (st.mode === 'read-write' && st.migration !== 'pending') {
      checks.push({
        id: 'store',
        status: 'ok',
        title: `Search history: ${st.dbPath}`,
        detail: `schema ${st.schemaVersion ?? '?'}`,
      })
    } else if (st.migration === 'pending') {
      checks.push({ id: 'store', status: 'info', title: 'The database will be upgraded on the next search' })
    } else {
      checks.push({ id: 'store', status: 'warn', title: `Search history is ${st.mode}`, detail: st.message })
    }
    // ADR-0006 point 10/11: two installed copies answering one Claude Code session.
    const duplicates = store.receipts.duplicatesSince(ctx.now() - DUPLICATE_LOOKBACK_MS)
    if (duplicates > 0) {
      checks.push({
        id: 'duplicates',
        status: 'warn',
        title: 'Two copies of search-hole answered the same Claude Code session',
        detail: `${duplicates} turn${duplicates === 1 ? '' : 's'} in the last 7 days; one copy stayed quiet each time.`,
        fix: 'Keep one copy: look for a second search-hole in `claude plugin list` and a manual one in `claude mcp list`, and remove the extra.',
      })
    }
  }

  // Settings.
  const ss = ctx.settings
  if (ss.error) {
    checks.push({
      id: 'settings',
      status: 'fail',
      title: 'settings.yaml is invalid (defaults in use)',
      detail: ss.error.why,
      ...(ss.error.fix ? { fix: ss.error.fix } : {}),
    })
  } else if (ss.warnings.length > 0) {
    checks.push({
      id: 'settings',
      status: 'warn',
      title: 'settings.yaml has warnings',
      detail: ss.warnings.join(' '),
    })
  } else {
    checks.push({
      id: 'settings',
      status: 'ok',
      title: ss.loaded?.fromFile ? 'settings.yaml is valid' : 'Default settings (no settings.yaml)',
    })
  }

  // Rules.
  const g = d.rules.global(store)
  if (g.error) {
    checks.push({
      id: 'rules',
      status: g.lastGood ? 'warn' : 'fail',
      title: g.lastGood
        ? 'rules.yaml has an error; the last good rules are in force'
        : 'rules.yaml has an error; no rules are in force',
      detail: g.error.why,
      fix: 'Fix the file (search-hole never rewrites a file it cannot read).',
    })
  } else if (g.exists) {
    checks.push({ id: 'rules', status: 'ok', title: `rules.yaml: ${g.loaded?.rules.length ?? 0} rules` })
  } else {
    checks.push({
      id: 'rules',
      status: 'info',
      title: 'No global rules yet',
      fix: 'Add one with `searchhole block <domain>`.',
    })
  }
  // Lists (ADR-0022): failures, stale copies, shrink-guard and pin refusals.
  checks.push(...d.rules.lists.doctorChecks(g, store))

  const dir = d.rules.projectDir()
  if (dir !== undefined) {
    const p = d.rules.project(dir, store)
    if (p.trust === 'untrusted' || p.trust === 'changed') {
      checks.push({
        id: 'project',
        status: 'warn',
        title: 'untrusted project rules',
        detail: `${p.path} ${p.trust === 'changed' ? 'changed since you trusted it' : 'has not been trusted'}; it is ignored.`,
        fix: 'Review the file, then run `searchhole trust`.',
      })
    } else if (p.trust === 'trusted') {
      checks.push(
        p.error
          ? { id: 'project', status: 'warn', title: 'Project rules have an error', detail: p.error.why }
          : {
              id: 'project',
              status: 'ok',
              title: `Project rules trusted: ${p.loaded?.rules.length ?? 0} rules`,
            },
      )
    }
  }

  // Engines.
  if (opts.probe === true) await d.engines.probe(1500, store)
  const engines = await d.engines.status(store)
  checks.push(...engines.map(engineCheck))
  if (!engines.some((e) => e.configured)) {
    checks.push({
      id: 'engines',
      status: ctx.host === 'claude-code' ? 'info' : 'warn',
      title: 'No search engine is set up',
      detail:
        ctx.host === 'claude-code'
          ? 'Claude Code’s own WebSearch is filtered by your rules meanwhile.'
          : 'The search tool returns an error until one is set up.',
      fix: 'Start SearXNG with `searchhole searxng up`, or add a free Tavily key with `searchhole keys set tavily`.',
    })
  }

  // Docker.
  const run = ctx.seams.runCommand ?? nodeRunCommand
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: DOCKER_TIMEOUT_MS,
  })
  if (docker.error === 'ENOENT')
    checks.push({
      id: 'docker',
      status: 'info',
      title: 'Docker not found',
      detail: 'Only needed for a managed SearXNG.',
    })
  else if (docker.code === 0)
    checks.push({ id: 'docker', status: 'ok', title: `Docker ${docker.stdout.trim().slice(0, 40)}` })
  else
    checks.push({
      id: 'docker',
      status: 'info',
      title: 'Docker is installed but not running',
      detail: docker.error === 'timeout' ? 'docker info timed out' : 'docker info failed',
    })

  // SearXNG reachability.
  const sx = ctx.settings.settings.engines.searxng
  if (sx.enabled && sx.url !== null) {
    const base = sx.url.replace(/\/+$/, '')
    const res = await d.engines.get(
      `${base}/config`,
      AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
      SEARXNG_TIMEOUT_MS,
    )
    if ('failure' in res) {
      // Not running is a normal state (it is optional): say so plainly in the engine line too.
      const status = engines.find((e) => e.engine === 'searxng')
      if (status) status.reachable = false
      const line = checks.findIndex((c) => c.id === 'engine:searxng')
      if (line >= 0 && status?.health !== 'unhealthy') {
        checks[line] = {
          id: 'engine:searxng',
          status: 'info',
          title: 'searxng: not running (optional)',
          fix: SETUP_FIX.searxng ?? 'Start it with `searchhole searxng up`.',
        }
      }
      checks.push({
        id: 'searxng',
        status: 'info',
        title: `SearXNG is not reachable at ${base}`,
        detail: res.failure.networkError,
        fix: ctx.settings.settings.searxng.managed
          ? 'Start it with `searchhole searxng up`.'
          : 'Check engines.searxng.url in settings.yaml.',
      })
    } else {
      let json = false
      try {
        json = typeof JSON.parse(res.text) === 'object'
      } catch {
        json = false
      }
      checks.push(
        res.status === 200 && json
          ? { id: 'searxng', status: 'ok', title: `SearXNG answers at ${base}` }
          : {
              id: 'searxng',
              status: 'warn',
              title: `SearXNG at ${base} answered HTTP ${res.status}`,
              fix: 'Enable `json` in search.formats (`searchhole searxng up` writes that overlay).',
            },
      )
    }
  }

  // Claude Code.
  if (ctx.host === 'claude-code' || ctx.env.CLAUDECODE === '1') {
    const mode = await d.searchMode()
    checks.push({
      id: 'claude-code:mode',
      status: 'info',
      title: `Claude Code mode: ${mode.configured} (now ${mode.effective})`,
      detail:
        mode.effective === 'builtin'
          ? 'Claude’s own WebSearch runs, filtered by your rules.'
          : 'WebSearch is steered to search-hole’s search tool.',
      fix: 'Change it with /search-hole:mode auto|builtin|engines.',
    })
    checks.push({
      id: 'claude-code:version',
      status: 'info',
      title: `Claude Code ${MIN_CLAUDE_CODE} or newer is needed for the hooks`,
      fix: 'Check with `claude --version`.',
    })
  }

  return {
    version: ctx.version,
    checks,
    engines,
    paths: { config: ctx.roots.config, data: ctx.roots.data, run: ctx.roots.run, source: ctx.roots.source },
  }
}
