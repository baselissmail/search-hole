# baselissmail/smart-doctor
> Ref: `~/Documents/personal dev/smart-doctor` @ 4cca89b (2026-10-28) · License: **MIT** (`LICENSE`, "Copyright (c) 2026 Basel Issmail"; `package.json` `"license": "MIT"`). No per-directory licenses. Runtime deps: `jose` 6.2.13 (MIT), `yaml` 2.9.1 (ISC), `@fontsource-variable/atkinson-hyperlegible-{next,mono}` 5.3.0 (fonts: `"license": "OFL-1.1"` in each installed `node_modules/@fontsource-variable/*/package.json`). Same author as search-hole, so the code can be reused directly. Version 0.2.3, 22 commits, first public release 0.2.0 on 2026-10-28.

## Purpose
A local CLI, web view and GitHub Action that works out why a SMART on FHIR (OAuth2) login fails. It runs every check it can on the client side, makes the real token request once, then turns the facts into **ranked causes with why/fix text**. It sends no telemetry and secrets never leave the machine. It does not do search, but it is the template the plan names for several search-hole mechanisms (§4 "ports and adapters, the same idea as smart-doctor's Run event bus", §12.2 typed errors, §12.3 mock server, §12.4 dashboard security, §4 option (b) binaries). This note says exactly which files and functions to lift, and where search-hole needs something different.

## Architecture sketch
```
 bin/smart-doctor.js ─► src/cli.js ─┐            (front-ends = adapters)
 src/ui/server.js (SSE) ────────────┤  subscribe to Run events
 action.yml (GitHub Action) ────────┤
 test/*, scripts/demo.js ───────────┘
            │ new Run() + withRun(run, flow)
            ▼
 doctor.js / launch.js (flows)  →  gatherers + checks (keys, discovery, clock, jwks, assertion, token…)
            │ httpRequest() reads currentRun() via AsyncLocalStorage, redacts, emits 'http'
            ▼
 core/result.js finish() → diagnose.js (facts → ranked causes, data in knowledge/*.js, vendors/*.js)
            ▼
 report.js renderHuman / renderJson / renderMarkdown      site/build.mjs (website generated from the same data)
```
`ARCHITECTURE.md` names four borrowed ideas: gather → judge → report (Lighthouse), ports & adapters, knowledge as data (ESLint rules, WireMock/Mockoon scenarios) and local-first files in git (Bruno). The code is plain JS ESM with JSDoc types checked by `tsc --checkJs` (`tsconfig.json`, `src/types.js`) and has **no build step**. `CONTRIBUTING.md` "Making a change" explains why: Node won't run `.ts` from `node_modules`.

## Key modules and data flow
- **Run event bus.** `src/core/run.js` (103 lines). `class Run extends EventEmitter` has `id = randomUUID()`, `flow`, `startedAt`, `steps[]` and `exchanges[]`. Its API:
  - `step(id, name)` emits `step:start` and returns a handle `{record, add(...checks), end()}`. `end()` sets `status = rollup(checks)` and emits `step:end`.
  - `amend(id, ...checks)` handles late facts (the clock from a later `Date` header) and emits `step:update`. It creates the step if it is missing, so "a late check is never silently dropped".
  - `http(exchange)`, `action({type:'open-url'|'await-paste'})`, `log(level,msg)` and `sections()`, which returns the steps that have checks.
  - `rollup()` is worst-wins: fail > warn > pass > info > skip.
  - Scoping is ALS:
    ```js
    // src/core/run.js (MIT)
    const als = new AsyncLocalStorage();
    export function currentRun() { return als.getStore(); }
    export function withRun(run, fn) { return als.run(run, fn); }
    ```
    `runCheck(opts, ctx)` (`src/doctor.js:20-34`) does `const run = ctx.run || new Run(...)` and then `withRun(run, () => backendFlow(opts, run))`. The caller can pass its own Run to subscribe before the work starts.
- **`done`.** `src/core/result.js` `finish(run, meta, token, facts)` calls `diagnose()` and emits `done` with `publicResult(result)`. `publicResult` strips `_accessToken` and the vendor functions, so the result is "safe to serialise to any front-end".
- **Consumers.**
  - CLI (`src/cli.js:266-311`) subscribes `step:end` to live progress on stderr, but only when stderr is a TTY and the output is not `--json`/`--report`. It subscribes `action` to show prompts.
  - UI (`src/ui/server.js:241-242`) forwards every event to SSE.
  - Tests and the demo use only the returned result.
  - The Action pipes `--report` Markdown into `$GITHUB_STEP_SUMMARY` (`action.yml`).
- **One HTTP helper.** `src/util.js` `httpRequest(url, opts)` wraps `fetch` with `redirect:'manual'`, an AbortController timeout (default 15 s) and `durationMs`. It **never throws on network errors**. It returns `{ok:false, networkError}` with a human cause from `describeNetworkError()` (ENOTFOUND, ECONNREFUSED, TLS codes, with a hint to set `NODE_EXTRA_CA_CERTS`). If `currentRun()` exists it records a **redacted** exchange with `pickHeaders()`, which allowlists `content-type, date, location, retry-after, www-authenticate, cache-control`. The `traceBody:false` option records `'[response body not recorded by design]'`.
- **Adapters.** `src/types.js` defines `RunContext {run, browser, prompter, signal}`. `src/adapters/browser.js` `systemBrowser({print})` first calls the optional `print(url)` callback (the CLI's sign-in flow passes one, so the URL is always shown), then returns early if `SMART_DOCTOR_NO_BROWSER` is set, otherwise spawns `open`/`xdg-open`/`cmd /c start` detached and swallows spawn errors. `src/adapters/scripted-browser.js` `fakeBrowser()` follows redirects and submits the mock's form for tests.
- **Exit codes.** `UsageError` (`src/core/errors.js`) and `ProfileError` exit with 2 and print no stack trace (`src/cli.js:124-129`). A failing verdict exits with 1.

## Data model and storage
There is no database. Results live in memory per run. The UI keeps `runs: Map<runId, {events[], listeners:Set, abort:AbortController, result, pasteResolve}>` and drops each entry after 30 min (`setTimeout(...).unref()`, `src/ui/server.js:226-266`).

Shapes (all JSDoc):
- Check `{id, title, status, detail?, fix?, data?}` (`src/util.js` `check()`).
- Cause `{id, title, why, fix, confidence 0..1, evidence?}` (`src/diagnose.js` typedef).
- Result `{runId, flow, meta, sections, diagnosis:{verdict:'ok'|'warn'|'fail'|'offline', causes}, http, tokenRequested, tokenObtained}` (`src/core/result.js`).

Profiles live in `smart-doctor.yaml`, described below.

## Config format
- `smart-doctor.yaml` is a map of named profiles (`src/profiles.js`). It is found by `findConfig()` in this order: `--config` → `$SMART_DOCTOR_CONFIG` → the nearest `./smart-doctor.yaml` walking up → `~/.config/smart-doctor/`.
- **Refuses secrets.** `ALLOWED` is a fixed key set (17 keys), and `FORBIDDEN = /secret$|^secret|password|privatekey|private_key|token$|^accesstoken|^refreshtoken|assertion/i` rejects with a message telling the user what to use instead. `secretEnv` must pass `isEnvVarName`. Secrets come only from env vars or from the UI's password field for one run.
- Options go profile + flags + env → `RunOptions` through one function, `src/options.js` `buildOptions`. The CLI and the UI share it, so validation and fallbacks are identical (`CHANGELOG.md` 0.2.1: "The local web view now applies the same option fallbacks and validation as the CLI").

## Extension points (plugins, hooks)
- Everything that is "knowledge as data" can be extended without touching the engine. `CONTRIBUTING.md` "Where to add what" maps each kind of change to a file:
  - causes → `src/knowledge/causes.js`
  - server wording → `src/knowledge/errors.js`
  - regression corpus → `src/knowledge/seen.js`
  - vendor quirks → `src/vendors/<id>.js`, registered in `src/vendors/index.js`
  - failure modes → `MODES` in `src/mock/server.js`
- Front-ends plug in by subscribing to `Run`. Browser and prompt are adapters.
- Library exports: `package.json` `exports` `"."` and `"./mock"`, so the mock server is a public API.
- Claude Code plugin: `.claude-plugin/plugin.json` and `marketplace.json` (`"source": "./"`), plus `skills/smart-doctor/SKILL.md`. It has a "Safety rules (follow exactly)" section and a "Finding the CLI" fallback order (PATH → `node <repo>/bin/...`). **No MCP server and no hooks.**

## Rules / lists: parsing and compilation
There are no blocklists. The analogue is the **explanation catalogue**:
- **Causes.**
  - `CAUSES: Record<id, {stage, title, why, fix}>` (57 entries, `src/knowledge/causes.js`; the built site also says "57 causes") and `STAGES[{id,title,blurb}]` (9 stages, used to group the website).
  - The ids are stable snake_case and are used in JSON output, tests and site URLs (`errors/<id-with-dashes>/`).
- **Ranking.** `src/diagnose.js` `diagnose(facts)` turns facts into `cause(id, confidence, evidence, override?)` calls:
  - It merges duplicates by keeping the highest-confidence entry (its evidence, or the earlier entry's evidence if it has none), then sorts by confidence descending.
  - It "never ends a failed request with nothing to say": the fallback is `unrecognised_error` at 0.5.
  - Vendor hints are added at `0.15|0.4 + weight` (0.15 when a local check already explains the failure; the 0–0.3 weight range is enforced by the guard test, not clamped in code) and titled `"<Vendor>: <title>"`.
  - Verdict rule: a private-key leak always fails; a token plus a cause ≥ 0.5 gives `warn`.
  - `confidenceLabel()` (`src/report.js:40`) maps confidence to words: ≥0.8 "very likely", ≥0.6 "likely", ≥0.4 "possible", otherwise "less likely".
- **Server wording.**
  - `TEXT_PATTERNS[{re, cause, confidence?, final?}]` is ordered, specific patterns first, and `final` stops generic patterns from piling on.
  - `ERROR_ALIASES` with `normalizeError()` handles spellings like "Invalid Grant" and `invalid-client`.
  - `ERROR_CODES` holds the meaning of each code and the causes most often behind it (`src/knowledge/errors.js`).
- **Regression corpus.** `SEEN[{where, body, expect}]` (`src/knowledge/seen.js`) holds real server bodies and the cause that must rank first. `test/knowledge.test.js` generates one test per entry.
- **Shape guards.** `test/knowledge.test.js` checks that every cause has a stage, title, why and fix, and that ids are snake_case. It **regex-scans `diagnose.js` source** for `cause('x')`/`add('x')` ids and checks that each one exists in `CAUSES`. Patterns must point at real causes, and vendor hints must have a `source`, a weight ≤ 0.3 and valid `flow`/`auth` values.

## Testing strategy
- **Runner and size.** The runner is Node's built-in `node --test` (`package.json` `"test"`), with no Vitest. There are about 150 `test(...)` calls across 10 files (counted with grep, `test/*.test.js`). `npm run check` runs lint + typecheck + format:check + test with no network (`AGENTS.md`).
- **Mock EHR with named failure modes.** `src/mock/server.js` `startMock({port=0, clients, modes, verboseErrors})`:
  - `MODES` is a `{name: description}` map with 18 entries, e.g. `clock-skew`, `rate-limit` (429 + `Retry-After: 30`), `server-error`, `stale-jwks`, `cached-discovery`, `wrong-state`, `user-denies`, `auto-approve` and `server-jwks-down`.
  - Unknown modes throw and list the valid ones (`:77`). Modes are a `Set` checked with `modes.has(...)` at each branch point.
  - Like real servers it returns bare `{"error":"invalid_client"}` unless `verboseErrors` is set.
  - It returns `{fhirBase, tokenUrl, …, jwksUrlFor(id), setClient(c), close()}`. `close()` calls `server.closeAllConnections()`.
  - The CLI exposes `smart-doctor mock --mode … --list-modes` (`src/cli.js:447-454`). `src/mock/demo.js` `startDemoMock()` adds three demo clients plus matching profiles, shared by `mock` and `ui --demo`.
- **E2E helper.** `test/helpers.js` `scenario({key, jwksFile, modes, client, check, before})` starts a mock on port 0, runs `runCheck`, closes the mock and returns the result. `topCause(r)`, `causeIds(r)` and `checkStatus(r,id)` make assertions one-liners (`test/integration.test.js`, 34 tests; `test/launch.test.js`, 27).
- **"The mock must be strict"** (`test/mock.test.js`): hand-built requests prove that it rejects jti replay and similar mistakes, "otherwise the end-to-end tests prove nothing".
- **Safety tests** assert that output and traces never contain a JWT (`/eyJ[\w-]+\.[\w-]+\.[\w-]+/`), the access token, private `d` or the secret (`test/integration.test.js:203-205,334`, `test/launch.test.js:249-253`, `test/cli.test.js:32-35`).
- **Property tests** use fast-check at `numRuns: 300` (`test/properties.test.js`):
  - `explainError` never throws and only returns known causes with confidence in [0,1]
  - `redactText` removes any known secret embedded in arbitrary text, and any JWT-shaped string
  - the callback parser never crashes
  - `normalizeError` is idempotent
- **UI API tests** (`test/ui.test.js`): CSP present, wrong token gives 401, a foreign `Host` gives 403, saving a secret gives 400. A hand-rolled SSE parser checks event order, that no JWT appears in the stream, and that a reconnect after `end` replays once and closes.
- **Site test** (`test/site.test.js`): one page per cause, every internal link resolves, every page has a `<title>` and a description of at least 20 chars.
- **Outside `npm test`:**
  - `npm run demo`: 25 scenarios, run in the CI test job.
  - `smoke:sandbox`: needs network, 16 scenarios against the public SMART launcher, exits 1 on a diagnosis diff.
  - `smoke:ui` and `readme-images`: optional Playwright, which generates screenshots and README images from real runs (`scripts/*.mjs`).
- **`TESTING.md`** is graduated: 1 automated (no network) → 2 CLI vs mock → 3 wizard → 4 web view → 5 public sandboxes → 6 your real setup → 7 binary. It ends with a "Ready to share when" checklist.

## UX patterns worth copying
- **Explanations with "evidence".** Each cause can carry the exact server text that triggered it (`diagnose.js` `cause(..., evidence)`), shown next to its why/fix.
- **`explain` command.** You paste an error and get ranked causes with no run at all (`explainError()`, `src/diagnose.js:304`). The UI exposes it at `/api/explain`.
- **Paste-safe `--report`** Markdown with redaction **on by default** (`renderMarkdown(result, {redact = true})`) and a UI "Copy report for a ticket" button that says what was masked (`src/ui/assets.js`). `scrubber()` masks whole values only, which fixes the bug where client id "app" turned `application/json` into `***lication/json` (CHANGELOG 0.2.3).
- **Website error catalogue generated from the knowledge files** (`site/build.mjs` imports `CAUSES`, `ERROR_CODES`, `SEEN`, `VENDORS`, `MODES`), so the docs can't drift from the tool.
- **First-run states.** The empty state teaches ("Start with a profile", `src/ui/assets.js:29-34`) and `ui --demo` gives you a practice server. The SSE `onerror` shows "Lost the connection… Is it still running in your terminal?" instead of hanging.
- **Accessibility and theme.** Atkinson Hyperlegible fonts, `prefers-color-scheme` and `prefers-reduced-motion` CSS (`src/ui/assets.js:145-245`). The issue form "Wrong or missing diagnosis" comes first and asks for `--report` output (`.github/ISSUE_TEMPLATE/1-wrong-diagnosis.yml`).

## Performance tricks
- **Lazy loading.** `cmdUi` loads the UI with `await import('./ui/server.js')` (`src/cli.js:510`), and fonts are read when requested.
- **Bounded input.**
  - Trace bodies are capped at `MAX_BODY = 4000` chars (`src/core/redact.js`; JSON and plain-text bodies only, form-encoded bodies are not truncated), and UI request JSON at 1e6 chars (`readJson`, which destroys the connection).
  - `redactDeep` stops recursing past depth 8 and returns anything deeper **unmasked** (a security caveat if the file is copied as is).
  - `stripTrailingSlash` uses a loop instead of `/\/+$/` to avoid quadratic backtracking (`src/util.js:56`), a CodeQL finding fixed in 0.2.2.
- **Small and quiet.** Four runtime deps and no build step. Long-lived timers are `.unref()`'d so they don't keep the process alive.

## License and what it means for us
MIT, same author. search-hole may copy files outright (`run.js`, `redact.js`, the `startUi` security block, the mock pattern, the workflows). Keep the MIT notice if search-hole ends up Apache-2.0. If search-hole bundles the Atkinson fonts, it must carry their OFL-1.1 license (confirmed in the fontsource `package.json` files). We plan Geist, which is also OFL (inferred; check the `geist` package).

## Implications for search-hole
- [dashboard-process-model] **What smart-doctor does.** The UI is an on-demand foreground process (`smart-doctor ui`): **port 0 by default**, a **new token per start**, it opens the system browser unless `--no-open`, and closes on SIGINT/SIGTERM (`src/cli.js:500-525`). Events are in-process (Run → SSE), with no DB.
  **What search-hole needs instead.** §4 wants a fixed port + lockfile + DB tail across processes. The gateway must be able to print the dashboard URL including the token, so persist the token in a `0600` file in the data dir, or rotate it per dashboard start and have the gateway read it from the lockfile (inferred design; smart-doctor has no precedent).
- [security] Lift the request guard in `startUi` (`src/ui/server.js:59-122`) almost verbatim:
  - `randomBytes(24).toString('hex')` token
  - `timingSafeEqual` with a length check (`safeEqual`)
  - an exact `Host` allowlist `127.0.0.1:${boundPort}` / `localhost:${boundPort}`, which returns 403 before any routing
  - token via the `x-<app>-token` header or `?t=` (needed because EventSource can't set headers). The token is checked **only for `/api/*`**: `/`, `/app.css`, `/app.js` and `/fonts/*` are served after the Host check alone.
  - **non-GET `/api/*` must be `application/json`** (415 otherwise, checked after the token). The usual reason, that this forces a CORS preflight which never succeeds, is inferred: the source gives no rationale and no test covers the 415.
  - no CORS headers at all
  - body cap of 1e6 decoded chars (`data.length > 1e6` → `req.destroy()`, no 413 reply)
  - common headers `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`
- [security] smart-doctor uses **no cookie**. The page moves `?t=` into `sessionStorage` and calls `history.replaceState(null,'','/')` (`src/ui/assets.js:319-320`), so the token leaves the address bar.
  **Gaps to close in search-hole:**
  - IPv6 loopback is unsupported: the server binds `127.0.0.1` only and `[::1]` is not in the Host allowlist.
  - No `Origin` check (the token covers it).
  - The token stays in the SSE query string.
  - `sessionStorage` is per tab: a reload in the same tab keeps working, but a new tab or window needs the original URL again.
- [security] **CSP text to reuse** (served on `/` only, `src/ui/server.js:101-102`):
  `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  With the React/Vite stack in §8.2, check which libraries inject `<style>` tags at runtime (sonner is a likely case, inferred). That would need a hash or nonce, not `'unsafe-inline'`.
- [ui-ux] **Bundled fonts, two paths.**
  - npm: `require.resolve('@fontsource-variable/.../*.woff2')`.
  - Binary: `scripts/build-assets.mjs` writes `src/ui/fonts.generated.js` (base64, gitignored), which `loadFont()` imports through a literal path so Bun embeds it. Served with `font/woff2`, `max-age=86400`, `font-display: swap`; on failure the CSS falls back to system fonts.
  - Do the same for Geist woff2 (geist npm package).
- [dashboard-process-model] **SSE details worth copying** (`streamEvents`, `src/ui/server.js:268-288`):
  - a per-run event log that is replayed to late subscribers
  - a `: ping` comment every 15 s
  - the stream **closes after `end`**, so EventSource does not auto-reconnect and replay
  - failures are named `run-error`, **never `error`**, because EventSource reserves `error`
  - `done` passes through `publicResult()` again
  For search-hole's DB tail, replace the per-run replay with `Last-Event-ID` = rowid (inferred adaptation).
- [engine-adapter] Copy the single HTTP helper contract:
  - never throws
  - returns `{ok, status, headers, text, json, durationMs}` on a response, or `{ok:false, status:0, headers:{}, networkError, durationMs}` on a network error or timeout (no `text`/`json`)
  - the traced exchange keeps only the six allowlisted response headers (`pickHeaders`), so e.g. rate-limit headers reach the caller but not the trace
  - `describeNetworkError()` turns error codes into human text
  - `redirect:'manual'`
  - an AbortController timeout
  - reports into the ambient run through ALS (`src/util.js:67-143`)
  Every engine adapter then gets tracing + redaction for free. Note: smart-doctor uses global `fetch`; search-hole's fetcher still needs the SSRF-safe undici dispatcher from §12.4.
- [other] **Run event bus → pipeline trace.**
  - Port `Run` as `SearchRun` with events such as `engine:start/end`, `http`, `rule:hit`, `merge`, `done`.
  - Run the pipeline inside `withRun()`.
  - Consumers: the SQLite writer, the MCP result builder (text + `structuredContent`), `searchhole search --explain` (live stderr only if TTY), and tests.
  - Because the dashboard is another process, the store writer is the bridge (§4 runtime topology).
  - Keep the "caller may pass its own Run" signature (`ctx.run || new Run()`) so subscribers attach first.
- [security] **Redaction at source.**
  - Copy `src/core/redact.js`, then extend `SENSITIVE_HEADERS` (`authorization`, `cookie`, `set-cookie`, `proxy-authorization`) with engine key headers: `x-subscription-token` (Brave), `x-api-key`, `api-key`. Also extend `SENSITIVE_KEYS` with `api_key`, `key`, `token`, `apikey`, for query and body.
  - Keep three mechanisms: `requestSecrets()`, which collects the values actually sent so that server echoes are masked anywhere; `redactText()`, with a JWT-shape regex; and `NO_PREFIX` (no partial reveal).
  - Extend them too, because as written they cover less than the names suggest: `requestSecrets()` collects only sensitive fields of a **form-encoded body** and the `Authorization` credential (plus the decoded Basic secret). It ignores URL query params, JSON bodies and every other header, so an echoed `x-subscription-token` or `?key=` would not be masked. `redactText()` masks known values only when they are ≥ 6 chars. `NO_PREFIX` holds only `client_secret`, `password` and `code_verifier`; other `SENSITIVE_KEYS` keep an 8-char prefix in bodies and a 4-char one in URLs, so engine key names must be added to `NO_PREFIX`. `redactDeep` leaves values deeper than 8 levels unmasked.
  - Pair with §12.4 query-secret scanning, which smart-doctor doesn't need.
- [testing] **Mock engine server = `startMock` pattern.**
  - A `MODES` `{name: description}` map, validated at start, toggled by `modes.has()`.
  - Port 0, with `close()` calling `closeAllConnections()`.
  - Runtime `setClient()`-style mutation.
  - Behaves like real servers (vague errors) unless `verboseErrors`.
  - A CLI `searchhole mock --mode … --list-modes`, and a `scenario()` helper returning `topCause()`-style accessors.
  - Map the §12.3 scenarios to mode names (`slow`, `rate-limit`, `quota-exhausted`, `malformed-json`, `empty`, `duplicates`, `no-dates`, `redirect-chain`, `ssrf`, `hostile-titles`, `list-shrinks`).
  - Add a "mock must be strict" test file and a `demo` script run in CI.
- [other] **Typed errors as data** (§12.2): a `CAUSES`-like catalogue for engine and gateway failures (bad key, quota, 429, SearXNG JSON format disabled, no engine healthy, list fetch failed), each `{stage, title, why, fix}` with stable ids. Then:
  - `doctor` ranks them with `confidence` + `evidence`.
  - A `SEEN` corpus holds real engine error bodies and the expected cause.
  - Guard tests check the shape, and the engine source is scanned for unknown ids.
  - The website/docs error catalogue is generated from the same data.
- [rule-format-precedence] The same pattern explains hidden results: every rule/list hit is `{ruleId, listId, title, why, undo}`, with `evidence` = the matched pattern. `explainError` maps to `searchhole explain <url>`, which says why it would be hidden or kept without running a search.
- [security] **Config refuses secrets**: `ALLOWED` set + `FORBIDDEN` regex + an env-var-name check (`src/profiles.js:16-80`). `FORBIDDEN` is tested against setting **names** only (`secretEnv` is exempt). Values are not scanned, except that `secretEnv` must look like an env-var name. Use this for `rules.yaml`/`.searchhole.yaml`. `findConfig()`'s walk up the directory tree is the discovery model for the project file; search-hole adds trust-by-hash.
- [runtime-packaging] **Proof that `bun build --compile` works for a Node ESM app with deps** (`scripts/build-binaries.mjs`):
  - `npx -y bun@1.2.21 build bin/smart-doctor.js --compile --minify --target=bun-<os>-<arch>` for `darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64` (`.exe`).
  - Bun is pinned via npx, so no Bun install in CI.
  - The entry point strips `--smol`/`--bun` from argv when `process.versions.bun` is set (`bin/smart-doctor.js`).
  - `src/version.js` is a constant, so the binary needn't read `package.json`; a test enforces that `package.json`, `version.js` and `.claude-plugin/plugin.json` match (`test/profiles.test.js:42-43`).
  - **Binary sizes are not recorded in the repo.** The script prints MB at build time; measure in P0.
  - smart-doctor has no native runtime dep (the only platform-specific packages are TypeScript 7's dev-only `@typescript/typescript-<os>-<arch>` binaries). With `bun:sqlite` in the binary and `node:sqlite`/other on npm, search-hole needs a driver interface (inferred).
- [distribution] **Signing.**
  - macOS binaries get **ad-hoc signing only** (`codesign --force --sign -` on a macos runner, `release.yml`). TESTING.md §7 says Linux-cross-built darwin binaries are unsigned.
  - **No notarization, no Windows Authenticode.**
  - Integrity comes from `SHA256SUMS-<os>.txt` plus `actions/attest-build-provenance` sigstore bundles attached as `provenance-<os>.sigstore.json` (verify with `gh attestation verify`).
  - For a Claude Code plugin shipping binaries in `bin/`, decide in the ADR whether ad-hoc is enough (inferred: git-cloned files don't get the quarantine xattr, browser downloads do).
- [distribution] **npm and binaries come from one tree.**
  - `files` whitelist (`bin, src, skills, README, CHANGELOG, SECURITY, LICENSE`), plus a CI job that fails if `npm pack --dry-run --json` contains anything else (`ci.yml` job `package`).
  - Docker image `node:24-alpine@sha256:…` with `npm ci --omit=dev --ignore-scripts` and `USER node` (`Dockerfile`).
  - Composite GitHub Action (`action.yml`).
  - Claude Code marketplace pointing at the repo root.
- [distribution] **Release pipeline** (`release.yml`, `RELEASING.md`). On a tag `v*.*.*`:
  1. `verify`: `npm run check`, and the tag must equal `package.json`.
  2. `build` matrix: ubuntu builds linux-x64, linux-arm64 and windows-x64; macos builds the darwin targets. The Linux binary is smoke-tested with `scripts/binary-smoke.sh`, which drives the real binary against its own mock.
  3. `github-release` (softprops, `generate_release_notes`). Steps 3 and 4 both `needs: build` and run in parallel. A `workflow_dispatch` run does only `verify` + `build`.
  4. `npm`: **trusted publishing via OIDC** (`id-token: write`, environment `npm`, `npm publish --provenance`), which skips the publish if the version already exists. The first publish is done by hand, then `npm trust github …`.
- [distribution] **Supply-chain hygiene to mirror:**
  - every action pinned to a commit SHA
  - `persist-credentials: false`
  - top-level `permissions: contents: read` in `ci.yml`, `pages.yml` and `release.yml` (`scorecard.yml` uses `read-all`, with job-level write scopes)
  - OpenSSF Scorecard weekly + on push to `main` + on branch-protection changes, SARIF to code scanning (`scorecard.yml`)
  - OpenSSF Best Practices badge (README; project 16012)
  - Dependabot with a **7-day cooldown**, grouped dev-deps/actions, and `ignore` rules for semver-major updates of `@types/node` and the Docker `node` image (to stay on the oldest supported Node and on LTS)
  - CodeQL and rulesets (signed commits, linear history, protected immutable tags) are repo settings with no workflow file (CHANGELOG 0.2.1)
  - **No SBOM.** The changelog is hand-written (an `Unreleased` section, conventional commits, squash merges), with **no changesets/release-please**.
- [testing] **CI matrix:** `test` runs on ubuntu, macOS and **Windows** × Node 22 and 24 with `fail-fast: false`, then `npm test` + `npm run demo`. There are separate jobs for lint/types/format, package contents + site build, and the binary build + smoke (`ci.yml`). This shows the same approach works for search-hole's Node 22/24/26 support.
- [mcp-tool-surface] smart-doctor ships **no MCP server**, only a skill that shells out to the CLI. Its skill's numbered "Safety rules (follow exactly)" and "Finding the CLI" sections are the template for search-hole's skill (never claim a rule was applied; use `suggest_rule`).
- [other] **Docs set to mirror:**
  - `ARCHITECTURE.md`: a borrowed-ideas table, a layout tree, a Run events list (a code block) and a front-end × subscribes/provides table.
  - `TESTING.md`: graduated steps, a "Try X → expected top cause" table, a "Ready to share when" list.
  - `SECURITY.md`: private reporting, 3/10 working-day SLA, a supported-versions table, a "what we do with each secret" table, a local UI section, and an "AI agents" section with permission deny rules.
  - `RELEASING.md`: one-time setup, how changes land, every release.
  - `CONTRIBUTING.md`: "Where to add what" table, rules for knowledge, a labels table, "Safety is a feature".
  - Also `AGENTS.md` (with `CLAUDE.md` = `@AGENTS.md`), `ROADMAP.md` (Next/Later/Not planned), `SUPPORT.md`, issue forms with `blank_issues_enabled: false`, and a PR checklist.

## Borrow / avoid
**Borrow**
- `src/core/run.js` (Run + ALS `withRun`/`currentRun` + `rollup` + `amend`) as the pipeline's event spine; `finish()`/`publicResult()` for a single "safe to serialise" result shape.
- `src/util.js` `httpRequest`/`describeNetworkError` and `src/core/redact.js` (whole file) with engine-key headers added; the property tests for `redactText` in `test/properties.test.js`.
- The `startUi` guard block (token, `safeEqual`, Host allowlist, JSON-only non-GET, headers, CSP) and `streamEvents` SSE semantics (`end` closes the stream, `run-error` naming, 15 s ping). Also `systemBrowser()` for `searchhole ui` and the `listen()` helper, which rejects on a busy port instead of crashing.
- Knowledge-as-data: `CAUSES`/`STAGES`, `TEXT_PATTERNS` with `final`, a `SEEN` corpus, and guard tests that scan engine source for ids. Also the confidence → words labels and a docs catalogue generated from data plus a link-check test.
- The mock-server pattern (`MODES` map, `startMock` handle, `scenario()`/`topCause()` helpers, `--list-modes`, the "mock must be strict" tests, `demo` in CI) and `binary-smoke.sh`, which drives the compiled binary against its own mock.
- `build-binaries.mjs` + `build-assets.mjs` (embedded fonts), the version-sync test, the release workflow (OIDC trusted publishing, provenance attestations, SHA256SUMS, tag == version check), the npm-pack whitelist CI job, Scorecard, SHA-pinned actions, and Dependabot cooldown.
- Config hygiene: `ALLOWED` + `FORBIDDEN` keys, env-var names only, the `findConfig` walk up the tree, and `UsageError` → exit 2 with no stack trace.

**Avoid**
- **Doc drift.** `CONTRIBUTING.md:27`, `AGENTS.md:34` and `.github/pull_request_template.md:12` still say "`SEEN_ON_REAL_SERVERS` in test/knowledge.test.js", but the corpus moved to `src/knowledge/seen.js` (`SEEN`). Generate or test doc references to file and symbol names.
- **UI as JS strings.** `src/ui/assets.js` (716 lines of HTML/CSS/JS in template strings) hides the code from lint and types (ROADMAP "Later" plans to fix it). search-hole's Vite-built dashboard avoids this, but must embed the built assets for binaries the way the fonts are embedded.
- **Port 0 + a token that dies with the process.** That doesn't fit a fixed-port, single-instance dashboard that gateways link to; design token persistence explicitly.
- **Ad-hoc-only macOS signing and no Windows signing.** Plan notarization or document the Gatekeeper and SmartScreen behaviour. Also add an SBOM (missing here) if the plugin ships binaries.
- **Pinning an old Bun** (`bun@1.2.21`) through `npx -y` at build time: pin a current Bun with a checksum and record the binary sizes in CI output or the release notes.
- **Loose type checking.** `tsconfig.json` has `"strict": false`; search-hole's TS-strict plan (§12.1) is right. Also avoid regex-scanning source as the only way to find ids: use typed constants so the compiler checks the ids.

## Verification
2026-10-29. Checked 105 claims against the source at 4cca89b: the license header and section, every "Implications" bullet, and the mechanisms they rely on (`src/ui/server.js`, `src/ui/assets.js`, `src/util.js`, `src/core/*.js`, `src/profiles.js`, `src/mock/server.js`, `src/diagnose.js`, `src/knowledge/*`, `src/adapters/browser.js`, `scripts/*`, `.github/workflows/*`, `.github/dependabot.yml`, `test/*`). Corrections:
- License header: added the runtime dep licenses (`jose` MIT, `yaml` ISC). Confirmed that the only `LICENSE` outside `node_modules` is at the root (MIT).
- `CAUSES` has 57 entries, not 56.
- `systemBrowser()` always calls the optional `print(url)` first and swallows spawn errors. It does not "print only if spawning fails".
- Duplicate merge keeps the higher-confidence entry's evidence, not "the first evidence". The vendor weight range is enforced by the test, not clamped in code.
- `MAX_BODY` does not truncate form-encoded bodies. `redactDeep` returns values deeper than 8 levels **unmasked**, not merely "stops".
- UI guard: the token is checked only on `/api/*`, since static assets need just the Host check. The 415 check runs after the token, and its CORS-preflight rationale is inferred (no source comment, no test). The body cap is 1e6 chars with `req.destroy()`, not "1 MB".
- Token handling: the `[::1]` gap is really "binds 127.0.0.1 only". A same-tab reload keeps the token, and only a new tab needs the URL. The line ref is `assets.js:319-320`.
- HTTP helper: separate success and network-error return shapes, and the trace keeps only six response headers.
- Redaction: `requestSecrets()` sees only form-encoded body fields and `Authorization`, and ignores URL query params, JSON bodies and other headers. `NO_PREFIX` is three keys, and other sensitive values keep an 8-char prefix (4 in URLs). `redactText` masks known values only when they are ≥ 6 chars.
- Config: `FORBIDDEN` checks setting names only.
- Native deps: none at runtime, while TypeScript 7 (dev) ships platform binaries.
- Release: `github-release` and `npm` run in parallel after `build`.
- Supply chain: `scorecard.yml` uses `read-all`. The Dependabot "pins" are semver-major `ignore` rules.
- ARCHITECTURE.md's Run events are a code block, not a table.
