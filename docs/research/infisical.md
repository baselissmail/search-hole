# Infisical/infisical
> Ref: `research/refs/infisical` @ b3f622d (2026-10-28) · License: **MIT ("MIT Expat")**, root `LICENSE` "Copyright (c) 2022 Infisical Inc."; every `ee/` directory is under a separate `ee/LICENSE` (README l.170). Sparse checkout = `frontend/` only (+ README, LICENSE). `find frontend -type d -name ee` is empty and there is no per-directory LICENSE under `frontend/`, so all code we can see is MIT. `ee/LICENSE` and the backend are not in the checkout (not verified). `frontend/src/components/license/` is client-side upgrade gating, not a licence boundary.

## Purpose
Infisical is a secrets/PKI/PAM platform. Its React SPA (`frontend/`) is a mature, dense admin dashboard and the best of our three refs for **validating the MASTER_PLAN §8.2 stack in real, current code** (React 19, Vite 8/Rolldown, TanStack Router/Query/Virtual, Tailwind 4, Radix + Base UI, Recharts 3, cmdk, sonner, motion). Two areas map straight onto search-hole: the **Agent Vault session log** (`pages/agent-vault/AgentVaultSessionsPage/components/SessionLogsPanel.tsx`: a live-tailing, virtualized log of an AI agent's proxied HTTP requests with Brokered/Passthrough/Blocked/Error decisions) and the **audit-log table** (`pages/organization/AuditLogsPage/`).

## Architecture sketch
```
Vite 8 SPA (static assets)  ──axios──►  Infisical API (not in checkout)
  TanStack Router  (virtual file routes: src/routes.ts, 542 lines → generated routeTree.gen.ts)
  TanStack Query   (hooks/api/*)      zustand (small global state)     react-hook-form + zod
  components/v3/generic   (own shadcn-style kit on Radix)   components/v3/platform (app-aware pieces)
```
- `frontend/vite.config.ts`: `build.rolldownOptions.output.manualChunks` forces `recharts`, `d3-*` and `victory-vendor` into one chunk because "recharts/d3 has circular dependencies" (otherwise uninitialised-import errors). Build target `es2020` plus edge88/firefox78/chrome87/safari14. Asset names embed the platform version: `assets/[name]-${version}-[hash].js`. `experimental.renderBuiltUrl` routes JS chunk URLs through `window.__toCdnUrl` (CDN rewrite at runtime). `optimizeDeps.include` pre-lists lazy-route deps so Vite does not re-optimise and force-reload the page mid-session (comment in file).
- `package.json` engines: node `^20.19.0 || >=22.12.0`, npm `>=11.10.0`. Scripts: `build` = `tsc -b && vite build`; `lint` = `eslint ./src --max-warnings 0`; `test` = `vitest run -c vitest.config.mts`; Storybook on 6006.

## Key modules and data flow
| Concern | Where | Note |
|---|---|---|
| Virtualized table | `src/components/v3/generic/Table/Table.tsx` `TableVirtualBody` (l.92-140) | `useVirtualizer`, `estimateRowHeight=41`, `overscan=10`, spacer `<tr aria-hidden>` rows for top/bottom padding (keeps real `<table>` semantics), sets `aria-rowcount` and per-row `aria-rowindex` |
| Live-tail log | `SessionLogsPanel.tsx` (789 lines) + `useSessionLogsLiveTail.ts` + `useNewRequestsCounter.ts` + `LiveStatusRow.tsx` | virtualizer `overscan: 16`, row height 41 px; next page fetched when `lastVisibleIndex >= visible.length - 30`; live = **polling** every `AGENT_VAULT_SESSION_LOG_LIVE_POLL_MS = 15_000` (`hooks/api/agentVault/queries.tsx:72`) |
| Scroll anchoring | `useNewRequestsCounter.ts`, `findRowShift` in `SessionLogsPanel.utils.ts` | when rows land above the reader, `scrollTop += shift * rowHeight`; only rows with `arrivals > since` count as new; counter clears when `scrollTop < 1`; `showNewRequests` smooth-scrolls to top |
| Live state machine | `LiveStatusRow.tsx` | states `live`/`reconnecting`/`paused`/`ended`, each a badge (icon + label + variant) and a status row with plain-language text; `motion-safe:animate-ping` dot; pause when a byte budget is exceeded (`isOverByteBudget`) |
| Decision chips | `SessionLogRow.tsx` `DECISION_PRESENTATION` | Brokered (key icon, success), Passthrough (arrow, neutral), Blocked (shield-ban, warning), Error (x-circle, danger): label + icon + colour together |
| Audit log table | `AuditLogsPage/components/LogsTable.tsx` | 30 per page (`AUDIT_LOG_LIMIT`), infinite query, 8 skeleton rows, "Load More" button, "End of logs" footer, `Empty` when none, details in a `Sheet` |
| URL state | `pages/organization/NetworkingPage/route.tsx` | `validateSearch: zodValidator(z.object({selectedTab: z.string().catch("gateways"), ...}))` + `search.middlewares: [stripSearchParams({...defaults})]`; `pages/organization/layout.tsx` uses `retainSearchParams(["subOrganization"])` |
| Command palette | `components/v3/generic/Command/GlobalCommandMenu.tsx` | see UX |
| Theme | `components/v3/platform/ThemeProvider/ThemeProvider.tsx`, `src/index.css` | see UX |
| Spreadsheet grid | `components/v3/generic/DataGrid/*` (7.7k lines) | editable grid on TanStack Table v8 + virtualizer (`use-data-grid.ts:2096`); kebab-case files unlike the rest, so likely vendored from a registry (inferred); we do not need it |

## Data model and storage
No local DB; everything is server state via TanStack Query. Browser-side only: `localStorage` key `infisical-theme` (`ThemeProvider.tsx`, wrapped in try/catch with a silent fallback), `hooks/usePersistentState.ts`, `hooks/useLocalStorageState.ts`. Audit-log filters live in `useState` (`LogsSection.tsx`), **not** in the URL; only tab/view-level params are URL state.

## Config format
Build-time only: `VITE_ALLOWED_HOSTS`, `INFISICAL_PLATFORM_VERSION` / `VITE_INFISICAL_PLATFORM_VERSION` (`vite.config.ts`). Design tokens are Tailwind v4 `@theme {}` blocks in `src/index.css` (713 lines).

## Extension points (plugins, hooks)
- `GlobalCommandMenu` takes data, not code: `groups: {heading, items: {id,label,breadcrumb,icon,keywords,shortcut,priority,children(drill-down)}}`, `searchGroups`, `searchStatus` (`idle|loading|error`), `onItemSelect(item, {mode: browse|search|drill-down})`.
- Component lifecycle is governed by two ledgers: `src/components/COMPONENT_LIFECYCLE.md` (deprecation decisions) and `V3_MIGRATION.md` (a machine-checked "removal ledger": `frontend/scripts/audit-v2-ui.mjs --assert-zero`; the script is outside the checkout). `components/v2` is now deleted; stories are the API reference.

## Rules / lists: parsing and compilation
n/a — UI-only ref, no rule or list compilation (nearest analogue is the audit filter chips in `AuditLogsPage/components/AuditSearchFilter.tsx`).

## Testing strategy
Vitest ^4.1.11 (config `vitest.config.mts` not in checkout) with only **28** `*.test.ts(x)` files; the main quality net is **67 Storybook stories** (`*.stories.tsx`, every `v3/generic` component) with `@storybook/addon-a11y` and `storybook-addon-tag-badges` (Storybook ~10.3.6). Gates: `tsc -b`, `eslint --max-warnings 0`, the V2-removal audit script. Overlay stacking has its own unit test (`components/v3/utils/overlay-layer.test.ts`). Takeaway: stories + axe beat unit tests for a component kit.

## UX patterns worth copying
- **Linked rows, not onClick navigation**: `RowLink` (`createLink` over an `<a>` with an `::after` overlay) + `linked` on `TableRow`/`Card`; inner buttons/inputs are lifted with `z-10` so cmd/ctrl-click and "open in new tab" work (`generic/RowLink/RowLink.tsx`; rule stated in `COMPONENT_LIFECYCLE.md`).
- **`/` and Cmd/Ctrl+F focus the page search** (`hooks/useSlashFocusSearch.ts`), but only when focus is not in an input, dialog, combobox, menu, cmdk, CodeMirror, Monaco or xterm (`EDITABLE_SELECTOR`), and no overlay is open.
- **Command menu** with `shouldFilter={false}` and our own scorer (`getSearchScore`): exact 100, prefix 80, substring 60, keyword prefix 50, keyword substring 40, breadcrumb 30, plus `priority`; supports drill-down and an async search status. Global ⌘K handler ignores `isComposing`, `repeat`, and elements matching `[data-command-menu-shortcut="ignore"]`, editors and terminals.
- **Empty states by cause**: `V3_MIGRATION.md` says to distinguish collection-empty, filtered-zero, loading and permission-denied; `Empty` has `EmptyMedia variant="icon"` and an optional SVG dashed frame (`generic/Empty/Empty.tsx`).
- **Toasts**: sonner at bottom-centre, 4 px status stripe on the left via gradient, `closeButton`, themed through `--normal-bg` CSS vars (`generic/Toast/Toast.tsx`); an `Undo` action is demoed in `Toast.stories.tsx:205`.
- **Loading without flicker**: `hooks/useDelayedLoading.ts` (show a loader only after 200 ms; once shown keep it `minDuration`); skeleton rows (`Skeleton`, 8 rows) for first load.
- **Theme tokens**: dark default, `data-theme` attribute on `<html>`, `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`, semantic OKLCH tokens (`--color-background: oklch(21.47% 0.0058 285.9)`, success/info/warning/danger) in `@theme`, light overrides in `html[data-theme="light"]`, z-index tokens (`--z-index-toast: 999999999`), `color-scheme` set on `<html>`.
- Status as **badge = icon + word + colour**; `LiveDot` pings only under `motion-safe`.

## Performance tricks
- Virtualize only the heavy tables (3 files use `useVirtualizer`); overscan 10-16; fixed row height 41 px as estimate with `measureElement` for variance.
- Prefetch next page 30 rows before the end instead of an intersection sentinel.
- Poll 15 s (a comment in `SessionLogsPanel.tsx` says polling stops in a hidden tab, i.e. react-query's default background behaviour, inferred), cap the working set by byte budget and show "Paused: showing the most recent N".
- Manual chunk for Recharts; lazy routes; `optimizeDeps.include` for lazily imported deps.

## License and what it means for us
MIT: we may copy files with the copyright notice kept (add a `THIRD_PARTY_NOTICES` line per file or folder). Do **not** copy: Alliance No. 2 font files (`src/assets/fonts`, licence unknown), logos/illustrations, `DataGrid/*` (provenance unclear, third-party licence may differ). IBM Plex Sans and JetBrains Mono come from `@fontsource/*` (OFL). Nothing here is under `ee/`.

## Implications for search-hole
- [runtime-packaging] Vite 8 with `build.rolldownOptions` ships a 4,364-file `frontend/src` SPA in production, so the Vite 8 + Rolldown choice in §8.2 is validated; keep the `manualChunks` workaround for Recharts/d3 if we use it (`vite.config.ts`).
- [dashboard-process-model] Infisical polls (15 s) for live data instead of SSE; our 250 ms rowid-tail plus SSE (§4) is more ambitious, so spike it early and keep a poll fallback for the `reconnecting` state (`LiveStatusRow.tsx`).
- [ui-ux] Adopt the live-log contract from `useNewRequestsCounter.ts`: scroll anchoring when rows land above, a "N new" pill that clears at `scrollTop < 1`, and four explicit live states (live/reconnecting/paused/ended) with plain-language text.
- [ui-ux] Use Brokered/Blocked-style decision chips as the model for kept/hidden/pinned/lowered: label + icon + variant from one lookup table (`SessionLogRow.tsx DECISION_PRESENTATION`).
- [ui-ux] Virtualized `<table>` with spacer rows and `aria-rowcount`/`aria-rowindex` (`Table.tsx:92-140`) is the proven way to meet the 100k-row and WCAG 2.2 targets in §8.1.
- [ui-ux] URL state: `zodValidator` + `.catch(default)` + `stripSearchParams(defaults)` gives typed, self-healing, short URLs; Infisical still keeps heavy filters in `useState`, so our "URL is the state" goal (§8.4.4) needs more than they do (see supabase-studio.md for the nuqs codec).
- [ui-ux] Plan row "Components: shadcn on Base UI" is ahead of the field: Infisical imports Radix in 32 files and `@base-ui/react ^1.7.0` in only 2 (Combobox, TagsInput). Either choice works; pick Base UI only where Radix lacks a primitive (combobox, autocomplete).
- [ui-ux] Plan rows React Compiler, Table v9, Lucide v1, uPlot, `@tanstack/react-hotkeys` have **zero** adopters here (react-compiler absent; Table `^8.21.3`; lucide-react `^0.544.0`; hotkeys hand-rolled). Pin the plan's versions only after a spike.
- [testing] Component kit QA = Storybook 10 + addon-a11y + `--max-warnings 0` lint, matching §8.2's QA row; unit tests are secondary (28 files).
- [ui-ux] Per-viewer prefs (theme) are read from `localStorage` inside try/catch with a safe default (`ThemeProvider.tsx`), the pattern §12.4 will need for all per-viewer prefs.
- [ui-ux] Dark-by-default with OKLCH semantic tokens and a `data-theme` attribute is simple; for us prefer `prefers-color-scheme` default plus an explicit override, and keep `color-scheme` in sync.

## Borrow / avoid
**Borrow**
- `useNewRequestsCounter.ts` + `findRowShift` (scroll anchoring + new-rows counter).
- `LiveStatusRow.tsx` live-state badges and copy.
- `TableVirtualBody` structure with ARIA row indices.
- `DECISION_PRESENTATION` lookup shape; `RowLink` pattern; `useSlashFocusSearch` guard list; `useDelayedLoading`.
- `GlobalCommandMenu` scoring weights and `shouldFilter={false}` approach.
- Route search schemas: `zodValidator` + `.catch` + `stripSearchParams`.

**Avoid**
- Keeping log filters in component state (not shareable or restorable).
- Hand-rolled global keydown handlers per feature (no registry, no cheat sheet).
- `zod ^3` + `@tanstack/zod-adapter` for new code (Dokploy and the plan use zod 4; check adapter status).
- Toaster hard-coded `theme="dark"` (`Toast.tsx`) and a z-index of 999999999.
- Vendoring a 7.7k-line DataGrid we do not need.
