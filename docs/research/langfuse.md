# langfuse/langfuse
> Ref: `research/refs/langfuse` @ b1067f3 (2026-10-28) · License: **MIT ("Expat") with an Enterprise carve-out.** Root `LICENSE` ("Copyright (c) 2023-2026 ClickHouse, Inc.") says everything under `ee/`, `web/src/ee/`, `worker/src/ee/` and `packages/shared/src/server/ee/` is under `ee/LICENSE` (the commercial "Langfuse Enterprise license"). Everything else is MIT (third-party components keep their own licenses). The EE directories hold `web/src/ee/features/{admin-api,audit-log-viewer,billing,multi-tenant-sso,sfdc-sync,sso-settings,ui-customization,verified-domains}`, `worker/src/ee/{dataRetention,cloudUsageMetering,…}` and `packages/shared/src/server/ee/{ingestionMasking,fips,licenseCheck,clickhouseBilling}`. `.agents/skills/skill-creator/license.txt` belongs to a vendored agent skill and is irrelevant. Root `package.json` `"version": "4.71.0"`, `"license": "MIT"`.

## Purpose
Langfuse is an open-core LLM observability platform: traces, observations/spans, sessions, scores, evals, prompts and datasets. It is the best open-source reference for a **dense trace/log explorer in React**. It shows how to build data tables with filters in the URL, a peek (side detail) panel with j/k navigation, saved views, a virtualized span tree and a log view. That matches the search-hole dashboard's Live log, its expandable search→results rows, and the later Sessions/receipts view (§8.3). Its backend (Postgres + ClickHouse + Redis/BullMQ + S3, two services) is far heavier than we need. It is mostly useful as a list of what **not** to build for a single-user local tool.

## Architecture sketch
```
SDKs / OTel ──► web (Next.js 16, /api/public ingestion) ──► S3/MinIO (raw event JSON)
                     │                                       │
                     └─ BullMQ job (Redis) "ingestion-queue" ─┘ delay 5 s (15 s near UTC midnight)
                                         ▼
                      worker (Express + BullMQ consumers, ~40 queues)
                          └─ ClickhouseWriter: batch 1000 rows / 1000 ms, 3 attempts
                                         ▼
     ClickHouse (traces, observations, scores, events…)    Postgres/Prisma (83 models: users, projects,
                                                            api keys, prompts, table_view_presets, …)
browser ◄─ tRPC v11 + React Query (polling, no push) ◄─ web
```
- `docker-compose.yml` runs six containers: `langfuse-worker`, `langfuse-web` (port 3000), `clickhouse` 25.12, `minio`, `redis:7` and `postgres:17`. Every service except web (and MinIO's S3 port 9090) binds to `127.0.0.1` (`docker-compose.yml` lines 4-5 comment, `ports: - 127.0.0.1:…`).
- Monorepo: pnpm 12.8.2 + Turbo (`package.json` `devEngines`, `turbo.json`). Workspaces are `web/`, `worker/`, `packages/{shared,icons,config-*,eslint-plugin,…}` and `ee/`, plus a Rust `ai-gateway/`.
- Web uses **both** the Pages Router (`web/src/pages/_app.tsx`) and the App Router (`web/src/app/layout.tsx`, `web/src/app/api`).

## Key modules and data flow
| Concern | Where | Notes |
|---|---|---|
| Ingestion fan-in | `packages/shared/src/server/ingestion/processEventBatch.ts` | Uploads each event batch to S3 (`getS3StorageServiceClient`), then enqueues a BullMQ job with `getDelay()`: 5 s by default, `LANGFUSE_INGESTION_QUEUE_DELAY_MS` (default 15 000, `packages/shared/src/env.ts:225`) between 23:45 and 00:15 UTC "to avoid duplicates for out-of-order processing", and 0 for OTel |
| Queue registry | `packages/shared/src/server/queues.ts: enum QueueName` (line 410) | About 45 named queues (ingestion, evals, exports, retention, webhooks, sharded secondaries…) |
| Batch writer | `worker/src/services/ClickhouseWriter/index.ts: ClickhouseWriter` | In-memory per-table queue flushed at `LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE`=1000 or every `…_WRITE_INTERVAL_MS`=1000; `…_MAX_ATTEMPTS`=3 (`worker/src/env.ts:282-293`) |
| API | `web/src/server/api/root.ts`, `routers/*.ts` (traces, observations, sessions, scores, tableViewPresets, …) | tRPC v11 + superjson |
| Traces table | `web/src/features/traces/TracesTable.tsx` | **Three separate queries**: `api.traces.all` (rows, line 529), `api.traces.countAll` (total, line 515), `api.traces.metrics` (cost/latency/scores per visible id, line 535), plus `api.traces.filterOptions` for facets (line 339). Rows and metrics are joined client-side by `components/table/utils/joinTableCoreAndMetrics.ts` |
| Data table | `web/src/components/table/data-table.tsx` (1734 lines) | TanStack Table v8, `manualPagination`, column visibility/order/pinning, row-height presets, peek integration |
| Peek panel | `web/src/components/table/peek.tsx`, `peek/README.md`, `peek/hooks/usePeekNavigation.ts` (`PEEK_PARAM = "peek"`) | Side detail panel; see UX |
| Trace detail | `web/src/features/traces/components/{Trace,TraceTree,VirtualizedTree,TraceLogView/,TraceTimelineDense/,TraceGraphView/}` | Tree, log view, d3 timeline, agent graph |
| Filters | `web/src/features/filters/hooks/useFilterState.ts`, `useSidebarFilterState.tsx`; schema `packages/shared/src/interfaces/filters.ts` | URL codec plus sessionStorage fallback |
| Saved views | `web/src/components/table/table-view-presets/` (README), server `packages/shared/src/server/services/TableViewService/` | Prisma `TableViewPreset`, `DefaultView` |
| j/k detail nav | `web/src/features/navigate-detail-pages/DetailPageNav.tsx:105-131` | Window keydown; ignores inputs, `role="textbox"` and meta/ctrl |

## Data model and storage
- **Postgres (Prisma 6.19)**: `packages/shared/prisma/schema.prisma` has 83 `model`s and 462 migration dirs (`packages/shared/prisma/migrations`). It holds the "control plane": orgs, projects, users, API keys, prompts, and the UI state that needs persisting:
  - `TableViewPreset` (line 1920): `name`, `tableName`, `filters Json`, `columnOrder Json`, `columnVisibility Json`, `searchQuery`, `orderBy Json`, `createdBy`/`updatedBy`.
  - `DefaultView` (line 1947): a per-user or per-project default view, with `viewId` deliberately un-FK'd so frontend-defined system presets (prefix `__langfuse_`) can be defaults.
- **ClickHouse**: `packages/shared/clickhouse/migrations/canonical/` has 53 up/down pairs. `0001_traces.up.sql` uses `ReplacingMergeTree(event_ts, is_deleted)`, `PARTITION BY toYYYYMM(timestamp)` and `ORDER BY (project_id, toDate(timestamp), id)`, with `bloom_filter` skip indexes on `id` and on metadata map keys/values, and `ZSTD(3)` codecs on `input`/`output`. `0002_observations.up.sql` adds `parent_observation_id`, `level`, the usage/cost maps and `type LowCardinality(String)`. Soft delete and upserts work through the version column and `is_deleted`.
- **Migration discipline**: `clickhouse/migrations/README.md` says `canonical/` holds the only templates, rendered into `clustered/` and `unclustered/`. "Keep migration version numbers and filenames stable… Their rendered output is compatibility history", and a test "locks the exact historical bytes for both generated migration trees" (`packages/shared/src/server/clickhouse/prepareMigrations.test.ts`).
- **Redis** (BullMQ, ioredis 5) for queues and caches. **S3/MinIO** for raw events and media.
- Retention lives in **EE** (`worker/src/ee/dataRetention`), so don't look there for ideas you might copy.

## Config format
- Env vars validated with zod at startup: `web/src/env.mjs`, `worker/src/env.ts`, `packages/shared/src/env.ts`. Every knob is a `z.coerce.number().positive().default(…)` (for example the batch size above). No config file.
- UI preferences live in `localStorage` (peek width `peekViewWidthFraction`, resizable layout groups `trace-layout-peek-*`) and `sessionStorage` (per-project filter fallback), per `components/table/peek/README.md` "State altitudes".

## Extension points (plugins, hooks)
- No plugin system in the UI. Extensibility goes through the public REST API (OpenAPI exported by Fern, `package.json` `openapi:export`), webhooks (`worker/src/queues/webhooks.ts`) and integrations (PostHog, Mixpanel and blob storage queues).
- `packages/langfuse-skills` and `skills-lock.json` ship agent skills for the repo. That is tooling, not product.

## Rules / lists: parsing and compilation
n/a. Langfuse has no block/allow rules. The nearest analogue is the **typed filter model**:
- `packages/shared/src/interfaces/filters.ts: filterOperators` (line 4) lists the operators per type:
  - `datetime` `> < >= <=`
  - `string` `= contains "does not contain" "starts with" "ends with" "is not empty"`
  - `stringOptions` / `categoryOptions` `"any of" "none of"`
  - `arrayOptions` adds `"all of"`
  - `number`, `stringObject` (key + value, with `"is set"/"is not set"`), `numberObject`, `booleanObject`, `boolean`
- Each type is a zod object (`timeFilter`, `stringFilter`, …) joined in `singleFilter`. The same schema compiles to ClickHouse SQL (`packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts`) and to Prisma (`packages/shared/src/server/filterToPrisma.ts`).
- **URL codec** (`web/src/features/filters/hooks/useFilterState.ts: getCommaArrayParam`, lines 38-120): each filter becomes `columnId;type;key;operator;encodeURIComponent(value)`, joined by `,` under the `filter` query param (`useQueryParam("filter", withDefault(…, sessionFilterState))`, line 165). Option arrays are `|`-joined with pipe escaping, and dates are ISO strings. Unknown columns are dropped on encode. A peek context overrides the URL store.

## Testing strategy
- Vitest workspace (`vitest.workspace.ts`, `web/vitest.config.mts`) with name-based projects:
  - `*.clienttest.ts(x)`: 555 files, jsdom component and hook tests
  - `*.servertest.ts`: 356 files
  - Storybook stories run as tests via `@storybook/addon-vitest` + `@vitest/browser-playwright`: 345 `*.stories.tsx` files
- Performance trick in the config: server tests that don't touch global state run with `isolate: false`. A regex classifies them by content (`GLOBAL_STATE_PATTERN` matches `vi.mock|spyOn|useFakeTimers|process.env… =`). The comment measured 371 s spent on imports against 264 s on tests.
- Playwright e2e in `web/src/__e2e__/*.spec.ts` (auth, create-project, onboarding-api-key, app-shell-overflow).
- `scripts/scan-client-bundle.mjs` is a post-build scanner. It parses every emitted client chunk and fails on **free identifiers** that are not browser globals. This catches minifier dropped-binding bugs and Node leakage (`require`, `process`, `Buffer`) into browser code.
- ClickHouse migration byte-lock test (see Data model).

## UX patterns worth copying
1. **Peek panel** (`components/table/peek/README.md`):
   - On desktop it is a docked-right, **non-modal** dialog over the table. The table stays interactive, and clicking another row (`[data-row-index]`) switches the peeked item in place. Escape or click-outside closes it, except for clicks inside `[data-peek-content]`, the toast layer and selection checkboxes.
   - A left-edge drag resizes it, and dragging to the far edge or pressing Expand maximizes it.
   - The default width is 50vw capped in px (`peek/store/peekPanelStore.ts: PEEK_MAX_DEFAULT_WIDTH_PX = 1400`), so huge monitors don't get a huge peek.
   - **State altitudes:** item id and `peekView=expanded` live in the URL. Width is a persisted preference in localStorage. Drag state is transient, in a per-mount zustand store, and is committed on pointer-up.
   - `PeekTableStateProvider` sits *outside* the `key={itemId}` boundary, so nested tables keep their filter, sort and page while you press j/k.
2. **j/k** moves to the previous/next item of the current list (`DetailPageNav.tsx`), with a visual "pulse" on the button the shortcut triggered (`pulseShortcut`). It ignores inputs and modifier keys so it never fights ⌘K (`features/command-k-menu/CommandMenuProvider.tsx`, cmdk).
3. **Saved views that degrade gracefully** (`table-view-presets/README.md`):
   - Removed columns are ignored.
   - Invalid filters or orderBy are dropped with a warning toast.
   - Deleted-view permalinks fall back to defaults silently.
   - On the Tracing tables, editing filters, search, sort or columns deselects the view, but no-op edits keep it.
   - "Permalink" copies `?viewId=`.
4. **Row density switch** (`components/table/data-table-row-height-switch.tsx`): Small/Medium/Large = `h-7`/`h-24`/`h-64` (28/96/256 px) plus a custom height up to 4000 px. Resizing updates only the dragged row's DOM during the drag, and commits one shared height on release (`components/table/README.md`).
5. **Faceted sidebar filters** with a summary line per facet (`components/table/FacetHeader.tsx`, `features/filters/lib/facet-display.ts`). Options come from a dedicated `filterOptions` query, not from the visible page.
6. **Setup page that polls until data arrives**: `TracesSetupPage.tsx:104-120` uses `refetchInterval: project?.hasTraces ? false : 5000`, so the empty state flips to the table automatically. That is the "empty states teach" pattern from §8.4.8.
7. **Typography and token discipline** (`web/src/styles/globals.css`):
   - Exactly two font weights (`--font-weight-regular: 400`, `--font-weight-bold: 600`); "font-medium / font-semibold… are drift".
   - Mono is IBM Plex Mono, loaded locally (`styles/fonts.ts`, `next/font/local`). The sans face is deliberately deferred: the app ships system stacks and the weight roles stay font-relative.
   - Some unused Tailwind palettes are disabled (`--color-cyan-*: initial;`, lime, sky, fuchsia, rose, neutral, stone, slate, zinc, indigo) so off-token colors can't be used. A TODO in the file says the rest (red, orange, amber, yellow, green, emerald, teal, blue, violet, purple, pink, gray) are still enabled.
   - Tailwind v4 `@theme static` / `@theme inline`, with `@custom-variant dark (&:where(.dark, .dark *))`.
8. **Design-system boundary** (`components/design-system/README.md`): presentational components only, one export per folder, compound subcomponents via `Object.assign`, and no imports from `features/`. Icons go through a typed wrapper package (`packages/icons/README.md`: `size="sm|base|lg|xl"` = 12/14/20/28 px, `base` is the default, over Lucide `^0.552.0`).
9. **Charts are hand-rolled on d3 primitives** (`d3-scale`, `d3-shape`, `d3-zoom` in `web/package.json`; `components/design-system/internal/charts/{SeriesChartCore,BarChartCore}.tsx`). **There is no Recharts dependency in this ref**, which corrects the premise in our §8.2 that "Langfuse… use… Recharts".
10. The **dense timeline** (`features/traces/components/TraceTimelineDense/TimelineDense.tsx` header comment) is driven "like a map": no scrollbars, wheel pans both axes, ⌘/ctrl+wheel and pinch zoom about the cursor, drag-box zoom, and double-click to focus an element. That fits a future receipt timeline. It is overkill for v1.

## Performance tricks
- **Big tables are paginated, not virtualized.**
  - `DataTablePagination.tsx: TRACING_PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50, 100]`, with `manualPagination` in `data-table.tsx:431`.
  - When the total count is unknown, page count comes from `hasNextPage` (`data-table.tsx:400-422`).
  - The total count is a **separate query** that can load later (`isTotalCountLoading`), and metrics are a third query keyed by the visible ids.
- **Virtualization only where lists are unbounded inside one item**:
  - `features/traces/components/VirtualizedTree.tsx`: TanStack Virtual with `getItemKey: node.id`. The cache is keyed by id, not index, because collapse/expand reorders rows and index keys made rows overlap (LFE-10591 comment).
  - `overscan = 16` **rows**. The comment notes the old value 500 "mistook it for pixels".
  - Dynamic `measureElement` via `getBoundingClientRect`, and `scrollToIndex(index, {align: isInitial ? "center" : "auto"})` so clicking a visible row never jumps the list.
  - `scrollbar-visible` avoids overlay scrollbars being cut by full-width row backgrounds.
- `features/traces/fns/flattenTree.ts` flattens the tree **iteratively with an explicit stack**, which is safe for traces 10k+ levels deep. Indent is capped to the container width (`computeMaxVisualDepth`, LFE-10959: a ~1400-level trace).
- **Conditional virtualization** in the log view (`TraceLogView.tsx` header; `features/traces/constants/traceViewConfig.ts`):
  - `virtualizationThreshold: 350`; below it every row is in the DOM with full features (JSON mode, expand-all), above it only visible rows render.
  - Row heights are 28 px collapsed and 150 px expanded.
  - Per-row I/O is **lazy-loaded on expand**, with viewport prefetch (`rootMargin: "100px"`, `debounceMs: 250`).
- The data-table body memo compares explicit table snapshots "because TanStack's table instance is mutable" (`components/table/README.md`). Row components subscribe only to their own mode or selection slice.
- Ingestion side: S3-first buffering, delayed jobs to merge out-of-order events, ClickHouse batch inserts (1000 rows / 1 s). All irrelevant at our volume.

## License and what it means for us
- MIT outside the four EE directories. We may copy short snippets (≤ 10 lines) from `web/src/components`, `web/src/features` (non-ee) and `packages/shared` (non-`server/ee`) with attribution ("Portions © ClickHouse, Inc., MIT").
- **Do not copy anything** from `ee/`, `web/src/ee/` (including `audit-log-viewer`), `worker/src/ee/` (including `dataRetention`) or `packages/shared/src/server/ee/` (including `ingestionMasking`). Those are commercially licensed. Ideas only, and even then prefer other sources for retention and audit-log UI.
- Its stack (Next.js, tRPC, Prisma, ClickHouse) is not ours, so in practice we will borrow patterns, not code.

## Implications for search-hole
- [dashboard-process-model] Langfuse's **tables and trace views have no push channel**. Tables auto-refresh by polling at fixed intervals `Off/30s/1m/5m/15m` (`components/table/utils/refresh-intervals.ts`, a `setInterval` that invalidates the queries in `TracesTable.tsx:255-258`), and the setup page polls every 5 s until the project has traces. The only SSE in the web app is the in-app agent chat stream (`features/in-app-agent/server/watchHandler.ts` returns `text/event-stream` and takes a `cursor` query param, i.e. a resumable cursor like our `Last-Event-ID` idea), which is not used for lists. Our "live but calm" Live log needs a push tail (SSE over `rowid > last`, per §4). Langfuse is evidence that a manual refresh plus an interval selector is an acceptable fallback for the non-live tables (Rules, Engines, Sources).
- [ui-ux] Split every table query into **rows (keyset page) / count / per-row metrics**, as `TracesTable.tsx:515-535` does. That way a slow `COUNT(*)` over 100k SQLite rows never blocks first paint. Show "≥ N" or a skeleton until the count arrives.
- [ui-ux] Take Langfuse's **paginate history, virtualize bounded lists** split, adapted for us:
  - **Live log**: a virtualized window over a bounded in-memory ring of the latest N searches (fixed row height in compact mode), plus keyset "load older".
  - **Expanded search** (its results): rendered without virtualization below about 350 rows, like `virtualizationThreshold: 350`.
  - **History** pages: server pagination.
  - This meets "100k rows at 60 fps" without holding 100k rows in memory.
- [ui-ux] Use **TanStack Virtual with `getItemKey` = row id and `overscan` as a row count (~10-20)**. Use `measureElement` only in expanded mode, and fixed size in compact mode (`VirtualizedTree.tsx`).
- [ui-ux] Adopt the **peek panel** model for "row → detail" (search → results, rule hits, engines):
  - non-modal, right-docked, row click switches the item, j/k moves
  - selected id in the URL (`?peek=<searchId>`), width in localStorage, expand flag in the URL
  - on mobile use the Base UI Drawer, not vaul. Langfuse still uses vaul (`peek/README.md`), and our plan says vaul is unmaintained.
- [ui-ux] Define the dashboard filter model as a **zod discriminated union by type with closed operator enums**, modeled on `packages/shared/src/interfaces/filters.ts`. One schema should feed three things: TanStack Router search-param validation, the SQL builder in `packages/store`, and the facet UI. Prefer typed search params over Langfuse's `;`/`,` string codec. A compact text syntax (see the mitmproxy note) can compile into the same AST.
- [ui-ux] Saved views (P4b) can be one SQLite table `views(id, page, name, filters_json, columns_json, order_json, created_at)` with **validate-on-apply and drop unknown parts with a toast**. Langfuse needed `TableViewPreset` + `DefaultView` in Postgres; we don't need users or projects.
- [ui-ux] The design-token discipline is cheap and fits the Impeccable/Vercel audits:
  - two weights
  - mono for data
  - disable unused Tailwind v4 palettes in `@theme`
  - one typed icon wrapper with 3 sizes
- [ui-ux] §8.2 says Langfuse uses Recharts. This ref uses **d3 primitives in its own design system** instead. That doesn't change our pick (shadcn charts + uPlot), but SYNTHESIS should correct the claim.
- [upgrades-migrations] Borrow the **byte-lock on shipped migrations**, but note what Langfuse actually locks. `prepareMigrations.test.ts` feeds the rendered files for migrations 0001-0047 (94 files, `up` and `down`) into one SHA-256 per mode (clustered, unclustered) and compares it with a hard-coded hash (`historicalMigrationCount = 94`, `historicalMigrationVersion = 47`). Later migrations (0048-0053) are not locked, and the point of the lock is to prove the template renderer still produces the historical bytes, not to police each file. The README rule is that shipped files keep their numbers and names and change only as a deliberate forward fix. For us: hash every released migration file (a manifest of per-file hashes gives a better failure message than one aggregate) and fix mistakes with a new forward migration. Langfuse itself ships `down` files, so "no `down` files" is our choice, not theirs.
- [sqlite-driver] Langfuse's two-store split (Postgres control plane vs ClickHouse append-only events with `ReplacingMergeTree` versioning and monthly partitions) maps to two table families in **one** SQLite file:
  - mutable config tables: `rules`, `lists`, `suggestions`, `views`
  - append-only, retention-pruned event tables: `searches`, `results`, `fetches`
  - Monthly partitioning becomes an indexed `created_at` + batched `DELETE … WHERE created_at < ?`.
  - No ClickHouse, no Redis, no S3.
- [testing] Copy two cheap CI guards:
  - (1) a **post-build client-bundle scanner** for free identifiers and Node globals (`scripts/scan-client-bundle.mjs`). It is relevant because we bundle the dashboard and the MCP App with Vite/Rolldown.
  - (2) split Vitest projects by environment (jsdom vs node), with `isolate: false` where safe.
  - Storybook-as-tests (`@storybook/addon-vitest`) fits our Storybook 10 + addon-a11y plan.
- [other] Overkill, don't build: BullMQ/Redis queues, S3 event buffering with midnight delays, ClickHouse writer batching, tRPC, Next.js SSR, multi-tenant RBAC, the ~45 queues. Our single-user volume (hundreds of searches a day) needs one SQLite writer per process and a WAL.

## Borrow / avoid
**Borrow**
- Peek panel semantics: non-modal, row click switches, j/k, URL-owned id/expanded, localStorage width, a state provider outside the remount key (`components/table/peek/README.md`).
- Separate rows/count/metrics queries (`features/traces/TracesTable.tsx`).
- Virtualizer settings: id-keyed cache, overscan as rows, scroll-selected-into-view with `align: "auto"` (`features/traces/components/VirtualizedTree.tsx`).
- Iterative flatten for trees (`features/traces/fns/flattenTree.ts`).
- A conditional virtualization threshold of ~350 rows plus lazy loading of row details on expand (`TraceLogView.tsx`, `traceViewConfig.ts`).
- A typed filter schema with operator enums per type (`packages/shared/src/interfaces/filters.ts`).
- Saved-view graceful degradation rules (`table-view-presets/README.md`).
- A density switch with 3 presets (`data-table-row-height-switch.tsx`).
- An empty state that polls and flips to data (`TracesSetupPage.tsx`).
- Token discipline in `styles/globals.css`, and the post-build bundle scanner.

**Avoid**
- The Postgres + ClickHouse + Redis + S3 + worker topology and BullMQ queues. All of it is wrong for a local tool.
- Polling-only refresh for the live view.
- Next.js and tRPC: we serve a static Vite SPA from Hono.
- vaul for mobile drawers.
- `use-query-params` string codecs: use TanStack Router typed search params instead.
- Anything in the EE directories (license).
- Shipping 83-model complexity in UI state. Keep views and preferences tiny.

## Verification
Date: 2026-10-29. Claims checked: 78 (license header and section, EE directory list, every "Implications for search-hole" bullet, and the mechanisms they rely on: refresh intervals, query split, virtualization settings, peek behavior, filter schema and URL codec, saved-view rules, ClickHouse migration files and byte-lock test, token CSS, test config, queue and writer defaults, cited paths).

Corrections made:
- [dashboard-process-model] "no push channel" was too broad. Tables and trace views poll, but `features/in-app-agent/server/watchHandler.ts` serves `text/event-stream` with a `cursor` parameter. Rewritten to say lists have no push channel.
- [upgrades-migrations] The byte-lock does not hash "every released migration file". It is one SHA-256 per mode over the rendered migrations 0001-0047 (94 files, up and down), hard-coded in `prepareMigrations.test.ts`. Also Langfuse ships `down` files; "no down files" is our choice. Bullet rewritten.
- Token CSS: only some Tailwind palettes are disabled (a TODO lists the rest), the sans face is system fonts (only mono is IBM Plex), and the icon wrapper has 4 sizes (sm/base/lg/xl = 12/14/20/28), not 3.
- Saved views: "editing deselects the view" applies to the Tracing tables.
- Counts: 462 migration directories (463 entries include `migration_lock.toml`).
- License section: noted that third-party components keep their own licenses.
- Verified, no change: MIT root license with the four EE directories under `ee/LICENSE`, version 4.71.0, no Recharts anywhere in the repo (the plan's claim about Langfuse and Recharts is wrong), vaul in the peek README, overscan 16 / threshold 350 / row heights / `getItemKey`, filter operators and `discriminatedUnion`, URL codec format.
