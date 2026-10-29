# Dokploy/dokploy
> Ref: `research/refs/dokploy` @ 96fb004 (2026-10-28) · License: **Apache-2.0 outside any `/proprietary` directory** (`LICENSE.MD`, "Copyright 2026-present Dokploy Technology, Inc."); content under a `/proprietary` directory is under the **Dokploy Source Available License 1.0** (`LICENSE_PROPRIETARY.md`: production use needs a commercial agreement; copy/merge/publish/distribute forbidden). Proprietary dirs present: `apps/dokploy/components/proprietary/` (audit-logs, auth, license-keys, roles, sso, whitelabeling), `apps/dokploy/server/api/routers/proprietary/`, `packages/server/src/services/proprietary/`. `apps/monitoring/LICENSE.md` (Go sidecar) is MIT, "Copyright 2025 Mauricio Siu". `TERMS_AND_CONDITIONS.md` also says "commercial resale or redistribution of Dokploy as a service is strictly forbidden without explicit consent", wording that is not in the Apache text (ambiguous, treat as a warning). `apps/dokploy/package.json` says `"license": "Apache-2.0"`. **I did not open any proprietary file.**

## Purpose
Dokploy is a self-hosted PaaS (Vercel/Heroku alternative) that deploys apps and databases on Docker/Swarm behind Traefik. Its dashboard is the "self-hosted ops console" archetype: one process on one box, local-first admin UI, live container logs and metrics. For us it validates a second, different stack (Next.js 16 pages router + tRPC + shadcn) and gives concrete log-viewer code (pause buffer, severity classification, conditional virtualization) plus a worked example of WebSocket authorisation. It does **not** support the TanStack Router/URL-state part of §8.2.

## Architecture sketch
```
one Node 24 process: apps/dokploy/server/server.ts
  http.createServer ─► Next 16.4.1 request handler (pages router, `next build --webpack`)
  + `ws` WebSocketServer x6, noServer, path-routed in server.on("upgrade")
      /docker-container-logs  /docker-container-terminal  /listen-deployment  /drawer-logs  /terminal  /listen-docker-stats-monitoring
  + cron/queue init (initCronJobs, initSchedules, startDeploymentWorker) in the same process
sidecars: apps/monitoring (Go, metrics), apps/schedules, apps/api   |   Postgres (no Redis: deployment queue is in-process, server/queues/in-memory-queue.ts)
browser: tRPC 11 + TanStack Query 5 (superjson), WebSocket for logs/stats
```
- `package.json` start script: `node -r dotenv/config dist/migration.mjs && node -r dotenv/config dist/server.mjs`, i.e. **migrate, then serve**, same image. `esbuild.config.ts` bundles the server entries (`server`, `migration`, `reset-password`, `reset-2fa`...) with `packages: "external"` and bakes `.env.production` into `process.env.*` via `define`, except `DATABASE_URL`.
- Monorepo: pnpm 10.22 workspaces `apps/*`, `packages/*` (`@dokploy/server` shared by app, API and schedules); Biome 2.5.7 for lint/format; Node `^24.22.1`; TypeScript `^7.0.2`.

## Key modules and data flow
| Concern | Where | Note |
|---|---|---|
| Container log stream | `apps/dokploy/components/dashboard/docker/logs/docker-logs-id.tsx` (419 lines) | opens `ws(s)://host/docker-container-logs?containerId&tail&since&search&runType[&serverId&serviceId]`; appends text, re-splits and trims to `lines` (default 100) on every message |
| Pause | same file `handlePauseResume`, `messageBuffer`, `isPausedRef` | while paused, incoming chunks go to a buffer; resume concatenates and trims; the ref avoids stale closures in `ws.onmessage` |
| Empty vs loading | same file `resetNoDataTimeout` | 2 s without data flips `isLoading` off so the UI can say "No logs found" |
| Virtual list | `.../logs/virtual-log-list.tsx` | `VIRTUALIZE_THRESHOLD = 5000`: below it every row is in the DOM "so Ctrl+F works"; above it `useVirtualizer` (`estimateSize 20`, `overscan 20`) and `measureElement`; auto-scroll sticks while within 10 px of the bottom |
| Severity | `.../logs/utils.ts` `getLogType` | explicit level first (JSON `"level"`/`"severity"`, numeric pino/bunyan 10-60 and syslog 0-7, logfmt `level=`), then HTTP `statusCode`, then keyword regexes with "error: none"-style negations stripped; unit-tested in `__test__/logs/log-classification.test.ts` |
| Rendering | `.../logs/terminal-line.tsx` | `fancy-ansi` to HTML, search hits wrapped in `<span class="bg-orange-200/80 ...">`, injected with `dangerouslySetInnerHTML`; colour bar + `Badge` with the level word; timestamp tooltip |
| Requests table | `components/dashboard/requests/{show-requests,requests-table,columns}.tsx` | Traefik access log; TanStack Table v8 with **server-side** paging (10 per page), sort, status facet (`DataTableFacetedFilter`, 100-599 grouped with icons), date range default last 3 days, `Sheet` for row detail, `refetchInterval: 5000` on an existence check |
| Command palette | `components/dashboard/search-command.tsx` | cmdk `CommandDialog` on `Ctrl/Cmd+J` (`e.code === "KeyJ"`); groups Projects and Services, results from `api.project.all`; `router.push` on select |
| Chord nav | `hooks/use-keyboard-nav.tsx` | GitHub-style `g` then a letter (`g l` logs, `g m` monitoring ...), 1500 ms window, ignores inputs/contenteditable/`role=textbox`, writes `?tab=` |
| Metrics charts | `components/dashboard/monitoring/free/container/docker-*-chart.tsx`, `components/ui/chart.tsx` | shadcn chart wrapper over Recharts 3; `isAnimationActive={false}` on series; `accessibilityLayer` set once in `ui/chart.tsx:143` and in `request-distribution-chart.tsx:50` |
| WS authz | `server/wss/authorize.ts`, `server/wss/docker-container-logs.ts` | `validateRequest(req)` (cookie session) then `canAccessDockerOverWss`; input validators `isValidContainerId/Tail/Since/Search` before shelling out to `docker logs` |

## Data model and storage
Postgres via Drizzle ORM 0.45 + `postgres` 3.4.4; 201 files under `apps/dokploy/drizzle` (last `0198_nostalgic_mongoose.sql`), generated by `drizzle-kit generate`, applied by `migration.ts` (`migrate(db, {migrationsFolder: "drizzle"})` on a single-connection client, logs "Migration failed" but does not abort). UI preferences: `hooks/useLocalStorage.tsx`, `hooks/use-sort-preference.ts` (initialises from the default, reads `localStorage` after mount to avoid a hydration mismatch), sidebar state in a 7-day cookie `sidebar_state` (`components/ui/sidebar.tsx:24-29`). The access-log feature keeps only "the last 1000 entries" of Traefik's file via a cron (tooltip text, `show-requests.tsx`).

## Config format
`components.json`: shadcn `style: "radix-nova"`, `cssVariables: true`, `iconLibrary: "lucide"`, `rtl: false`, empty `registries`. Tailwind v4 CSS-first in `styles/globals.css` (`@import "tailwindcss"`, `@theme`, `@custom-variant dark (&:is(.dark *))`), HSL CSS variables bridged into Tailwind colours (`--color-border: hsl(var(--border))`); both `tw-animate-css` and `tailwindcss-animate` are present. `next.config.mjs` sets `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `typescript.ignoreBuildErrors: true`.

## Extension points (plugins, hooks)
Not a plugin system; the extension surface is the tRPC router set (`server/api/routers/*`) plus an OpenAPI export (`generate:openapi`, `@dokploy/trpc-openapi`). Enterprise features sit behind `components/proprietary/enterprise-feature-gate.tsx` (path only, not read).

## Rules / lists: parsing and compilation
n/a — Dokploy has no rule or list engine (the only "parser" is the log-level classifier above).

## Testing strategy
Vitest ^4.1 with `pool: "forks"` (`__test__/vitest.config.ts`), **177 files under `apps/dokploy/__test__`**, almost all server/unit tests (`include: ["__test__/**/*.test.ts"]`, so `.tsx` component tests are not even matched; one `.test.tsx` exists and is skipped by the glob). UI logic that matters is extracted into pure modules and tested (`logs/log-classification.test.ts`, `logs/container-logs-search.test.ts`, `container-selection.test.ts`). No Playwright, no Storybook.

## UX patterns worth copying
- **Chord navigation** (`g` + letter) with an input guard and a timeout; per-page shortcut dictionaries.
- **Pause = buffer, resume = flush**, with the line cap re-applied; a clear Pause/Play button (`lucide` `Pause`/`Play`) in the log toolbar.
- **Log toolbar**: line-count select, "since" select, level multi-select (`status-logs-filter.tsx`), search, download as `<name>-YYYYMMDD_HHMMSS.log.txt`, copy with a 2 s "Copied" state.
- **Level = coloured bar + word badge** (`terminal-line.tsx`), tinted row backgrounds only for error/warning/debug.
- **Relative time with absolute tooltip** (`components/shared/date-tooltip.tsx`: `formatDistanceToNow` + `format(date,"PPpp")`).
- **Sidebar** is the shadcn sidebar: `Ctrl/Cmd+B`, cookie-persisted collapse state.
- `FocusShortcutInput` (`components/shared/focus-shortcut-input.tsx`): Ctrl/Cmd+K focuses a page search when focus is not already in a field.
- Honest empty/warning copy: "When you activate, you need to reload traefik" shown only while active and the log count is 0 (`shouldShowWarning`).

## Performance tricks
- Virtualize only past 5000 log lines, because native Ctrl+F matters more than DOM size for small lists (`virtual-log-list.tsx`).
- Server-side pagination and sorting for the request table; client holds one page.
- `isAnimationActive={false}` on Recharts series for live-updating metrics.
- Anti-pattern to avoid: `rawLogs` is one string re-split on every WS message and re-parsed with regexes on every state change (`docker-logs-id.tsx`, `useEffect` on `[rawLogs, ...]`), O(n) per message.

## License and what it means for us
Apache-2.0 for non-proprietary paths, so short snippets are allowed with attribution, but almost everything useful here is generic shadcn/Radix code that we can regenerate from the shadcn registry (MIT) instead. Never copy from, or even model on, `**/proprietary/**` (DSAL forbids it), and treat `components/dashboard/monitoring/paid/**` carefully: it is not under a `/proprietary` folder, so Apache applies on paper, but the name signals Dokploy Cloud code, so prefer ideas only. The `TERMS_AND_CONDITIONS.md` "no resale as a service" sentence is a reason to take patterns, not whole components.

## Implications for search-hole
- [dashboard-process-model] A single Node process that hosts the UI, path-routed `ws` servers (`noServer` + `server.on("upgrade")`) and background jobs works for a single-host tool, but it needs per-endpoint auth: Dokploy's own comment in `server/wss/authorize.ts` says the WS handlers "only checked session + organization, so any member could reach a root shell". Our local dashboard must authenticate SSE/WS exactly like HTTP (Origin check, token).
- [security] Validate every query param that reaches a shell or a query (`isValidContainerId`, `isValidTail`, `isValidSince`, `isValidSearch` in `server/wss/utils.ts`); for us the analogue is SSE filters feeding SQL, so use bound parameters only.
- [security] `dangerouslySetInnerHTML` on log text (`terminal-line.tsx`) is a stored-XSS vector for untrusted data. Search-hole renders titles/snippets/URLs scraped from the web, so render text nodes only and highlight by splitting strings, never by injecting HTML.
- [upgrades-migrations] "migrate, then serve" in one start command with a one-connection migrator is the simplest upgrade path, but it has no lock or schema-newer check; our multi-process case (§4 upgrades) needs both.
- [ui-ux] Pause-by-buffer with `isPausedRef` and a 2 s no-data timer is a cheap live-view model; combine it with Infisical's "N new" pill rather than silently trimming.
- [ui-ux] Conditional virtualization (`> 5000` rows) contradicts "smooth with 100k+ rows" only if misapplied: use real virtualization for the log, but keep a "plain list below N" mode or provide in-page find, since virtualized rows break browser Ctrl+F (`virtual-log-list.tsx` comment).
- [engine-adapter] `getLogType` is a good template for engine-error classification: explicit structured fields first, heuristics second, negation stripping ("error: none") before keyword match, and a unit-test file per heuristic.
- [ui-ux] Stack validation: React 19.2.7, Tailwind ^4.3.1, Recharts ^3.8.0, Radix, cmdk, Lucide are in use; Next 16 instead of Vite/TanStack Router, sonner ^1.7.4, cmdk ^0.2.1, lucide ^0.469.0, zod ^4.3.6, no motion/vaul/Base UI. The §8.2 "projects converge on this stack" claim holds for Dokploy only partly: React 19, Tailwind 4, Radix, TanStack Query/Table v8/Virtual and Recharts 3 yes; TanStack Router and Base UI no.
- [testing] Their tests are server-heavy and component-light (177 files, Vitest forks); do not take it as a model for UI QA.
- [ui-ux] Hydration-safe preferences: initialise with the default and read `localStorage` in an effect (`use-sort-preference.ts`); in a pure SPA we can read synchronously.

## Borrow / avoid
**Borrow**
- Pause/resume buffering semantics and the 2 s no-data timer.
- `getLogType`-style layered classifier plus its test file layout.
- Chord-nav guard (inputs, contenteditable, textbox role, timeout).
- Download/copy filename and "Copied" feedback conventions.
- WS upgrade routing with `noServer` and explicit path match; per-endpoint authorise function with a written rationale.

**Avoid**
- Anything under `**/proprietary/**` and, to be safe, `monitoring/paid/**`.
- HTML-string highlighting with `dangerouslySetInnerHTML`.
- Whole-buffer string re-split per message.
- `typescript.ignoreBuildErrors: true`.
- Local `useState` for table filters and paging (no deep links).
- Adopting Next.js for a localhost tool (custom server + webpack build, 201 migration files): it is why Dokploy needs a bundler step plus a custom `server.ts`.
