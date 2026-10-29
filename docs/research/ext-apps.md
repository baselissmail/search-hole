# modelcontextprotocol/ext-apps
> Ref: `research/refs/ext-apps` @ 07cda25 (2026-10-27) · License: the root `LICENSE` is the MCP transition text. New code is Apache-2.0; contributions not yet relicensed stay MIT ("Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.", `LICENSE` line 190, under the "MIT License" heading at line 188); non-spec docs are CC-BY-4.0. There are no per-directory LICENSE files and no NOTICE file. The root `package.json` and all 23 `examples/*/package.json` that declare a license say `"license": "MIT"`.

## Purpose
This is the SDK and spec for **MCP Apps** (`io.modelcontextprotocol/ui`, SEP-1865, stable revision `2026-01-26`). With it, a tool result renders as a sandboxed HTML "View" inside the chat. The package is `@modelcontextprotocol/ext-apps` **2.0.4** (`package.json`). It has three roles:
- the View side (`App`)
- the host side (`AppBridge`)
- server helpers (`registerAppTool`, `registerAppResource`, `getUiCapability`)

For search-hole it settles the in-chat receipt panel (plan §8.5, P5) and the app-only `apply_rule` tool (§4 tool surface). It also gives the fallback rules for hosts without UI, such as Claude Code.

## Architecture sketch
```
MCP server ──tools/list (tool._meta.ui.resourceUri = "ui://…")──► Host (AppBridge)
           ◄─resources/read ui://… (mimeType text/html;profile=mcp-app, _meta.ui.csp)─┘
Host ──postMessage JSON-RPC (ui/*)──► View iframe (App)      [double iframe: sandbox proxy + inner]
  ui/initialize → hostContext{theme, styles.variables, styles.css.fonts, displayMode, …}
  ui/notifications/tool-input | tool-input-partial | tool-result | tool-cancelled | host-context-changed
View ──tools/call (proxied to the same server; visibility must include "app")──► Host ──► server
View ──ui/request-display-mode | ui/open-link | ui/download-file | ui/message | ui/update-model-context──► Host
```
- `App` and `AppBridge` both extend `Protocol` from `@modelcontextprotocol/client` (`src/app.ts: class App`, line 340; `src/app-bridge.ts: class AppBridge`, line 305; `docs/overview.md` §Architecture).
- Package exports (`package.json`): `.` (App + styles), `./app-with-deps`, `./react`, `./react-with-deps`, `./app-bridge`, `./server` and `./schema.json`.
- The standard entries keep `@modelcontextprotocol/{client,core,server}` and `zod` external. The `*-with-deps` entries bundle them (`build.bun.ts: PEER_EXTERNALS`).

## Key modules and data flow
**Server helpers** (`src/server/index.ts`):
- `registerAppTool(server: Pick<McpServer,"registerTool">, name, config: McpUiAppToolConfig, cb): RegisteredTool`
  - `config` takes `{title?, description?, inputSchema?, outputSchema?, annotations?, _meta}`. `_meta` is **required** and is typed as a union: either `{ui: McpUiToolMeta}` or the deprecated flat `_meta["ui/resourceUri"]?` (`McpUiAppToolConfig`, lines 119–138).
  - When a resource URI is given in one form, it copies it into the other (lines 288–297), then forwards to `server.registerTool`. An app-only tool with no `resourceUri` gets neither key.
  - A raw zod-shape overload still exists but is `@deprecated`. Use `z.object(...)`.
- `registerAppResource(server: Pick<McpServer,"registerResource">, name, uri, config: McpUiAppResourceConfig, readCallback): RegisteredResource`
  - It spreads `{ mimeType: RESOURCE_MIME_TYPE, ...config }` into `server.registerResource`.
  - `config._meta.ui` is the `resources/list`-level default. A `_meta.ui` on a `resources/read` content item **takes precedence** (doc comment on `McpUiAppResourceConfig`; `specification/draft/apps.mdx` §"Metadata Location", lines 263–272).
- `getUiCapability(clientCapabilities)` returns `clientCapabilities.extensions?.["io.modelcontextprotocol/ui"]`, typed `McpUiClientCapabilities {mimeTypes?: string[]}`. `EXTENSION_ID = "io.modelcontextprotocol/ui"`.
- Constants (`src/constants.ts`):
  - `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"`
  - `RESOURCE_URI_META_KEY = "ui/resourceUri"`, legacy. Spec: "will be removed before GA" (`specification/2026-01-26/apps.mdx` line ~340).

**Exact field names** (`src/spec.types.ts`):
- `McpUiToolMeta`:
  - `resourceUri?: string`
  - `visibility?: ("model"|"app")[]`, default `["model","app"]`
  - `csp?: never` and `permissions?: never`. These belong on the resource; hosts ignore them on a tool.
- `McpUiResourceMeta`:
  - `csp?: McpUiResourceCsp`
  - `permissions?: {camera?, microphone?, geolocation?, clipboardWrite?}`, each `{}`
  - `domain?: string`, which is host-specific, e.g. `{hash}.claudemcpcontent.com`
  - `prefersBorder?: boolean`
- `McpUiResourceCsp` has four keys:
  - `connectDomains`, which maps to `connect-src`
  - `resourceDomains`, which maps to `img-src`, `script-src`, `style-src`, `font-src` and `media-src`, with wildcard subdomains allowed
  - `frameDomains` (`frame-src`, default `'none'`)
  - `baseUriDomains` (`base-uri`, default `'self'`)
- `docs/csp-cors.md` and the `create-mcp-app` skill ("Common Mistakes" #3) both say: put `csp`/`domain` in the **`contents[]` item returned by the read callback**, not in the `registerAppResource` config.

**App side** (`src/app.ts`):
- `new App(appInfo, appCapabilities = {}, options = { autoResize: true })` (line 581). The `AppOptions` (line 142) are:
  - `autoResize` (documented default true). The default is really the whole `options` object `{ autoResize: true }`, and `connect()` only resizes when `this.options?.autoResize` is truthy (line 2338). So **any options object passed without `autoResize: true` turns auto-resize off.**
  - `strict` (default false; it warns rather than throws if you call host methods before `connect`)
  - `allowUnsafeEval` (default false). In that case the constructor runs `z.config({ jitless: true })` so zod works under the no-`unsafe-eval` CSP.
  - `webMcpBridge` (default true; it mirrors tools into `document.modelContext`)
- `connect(transport = new PostMessageTransport(window.parent, window.parent))` (line ~2263) does four things:
  - it sends `ui/initialize {appInfo, appCapabilities, protocolVersion: "2026-01-26"}`
  - it stores `hostCapabilities`, `hostInfo` and `hostContext`
  - it sends `ui/notifications/initialized`
  - it starts auto-resize
  
  If anything fails, it closes the transport and throws.
- Handlers (getter/setter pairs, lines 1112–1466):
  - `ontoolinput`, `ontoolinputpartial`, `ontoolresult` (receives a `CallToolResult`) and `ontoolcancelled`
  - `onhostcontextchanged` (receives a partial `McpUiHostContext`)
  - `onteardown`, `oncalltool` and `onlisttools`
  - `addEventListener` for multiple listeners. The `ontoolinput`, `ontoolinputpartial`, `ontoolresult`, `ontoolcancelled` and `onhostcontextchanged` setters are marked `@deprecated` in favour of `addEventListener("toolresult" | "hostcontextchanged" | …)` (lines 1109–1288), though they still work.
  
  The skills say: **register every handler before `connect()`** (`plugins/mcp-apps/skills/create-mcp-app/SKILL.md` "Common Mistakes" #4).
- Methods:
  - `callServerTool({name, arguments}, options)` (line 1567). It sets `resetTimeoutOnProgress: true` so host heartbeats keep a long call alive. Transport failures throw; tool failures come back as `isError: true`.
  - `readServerResource` and `listServerResources`
  - `sendMessage({role:"user", content})`, `sendLog` and `updateModelContext({content?, structuredContent?})`. The last one replaces the previous context and is sent with the next user turn (`McpUiUpdateModelContextRequest` doc).
  - `openLink({url})`, `downloadFile({contents: (EmbeddedResource|ResourceLink)[]})` and `requestTeardown()`
  - `requestDisplayMode({mode})` returns `{mode}`, the mode the host actually set (line 2107)
  - `sendSizeChanged`, `getHostCapabilities()`, `getHostVersion()` and `getHostContext()`
- **Display modes**: `McpUiDisplayMode = "inline" | "fullscreen" | "pip"`.
  - The View MUST declare `appCapabilities.availableDisplayModes`.
  - It MUST check the host's `hostContext.availableDisplayModes` before it asks for a mode.
  - It MUST handle getting back a different mode than it asked for.
  - The host reports mode changes through `host-context-changed` (`specification/2026-01-26/apps.mdx` §Display Modes, lines 735–790).
- **Host context** (`McpUiHostContext`) holds:
  - `toolInfo{id, tool}`, `theme` (`light|dark`), `styles{variables, css{fonts}}`
  - `displayMode`, `availableDisplayModes`
  - `containerDimensions`: `height` or `maxHeight`, combined with `width` or `maxWidth`
  - `locale` (BCP 47), `timeZone` (IANA), `userAgent`, `platform` (`web|desktop|mobile`)
  - `deviceCapabilities{touch, hover}` and `safeAreaInsets`
- **Host capabilities** (`McpUiHostCapabilities`): `openLinks`, `downloadFile`, `serverTools{listChanged}`, `serverResources`, `logging`, `sandbox{permissions, csp}`, `updateModelContext`, `message`, `sampling` and `experimental`.

**Theming helpers** (`src/styles.ts`):
- `applyDocumentTheme(theme)` sets `data-theme` and `style.colorScheme` on `<html>`.
- `applyHostStyleVariables(styles, root = documentElement)` calls `setProperty` for each defined key.
- `applyHostFonts(fontCss)` injects `<style id="__mcp-host-fonts">` **once**. If that id already exists it does nothing, so a later font change is ignored.
- `getDocumentTheme()` reads `data-theme`, or the Tailwind `.dark` class.
- React equivalents: `useApp`, `useAutoResize`, `useDocumentTheme`, `useHostStyleVariables`, `useHostFonts` and `useHostStyles` (`src/react/*.ts`).

**CSS variables**: `McpUiStyleVariableKey` in `src/spec.types.ts` has **76 keys**. RELEASES.md 0.2.2 said 36; the plan says "about 70".
- Colors:
  - `--color-background-*` ×10: primary, secondary, tertiary, inverse, ghost, info, danger, success, warning, disabled
  - `--color-text-*` ×10 and `--color-border-*` ×10, with the same suffixes
  - `--color-ring-*` ×7: primary, secondary, inverse, info, danger, success, warning
- Fonts:
  - `--font-sans` and `--font-mono`
  - `--font-weight-{normal,medium,semibold,bold}`
  - `--font-text-{xs,sm,md,lg}-size` and `-line-height`
  - `--font-heading-{xs,sm,md,lg,xl,2xl,3xl}-size` and `-line-height`
- Other:
  - `--border-radius-{xs,sm,md,lg,xl,full}`
  - `--border-width-regular`
  - `--shadow-{hairline,sm,md,lg}`

Hosts may pass any subset and should use `light-dark()`. Views must set their own fallbacks (spec §Theming → View Behavior).

## Data model and storage
n/a: this is a protocol library with no persistence. View state: `docs/patterns.md` §"Persisting view state" puts a server-minted `viewUUID` in `CallToolResult._meta` and stores the state in `localStorage` under that key. That works only where the host's inner iframe has `allow-same-origin`:
- basic-host sets it (`examples/basic-host/src/sandbox.ts` line 46)
- per `docs/research/mcp-inspector.md`, the Inspector does not

## Config format
n/a for config files. The "config" is tool and resource `_meta`. A minimal app-only tool, from `examples/system-monitor-server/server.ts` lines 156–174 (MIT/Apache):
```ts
registerAppTool(server, "poll-system-stats", {
  title: "Poll System Stats",
  description: "Returns dynamic system metrics for polling … App-only.",
  inputSchema: z.object({}),
  outputSchema: PollStatsSchema,
  _meta: { ui: { visibility: ["app"] } },   // no resourceUri needed
}, async () => ({ content: [...], structuredContent: stats }));
```

**Restrictive default CSP** that hosts MUST use when `ui.csp` is omitted (`specification/2026-01-26/apps.mdx` lines ~276–283): `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'`. It has **no `font-src`**, so fonts, including `data:` fonts, fall back to `default-src 'none'`. Hosts "MAY further restrict but MUST NOT allow undeclared domains". The spec's own sample builder for a declared `ui.csp` (§Security Implications → Content Security Policy Enforcement, lines 1729–1744) emits `font-src 'self' <resourceDomains>`, still without `data:`. The reference basic-host is looser: `font-src 'self' data: blob: <resourceDomains>` (`examples/basic-host/serve.ts` line 84). So whether `data:` fonts load depends on the host.

## Extension points (plugins, hooks)
- **Views can expose tools to the host**: `App.registerTool` / `oncalltool` / `onlisttools`, with `appCapabilities.tools{listChanged}`. The draft spec covers this under "App-Provided Tools" (`specification/draft/apps.mdx`), and there is an optional WebMCP bridge (`src/webmcp.ts`). We don't need it.
- Host side: `AppBridge(client | null, hostInfo, hostCapabilities, {hostContext})` (`src/app-bridge.ts` line 530) with setters `oncalltool`, `onopenlink`, `onrequestdisplaymode`, `onupdatemodelcontext`, `onsizechange` and others (lines 702–1562). A test host can stub the MCP client completely.
- The repo ships a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` → `plugins/mcp-apps`). Its skills are `create-mcp-app`, `add-app-to-server`, `convert-web-app` and `migrate-oai-app`. The plan §8.6 install command (`/plugin install mcp-apps@modelcontextprotocol-ext-apps`) matches the repo's `README.md` (line 70), `docs/agent-skills.md` and `plugins/mcp-apps/README.md`. However, `.claude-plugin/marketplace.json` sets the marketplace `"name": "mcp-apps"`, so the `@…` suffix that actually works may be `@mcp-apps` (unverified; check in the session).

## Rules / lists: parsing and compilation
n/a: no rules or lists. The only "rule" engine is the host's tool visibility and CSP construction.

## Testing strategy
- **Unit tests**: `bun test src examples`. They include:
  - `src/server/index.test.ts`, covering metadata normalization and `getUiCapability`
  - `src/app.test.ts` and `src/app-bridge.test.ts` (3,132 lines)
  - `src/wire-compat.test.ts`
  - `src/interop-v1.test.ts`, which runs the published 1.7.5 package against this build (`package.json` "//interop")
- **Dependency isolation**: `scripts/check-dependency-isolation.mjs` asserts that `client` is a required peer and `server` an optional one. It also checks that a View-only consumer neither installs nor bundles `server`.
- **E2E**: Playwright drives `examples/basic-host`, the reference host (`playwright.config.ts`). The setup:
  - `examples:start` runs all examples
  - screenshot goldens use `maxDiffPixelRatio: 0.06` with animations disabled (`tests/e2e/servers.spec.ts-snapshots`)
  - the Docker Playwright image (`test:e2e:docker`) makes screenshots deterministic
  - `tests/e2e/security.spec.ts` checks sandbox attributes, rejection of cross-app message injection, that `window.top` is inaccessible, and referrer validation
- **Manual**: basic-host takes `SERVERS='["http://localhost:3001/mcp"]'` and serves at `:8080`. It connects **over HTTP only** (`docs/testing-mcp-apps.md`). It has panels for tool input/result, messages and model context.

## UX patterns worth copying
- **Closest example to our receipt card: `examples/lazy-auth-server`**, in vanilla TS.
  - `mcp-app.html` holds a heading, one line of text and a `.actions` row with **two buttons plus a fullscreen toggle**.
  - `new App(info, { availableDisplayModes: ["inline","fullscreen"] })` declares the modes.
  - The buttons call `callServerTool` with a 5-minute timeout, disable themselves while in flight, and render the output with `textContent` (`src/mcp-app.ts` lines 44–118; the file has 126 lines).
  - Its fullscreen toggle does **not** check `availableDisplayModes` first; it just catches the error. Add that check (spec MUST).
- Runner-up for layout: `system-monitor-server`, a `<dl>` info list plus a status chip, though it pulls in chart.js. `debug-server` shows app-only tools that do declare `resourceUri` (`server.ts` lines 220–275).
- Theming boilerplate (`examples/basic-server-vanillajs/src/mcp-app.ts`, `src/global.css`):
  - one `handleHostContextChanged(ctx)` that applies theme, variables, fonts and `safeAreaInsets` padding
  - called once after `connect()` with `getHostContext()`, then wired to `onhostcontextchanged`
  - `:root { color-scheme: light dark; --color-text-primary: light-dark(...) ... }` fallbacks
  - `<meta name="color-scheme" content="light dark">`
- Fullscreen (`docs/patterns.md` §"Entering / exiting fullscreen"):
  - toggle `.fullscreen` based on the returned `mode`
  - hide the button when `availableDisplayModes` lacks `fullscreen`
  - set `border-radius: 0` in fullscreen
- `updateModelContext` with **YAML frontmatter** keeps the model informed of what the user did in the View, without starting a new turn (`docs/patterns.md` §"Passing contextual information").
- Errors: the server returns `isError: true`. View-side failures go through `updateModelContext` (`docs/patterns.md` §"Giving errors back to the model").
- Set `prefersBorder` explicitly, "because hosts' defaults may vary" (`McpUiResourceMeta` doc).

## Performance tricks
- **Auto-resize** (`src/app.ts: setupSizeChangedNotifications`, line 2178):
  - a `ResizeObserver` on `<html>` and `<body>`, coalesced by `requestAnimationFrame`
  - it measures height by setting `html.style.height = "max-content"` for a moment, and reads width from `innerWidth` so scroll positions aren't destroyed
  - it sends only when the size changes, which avoids feedback loops
- `z.config({ jitless: true })` keeps zod working under strict CSP; `allowUnsafeEval: true` restores the JIT path.
- Peer externals give consumers one shared SDK and zod instance.
- `ontoolinputpartial` renders a preview from "healed" partial JSON (`docs/patterns.md` §"Lowering perceived latency"). Pause offscreen work with `IntersectionObserver` (§"Pausing computation-heavy views").
- Hosts MAY prefetch and cache the UI resource at connection time (spec §Resource Discovery → Behavior). So keep the HTML static and the data in the tool result.
- **No bundle sizes are reported in the repo.** A grep for gzip/KB finds none. The only number is that `*-with-deps` is "about 25% larger than the 1.x bundles" (`docs/migrate-to-2.md`). The plan's 58/64/129 KB figures come from elsewhere; re-measure them in P5.

## License and what it means for us
The code is Apache-2.0 or MIT (both permissive). We may copy snippets and patterns, such as the vite config, the theming handler and a test-host harness built on `AppBridge`, if we:
- keep attribution
- ship the Apache-2.0 text and the MIT notice (LF Projects copyright) in THIRD_PARTY notices
- treat the docs as CC-BY-4.0 when quoting prose

The package itself is a runtime dependency (MIT per npm metadata) and creates no copyleft concern.

## Implications for search-hole
- [mcp-tool-surface] Register `receipt` with `registerAppTool(server, "receipt", {…, _meta: { ui: { resourceUri: "ui://search-hole/receipt.html" } }}, cb)`.
  - Register `apply_rule` with `_meta: { ui: { visibility: ["app"] } }`, with or without the same `resourceUri`.
  - Give **only `receipt`** a `resourceUri`. If `search` had one, a panel would appear for every search (inferred from spec §Resource Discovery → Behavior: the host renders whenever `resourceUri` is present).
  - `registerAppTool` accepts any `Pick<McpServer,"registerTool">`, so it works on the instance built inside the SDK v2 `serveStdio(factory)` / `createMcpHandler(factory)`.
- [security] **`visibility: ["app"]` is enforced by the host, not the server.** The spec's MUSTs (`apps.mdx` §Visibility, lines 395–402) bind hosts that implement MCP Apps. A host that doesn't speak the extension, such as Claude Code (`docs/research/mcp-spec.md`, client matrix), has no reason to hide `apply_rule` from the model (inferred). `docs/research/mcp-spec.md` also notes that `tools/list` must be identical for every connection, so we can't simply leave the tool out. Required defenses in the `apply_rule` handler:
  - (1) Refuse unless this request declares `extensions["io.modelcontextprotocol/ui"].mimeTypes ∋ "text/html;profile=mcp-app"`, then return `isError` pointing to `/search-hole:block`.
  - (2) Require a single-use, short-TTL nonce that the server minted into the `receipt` result's `_meta`. The spec says `_meta` is "not intended for model context" (§Data Passing → Best Practices), but treat that as defense in depth, not a guarantee.
  - (3) Write every applied rule with `created_by: "panel"` and an undo entry.
- [dual-protocol] `getUiCapability`'s documented pattern (`server.server.oninitialized` + `getClientCapabilities()`, `src/server/index.ts` lines ~473–498) only works on **legacy** connections. On 2026-07-28 stdio connections, `getClientCapabilities()` is undefined (`docs/research/mcp-typescript-sdk.md`). Feed `getUiCapability` with `ctx.mcpReq.envelope["io.modelcontextprotocol/clientCapabilities"]` on modern requests and with `getClientCapabilities()` on legacy ones. Use it only to adapt **output** (and to gate `apply_rule`), never to vary registration.
- [ui-ux] Fallback is mandatory. The spec says: "Tools MUST return meaningful content array even when UI is available" (§Server Behavior → Graceful Degradation). `receipt` returns:
  - `content`: the one-line summary plus a short table, for the model and text-only hosts
  - `structuredContent`: the full receipt, which the spec says is "not added to model context"
  - `_meta`: the nonce and `viewUUID`
  
  Keep `structuredContent` small. The plan reports a ~150k-character delivery limit on claude.ai; that limit is not in this ref.
- [ui-ux] Inline card, two actions:
  - Primary: "Full receipt", which calls `requestDisplayMode({mode:"fullscreen"})`. Show it only if `hostContext.availableDisplayModes` includes fullscreen; otherwise fall back to `openLink` to the dashboard URL.
  - Secondary: "Open dashboard" via `openLink`, or the block action.
  
  Put per-row Block/Trust buttons (calling `apply_rule`) in the fullscreen view, so the inline card needs no menu. After each apply, call `updateModelContext` with YAML frontmatter (e.g. `blocked: pinterest.com`) so the model stops proposing it (`docs/patterns.md` §"Passing contextual information"). Gate this on `getHostCapabilities()?.updateModelContext`.
- [ui-ux] Theming: transparent body, `color-scheme: light dark`, fallbacks for every one of the 76 variables we use, `applyDocumentTheme`, `applyHostStyleVariables` and `applyHostFonts` in one handler, `safeAreaInsets` padding, and `prefersBorder` set explicitly. Since `applyHostFonts` applies only once (`src/styles.ts` line 212), font updates after init are lost; acceptable.
- [security] CSP: declare nothing except the font host. The default CSP has no `font-src`, so host-provided `@font-face` URLs need `resourceDomains`. The plan says `https://assets.claude.ai`, which is not verifiable in this ref. **Inlined `data:` fonts are blocked too**, so the panel can't embed Geist Mono; use `var(--font-mono)` with a system fallback. Also:
  - render no source favicons from remote URLs (`img-src 'self' data:` only)
  - render every web-sourced string with `textContent`, as lazy-auth does
  - make no `fetch` (`connect-src 'none'`)
- [runtime-packaging] View bundle: vanilla TS or Preact plus `vite-plugin-singlefile`, using exactly the examples' config:
  - `plugins:[viteSingleFile()]` (Preact adds `@preact/preset-vite` before it)
  - `rollupOptions.input: process.env.INPUT`, `emptyOutDir:false`, minify unless dev, inline sourcemap in dev
  
  The gateway reads `dist/receipt.html` in the resource read callback (`examples/basic-server-vanillajs/server.ts`). For a single-file gateway bundle, inline the HTML as a string at build time instead of reading from disk (inferred). The examples pin **vite ^6** and singlefile ^2.3.0; plan §8.2 uses Vite 8 (Rolldown), so check that singlefile works with Rolldown in P5 (inferred risk).
- [runtime-packaging] Versions: ext-apps 2.0.4, `engines.node >=20`, `LATEST_PROTOCOL_VERSION = "2026-01-26"`, `dependencies: @standard-schema/spec ^1.1.0`. Peers:
  - `@modelcontextprotocol/client ^2.0.0`, required (the View bundles it, because `App` extends `Protocol`)
  - `core ^2.0.0`, required
  - `server ^2.0.0`, optional, only needed for `./server`
  - `zod ^4.2.0`, required (4.0/4.1 rejected: no `~standard.jsonSchema`, `docs/migrate-to-2.md`)
  - react 17–19, optional
  
  This matches plan §3 (SDK v2 2.4.0 satisfies `^2.0.0`). Pass `webMcpBridge: false` to skip probing `document.modelContext`.
- [dual-protocol] **Don't copy the examples' `main.ts`.** They use `createServer().connect(new StdioServerTransport())` and `NodeStreamableHTTPServerTransport`, the legacy path (`examples/basic-server-vanillajs/main.ts`). Use `serveStdio(factory)` / `createMcpHandler(factory)` per `docs/research/mcp-typescript-sdk.md`.
- [testing] For P5 tests:
  - (a) Unit-test the View against an in-page `AppBridge(null, hostInfo, hostCaps, {hostContext})` that pushes fixture `sendToolResult` payloads, including hostile titles for the XSS test, and asserts `oncalltool` receives `apply_rule` with the right args.
  - (b) Run Playwright screenshot goldens in light and dark through basic-host, which needs the gateway's HTTP entry because basic-host is HTTP-only, with the 0.06 diff ratio and the Docker image.
  - (c) Run the axe pass on the View.
- [session-definition] `hostContext.toolInfo.id` (the JSON-RPC id of the `tools/call`) plus a server-minted `viewUUID` in result `_meta` identify one panel instance. They are not a conversation. Don't use them as the session key (inferred).
- [distribution] Claude Code users can install the `mcp-apps` skills from this repo's marketplace (`.claude-plugin/marketplace.json`) in the building session, matching plan §8.6.

## Borrow / avoid
**Borrow**
- `lazy-auth-server`'s layout as the starting point for the receipt card: two actions plus a fullscreen toggle, `availableDisplayModes` in the constructor, `textContent` rendering, and disabled-while-pending buttons.
- The one-handler theming pattern plus the `global.css` fallback block (`basic-server-vanillajs`).
- An `AppBridge`-based fake host for unit tests, plus the security self-tests idea (`tests/e2e/security.spec.ts`).
- `updateModelContext` with YAML frontmatter after user actions; `viewUUID` in `_meta`.
- A dependency-isolation check in CI: the View bundle must not pull in `@modelcontextprotocol/server` (`scripts/check-dependency-isolation.mjs`).
- Explicit `prefersBorder`; CSP and `domain` only on the `resources/read` content item.

**Avoid**
- Trusting `visibility: ["app"]` as the only guard on `apply_rule`.
- Conditional tool registration in `oninitialized` (legacy only; it breaks the stateless era and the identical `tools/list` rule).
- `localStorage` without try/catch (opaque-origin hosts), remote favicons, web fonts as `data:` URIs, any `fetch`.
- The deprecated flat `_meta["ui/resourceUri"]` and raw zod shapes. `registerAppTool` writes the flat key anyway for old hosts, which is fine.
- Copying the examples' legacy transport wiring or their chart.js/three.js dependencies (budget ≤ 80 KB gz).
