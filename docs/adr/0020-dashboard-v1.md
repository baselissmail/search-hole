# ADR-0020: Dashboard v1: stack, API and build

**Status:** Accepted (2026-10-31)
**Related:** [0004](0004-dashboard-process-model.md) (process model and security), MASTER_PLAN §8

## Context

P4 ships the first dashboard. ADR-0004 fixed the process model: an on-demand `searchhole ui`, a login code with a bearer token, an SSE tail of the search log, and no daemon. MASTER_PLAN §8.2 proposed a stack, and asked that its versions be re-checked when the work starts and that the number of UI dependencies stay small.

## Decision

1. **Scope (§8.3 v1).**
   - **Live log:** a virtualized table, expandable rows, a live tail with an "N new" pill.
   - **Rules & lists:** list, add, remove with Undo, explain a URL, approve or reject suggestions.
   - **Engines:** status, health and key source (never the key), plus a probe.
   - **Settings:** mode, query hygiene, loop limits, retention, the receipt line, and theme.
   - **Overview header:** this week's searches, hidden results, top hidden domains, source-type mix and engines used.
   - **P4b:** sessions/receipts, sources, clients, Storybook, RTL pass, and "delete all data".
2. **Stack (apps/dashboard)**, the §8.2 choices pinned to releases at least two weeks old on 2026-10-31:
   - React 19.3 with React Compiler 1.0, Vite 8;
   - TanStack Router, Query, Table v9 and Virtual;
   - Tailwind CSS 4 with tokens as CSS variables, and Base UI primitives;
   - cmdk, sonner, lucide-react, Geist fonts (bundled).

   No chart library in v1: the overview header is numbers and bars drawn with CSS.
3. **Server (packages/search-hole `src/ui/`):** Hono with `@hono/node-server`, bundled into `dist/searchhole.mjs` like every other dependency (ADR-0002). It serves the API from `src/ui/contract.ts` (a types-only module that the dashboard imports at compile time) and the built assets from `dist/ui/`. The UI process runs the App as the user's own surface (host `cli`): no loop guard, and reads may migrate (ADR-0019, the v0.1.1 store fix).
4. **Security, as in ADR-0004 point 4:**
   - bind `127.0.0.1:7341`; a Host allowlist; an Origin check on non-GET requests; no CORS;
   - a single-use 60 s login code passed in the URL fragment, exchanged for a bearer token kept in `sessionStorage`;
   - the stream is read with `fetch()` so it can carry the token;
   - CSP: `default-src 'self'`; scripts, styles and fonts `'self'` only; `connect-src 'self'`; `frame-ancestors 'none'`; plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

   Web-sourced text is rendered with React text nodes only. There is no `dangerouslySetInnerHTML`, and a hostile-title test enforces it.
5. **Writes from the dashboard** are user actions and go through the App's admin methods (rules, suggestions, settings). Settings changes are limited to an allowlist (`SettingsPatch`) that excludes `hooks.guard`. Everything else is edited in `settings.yaml`.

## Alternatives considered

- **Plain `node:http`.** It would mean one fewer dependency, but routing, body limits and streaming helpers would be ours to maintain. Hono is small, bundles cleanly, and matches the planned v2 remote transport.
- **A chart library in v1.** Deferred: the header needs a handful of numbers. uPlot or Recharts come back with the P4b Overview.

## Consequences

- `pnpm build` builds the dashboard before the package, and the plugin ships `dist/ui/`.
- The dashboard works offline, with no external requests: fonts and icons are bundled.
- **Stream: one cursor per client, not a shared tailer.** ADR-0004 point 5 describes a single 250 ms tailer fanning out through bounded queues. v1 polls per stream instead, with each client keeping its own cursor. It is simpler, and a local single-user dashboard has one or two tabs, so 4–8 sub-millisecond keyset queries a second. Writes are awaited, which gives backpressure without a queue to overflow. A shared tailer comes back if a remote (v2) dashboard needs many viewers.
- The UI process is started only by the user (`searchhole ui`, `/search-hole:dashboard`). Gateways never start it, and no MCP output contains a login code or token (ADR-0004 point 3).

## Validate early

- 100k log rows scroll at 60 fps; axe has no serious or critical issues; the full keyboard path works; light and dark screenshots are reviewed (P4 acceptance, MASTER_PLAN §11).
