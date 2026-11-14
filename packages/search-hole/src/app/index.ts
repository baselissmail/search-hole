// SPDX-License-Identifier: Apache-2.0
/**
 * `createApp`: the App facade (src/app/types.ts) over the P1 modules. The CLI and the MCP
 * gateway call only this. Construction resolves the roots and reads settings.yaml; nothing
 * else happens until a method needs it (the store opens on first use, ADR-0006/0013).
 */
import { readFileSync } from 'node:fs'
import { checkQuery as scanQuery } from '../core/hygiene.ts'
import { SearchHoleError } from '../shared/errors.ts'
import { setSettingsFileValue } from '../shared/settings.ts'
import { AVAILABLE_ENGINES, type EngineId } from '../shared/types.ts'
import {
  builtinBlockedDomains,
  checkUrl,
  filterBuiltinResults,
  recordBuiltinFetch,
  searchBudget,
  searchMode,
} from './builtin.ts'
import {
  type AppContext,
  configuredMode,
  createContext,
  loadSettingsState,
  settingsStamp,
} from './context.ts'
import { createDashboardApi } from './dashboard.ts'
import { runDoctor } from './doctor.ts'
import { Engines } from './engines.ts'
import { lazyFetcher, runFetch } from './fetch.ts'
import { ListsService } from './lists.ts'
import { logDetail, recentLog } from './logview.ts'
import { LoopGuard } from './loopguard.ts'
import { Receipts } from './receipts.ts'
import { reviewList, setReviewDismissed } from './review.ts'
import { RulesService } from './rules.ts'
import { runSearch } from './search.ts'
import { approveSuggestion, listSuggestions, rejectSuggestion, suggestRule } from './suggestions.ts'
import type { App, AppOptions, CreateApp, RequestCtx, SearchMode } from './types.ts'

export { BUILTIN_BLOCKED_DOMAINS_CAP } from './builtin.ts'
export { isReceiptId, newReceiptId } from './receipts.ts'
export type * from './types.ts'

const MODES: readonly SearchMode[] = ['auto', 'builtin', 'engines']
/** Engines that take an API key (SearXNG never does). */
/** Engines a key can be stored for: the ones this build can search with, minus keyless SearXNG. */
const KEYED_ENGINES: readonly EngineId[] = AVAILABLE_ENGINES.filter((e) => e !== 'searxng')
/** Gateway heartbeat rows are refreshed at most this often (ADR-0004). */
const HEARTBEAT_MS = 30_000

/** Builds the app. Throws `config_invalid` only when no data folder can be resolved. */
export const createApp: CreateApp = async (opts: AppOptions): Promise<App> => {
  const ctx: AppContext = createContext(opts)
  const engines = new Engines(ctx)
  if (ctx.host !== 'cli') engines.warmKeys()
  const loop = new LoopGuard(ctx.now)
  const lists = new ListsService(
    ctx,
    ctx.seams.listRefreshDelayMs === undefined ? {} : { kickDelayMs: ctx.seams.listRefreshDelayMs },
  )
  const rules = new RulesService(ctx, lists)
  const receipts = new Receipts(ctx)
  const fetcher = lazyFetcher(ctx)
  let lastHeartbeat = 0

  const heartbeat = async (): Promise<void> => {
    if (ctx.host === 'cli' || ctx.now() - lastHeartbeat < HEARTBEAT_MS) return
    const store = ctx.store.peek()
    if (store?.status().mode !== 'read-write') return
    lastHeartbeat = ctx.now()
    try {
      store.gateways.heartbeat({
        id: ctx.gatewayId,
        pid: process.pid,
        hostProfile: ctx.host,
        appVersion: ctx.version,
        schemaVersionKnown: store.status().latestSchemaVersion,
        startedAt: ctx.startedAt,
      })
    } catch {
      // A missed heartbeat only delays the dashboard's view of this gateway.
    }
  }

  const reloadSettings = (): void => {
    ctx.settings = loadSettingsState(ctx.layout.settings, ctx.env)
    engines.reconfigure()
  }
  /** A gateway lives for the whole session: pick up settings.yaml edits (CLI, skills, editor). */
  const freshSettings = (): void => {
    if (settingsStamp(ctx.layout.settings) !== ctx.settings.stamp) reloadSettings()
  }

  const builtinDeps = () => {
    freshSettings()
    return { ctx, engines, rules, receipts, loop }
  }
  /** After a real request: let a gateway refresh due lists in the background (ADR-0022). */
  const kickLists = (): void => {
    const store = ctx.store.peek()
    try {
      lists.kick(() => rules.global(store), store)
    } catch (e) {
      ctx.logger.warn({ err: e }, 'could not schedule the list refresh')
    }
  }
  /** The global rules file and the store, for list writes (the store opens for writing). */
  const listCtx = async () => {
    const st = await ctx.store.write()
    return { global: () => rules.global(st), store: async () => st, st }
  }
  const freshnessDefaults = async () =>
    rules.context(undefined, await ctx.store.read()).defaults.freshness ?? {}

  const app: App = {
    version: opts.version,
    host: opts.host,

    async search(args, rctx) {
      freshSettings()
      const out = await runSearch({ ctx, engines, rules, receipts, loop }, args, rctx)
      await heartbeat()
      kickLists()
      return out
    },

    async fetch(args, rctx) {
      freshSettings()
      const out = await runFetch({ ctx, rules, receipts, fetcher: fetcher.get }, args, rctx)
      await heartbeat()
      kickLists()
      return out
    },

    async receipt(ids, rctx) {
      const store = await ctx.store.read()
      return receipts.get(ids, rctx, store, await freshnessDefaults())
    },

    suggestRule: (input, rctx) => suggestRule({ ctx, rules }, input, rctx),

    searchMode: () => searchMode(builtinDeps()),
    builtinBlockedDomains: (rctx, query) => builtinBlockedDomains(builtinDeps(), rctx, query),
    filterBuiltinResults: async (query, results, rctx) => {
      const out = await filterBuiltinResults(builtinDeps(), query, results, rctx)
      kickLists()
      return out
    },
    checkUrl: (url, rctx) => checkUrl(builtinDeps(), url, rctx),
    recordBuiltinFetch: (url, rctx) => recordBuiltinFetch(builtinDeps(), url, rctx),
    searchBudget: async (query, rctx) => searchBudget(builtinDeps(), query, rctx),

    checkQuery(query) {
      freshSettings()
      const h = ctx.settings.settings.queryHygiene
      const r = scanQuery(query, {
        mode: h.mode,
        hosts: h.hosts,
        allow: h.allow,
        internalHosts: h.internalHosts,
        flagLoopback: h.flagLoopback,
      })
      return { action: r.action, query: r.query, classes: [...new Set(r.findings.map((f) => f.class))] }
    },

    async engineStatus() {
      freshSettings()
      return engines.status(await ctx.store.read())
    },

    async probeEngines(budgetMs) {
      freshSettings()
      const store = await ctx.store.read()
      await engines.probe(budgetMs, store)
      return engines.status(store)
    },

    async openTurn(rctx) {
      if (rctx.session !== undefined) loop.newTurn(rctx.session.key)
      return receipts.openTurn(rctx, await ctx.store.read())
    },

    async closeTurn(rctx) {
      freshSettings()
      return receipts.closeTurn(rctx, await ctx.store.read(), ctx.settings.settings.hooks.receiptLine)
    },

    async rekeySession(previousKey, rctx, source) {
      const next = rctx.session
      if (!next || next.source === 'fallback') return { movedRules: 0 }
      return { movedRules: rules.rekey(previousKey, next.key, source, await ctx.store.read()) }
    },

    rules: {
      async list(o) {
        return rules.list(o?.scope, await ctx.store.read())
      },
      add: (input, rctx) => rules.add(input, rctx, () => ctx.store.write()),
      remove: (idOrMatch, o) => rules.remove(idOrMatch, o?.scope, () => ctx.store.write()),
      async explain(url, o) {
        const store = await ctx.store.read()
        const rc = rules.context(undefined, store)
        const profile = rules.resolveProfile(rc, '', o?.profile, ctx.settings.settings.profiles_default).name
        return rules.explain(rc, url, profile, ctx.now())
      },
      async trust(projectDir) {
        return rules.trust(projectDir, await ctx.store.write())
      },
    },

    lists: {
      async list() {
        const st = await ctx.store.read()
        return lists.statuses(rules.global(st), st)
      },
      async catalog() {
        return lists.catalog(rules.global(await ctx.store.read()))
      },
      async add(input) {
        const l = await listCtx()
        return lists.add(input, l.global, l.store)
      },
      async remove(id) {
        const l = await listCtx()
        return lists.remove(id, l.global, l.store)
      },
      async setMode(id, mode) {
        const l = await listCtx()
        return lists.setMode(id, mode, l.global, l.store)
      },
      async update(ids, o) {
        const l = await listCtx()
        return lists.update(ids, o ?? {}, l.global, l.store)
      },
      async import(path, o) {
        const l = await listCtx()
        return lists.importFile(path, o, l.global, l.store)
      },
    },

    keys: {
      async set(engine, value) {
        if (!KEYED_ENGINES.includes(engine)) {
          throw new SearchHoleError('invalid_argument', `${engine} does not take an API key.`, {
            fix: `Keys are for: ${KEYED_ENGINES.join(', ')}.`,
          })
        }
        const stores = engines.keyStores()
        await stores.write.set(engine, value)
        engines.forgetKey(engine)
        return { backend: stores.write.label }
      },
      async status() {
        return Promise.all(
          KEYED_ENGINES.map(async (engine) => {
            const res = await engines.key(engine, false)
            return {
              engine,
              present: res.key !== null,
              source:
                res.key === null
                  ? res.detail === undefined
                    ? 'missing'
                    : `missing (${res.detail})`
                  : res.source,
            }
          }),
        )
      },
      async remove(engine) {
        const stores = engines.keyStores()
        const seen = new Set<object>()
        for (const s of [stores.write, ...stores.read]) {
          if (seen.has(s)) continue
          seen.add(s)
          try {
            await s.delete(engine)
          } catch (e) {
            if (s === stores.write) throw e
          }
        }
        engines.forgetKey(engine)
      },
    },

    suggestions: {
      list: () => listSuggestions({ ctx, rules }),
      approve: (id) => approveSuggestion({ ctx, rules }, id),
      reject: (id) => rejectSuggestion({ ctx, rules }, id),
    },

    log: {
      async recent(o) {
        return recentLog(await ctx.store.read(), o)
      },
      async detail(searchId) {
        return logDetail(await ctx.store.read(), searchId)
      },
    },

    review: {
      list: (o) => reviewList({ ctx, rules }, o),
      dismiss: (site) => setReviewDismissed({ ctx, rules }, site, true),
      restore: (site) => setReviewDismissed({ ctx, rules }, site, false),
    },

    settings: {
      async get() {
        freshSettings()
        const s = JSON.parse(JSON.stringify(ctx.settings.settings)) as Record<string, unknown>
        return {
          ...s,
          hosts: { 'claude-code': { mode: configuredMode(ctx) } },
          locked: [...(ctx.settings.loaded?.locked ?? [])],
        }
      },
      async setMode(mode) {
        if (!MODES.includes(mode)) {
          throw new SearchHoleError('invalid_argument', `Unknown mode "${String(mode)}".`, {
            fix: 'Use auto, builtin or engines.',
          })
        }
        await setSettingsFileValue(ctx.layout.settings, ['hosts', 'claude-code', 'mode'], mode, {
          lockPath: ctx.layout.settingsLock,
        })
        reloadSettings()
      },
    },

    doctor(o) {
      freshSettings()
      return runDoctor({ ctx, engines, rules, searchMode: () => searchMode(builtinDeps()) }, o)
    },

    async dashboardUrl() {
      try {
        const info = JSON.parse(readFileSync(ctx.layout.uiJson, 'utf8')) as { port?: unknown; pid?: unknown }
        if (typeof info.port !== 'number' || typeof info.pid !== 'number') return null
        process.kill(info.pid, 0)
        return `http://127.0.0.1:${info.port}/`
      } catch {
        return null
      }
    },

    dashboard: createDashboardApi({
      ctx,
      searchMode: () => searchMode(builtinDeps()),
      setMode: (mode) => app.settings.setMode(mode),
      reloadSettings,
      freshSettings,
    }),

    async close() {
      await lists.close()
      await fetcher.close()
      await engines.close()
      await ctx.store.close()
    },
  }
  return app
}

/** A request context for the terminal (`cli` host): no session, the cwd as project. */
export function cliRequestCtx(cwd: string): RequestCtx {
  return { projectDir: cwd }
}
