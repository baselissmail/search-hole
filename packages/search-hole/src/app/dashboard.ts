// SPDX-License-Identifier: Apache-2.0
/**
 * The dashboard's reads and its settings writes (ADR-0020). Reads go through the store's
 * read path; settings writes take the same file lock as the CLI and are validated as a whole
 * file before anything is written, so a bad value never lands in settings.yaml.
 */
import { SearchHoleError } from '../shared/errors.ts'
import { loadSettings, setSettingsValue, updateSettingsFile } from '../shared/settings.ts'
import type { SourceType } from '../shared/types.ts'
import type { AppContext } from './context.ts'
import { entryOf } from './logview.ts'
import type { DashboardApi, SearchMode, SettingsPatch, SettingsView } from './types.ts'

const DAY_MS = 24 * 60 * 60_000
const PAGE_DEFAULT = 100
const PAGE_MAX = 200

export interface DashboardDeps {
  ctx: AppContext
  searchMode(): Promise<{ configured: SearchMode; effective: 'engines' | 'builtin' }>
  setMode(mode: SearchMode): Promise<void>
  /** Re-reads settings.yaml after a write. */
  reloadSettings(): void
  /** Picks up edits made elsewhere before a read. */
  freshSettings(): void
}

const MODES: readonly string[] = ['auto', 'builtin', 'engines']
const HYGIENE: readonly string[] = ['block', 'redact', 'off']
/** Allowed paths with their value check; the schema then validates the whole file. */
const PATCHABLE: Readonly<Record<SettingsPatch['path'], (v: unknown) => boolean>> = {
  mode: (v) => typeof v === 'string' && MODES.includes(v),
  'queryHygiene.mode': (v) => typeof v === 'string' && HYGIENE.includes(v),
  'queryHygiene.hosts': (v) => typeof v === 'string' && HYGIENE.includes(v),
  'limits.searchesPerTurn': Number.isInteger,
  'limits.searchesPerHour': Number.isInteger,
  'limits.repeatQuery': Number.isInteger,
  'retention.days': Number.isInteger,
  'hooks.receiptLine': (v) => typeof v === 'boolean',
  'lists.autoUpdate': (v) => typeof v === 'boolean',
}

const clampInt = (v: number | undefined, lo: number, hi: number, fallback: number): number =>
  v === undefined || !Number.isFinite(v) ? fallback : Math.min(hi, Math.max(lo, Math.trunc(v)))

export function createDashboardApi(d: DashboardDeps): DashboardApi {
  const { ctx } = d

  const view = async (): Promise<SettingsView> => {
    d.freshSettings()
    const s = ctx.settings.settings
    return {
      mode: await d.searchMode(),
      queryHygiene: { mode: s.queryHygiene.mode, hosts: s.queryHygiene.hosts },
      limits: { ...s.limits },
      retention: { days: s.retention.days },
      hooks: { receiptLine: s.hooks.receiptLine, guard: s.hooks.guard },
      lists: { autoUpdate: s.lists.autoUpdate },
      locked: [...(ctx.settings.loaded?.locked ?? []), ...(ctx.env.SEARCHHOLE_MODE?.trim() ? ['mode'] : [])],
      paths: { config: ctx.roots.config, data: ctx.roots.data },
    }
  }

  return {
    async page(opts) {
      const store = await ctx.store.read()
      if (!store) return { items: [], nextBefore: null, maxId: 0 }
      const limit = clampInt(opts.limit, 1, PAGE_MAX, PAGE_DEFAULT)
      // `after` (the polling fallback) takes the oldest `limit` newer rows, so a client that
      // moves its cursor to the newest one it got never skips a gap; shown newest first.
      const rows =
        opts.after !== undefined && opts.hiddenOnly !== true
          ? store.searchLog.after(opts.after, limit).reverse()
          : store.searchLog.recent({
              limit,
              hiddenOnly: opts.hiddenOnly === true,
              ...(opts.before === undefined ? {} : { beforeId: opts.before }),
              ...(opts.after === undefined ? {} : { afterId: opts.after }),
            })
      const last = rows.at(-1)
      return {
        items: rows.map(entryOf),
        nextBefore: opts.after === undefined && rows.length === limit && last !== undefined ? last.id : null,
        maxId: store.tailState().maxId,
      }
    },

    async tail(after, limit) {
      const store = await ctx.store.read()
      if (!store) return { items: [], maxId: 0, epoch: 0 }
      const state = store.tailState()
      return {
        items: store.searchLog.after(after, clampInt(limit, 1, PAGE_MAX, PAGE_MAX)).map(entryOf),
        maxId: state.maxId,
        epoch: state.epoch,
      }
    },

    async overview(days) {
      const n = clampInt(days, 1, 90, 7)
      const store = await ctx.store.read()
      const o = store?.searchLog.overview(ctx.now() - n * DAY_MS)
      return {
        days: n,
        searches: o?.searches ?? 0,
        builtin: o?.builtin ?? 0,
        kept: o?.kept ?? 0,
        hidden: o?.hidden ?? 0,
        engines: [...(o?.engines ?? [])],
        topHidden: [...(o?.topHidden ?? [])],
        sourceTypes: { ...(o?.sourceTypes ?? {}) } as Partial<Record<SourceType, number>>,
        mode: await d.searchMode(),
        version: ctx.version,
      }
    },

    settingsView: view,

    async patchSettings(patch) {
      // hasOwn: a path such as "constructor" must not find an inherited function.
      const check = Object.hasOwn(PATCHABLE, patch.path) ? PATCHABLE[patch.path] : undefined
      if (check === undefined || !check(patch.value)) {
        throw new SearchHoleError('invalid_argument', `Can't set ${String(patch.path)} from the dashboard.`, {
          fix: 'Edit settings.yaml for anything else.',
        })
      }
      if (patch.path === 'mode') {
        await d.setMode(patch.value)
        return view()
      }
      const path = patch.path.split('.')
      await updateSettingsFile(
        ctx.layout.settings,
        (current) => {
          const next = setSettingsValue(current, path, patch.value)
          loadSettings(next) // throws config_invalid with the field and reason
          return next
        },
        { lockPath: ctx.layout.settingsLock },
      )
      d.reloadSettings()
      return view()
    },
  }
}
