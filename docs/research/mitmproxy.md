# mitmproxy/mitmproxy
> Ref: `research/refs/mitmproxy` @ df14a28 (2026-10-27) · License: **MIT** (`LICENSE`, "Copyright (c) 2013, Aldo Cortesi. All rights reserved." followed by the MIT grant). Vendored exceptions: `mitmproxy/contrib/click/LICENSE.BSD-3` (BSD-3-Clause, Pallets) and `mitmproxy/contrib/kaitaistruct/LICENSE` ("Either MIT or CC-0 - see the individual .ksy files"). `test/wg-test-client/LICENSE` is test-only. `release/installbuilder/license.xml.enc` is an encrypted installer licence and irrelevant. No copyleft.

## Purpose
An interactive HTTP(S)/TCP/UDP/DNS intercepting proxy with three front-ends:
- `mitmproxy` (TUI)
- `mitmdump` (CLI)
- `mitmweb` (Tornado backend + a React/TypeScript SPA)

For search-hole it is the reference for four things. mitmweb is a local web UI that shows a **live, filterable, very long list of events with a detail inspector**, protected by a random token, and that is the core of our Live log. It has a **terse filter expression language** (`~d`, `~u`, `~q`, `~s`, `~c`…) that we can adapt for log filtering and the "test a query" sandbox. Its **addon hook API** (typed lifecycle events dispatched to plain objects) is a clean model for our core event bus. And **replay/export** maps to "re-run this search with today's rules" and "copy as CLI".

## Architecture sketch
```
proxy core (sans-io layers) ──hooks──► AddonManager.chain  (core addons + user scripts)
                                           │  e.g. View addon (sortedcontainers list, filter, order)
                                           ▼
                              View signals: sig_view_add / _update / _remove / _refresh
                                           ▼
WebMaster (mitmproxy/tools/web/master.py) ─► ClientConnection.broadcast_flow(...)  (Tornado WebSocket /updates)
                                           ▲                      │ per-connection compiled filters
REST: /flows, /events, /options, /state, /flows/<id>/replay|duplicate|revert|kill|resume, …
                                           │                      ▼
React 19 SPA (web/src/js) ◄── fetch snapshot + WebSocket deltas ── Redux Toolkit store (hand-written reducers)
```
- Web deps (`web/package.json`): `react ^19.1.0`, `@reduxjs/toolkit ^2.8.1`, `react-redux ^9.2.0`, `codemirror ^6.0.1`, `vite ^7.2.2`, `typescript ^5.8.3`, `jest ^29.7.0`. **No virtualization library and no table library**: list virtualization is hand-written (`components/helpers/VirtualScroll.tsx`).
- `mitmweb` defaults (`mitmproxy/tools/web/webaddons.py: WebAddon.load`): `web_host "127.0.0.1"`, `web_port 8081`, `web_open_browser True`, `web_theme "system"` (choices system/dark/light), `web_columns ["tls","icon","path","method","status","size","time"]`.

## Key modules and data flow
| Module | Role |
|---|---|
| `mitmproxy/hooks.py` | `Hook` base: dataclass events; `name` derived from the class name (`HttpRequestHook` → `http_request`), registered in `all_hooks`; lifecycle hooks `ConfigureHook(updated)`, `RunningHook`, `DoneHook`, `UpdateHook(flows)` |
| `mitmproxy/addonmanager.py` | `AddonManager.register/add/remove`, `traverse()` over nested `addons`, `trigger_event()` (async) / `trigger()` (sync), `safecall()` logs and continues on addon exceptions, `AddonHalt` stops the chain, `LoadHook(loader)` lets an addon declare options and commands |
| `mitmproxy/eventsequence.py` | Canonical per-flow event order: HTTP = `requestheaders → request → responseheaders → response → (websocket_start/message/end | error)`; TCP/UDP = `start → message* → end|error`; DNS = `request → response → error` |
| `mitmproxy/proxy/layers/http/_hooks.py` | HTTP hooks: `HttpRequestHeadersHook`, `HttpRequestHook`, `HttpResponseHeadersHook`, `HttpResponseHook`, `HttpErrorHook`, `HttpConnectHook`, `HttpConnectUpstreamHook`, `HttpConnectedHook`, `HttpConnectErrorHook` |
| `mitmproxy/flowfilter.py` (848 lines) | Filter language, a pyparsing grammar (`_make()`, line 737), `parse()`, `match()`, generated `help` list |
| `mitmproxy/addons/view.py` | The in-memory store the UI reflects: `sortedcontainers.SortedListWithKey`, options `view_filter`, `view_order`, `view_order_reversed`; signals |
| `mitmproxy/addons/blocklist.py` | `block_list` option `"/flow-filter/status"`; first matching spec sets `flow.metadata["blocklisted"] = True` and answers with that status (444 = kill) |
| `mitmproxy/addons/clientplayback.py` | Replay: re-injects the request through the proxy core via a `MockServer` layer, sets `is_replay = "request"`, `client_replay_concurrency` ∈ {-1, 1} |
| `mitmproxy/addons/export.py` | `curl_command`, `httpie_command`, raw; exposed as the `export` command |
| `mitmproxy/addons/eventstore.py` | Event log, `collections.deque(maxlen=10000)` |
| `mitmproxy/tools/web/app.py` (941 lines) | Tornado handlers (route table line 889), auth, CSP, the `ClientConnection` WebSocket with per-connection filters, `flow_to_json` |
| `mitmproxy/tools/web/master.py` | Wires View and Event signals to WebSocket broadcasts (`_sig_view_add → broadcast_flow("flows/add")`, …) |
| `mitmproxy/tools/web/static_viewer.py` | `save_static()`: writes the same SPA plus `static.js` (`MITMWEB_STATIC = true`), flows JSON and `filter-help.json` for an offline read-only viewer |
| `web/src/js/backends/websocket.tsx` | Client sync protocol (see below); `backends/static.tsx` is the no-WebSocket variant |
| `web/src/js/ducks/flows/index.ts` | Flows reducer: `list`, `_listIndex`, `byId`, `view`, `_viewIndex`, `sort`, `selected`, `selectedIds`, `highlightedIds` |
| `web/src/js/components/FlowTable.tsx`, `FlowTable/FlowRow.tsx`, `FlowColumns.tsx` | Virtualized table, memoized rows, column components with `headerName` |
| `web/src/js/components/FlowView.tsx` | Detail inspector with tabs derived from content (`tabsForFlow`, line 92) |
| `web/src/js/ducks/ui/keyboard.tsx` | Single-key verbs |
| `web/src/js/urlState.ts` | URL ↔ store sync |

**Sync protocol** (`backends/websocket.tsx`):
1. Open `ws(s)://<origin>/updates`.
2. On open, flush queued client messages and GET `./state`, `./flows`, `./events` and `./options` in parallel.
3. While a resource is being fetched, buffer its WebSocket messages in `activeFetches[resource]`. After the snapshot arrives, dispatch `*_RECEIVE` and then replay the buffer.
4. `flows/reset` / `events/reset` trigger a refetch.

Server → client message types:
- `flows/add`, `flows/update`: `{flow, matching_filters: {search?: bool, highlight?: bool}}`
- `flows/remove`: `id`
- `flows/filterUpdate`: `{name, matching_flow_ids | null}`
- `flows/reset`, `events/add`, `events/reset`, `options/update`, `state/update`

Client → server: only `flows/updateFilter {name, expr}`. The **server compiles and evaluates the filter** for each connection (`app.py: ClientConnection.update_filter`, line 467) and returns the matching ids. Each later add/update carries per-connection `matching_filters` (`_broadcast_flow`, line 449). The reducer comment (`ducks/flows/index.ts:72-77`) documents the race: "We may see flows/add events for flows that are already in the view, or update/remove events for flows that aren't known at all. The reducer needs to handle these cases gracefully."

## Data model and storage
- In-memory only. `View` holds the flows. Persistence is opt-in: the `.mitm` flow-dump format via `mitmproxy/io` and the `save` addon (`addons/save.py`), and `savehar.py` for HAR. There is no database.
- **Wire model** (`app.py: flow_to_json`, line 82): "Remove flow message content and cert to save transmission space". Messages carry `contentLength` and `contentHash` (lines 154-155, 172-173) instead of bodies. Bodies load lazily from `/flows/<id>/(request|response|messages)/content.data`, or through a named content view at `/flows/<id>/<msg>/content/<view>.json` (routes lines 906-907). The list row also gets `id`, `type`, `intercepted`, `is_replay`, `marked` (emoji), `comment`, plus client/server connection and timing fields.
- The client keeps `list` (server order) and `view` (filtered + sorted) arrays with **id→index `Map`s** (`_listIndex`, `_viewIndex`) for O(1) lookups (`ducks/flows/_utils.ts: buildIndex`).

## Config format
- Typed options registered by addons (`loader.add_option(name, type, default, help, choices)`, `addonmanager.py: Loader.add_option`, line 70). Options are set by CLI `--set k=v`, a YAML config file (`~/.mitmproxy/config.yaml`, inferred from docs naming), or the web Options editor (`/options`, `/options/save`). `configure(updated: set[str])` is called with the changed keys, including all keys at startup (`hooks.py: ConfigureHook`).
- Web-specific options include `web_password`. A value starting with `$` is an **argon2 hash**, otherwise plaintext with a warning. If it is empty, a random `secrets.token_hex(16)` token is generated at startup (`webaddons.py: WebAuth`).
- TS option types are **generated** from Python (`web/gen/options_js.py` → `web/src/js/ducks/_options_gen.ts`).

## Extension points (plugins, hooks)
- **Addons are plain objects whose method names match hook names** (`request(self, flow)`, `response(self, flow)`, `configure(self, updated)`…). `_iter_hooks` uses `getattr(addon, event.name)` and gracefully skips module attributes that shadow hook names (`addonmanager.py:243-262`). Sync and async handlers are both supported (`invoke_addon` awaits awaitables). Addons can nest children via an `addons` attribute (`traverse`, line 110).
- **Error isolation**: `safecall()` catches any exception from an addon, logs it with a trimmed traceback and continues with the next addon. Only `AddonHalt`/`OptionsError` propagate (`addonmanager.py:45-60`).
- **Lifecycle**: `load(loader)` (declare options and commands) → `configure(updated)` → `running()` → per-flow hooks → `done()`. After a flow hook, `handle_lifecycle` also fires `UpdateHook([flow])` so observers such as the UI refresh (`addonmanager.py:232-241`).
- **Commands**: `loader.add_command(path, func)` plus a typed command registry (`mitmproxy/command.py`). The web UI runs them over `POST /commands/<cmd>` (`components/CommandBar.tsx`), and export uses `runCommand("export", format, "@<id>")` (`web/src/js/flow/export.ts`).

## Rules / lists: parsing and compilation
The filter language (`mitmproxy/flowfilter.py` docstring and classes):
- Unary flags:
  - flow type and state: `~all`, `~e` (error), `~marked`, `~http`, `~websocket`, `~tcp`, `~udp`, `~dns`
  - request/response: `~q` (request with no response), `~s` (has response), `~a` (asset content-type)
  - replay: `~replay`, `~replayq`, `~replays`
- Regex filters:
  - headers: `~h`, `~hq`, `~hs`
  - bodies: `~b`, `~bq`, `~bs`
  - content type: `~t`, `~tq`, `~ts`
  - `~m` method, `~d` domain (matches `request.host` or `pretty_host`), `~u` URL (`pretty_url`)
  - `~src`, `~dst`, `~meta`, `~marker`, `~comment`
- Integer filter: `~c CODE`.
- A **naked word is `~u <word>`**.
- Operators: `!` (not, right-assoc), `&` (and), `|` (or) and `( … )`. Juxtaposition is AND, because `OneOrMore(...)` wraps the result in `FAnd` (lines 772-784).
- Values are bare words (`CharsNotIn("()~'\"" + whitespace)`) or single/double-quoted strings with `\` escapes. The bare-word form is a deliberate workaround for slow `pyparsing_unicode.printables` (line 748 comment).
- Multi-character codes are registered before single-character ones (comment at line 739). A closing `)` ends a filter name, so `!(~s)` works.
- **Case-insensitive by default**: `re.IGNORECASE` unless `MITMPROXY_CASE_SENSITIVE_FILTERS=1` (lines 57-61).
- The `@only(http.HTTPFlow, …)` decorator makes a filter return False for unrelated flow types.
- Compilation: `parse(s)` → a tree of callable `_Token`s (`FAnd/FOr/FNot` + actions). Each node has a **human-readable `__str__`** ("domain matches /x/i", "response code is 404", " and "-joined). `help` is generated from each class's `code`/`help` and served at `/filter-help.json` (`app.py: FilterHelp`, route line 891).
- The client has a **second grammar** in PEG.js (`web/src/js/filt/filt.peg` → `filt.js`), used only to validate input live and show `.desc` in the filter tooltip (`components/Header/FilterInput.tsx:64-81`). Matching always happens on the server, so the two grammars can drift.
- Two **named filters** run at once: `search` (hides non-matching rows) and `highlight` (marks matching rows, keeps all), via `ducks/ui/filter.ts: FilterName`.
- Blocklist spec: `/flow-filter/status` with any separator character, parsed by `blocklist.py: parse_spec`. **First match wins**, and the decision is recorded on the object (`flow.metadata["blocklisted"]`).

## Testing strategy
- Python: pytest under `test/mitmproxy/**` (242 `.py` files), mirroring the package layout (`test_flowfilter.py`, `test_addonmanager.py`, `test_hooks.py`, `tools/web/test_app.py`…). Fixtures are factories in the package itself: `mitmproxy/test/tflow.py` (`tflow(resp=True, err=True, ws=True)`), `taddons.py` (a test context for addons) and `tutils.py`.
- **Per-file 100 % coverage gate**: `test/individual_coverage.py`, `pyproject.toml [tool.pytest.individual_coverage]` (line 155) with an exclude list, run by tox env `individual_coverage` (line 317).
- **Security invariant test**: `test_app.py: test_all_handlers_have_auth` asserts every route handler subclasses `AuthRequestHandler` (line 48).
- **Generated-file drift test**: `test_generated_files` imports every `web/gen/*.py` generator, re-generates and asserts the checked-in TS equals the output, failing with "must be regenerated by running …" (`test_app.py:39-45`). Generators: `web/gen/tflow_js.py` → `web/src/js/__tests__/ducks/_tflow.ts` (fixture flows from the real Python model), `options_js.py`, `state_js.py`, `backend_consts.py`, `web_columns.py`.
- Web: Jest (`web/jest.config.js`) with 124 test files under `web/src/js/__tests__/` (ducks, components, backends, `urlStateSpec.tsx`).
- Web app tests use `tornado.testing.AsyncHTTPTestCase` with a real `WebMaster` (`test_app.py:53+`).

## UX patterns worth copying
1. **Filter bar with live validation, a human-readable explanation and a clickable cheat sheet**: `FilterInput.tsx` shows `Filt.parse(value).desc`, and on an empty input it shows `FilterDocs.tsx` (the list from `/filter-help`), where clicking an entry inserts it.
2. **Search vs highlight**: two simultaneous filters. One narrows the list, the other only marks rows. Both are mirrored in the URL as `#/flows/<id>/<tab>?s=<search>&h=<highlight>&e=1&c=1` (`urlState.ts`: `Query = {SEARCH:"s", HIGHLIGHT:"h", SHOW_EVENTLOG:"e", SHOW_COMMANDBAR:"c"}`). A deep-linked flow id is selected once it arrives (`selectFlowOnceAvailable`).
3. **Keyboard verbs on the selection** (`ducks/ui/keyboard.tsx`):
   - navigation: `j`/`k`/arrows, `Space`/`PageDown`, `PageUp`, `Home`/`End`, `Esc` (deselect), `←`/`→`/`Tab` (cycle detail tabs)
   - actions: `d`/`Delete` remove, `D` duplicate, `r` replay, `v` revert, `x`/`X` kill (one/all), `a`/`A` resume, `z` clear, `n` new request
   - Ignores ctrl/meta so browser shortcuts survive.
   - Mouse: click selects, ⌘/ctrl-click toggles and shift-click selects a range (`FlowRow.tsx`).
4. **Detail inspector tabs derived from the data** (`FlowView.tsx: tabsForFlow`): request, then response/websocket only if present, then error only if present, then connection, timing and comment. Each tab is deep-linkable.
5. **Quick actions on row hover** (a `quickactions` column that "only shows its buttons over the row on hover"; `FlowTable.tsx` comment). Resizable columns, with widths persisted to localStorage (`ducks/ui/columnWidths.ts`). A column chooser via the `web_columns` option.
6. **Autoscroll only when pinned to the bottom**: `getSnapshotBeforeUpdate` records `isAtBottom` and `componentDidUpdate` restores it (`components/helpers/AutoScroll.tsx`). If the user has scrolled up, new rows never move the viewport.
7. **Connection indicator + event log pane** (`components/Header/ConnectionIndicator.tsx`, `components/EventLog.tsx`) and a **command bar** for power users (`components/CommandBar.tsx`).
8. **Theme option `system|dark|light`** (`webaddons.py`, `components/helpers/ThemeManager.tsx`, `useTheme.ts`).
9. **Static export** of the same UI for sharing a capture read-only (`static_viewer.py` + `backends/static.tsx`).

## Performance tricks
- **Fixed-height virtualization with spacer rows** (`components/helpers/VirtualScroll.tsx: calcVScroll`; `FlowTable.tsx`, default `rowHeight: 32`):
  - a `<tr style={{height: paddingTop}}/>` + the visible slice + `<tr style={{height: paddingBottom}}/>`
  - a sticky header via `transform: translateY(viewportTop)`
  - The start row is forced even to preserve `:nth-child(even)` zebra striping. MIT, © Aldo Cortesi:
    ```ts
    // Make sure that we start at an even row so that CSS `:nth-child(even)` is preserved
    start = Math.max(0, Math.floor(newViewportTop / rowHeight) - 1) & ~1;
    end = Math.min(itemCount, start + Math.ceil(viewportHeight / rowHeight) + 2);
    ```
  - It clamps `viewportTop` when many rows disappear at once (PR #5658 note, `FlowTable.tsx:157-166`).
  - It recomputes the window only when the list, row height or column widths change, to avoid a setState loop (comment at lines 80-92).
- **Hand-written reducers instead of Immer**: "RTK's createSlice always uses Immer, which is orders of magnitude slower" (`ducks/flows/index.ts:71`).
- **Incremental sorted maintenance**:
  - `insertViewItem` does a sorted insert.
  - `updateViewItem` bubbles the item up or down only as far as the comparator requires, rewriting just the shifted indices ("is this overoptimized? yes. was it fun? also yes.", `ducks/flows/_utils.ts`).
  - `removeViewItemAt` re-indexes from `pos` only.
- Column names are fetched once at table level rather than in N row subscriptions (`FlowTable.tsx` connect comment). Rows are `React.memo`.
- The server serializes each flow **once** per broadcast and evaluates only per-connection filters per client (`broadcast_flow` → `_broadcast_flow(type, f, flow_json)`, `app.py:440-465`).
- **Per-connection asyncio send queue**: a slow socket doesn't block broadcasts, and a closed socket is dropped (`WebSocketEventBroadcaster.send_task`, `app.py:403-417`).
- Lazy bodies (contentLength/contentHash on the list, content on demand). Event log bounded at 10 000 entries.
- Gzip for API and flow files (`GZipContentAndFlowFiles`, `app.py:882`).

## License and what it means for us
MIT (with BSD-3/MIT-or-CC0 vendored bits we don't need). We may copy short snippets (≤ 10 lines) with attribution, for example the even-row `calcVScroll` trick, `isAtBottom` and the race-tolerant reducer branches. Larger pieces should be re-implemented in our own TypeScript. The filter grammar is Python + pyparsing and PEG.js, so we will write our own grammar anyway, reusing the **operator vocabulary**, which is not copyrightable in any meaningful sense.

## Implications for search-hole
- [dashboard-process-model] Adopt mitmweb's **snapshot + buffered deltas** protocol for SSE:
  1. Open `EventSource('/api/stream')`.
  2. Fetch `GET /api/searches?limit=…` in parallel, and buffer stream events until the snapshot lands.
  3. Apply the snapshot, then replay the buffer.
  - Make the reducer idempotent: an add for a known id is a no-op, an update for an unknown id is an insert.
  - Use `rowid` as the SSE event id, so `Last-Event-ID` resumes after a reconnect and a `reset` event forces a refetch (for example after retention pruning or "delete all data").
  - This removes the WebSocket requirement entirely: our client never needs to send filters over the socket if filtering is done by keyset SQL plus a client-side matcher (see the next items).
- [dashboard-process-model] Copy the server-side habits:
  - serialize each new row once, with a per-client send queue
  - skip work when there are no clients
  - **send summaries, not bodies**: SSE pushes `searches` rows (query, client, counts, latency, decision summary), and `results` for a search load when the row expands (`flow_to_json` lazy-content pattern)
- [ui-ux] For the 100k-row requirement, mitmweb shows that **fixed row height + spacer rows** (or TanStack Virtual with fixed `estimateSize`) plus **hand-written, index-map reducers** stay fast with very large live lists, without Immer and without a table library. Concretely:
  - keep `list` + `view` arrays and `id→index` Maps
  - insert new rows by sorted position (newest first is just a prepend)
  - pause autoscroll unless pinned, which our "23 new" pill already implies
- [ui-ux] [rule-format-precedence] Define a **search-hole log filter language** in mitmproxy style, compiled to one AST shared by `searchhole log --filter`, the dashboard filter bar and the "test a query" sandbox. Proposed vocabulary (our own):
  - text: `~q <rex>` query text, `~d <rex>` result domain, `~u <rex>` result URL
  - who and how: `~e <engine>`, `~c <client>` (claude-code, cursor…), `~p <profile>`
  - which rule fired: `~r <rule-id>`, `~l <list>`
  - decision and source flags: `~hidden`, `~kept`, `~pinned`, `~stale`, `~nodate`, `~official`, `~err` (engine error)
  - comparisons: `~age >30d`, `~lat >2s`
  - operators: `! & | ()`; juxtaposition = AND; a naked word = `~q word`; case-insensitive by default
  - Parse in TypeScript once (one grammar, no PEG/pyparsing drift), and show `describe(ast)` ("query matches /react/i and hidden by list ai-farms") under the input, as mitmweb's `.desc` does.
- [ui-ux] Compile log filters to **SQL** where possible (domain, engine, client, decision, date ranges) and fall back to an in-memory predicate on the windowed rows otherwise. Regexes typed in the dashboard run only against local data, but still cap their length and run them with a timeout, or use a linear-time engine, to keep the ReDoS-safe posture of §12.3.
- [ui-ux] Borrow **search + highlight** as two URL-backed filters (`?f=` narrows, `?hl=` marks). Highlight is how the sandbox can preview "what would list X hide?" without hiding anything. Also borrow deep links `…/log/<searchId>/<tab>`, tabs derived from data (Results, Hidden, Engines, Fetches, Receipt, Raw), and single-key verbs on the selected row (`j/k`, `b` block, `t` trust, `p` pin, `l` lower, `r` raise as in §8.4.1, plus `R` "re-run with current rules" and `y` "copy as CLI").
- [security] mitmweb's local-UI auth is a good baseline:
  - a random 128-bit token printed in the URL (`?token=`), also accepted as `Authorization: Bearer`
  - the first valid hit sets a **signed, HttpOnly, SameSite=Strict cookie named per port**
  - constant-time compare (`hmac.compare_digest`), an optional argon2 hash for a fixed password
  - XSRF cookie; **non-GET requests rejected when `Sec-Fetch-Site` is not `same-origin`/`none`**
  - CSP `default-src 'self'; connect-src 'self' ws:; img-src 'self' data:`, `X-Frame-Options: DENY`, `nosniff`
  - **every handler auto-wrapped with auth** (`__init_subclass__`) and a test that enforces it (`app.py:224-320`; `test_app.py:48`)
  - mitmweb has **no Host-header allowlist** (inferred: no rebinding or allowed-host check in `mitmproxy/tools/web/*.py`). We add one, plus `127.0.0.1` binding, which mitmweb also defaults to.
- [testing] Copy two invariants as tests:
  - (1) "every dashboard route goes through the auth + Host-check middleware" (enumerate the Hono routes)
  - (2) "generated client artifacts are current": generate dashboard/receipt-app types and fixture rows from the zod schemas in `packages/shared` and fail CI if they are stale (`web/gen/*.py` + `test_generated_files`)
  - Keep fixture factories (`tflow`-style `makeSearch()`, `makeResult()`) inside the package so unit, UI and e2e tests share them.
- [engine-adapter] [other] Model the core **event bus** on mitmproxy hooks, typed for TS:
  - a closed union of dataclass-like events with a fixed per-search order: `search:start → plan → engine:request → engine:response|engine:error → merge → decision(result) → search:end`, and `fetch:start → fetch:end|fetch:error`
  - listeners (store writer, pino logger, CLI `--explain` printer, SSE tailer in-process for the CLI, receipt builder) registered explicitly, **not** by method-name reflection
  - each listener wrapped in a `safecall` that logs and continues, so a failing listener (for example the DB is read-only) never breaks the search path
  - a `configure(updated)`-style hook when rules or lists reload
  - This matches the smart-doctor `AsyncLocalStorage` run-bus idea in §10.
- [rule-format-precedence] `blocklist.py` confirms the simple semantics we want to explain in the UI: **first matching rule decides, and the decision is stamped on the item** (`flow.metadata["blocklisted"]`). We store `results.decision` + `rule_id` + `list_id`. Our precedence (pin > block > raise/lower …) is richer, but the "stamp the deciding rule" rule is the same.
- [mcp-tool-surface] [other] **Replay** = "re-run this logged search through today's rules and engines" (`R`), and **dry-run replay** = re-apply only the rules to the stored engine results, with no network. That is cheap, deterministic and good for the "what changed since list v42?" question. **Export** = copy as `searchhole search --explain "<query>" --profile coding --engines brave` (cf. `export.py: curl_command`). Neither needs a new MCP tool. Both are dashboard and CLI features.
- [distribution] Dashboard start UX: print the tokenized URL and open the browser through a short curated list of openers that degrades to printing the URL on headless machines (`webaddons.py: open_browser`). On a port clash, the error suggests the next port (`master.py:113-118`, "Try specifying a different port by using `--set web_port=…`"). Our single-instance lockfile should instead **reuse the running dashboard** and print its URL.
- [other] Static export (`static_viewer.py`) → a later "export receipt as a self-contained HTML file" can reuse the dashboard bundle with a static data backend. Low priority, but it argues for a backend interface (`live | static`) in the dashboard data layer from the start.

## Borrow / avoid
**Borrow**
- The snapshot + buffered-delta sync with a race-tolerant reducer (`backends/websocket.tsx`, `ducks/flows/index.ts`).
- Summary rows on the wire, details on demand (`app.py: flow_to_json`).
- Fixed-height spacer-row virtualization, even-row start, and autoscroll only when pinned (`helpers/VirtualScroll.tsx`, `helpers/AutoScroll.tsx`).
- Hand-written index-map reducers without Immer, and incremental sorted updates (`ducks/flows/_utils.ts`).
- The `~x` filter vocabulary, naked word = default field, case-insensitive default, a generated help list, human-readable `describe()`, and search + highlight in the URL (`flowfilter.py`, `FilterInput.tsx`, `urlState.ts`).
- Single-key verbs that ignore modifiers; tabs derived from data; hover quick-actions; persisted column widths.
- Token-in-URL → SameSite=Strict signed cookie, Bearer for automation, the `Sec-Fetch-Site` check on mutations, CSP, auth-on-every-handler plus a test (`app.py`, `webaddons.py`, `test_app.py`).
- Generated client fixtures with a drift test (`web/gen/*`).
- Typed lifecycle hooks with `safecall` isolation and a fixed event order (`hooks.py`, `addonmanager.py`, `eventsequence.py`).

**Avoid**
- Two parsers for one filter language (Python + PEG.js): use one TS grammar.
- Method-name reflection for hook dispatch: use explicit typed `on(event, fn)`.
- WebSocket where SSE suffices, since our stream is one-way.
- Keeping everything in memory with no DB: we must persist.
- No Host allowlist on the UI server.
- Class components with `getSnapshotBeforeUpdate`: in React 19 use a layout effect plus a ref for the pinned-to-bottom check.
- Plaintext passwords in options. If we ever add a fixed dashboard password, store only an argon2/scrypt hash, but a random per-run token is enough for v1.
