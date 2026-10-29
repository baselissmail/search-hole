# ADR-0001: Monorepo shape

- **Status:** Accepted (2026-10-30)
- **Related:** [0002](0002-runtime-and-packaging.md), [0012](0012-mcp-tool-surface-and-output-limits.md)

## Context

The plan sketches nine workspace packages (`core`, `store`, `gateway`, `lists`, `fetch`, `shared`, plus `cli`, `dashboard`, `receipt-app`) and leaves the final layout to Phase 0. Constraints that shape it:

- **One artifact ships.** The npm package `search-hole` provides the CLI, the stdio gateway, the dashboard server and its static assets. The Claude Code plugin, the `.mcpb` and the Codex/Cursor manifests all wrap the same bundled code ([ADR-0002](0002-runtime-and-packaging.md)). No internal package is ever published on its own.
- **Everything Node-side is bundled into one dependency-free `dist/`.** In-repo workspace symlinks buy nothing at runtime when every consumer bundles. The MCP Inspector deliberately avoids workspaces for this reason ([mcp-inspector.md](../research/mcp-inspector.md), "Why not workspaces").
- **The two UIs have different toolchains.** The dashboard is React + Vite + Tailwind for the browser. The receipt panel is Preact or vanilla TS + `vite-plugin-singlefile`, with an ≤ 80 KB budget. Neither should leak dependencies into the Node bundle.
- **The core must stay free of I/O** so that it is deterministic and unit-testable without a network (Principle 5, §4).
- MCPJam's 13-package workspace shows the cost of many hand-wired packages for a small team ([mcpjam-inspector.md](../research/mcpjam-inspector.md)).

## Decision

A **pnpm workspace with three packages** and layer boundaries enforced by a check, not by package walls:

```
packages/search-hole/          the published npm package (bins: searchhole, search-hole)
  src/core/                    pure: rules engine, merge, freshness, source typing, receipts,
                               date parsing, URL canonicalisation. No node:*, no undici, no fs.
  src/lists/                   pure parsers/compilers (YAML, Goggles, uBlacklist, ABP/AdGuard, hosts)
  src/engines/                 adapters: pure buildRequest/parseResponse (ADR-0009)
  src/store/                   SQLite driver port, migrations, queries, retention (ADR-0003, 0006)
  src/fetch/                   safe fetcher: SSRF guard, robots, limits, extraction
  src/gateway/                 MCP server (SDK v2), tools, host profiles (ADR-0012, 0013)
  src/ui-server/               Hono server for the dashboard (ADR-0004)
  src/cli/                     command parsing and terminal output
  src/shared/                  config loading, errors, logging, event bus, types
apps/dashboard/                React SPA → static assets embedded into packages/search-hole/dist/ui/
apps/receipt-app/              MCP App → single HTML file embedded as a string constant in the gateway
distribution/                  host manifests generated from one source by a build script:
  claude-plugin/ codex-plugin/ cursor-plugin/ mcpb/
lists/                         first-party curated lists + LICENSE
docs/                          ARCHITECTURE.md, adr/, research/, guides/, security/
```

Rules:

1. **Layer graph, checked in CI.** A dependency-cruiser config or a ~40-line script fails the build on violations:
   - `core` and `lists` import nothing outside themselves and `shared/types`, and no I/O module.
   - `engines` imports only `core` and `shared`.
   - `store`, `fetch`, `gateway`, `ui-server` and `cli` sit at the edge.
2. **Dependency injection by plain factories** (`createPipeline({engines, store, clock, fetcher})`), never a DI framework (§12.2).
3. **The bundle inlines everything.** A CI check fails if `dist/` contains a bare `require(`/`import` of anything that isn't a `node:` builtin. This is the reverse of the Inspector's externals guard.
4. **One copy of zod** via pnpm `overrides`. SDK v2 fails type-checking with two copies ([mcp-typescript-sdk.md](../research/mcp-typescript-sdk.md)).
5. **Host manifests are generated, not hand-maintained.** The Claude, Codex (Agent Plugins `mcp.json` needs a `type` and `${PLUGIN_ROOT}`) and Cursor (`${CURSOR_PLUGIN_ROOT}`, its own hook events) files differ in small ways ([platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §F). A test asserts that every manifest version matches `package.json`, as smart-doctor does ([smart-doctor.md](../research/smart-doctor.md)).

## Alternatives considered

- **The plan's nine packages.** Rejected. Each needs its own `package.json`, `tsconfig`, build and export map, and nothing is published separately. The boundary benefit is real, but a layer check gets it more cheaply. If a layer later needs publishing (for example `lists` as a standalone parser library), promote it to a package then.
- **A single package with no workspace,** with the UIs as subfolders. Rejected. The dashboard's React/Vite/Tailwind dependencies and the panel's Preact dependencies would share one `package.json` with the Node gateway. That bloats installs and blurs which dependencies ship in which bundle.
- **Separate repos.** Rejected. Lists, manifests and code version together, and the plan wants one marketplace repo.

## Consequences

- Fast builds and one place to look. Moving code between layers is a file move, not a package refactor.
- The layer check is the only thing keeping `core` pure, so it must run in CI from the first commit.
- `apps/*` build first; their outputs are inputs to the package build (`pnpm -r build` in topological order).
- Static assets are embedded at build time: the receipt HTML as a generated constant with a freshness test (MCPJam's trick, [mcpjam-inspector.md](../research/mcpjam-inspector.md)), and the dashboard as files in `dist/ui/`. The gateway never reads source files at runtime.

## Validate early (P1)

- Wire up the layer check and the "no external imports in dist" check before writing pipeline code.
- Measure gateway cold start with the full bundle. If dynamic `import()` chunks are needed to stay under 300 ms (§12.3), tsdown code-splitting inside `dist/` is fine. "Single file" is not a requirement; "no `node_modules`" is.
