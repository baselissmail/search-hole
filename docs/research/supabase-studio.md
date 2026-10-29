# supabase/supabase
> Ref: `research/refs/supabase` @ 9eaae4c (2026-10-29) · License: **Apache-2.0**, root `LICENSE` ("Copyright 2024 Supabase"). Sparse checkout: `apps/studio/{components,hooks,state,lib,package.json}`, `packages/ui/{src,package.json}`, `packages/ui-patterns/`. The only LICENSE file in the checkout is the root one. `packages/ui/package.json` and `packages/ui-patterns/package.json` declare `"license": "MIT"` and `apps/studio/package.json` declares none; the inconsistency is unresolved here (upstream per-package files not visible), so treat all of it as Apache-2.0 (notice and change-marking obligations). The pnpm workspace file with the `catalog:` versions is not in the checkout, so React, Next, TanStack Router/Start/Table, Radix, Recharts, motion, zod, lucide and vitest versions are **unknown** (shown as `catalog:`).

## Purpose
Supabase Studio is the largest open-source React admin console around and has a purpose-built **Logs Explorer** (`components/interfaces/UnifiedLogs/`, 11.3k lines incl. tests): faceted filters in a sidebar, a typed filter bar, a level histogram, infinite scroll, a "Live" toggle, multi-row selection and a dockable detail panel. That is the closest published design to search-hole's Live log (§8.3). Also a rich keyboard-shortcut system and a shared `ui` / `ui-patterns` kit. Studio is mid-migration from Next.js to TanStack Start (`dev:tanstack`, `build:tanstack`, `@tanstack/react-start`, `@tailwindcss/vite 4.2.4` in `apps/studio/package.json`).

## Architecture sketch
```
Studio (Next pages router today; TanStack Start + Vite build in parallel)
  data layer: TanStack Query ~5.104.3 (infinite + count + chart queries, @/data/* not in checkout)
  URL state:  nuqs 2.7.1 (133 files) — custom adapter for TanStack Router (lib/nuqs-tanstack-adapter.tsx)
  global UI state: valtio (catalog) in state/*.ts   local prefs: localStorage via react-query (hooks/misc/useLocalStorage.ts)
  UI kit: packages/ui (shadcn on radix-ui, cva, sonner ^2.0.8, vaul ^1.1.2, cmdk ^1.1.1, react-resizable-panels ^4.6.5, motion)
          packages/ui-patterns (CommandMenu, FilterBar, Chart, EmptyStatePresentational, TimestampInfo, ShimmeringLoader...)
```
Tables: TanStack Table (catalog) for the unified logs; `react-data-grid 7.0.0-beta.47` for the legacy Logs Explorer, Realtime Inspector and Table Editor; `@tanstack/react-virtual ^3.13.24` for a few lists.

## Key modules and data flow
| Concern | Where | Note |
|---|---|---|
| Orchestrator | `UnifiedLogs/UnifiedLogs.tsx` (628 lines) | three parallel queries (rows: infinite; counts + facets; histogram), `refetchAllData()` refetches all; `getUniqueLogRows` dedupes pages by `id` |
| Row model | `UnifiedLogs.schema.ts` `columnSchema` (zod) | `id, log_type, method, pathname, level(nullable enum), status, date, timestamp, event_message, log_count, logs[], auth_user, metadata` |
| Table | `components/ui/DataTable/DataTableInfinite.tsx` | `[Joshen] JFYI this component is NOT virtualized and hence will struggle handling many data points` (l.37); rows `h-[30px]`, `text-xs`, sticky header, resizable columns, skeleton rows (default 15, `ShimmeringLoader`), "Load more" + "Showing X of Y rows"; scroll fetch with a 300 px bottom buffer |
| Virtualized variant | `components/ui/VirtualizedTable.tsx` (242 lines) | `useVirtualizer` with spacer rows and `measureElement` via `cloneElement`; used by Storage and AuditLogs tables, not by logs |
| Live | `ui/DataTable/LiveButton.tsx` | polls `fetchPreviousPage()` every `REFRESH_INTERVAL = 10_000`; turning Live on nulls `date` and `sort`; `useLiveMode` (`UnifiedLogs.hooks.ts`) remembers the start time and `getLogRowClassName` dims rows older than it (`opacity-50`) |
| Push live (other feature) | `Realtime/Inspector/useRealtimeMessages.ts` | websocket client; reducer keeps **100** newest messages (`take(sortBy(..., -timestamp), 100)`) |
| Filters | `UnifiedLogs.filters.ts`, `LogsFilterBar.tsx`, `ui/DataTable/FilterSideBar.tsx`, `ui-patterns/src/FilterBar/*` | see Config; sidebar facets carry server counts; filter bar is a pill-style typed builder (property, operator, value, async options, AND/OR groups, `useAIFilter.ts`) |
| Histogram | `ui/DataTable/TimelineChart.tsx` | Recharts stacked `Bar` by level; drag-highlight (`useChartHighlight`) sets the `date` range filter |
| Detail | `ServiceFlowPanel.tsx`, `LogsListPanel.tsx` | `ResizablePanelGroup`, dock bottom or right (`LOCAL_STORAGE_KEYS.UNIFIED_LOGS_DOCK`), min size 300/400 px |
| Selection | `ui/DataTable/rowSelection.utils.ts` `selectTableRow` + `useTableRowSelection.ts` | pure function for click / shift-range / cmd-toggle; selection resets when filters/sort/project change but **not** on paging or live updates |
| Shortcuts | `state/shortcuts/{registry.ts (573 lines),useShortcut.tsx,matchEvent.ts,state.ts}`, `registry/unified-logs.ts` | see UX |
| Timestamps | `ui-patterns/src/TimestampInfo/index.tsx` | tooltip rows UTC / local / relative / raw unix-micro, click-to-copy, optional timezone override via provider, shows browser TZ when overridden |
| Empty/error | `ui-patterns/src/EmptyStatePresentational`, `ui/NoSearchResults.tsx`, `ui/AlertError`, `Settings/Logs/LogsTableEmptyState.tsx` | "No results found" + "Reset filter" button; first-use empty state with icon, title, description, one action |

## Data model and storage
No local DB; Postgres/Logflare queries sit behind `@/data/logs/*` (not in checkout). Client persistence: `localStorage` through `useLocalStorageQuery` (react-query keyed `['localStorage', key]` so all hooks on a key stay in sync; bails out on unchanged values to avoid update loops, `hooks/misc/useLocalStorage.ts`): column visibility (`data-table-visibility`, default `{uuid:false}`), column order, dock side, resizable layout (`autoSaveId logs-layout`), per-shortcut disable map (`state/shortcuts/state.ts`). Pending table edits are an **operation queue** (`state/table-editor-operation-queue.types.ts`: `EDIT_CELL_CONTENT | ADD_ROW | DELETE_ROW`, each with `oldValue/newValue` or `originalRow` for undo) with an "undo latest" shortcut.

## Config format
URL schema is declared once as nuqs parsers (`UnifiedLogs.constants.tsx` `SEARCH_PARAMS_PARSER`): repeatable `filter=column:op:value` with `op` in `eq|neq|ilike|notilike` (`UnifiedLogs.filters.ts`), `date=<ts>,<ts>` range, `sort=id.desc`, `size` (default 40), `cursor`, `direction`, `live`, `id` (open row), `user`, plus numeric slider ranges (`latency`, `timing.*`). Two-way sync between the Table's `columnFilters` state and the URL is debounced 250 ms (`useFilterSearchSync`). Tailwind v4 tokens live in a shared `config/tailwind.config.css` (not in checkout); semantic classes such as `bg-surface-100`, `text-foreground-lighter`, `bg-warning/5`, `--chart-muted`.

## Extension points (plugins, hooks)
- **Shortcut registry**: add an id to a per-surface registry file, then `useShortcut(SHORTCUT_IDS.X, cb, {enabled, registerInCommandMenu, ignoreInputs, conflictBehavior, timeout, label})`. Registry entry = `{id, label, sequence, options, showInSettings, referenceGroup}`.
- **Command menu** (`ui-patterns/CommandMenu`): `useRegisterCommands(section, commands, {enabled, deps, orderCommands, sectionMeta})`, so any mounted component contributes commands only while mounted.
- `ui-patterns/FilterBar` properties accept `options` as array, sync fn, async fn or a custom React component (used for the time-range picker), each with its own operator list.

## Rules / lists: parsing and compilation
n/a — dashboard UI ref; the filter URL codec above is the only "grammar" (split on `:`, rest joined so values may contain colons).

## Testing strategy
Vitest (`catalog:`) with `@testing-library/react ^16.3.3`, `jest-dom`, `user-event`, `msw ^2.3.0`, `next-router-mock`; **669** `*.test.ts(x)` files in `apps/studio` and 52 in `packages` (co-located next to sources, e.g. `UnifiedLogs.filters.test.ts`, `UnifiedLogs.queries.test.ts`, `rowSelection.utils.test.ts`, `nuqs-tanstack-adapter.test.ts`, `ServiceFlowPanel.test.ts`). Pure logic is split into `*.utils.ts` precisely so it is unit-testable. No Storybook (0 stories). `lint:ratchet` (`eslint-config-supabase/ratchet-eslint-rules.ts`) lets rule violations only go down. Evals use Braintrust for the AI assistant (irrelevant).

## UX patterns worth copying
- **Single shortcut registry + live cheat sheet**: `ShortcutsReferenceSheet.tsx` is built from `useHotkeyRegistrations()`, so it should list only shortcuts currently mounted (inferred from the hook), grouped via `referenceGroup`. Users can disable each shortcut (`showInSettings`). `eventMatchesAnyShortcut` (`matchEvent.ts`) only suppresses default browser behaviour for shortcuts that are currently enabled.
- **Logs keymap** (`registry/unified-logs.ts`): Up/Down previous/next row, Shift+Up/Down extend selection, `Escape` closes the panel (`conflictBehavior: 'allow'` for an Escape ladder), `Shift+R` refresh, `Shift+E` export, `Shift+F` focus filter, chord `F` then `C` clear filters, `Mod+J` live, `Mod+B` filter sidebar, `Mod+U` reset columns, `Mod+.` reset focus. Command menu is `Mod+K`; a doc comment in `useShortcut.tsx` still says Cmd+P (stale).
- **Open row in the URL** (`id` param) with a fallback fetch if the row is not in the loaded pages (`selectedLogQuery` appended to table data), so deep links survive filters/paging.
- **Auto-hide empty columns** (`shouldHideColumn` in `UnifiedLogs/components/Columns.tsx`) and a column popover with search + drag reorder (dnd-kit), persisted per view key.
- **Fade, don't blank, on refetch**: `opacity-60 transition-opacity` on the table while filtering (but not while paginating or live).
- **Skeleton + mask**: loading table uses `mask-image: linear-gradient(black 70%, transparent)`; `useMinimumDisplayTime` (`hooks/misc`) keeps a value on screen for at least N ms to prevent flashes.
- Header labels in mono `text-xs`, tabular dates (`font-mono tracking-tight`), 30 px rows: the "data typography" of §8.4.6.
- **Counter-example**: the level column is a colour-only 6 px dot (`LogLevelDot.tsx`, `DataTableColumnLevelIndicator.tsx`), which fails §8.4.7 (colour + icon + word).
- Export: JSON/CSV with `toast.success('Downloading logs as ...')` (`DownloadLogsButton.tsx`).
- Responsive: filter sidebar becomes a drawer below the `sm` breakpoint (`DataTableFilterControlsDrawer`).

## Performance tricks
- Parallel count/facet/histogram queries so the table is not blocked by aggregation; stable `useMemo` query keys that drop nulls and `live`.
- `useLocalStorageQuery` no-op bailout; `useLatest` for callbacks in shortcut hooks to avoid re-registration churn; `useDebounce(…, 250)` before writing filters to the URL.
- The main logs table is knowingly unvirtualized; the repo's own answer for big lists is `VirtualizedTable` (spacer rows). A fixed `RingBuffer` (`lib/ringBuffer.ts`) exists for bounded buffers.

## License and what it means for us
Apache-2.0 allows copying with the licence text, retained notices and a statement of changes. Safe to adapt: `rowSelection.utils.ts`, shortcut-registry design, `VirtualizedTable.tsx`, `useLocalStorageQuery`, `TimestampInfo` (re-implement on `Intl`, we do not want dayjs), filter codec. Do not copy Supabase logos, brand assets, copy text, or anything that imports `common`/`@/data` (not in checkout). `components/ui/DataTable/*` (provider, `filterFields`, `LiveButton`, `TimelineChart`, "REMINDER:" comments) looks adapted from an upstream open-source data-table template (inferred from structure; no attribution header in the files read), so check provenance before lifting wholesale.

## Implications for search-hole
- [ui-ux] Model the Live log on `UnifiedLogs`: sidebar facets with counts, typed filter bar, level/decision histogram that doubles as a time-range brush, detail panel docked right/bottom, selection that survives live updates, open row in the URL.
- [ui-ux] Studio's own table is **not** virtualized and carries a comment saying so; §8.1's "smooth with 100k+ rows" therefore needs `TanStack Virtual` + spacer rows (`VirtualizedTable.tsx`) or Infisical's `TableVirtualBody`, on top of server-side paging, not a port of `DataTableInfinite`.
- [dashboard-process-model] Even Supabase's logs "Live" is polling (10 s via `fetchPreviousPage`) and Realtime is a websocket; our SSE tail is not copied from anywhere, so budget a spike and keep Supabase's rule that enabling Live clears sort and date range.
- [ui-ux] URL state: nuqs is used in 133 Studio files and Studio had to write its **own TanStack Router adapter and search codec** (`lib/nuqs-tanstack-adapter.tsx`, `lib/router-search-params.ts`) because TanStack's default search serialisation is JSON-first (coerces `"2"` to 2, quotes JSON-looking strings, no repeated keys) and the stock adapter appends a trailing slash and strips `%0A`. Decide early: typed TanStack Router `validateSearch` with a custom `parseSearch/stringifySearch`, or nuqs; do not leave defaults.
- [ui-ux] Filter URL grammar `filter=column:op:value` (repeatable, rest-of-string value) is a readable, shareable encoding that fits our `host:eq:pinterest.com` / `decision:eq:hidden` filters.
- [ui-ux] Adopt a central `SHORTCUT_DEFINITIONS` registry keyed `"<surface>.<action>"` plus `useShortcut` that auto-registers into the ⌘K menu and a generated `?` cheat sheet; this is how §8.4.1's verbs (`b t p l r ?`) stay discoverable and rebindable. Studio uses `@tanstack/react-hotkeys ^0.10.0` (sequences, `ignoreInputs`, conflict modes); the plan's 0.17.0 is newer and unverified here.
- [ui-ux] Stack check vs §8.2: sonner ^2.0.8 and cmdk ^1.1.1 match exactly; `vaul` is used in exactly one file (`packages/ui/.../drawer.tsx`), consistent with "avoid vaul"; `motion/react` is imported 70 times; **no** Base UI import, **no** uPlot, no React Compiler, Recharts in 19 files, Tailwind `@tailwindcss/vite 4.2.4`.
- [ui-ux] Undo instead of confirm: Studio queues edits (`QueuedOperationType`) with an undo shortcut; a "pending rule changes" queue plus `undoLatest` is a good model for the Suggestions inbox and bulk rule edits.
- [testing] Co-located `*.test.ts` for every pure helper, `msw` for network, `ratchet` lint; prefer this for the dashboard's filter codec, selection reducer and shortcut matching (cheap, deterministic) and add axe/Playwright on top.
- [security] The Logs Explorer paths read (`UnifiedLogs/`, `Settings/Logs/`, `ui/DataTable/`) contain no `dangerouslySetInnerHTML` (grep: 3 files in all of `components/`, none there); keep that rule for snippets/titles.

## Borrow / avoid
**Borrow**
- `selectTableRow` (pure selection reducer) and `useTableRowSelection` scoping rule.
- Shortcut registry + `useShortcut` + generated reference sheet + `eventMatchesAnyShortcut`.
- `VirtualizedTable` spacer-row virtualization.
- Filter codec (`logsFiltersToUrlParams` / `parseLogsFilterUrlParams`) and the debounced URL sync.
- `useLocalStorageQuery` shape; `useMinimumDisplayTime`; `shouldHideColumn`; `TimestampInfo` tooltip rows.
- Docked, resizable detail panel with persisted side.

**Avoid**
- A non-virtualized `DataTableInfinite` for 100k rows; "Load more" as the only scroll model.
- Colour-only level dots.
- Two table engines (TanStack Table and react-data-grid) in one product.
- Depending on `catalog:` workspace versions, valtio + nuqs + react-query-for-localStorage all at once (three state systems).
- A custom router search codec unless needed; start with a decision and a test (`router-url-shape.test.tsx` pattern).
