# gorhill/uBlock

> Ref: `research/refs/ublock` @ aaefbdb (2026-10-28) · License: GPL-3.0-or-later (`LICENSE.txt`; every `src/js/*.js` header says "version 3 ... or (at your option) any later version"; `platform/npm/package.json` declares `GPL-3.0-or-later`). Vendored libraries keep their own terms: `src/lib/publicsuffixlist/publicsuffixlist.js` is dual GPLv3 / Apache-2.0, `src/lib/lz4/*` BSD-2-Clause, `src/lib/codemirror/LICENSE` MIT, `src/lib/csstree/LICENSE` MIT, `src/lib/hsluv/LICENSE` MIT, `src/lib/diff/swatinem_diff.js` LGPL-3, `src/lib/regexanalyzer/README.md` describes an "implied" permissive license. **Ideas only: no code in this note, and none may be copied into search-hole.**

## Purpose
uBlock Origin (uBO) is a browser content blocker. Its static network filtering engine (SNFE) compiles ABP/uBO-syntax filter lists, hosts files and plain domain lists (several hundred thousand filters across the default lists) into a compact in-memory matcher. It answers "block / allow / no match" for each network request in microseconds, and starts in a few hundred ms from a serialized snapshot (the "selfie"). For search-hole it is the best reference for four things: (1) how a list goes from text to a compiled form to a cached snapshot, with version-based invalidation; (2) hostname-set data structures; (3) list catalog metadata and the update scheduler (`! Expires:`, mirrors, diff updates); (4) the `badfilter` / `important` / exception precedence model. The DOM element picker and cosmetic filtering are out of scope, except as UX ideas.

## Architecture sketch
```
assets.json catalog ─► assets.js (fetch, mirrors, Expires, diff-updater worker) ─► raw list text (cacheStorage / IndexedDB)
        │                                                                     │
        │                     storage.js: compileFilters()                     ▼
        │      line iterator ► AstFilterParser (static-filtering-parser.js) ► FilterCompiler (static-net-filtering.js)
        │                                                                     │  writes JSON-per-line "compiled list"
        ▼                                                                     ▼
  selectedFilterLists ─────────────► per-list cache key `compiled/<assetKey>` (prefixed with compiledMagic)
                                                                              │ fromCompiled(): dedupe lines, collect badfilters
                                                                              ▼
                                                    freeze(): build buckets (realm bits ► token hash ► filter unit)
                                                                              │ optimize() deferred, throttled
                                                                              ▼
                                       selfie: `selfie/staticNetFilteringEngine` (typed arrays + tries + bucket maps)
                                                                              │
                         start.js: load selfie ─(invalid)─► rebuild from compiled lists ─(missing)─► recompile raw
```
Request path: `pagestore.js: PageStore.filterRequest` (line 760). Trusted-site check, then dynamic URL rules, then the dynamic hostname firewall, and the static engine last (`staticNetFilteringEngine.matchRequest`, static-net-filtering.js:5582).

## Key modules and data flow
- `src/js/static-filtering-parser.js` (4475 lines): `AstFilterParser` turns each line into a node-array AST with typed nodes (`NODE_TYPE_NET_PATTERN`, `NODE_TYPE_NET_OPTION_NAME_*`) and flags (`AST_FLAG_HAS_ERROR`, `AST_ERROR_REGEX`, `AST_ERROR_UNTRUSTED_SOURCE`). Fast path, lines 953-966: a line of plain ASCII with no slashes skips full parsing. A pure hostname (checked by `reHostnameAscii`, line 817) is flagged as a hostname pattern straight away. Hosts-file lines: `reHostsSink` (line 819) strips the leading IP. `reHostsRedirect` (line 820) drops lines for `localhost`, `0.0.0.0`, `broadcasthost` and `ip6-*` (lines 1628-1648). The same parser drives the CodeMirror editor's highlighting and linting (`src/js/codemirror/ubo-static-filtering.js:226`).
- `src/js/static-net-filtering.js` (6124 lines). `FilterCompiler.process` (line 3883) reads the AST into compiler state: action, anchors, party, type bits, `badFilter`, `important`, option values. `compile` (line 4211) routes to section `NETWORK_FILTERS:GOOD` or `NETWORK_FILTERS:BAD`. `compileToFilter` (line 4249) builds a list of "units" (pattern, anchor, domain option, important, modifier) and emits one compiled tuple per type bit (`compileToAtomicFilter`, line 4427). Each tuple is a JSON array holding the category bits, the token hash and the filter data.
- `src/js/static-filtering-io.js`: `CompiledListWriter` / `CompiledListReader`. The compiled list is plain text with sections delimited by `#block-start-<id>` / `#block-end-<id>`. Each line is one `JSON.stringify`'d tuple, so a whole compiled filter can be compared and deduplicated as a string.
- `src/js/storage.js`: `getCompiledFilterList` (line 1020) returns the cached compiled list when its first line equals `compiledMagic`; otherwise it fetches the raw list and recompiles it. `compileFilters` (line 1102) is the line loop: it joins continuation lines that end in ` \` and are followed by 4 spaces, logs invalid filters with the list name, and prefixes the output with the magic number (line 1169). `selfieManager` (lines 1296-1374) holds `create`, `load` and `destroy`.
- `src/js/assets.js` (1485 lines): asset registry, `fetchText`, `fetchFilterList` (with `!#include`), `getRemote` (mirror loop), and the updater (`updateFirst`, `diffUpdater`, `updateNext`, `updateDone`, lines 1190-1475).
- `src/js/diff-updater.js`: a Web Worker that fetches patch files, applies RCS-style diffs and checks SHA-1.
- `src/js/hntrie.js`, `src/js/biditrie.js`: hostname trie and bidirectional pattern trie in typed arrays, each with an optional WASM matcher (`src/js/wasm/`).
- `src/js/reverselookup.js` + `reverselookup-worker.js`: answer "which list contains this filter?" on demand by searching the compiled list text. It runs in a worker with a 1.5-minute TTL (`workerTTL`, reverselookup.js). The engine itself does not store list provenance per filter.

## Data model and storage
- **Filter arena.** All filter units live in one growable `Int32Array` (`filterData`, static-net-filtering.js:486-544). It grows in 64K-element pages and shrinks after optimization (`filterDataShrink`). Each unit is a short run of int32s: the class id first, then class-specific fields (string offsets, lengths, flags, links). Objects that cannot live in an int array, such as lazily built `RegExp`s and hostname arrays before they are trie-ified, go in a side array, `filterRefs` (lines 546-568). Units with identical compiled args are deduplicated at load: `filterFromCompiled` keys on class id plus `keyFromArgs` (lines 611-623).
- **Class registry.** Filter classes register in a fixed order (`registerFilterClass`, line 604). The comment at line 596 warns that any change to the mapping must bump `compiledMagic`, because compiled lists store class ids.
- **Buckets.** `bitsToBucket` maps category bits to a map from token hash to unit. Category bits encode the realm in bits 0-1 (block=0, allow=1, block-important=2), the party in bits 3-4, the request type in bits 5-9, and header/modifier realms in higher bits (lines 51-80). A bucket with more than one unit becomes a `FilterBucket` linked list (`addFilterUnit`, line 5103).
- **Selfie** (`toSelfie`, line 5185). Contents: `version`, counters (`processedFilterCount`, `acceptedCount`, `discardedCount`), `bitsToBucket`, the URL tokenizer's known-token bitmap, both HNTrie container buffers, the BidiTrie buffer, `filterData` and `filterRefs`. It is serialized with `src/js/s14e-serializer.js`, a structured-clone-to-string serializer that supports typed arrays, Maps and back-references, with optional LZ4. It is stored in IndexedDB (`cachestorage.js:467`), and entries ≥ 64 KiB are compressed (`cacheStorageCompressionThreshold: 65536`, background.js). Each trie buffer carries a djb2-style checksum (`i32Checksum`, hntrie.js:124) that `fromSelfie` verifies (hntrie.js:459-462).
- **Cache keys:** raw list under its asset key; `compiled/<assetKey>`; `selfie/staticMain` (magic plus `availableFilterLists`); `selfie/staticNetFilteringEngine`; `selfie/staticExtFilteringEngine`. The cache registry keeps `writeTime`, `readTime`, `resourceTime`, `lastModified`, `expires`, `diffPath`, `diffName` and `diffExpires` for each asset (assets.js:1190-1230).

## Config format
- `hiddenSettingsDefault` (background.js:47-94) holds the tunables:
  - `assetFetchTimeout` 30 s
  - `autoUpdateAssetFetchPeriod` 5 s
  - `autoUpdateDelayAfterLaunch` 37 s
  - `autoUpdatePeriod` 1 h
  - `cacheStorageCompression` true
  - `differentialUpdate` true
  - `manualUpdateAssetFetchPeriod` 500 ms
  - `selfieDelayInSeconds` 53
  - `trustedListPrefixes` `'ublock-'`
  - `updateAssetBypassBrowserCache` false
- `systemSettings` (background.js:185-186): `compiledMagic: 72` and `selfieMagic: 72`, with the comments "Increase when compiled format changes" and "... selfie format changes".
- `assets/assets.json` (74 entries) is the list catalog. Field counts: `content` 74, `contentURL` 74, `group` 71, `title` 71, `supportURL` 71, `tags` 66, `off` 62, `lang` 37, `cdnURLs` 30, `parent` 24, `preferred` 11, `patchURLs` 9, `group2` 7, `updateAfter` 5, `instructionURL` 3, `ua` 1.
  - Groups: `default`, `ads`, `privacy`, `malware`, `multipurpose`, `annoyances`, `regions`.
  - `content` is `filters` or `internal` (`assets.json` itself, `public_suffix_list.dat`, `ublock-badlists`).
  - `contentURL` is an ordered array: the remote origin first, then bundled local fallbacks such as `assets/ublock/filters.min.txt`. `cdnURLs` are mirrors. `updateAfter` is in days (13 for assets.json, 19 for the PSL, 29 for badlists).
  - **There is no license field and no checksum field** in the catalog.
- List header metadata is parsed from the **first 1024 characters only** (`extractMetadataFromList`, assets.js:67-94). It accepts `! Field: value` or `# Field: value`, with hyphen or space in the field name, case-insensitive. Fields used: `Title`, `Homepage`, `Last-Modified`, `Expires`, `Diff-Name`, `Diff-Path`, `Diff-Expires`. Values starting with `%` (unfilled template placeholders) are ignored.

## Extension points (plugins, hooks)
- Asset observers (`assets.addObserver`, assets.js:219) get the topics `before-asset-updated` (return true to allow the update), `after-asset-updated`, `asset-update-failed` and `after-assets-updated`. storage.js's `assetObserver` (line 1591) uses them to skip unused or bad lists and to destroy the selfie when an asset changes (line 1647).
- Pre-parser directives in lists (static-filtering-parser.js:4256-4471):
  - `!#if <env-token>` / `!#else` / `!#endif` gate lines by platform.
  - `!#include <file>` pulls in sublists. Only relative paths under the parent list's directory are allowed: absolute URLs and `..` are rejected (assets.js:423-467). If any sublist fails, the whole list update aborts (assets.js:476-487).
- Trusted-source gating: some options (e.g. `replace=`, `urlskip=`, `uritransform=`, and certain `redirect` uses) are rejected with `AST_ERROR_UNTRUSTED_SOURCE` unless the list is trusted (static-filtering-parser.js:1455-1520). `isTrustedList` (storage.js:414) trusts only asset keys with the `ublock-` prefix, plus user filters if the user opted in.
- `@gorhill/ubo-core` npm package (`platform/npm/README.md`). It exposes `StaticNetFilteringEngine.create()`, `useLists([{name, raw}])`, `matchRequest({originURL,url,type})`, `toLogData()`, `serialize()` / `deserialize()`, and a standalone `HNTrieContainer`. It is GPL, so we cannot depend on it.

## Rules / lists: parsing and compilation
**Pipeline (text → compiled → selfie):**
1. The raw text is pre-pruned by `!#if` (`sfp.utils.preparser.prune`).
2. Each line is parsed into an AST. Comments, cosmetic and network filters are classified, and errors are logged with the list name.
3. Network filters become compiled tuples of category bits, token hash and filter data, written to the GOOD or BAD section.
4. The per-list compiled text is cached with the magic number as its first line.
5. On load, `fromCompiled` (line 5257) adds each GOOD line to a `Set`; an exact duplicate line from another list increments `discardedCount`. BAD lines go to `badFilters`.
6. `freeze` (line 4544) skips any GOOD line present in `badFilters`, instantiates units, and places them into buckets.
7. `optimize` (line 5130) is deferred 2 s after freeze. It runs in 40 ms slices and reschedules itself every 1 s with a declining throttle budget. It turns hostname arrays into HNTries, turns buckets of ≥ 3 plain patterns into a BidiTrie (`FilterBucket.optimizePatternTests`, line 2865), and coalesces ≥ 5 units that share an origin test or a regex pre-test (`FilterBucketIfOriginHits`, `FilterBucketIfRegexHits`, line 2822).
8. The selfie is written 53 s later (debounced `createTimer`, storage.js:1360-1372).

**Tokenization (why lookups are fast):**
- At compile time each pattern picks one "best token": the alphanumeric/`%` run with the lowest "badness" from a frequency table (`badTokens`, line 3564: `https` 123617, `com` 76987, `js` 43620, `www` 33129...). Runs next to `*` are rejected, and so are runs shorter than the 7-character maximum that touch the pattern edge.
- The token is hashed with djb2 over at most 7 chars (`tokenHashFromString`, line 3441).
- At match time the URL is lowercased and tokenized once. Only tokens whose low 16 hash bits are present in the 64 KiB `knownTokens` bitmap are kept (lines 3468-3510), so each request probes only buckets that actually exist.
- Special hashes: `DOT_TOKEN_HASH` (pure hostnames), `ANY_TOKEN_HASH`, `ANY_HTTP(S)_TOKEN_HASH`, `NO_TOKEN_HASH` (untokenizable patterns, probed last) (lines 226-232).

**Pure hostname fast lane.**
- A filter that is a pure hostname with no options compiles to `DOT_TOKEN_HASH` (line 4251). That covers `||example.com^`, a bare `example.com`, and the host in a hosts-file line.
- At freeze all such hostnames go into **one `FilterHostnameDict` per category-bits bucket** (lines 4566-4573). It starts as an array and is converted lazily into an HNTrie on the first match or during optimization (`FilterHostnameDict.optimize`, line 2600).
- `realmMatchString` (line 5446) probes the hostname dict first, before any token-based pattern, in all four bucket combinations (any/type × any/party).

**Precedence: block, exception, important, badfilter** (`matchRequest`, line 5582):
- The block realm is evaluated first. If it matches and the match was `$important`, the result is block. Otherwise the allow (exception, `@@`) realm is evaluated. If an exception matches, the block-important realm is checked: important wins, else allow wins. With no exception, the block stands. The return codes are 0 = no match, 1 = block, 2 = allow.
- Important filters are also inserted into the plain block realm, so the important realm is consulted only when an exception has matched (comment at lines 4607-4613).
- `$badfilter` does not invert matching; it is **exact cancellation**. The filter is compiled with the same tuple it would otherwise have, but written to the BAD section. At freeze any GOOD line with an identical serialized form is discarded and counted in `discardedCount` (lines 4547-4551). A `badfilter` therefore cancels the same filter in every list, but only when the options normalize to the same compiled form. Exceptions (`@@`) and `badfilter` lines are exempt from the trusted-source checks (static-filtering-parser.js:1461).
- Outer layers sit above the static engine (`pagestore.js:760-840`): `isTrusted` (the user's trusted-site list) returns 0 before anything else is evaluated. Session URL rules come next, then the dynamic hostname firewall. Static filtering "has lowest precedence" (the comment at pagestore.js:825). Dynamic rules can return "noop" (3), which falls through to the static engine.

**Regex handling and safety:**
- A pattern `/.../` with length > 2 is a regex filter (static-filtering-parser.js:1665-1689). It is validated only with `new RegExp(source)` (`normalizeRegexPattern`, line 2945); an invalid regex sets `AST_ERROR_REGEX` and the filter is dropped.
- `FilterRegex` (static-net-filtering.js:1248) stores the source string in the BidiTrie character buffer. It compiles a JS `RegExp` **lazily on first match**, case-insensitive unless `match-case` is set, caches it in `filterRefs`, and tests it against the raw URL. The class is marked `isSlow` (line 1333), so domain options are evaluated before it.
- A token is extracted from the regex where possible (`extractTokenFromRegex`, line 4135, via `regex-analyzer.js: tokenizableStrFromRegex`), so most regex filters are only tried on URLs that contain a literal from them.
- `regex-analyzer.js: isRE2` rejects lookahead and lookbehind, but it is used only when converting to Chrome DNR rules (`FilterRegex.dnrFromCompiled`). **There is no ReDoS protection in the runtime matcher:** it uses the backtracking JS engine with no length cap and no timeout. Safety comes from list curation (trusted lists, badlists), not from the engine.

**List updates:**
- `! Expires:` parsing (`parseExpires`, assets.js:52-65). The regex takes a number and an optional `w|d|h|m` unit; no unit means days, and 0 is ignored. Weeks are multiplied by 7. Hours are floored at **4 h** and minutes at **240 min** (also 4 h). The result is stored in days.
- The default when no `Expires` or `updateAfter` is given is **7 days** (`EXPIRES_DEFAULT`, assets.js:40; `getUpdateAfterTime`, lines 125-141). Precedence: cached `Expires` from the list header, then the catalog's `updateAfter`, then 7 days.
- The scheduler checks every `autoUpdatePeriod` (1 h), starting 37 s after launch. `getUpdateCandidates` sorts **oldest `writeTime` first** (assets.js:1383-1388). Only lists that are selected, known and not bad are eligible (storage.js:1591-1605). Auto mode fetches **one asset every 5 s** (`autoUpdateAssetFetchPeriod`) and prefers CDN mirrors (`favorOrigin: false`); a manual update prefers the origin and spaces fetches 500 ms apart.
- At launch, if any list has `ageNormalized` ≥ 2 (age / expiry, assets.js:1175) an **emergency update** runs after 2 s (start.js:443-461).
- Fetch hygiene:
  - A timeout fires only after 30 s **without progress** (`onProgressEvent`, assets.js:299-303).
  - A cache-busting `_=<token>` is appended, rotating hourly modulo 13 (assets.js:346-355).
  - Empty bodies are treated as errors, and **HTML responses are rejected** (a body that starts with `<` and ends with `>`, assets.js:372-375).
  - Mirror URLs are shuffled (`getContentURLs`, assets.js:181-205).
  - A fetched copy whose `! Last-Modified:` is older than the cached copy's is skipped as stale (`resourceIsStale`, assets.js:113-123).
  - On failure the cached copy is kept and `asset-update-failed` is fired.
- **Diff updates** (assets.js:1192-1330, diff-updater.js):
  - Lists declare `! Diff-Path: <relative path>[#name]`, `! Diff-Name:` and `! Diff-Expires:`. The path encodes `YYYY.M.D.<minutes>`, so the client can compute when the next patch should exist. It reports `nopatch-yet` if that time is still in the future (diff-updater.js:55-66, 230-242).
  - A patch file contains `diff name:<n> lines:<n> checksum:<sha1-prefix>` blocks followed by RCS-style `a<line> <n>` / `d<line> <n>` operations (`parsePatch`, `applyPatch`).
  - The patched text must hash to the **SHA-1 prefix**; otherwise the result is `badchecksum` and the update falls back to a full fetch.
  - One patch file serves many lists (keyed by `name`), and patch fetches are cached per cycle (`patches` Map). "Hard" updates (patch due) are processed before "soft" updates (apply already-fetched patches).
- **Bad lists:** `ublock-badlists` is a remote text file of list URLs, one per line. A line with a second field means "do not even fetch"; otherwise "do not compile" (storage.js:770-776, 1028-1056).
- Per-list counts: `entryCount` and `entryUsedCount` are derived from the engines' accepted and discarded counts (storage.js:941-943). They are shown as "used/total" in the lists pane (`3p-filters.js: renderLeafStats`, line 62).

## Testing strategy
- `platform/npm/tests/snfe.js` (mocha style): initialization, list loading, serialize/deserialize round-trips, and matching cases (pure-hostname block, exception, block-important, `isBlockImportant`, regex with and without `match-case`, localhost).
- **Golden corpus:** `platform/npm/tests/request-data.js` loads a fixed set of real lists from `tests/data/bundle.tgz` (EasyList, EasyPrivacy, uBO lists, PGL, URLhaus). It replays every request in the public `scaling-palm-tree/requests.json` corpus and asserts each `matchRequest` result against a stored `data/results.json`, **once with WASM off and once with it on**.
- `tests/leaks.js` asserts no global-variable leaks; `tests/wasm.js` checks that WASM enable succeeds or fails cleanly.
- **Decision diff across versions:** `platform/dig/snfe.js` runs the corpus, writes `data/snfe.json`, and with `compare` diffs against the previous run (`snfe.diffs.json`). It also writes the costliest requests (`snfe.maxcost.json`, `medcost`, `mincost`).
- `src/js/benchmarks.js` runs in-extension benchmarks over a downloadable request dataset.

## UX patterns worth copying
- Lists pane (`src/js/3p-filters.js`):
  - groups and parent nodes
  - "used/total" filter counts
  - "last update N ago"
  - an "obsolete" badge when the list is past its expiry or the cache was purged
  - per-list support and instruction links
  - "update now", purge-cache and "hide unused lists" controls
- Logger: every decision shows the matched filter in normalized form plus its realm. A **"which list has this filter"** reverse lookup runs on demand (reverselookup.js), so the hot path carries no provenance cost.
- "My filters" editor: CodeMirror mode with syntax highlighting, linting and auto-complete hints, driven by the same `AstFilterParser` that compiles (codemirror/ubo-static-filtering.js:226-340), so the editor and the engine never disagree.
- Element picker (`src/js/epicker-ui.js:173-300`): it generates **several candidate filters at different specificities** and lets the user choose with a slider, previewing the effect before creating. This is the closest analogue to "block this site: exact host / registrable domain / path".
- The trusted-site list is a separate, simple, top-precedence user control: "disable everything here".

## Performance tricks
- One typed-array arena for all filter units, instead of hundreds of thousands of JS objects (lower GC and memory, and it serializes as a single buffer).
- HNTrie (hntrie.js):
  - Hostnames are stored **reversed** in a compressed trie inside one shared buffer (chars section plus 3×int32 cells: or-link, and-link, segment info).
  - Matching walks from the end of the needle, and a match must end at a label boundary (`.` or start). It returns the match offset, so the matching suffix can be recovered for logging without storing per-hostname ids.
  - On insert, an existing shorter suffix makes a longer host redundant: `add` returns -1 if `example.com` is present and `sub.example.com` is added (hntrie.js:406-410). The trie therefore reports only the broadest match.
  - Many tries share one container, so the needle is decoded once (`setNeedle`).
  - Optional WASM `matches`/`add`, little-endian only (hntrie.js:748-766).
- BidiTrie: plain patterns sharing a token are stored in a trie that extends **both left and right** from the token position, so one probe checks many filters (biditrie.js:23-100).
- Token bitmap pre-filter: the URL tokenizer drops tokens no filter uses (static-net-filtering.js:3468-3510).
- Lazy work:
  - RegExp compiled on first use.
  - Hostname dicts trie-ified on first match.
  - Optimization deferred and time-sliced (40 ms).
  - Selfie written 53 s after the last change.
  - The reverse-lookup worker starts on demand and stops after 1.5 min idle.
- Startup ladder (start.js:388-405): selfie (fast), else per-list compiled cache (no re-parse), else full compile. The engine is usable before optimization finishes.
- A per-page decision cache with 15 s shelf life (`NetFilteringResultCache`, pagestore.js:55-56).

## License and what it means for us
GPL-3.0-or-later. search-hole will be MIT or Apache-2.0 (§13), so **no uBO code, data structures transcribed from code, tests or test data may be copied**. We may learn the ideas listed here and reimplement them independently, with this note cited as the source of the idea. Notes:
- `src/lib/publicsuffixlist/publicsuffixlist.js` is dual-licensed and could be taken under Apache-2.0. We do not need it: `tldts` (MIT, used by uBlacklist) covers the need.
- `assets/assets.json` is a catalog of third-party list URLs. Re-derive our own catalog from each list's own homepage and license; do not copy the file.
- The `scaling-palm-tree` request corpus and uBO's `results.json` are not ours to bundle.

## Implications for search-hole
- [other] **Three-tier list cache, mapped to SQLite.**
  - (1) raw text with ETag / Last-Modified and sha256
  - (2) a per-list **compiled intermediate representation (IR)**: normalized, deduplicated rule tuples with a stable string key per rule, tagged with `compiler_version`
  - (3) a merged **matcher snapshot** (hostname set + regex set + per-rule metadata) built from the enabled lists, with a `snapshot_version` and a hash of its input list hashes

  Startup tries (3), then rebuilds from (2), then re-parses (1); evidence storage.js:1020-1060, start.js:388-405. Keeping (2) separate means toggling a list or editing user rules never forces a re-parse of the 418k-rule list.
- [upgrades-migrations] Copy the **magic-number invalidation** idea: `compiledMagic` / `selfieMagic` (background.js:185-186) are stored next to the cached data (start.js:218-231), and a mismatch destroys the dependent caches. For multi-version installs, key artifacts by `(list_id, content_sha256, compiler_version)` and **never delete artifacts of a newer `compiler_version`**. Each gateway uses or builds the artifact for its own version, which avoids two processes fighting by invalidating each other. uBO only has one process, so it simply deletes (inferred difference).
- [upgrades-migrations] Verify snapshot integrity on load with a checksum, as HNTrie and BidiTrie do (hntrie.js:124, 454-462). Treat a failed check as "rebuild", never as a crash.
- [rule-format-precedence] Adopt uBO's **layered** model: user trusted/allow layer > user rules > list rules, where list rules are evaluated last (pagestore.js:760-830). Inside the list layer use uBO's semantics: block < exception (`allow`) < `$important` block, as in matchRequest at static-net-filtering.js:5582-5611. That keeps imported AdGuard/ABP lists behaving as their authors expect, while §6's "a user's allow always beats any list rule, including `$important`" holds because the user allow layer sits above the whole list layer (like `isTrusted`).
- [rule-format-precedence] Implement `$badfilter` as **exact cancellation by normalized rule key across all subscribed lists**, applied at snapshot build (static-net-filtering.js:4544-4551). Expose the same mechanism to users as "disable this list rule" in the dashboard. It is more precise than an `allow`, and it is attributable ("disabled by you").
- [lists-subscriptions] Parse list headers from the first ~1 KiB only. Accept `! Key:` and `# Key:` with case-insensitive keys, and ignore `%placeholder%` values (assets.js:67-94). Support `Title`, `Homepage`, `Last-Modified`, `Expires`, and later `License` (our addition).
- [lists-subscriptions] `Expires`: number + `w|d|h|m`, default unit days, **floor 4 h**, default **7 days** when absent (assets.js:40-65). The user's `update: 7d` in `rules.yaml` overrides it, but never goes below the floor.
- [lists-subscriptions] Updater behaviour to copy:
  - refresh oldest first (assets.js:1383-1388)
  - space fetches out (uBO: 5 s apart in auto mode)
  - run an **emergency refresh at startup** if age ≥ 2× expiry (start.js:443-461)
  - time out on no-progress, not on total time (assets.js:299-303)
  - **reject HTML or empty bodies** (assets.js:372-375)
  - skip a fetched copy older than the cached one (assets.js:113-123)
  - keep the last good list on failure

  Add what uBO lacks: ETag / If-None-Match, a sha256 per version, and the plan's "> 50% shrink → refuse" guard.
- [lists-subscriptions] Catalog format for our curated `lists/` index, modelled on assets.json:
  - fields: key, `title`, `group`, `tags`, `lang`, `contentURL[]` (origin first, then a **bundled fallback copy** for offline first run), `cdnURLs[]` (shuffled mirrors), `supportURL`, `updateAfter` (days)
  - plus fields uBO doesn't have: `license` (SPDX), `format` (ublacklist/abp/hosts/domains/goggles), `sha256`, `sourceType` (e.g. content-farm, official-docs)
  - a `badlists` equivalent: a remotely updatable deny-list of known-bad or hijacked list URLs (storage.js:770-776)
- [lists-subscriptions] Diff updates (assets.js:1192-1330, diff-updater.js) are worth it only for the 418k-rule list and only if its maintainer publishes patches. For v1, use HTTP conditional requests and record the idea in the lists ADR as future work. If we ever do it, copy the integrity design (SHA-1 or sha256 prefix per patched file, fall back to a full fetch on mismatch), not the code.
- [lists-subscriptions] Show per-list **"used/total"**: rules accepted, duplicates across lists, invalid, cancelled by badfilter (storage.js:941-943; 3p-filters.js:62-71). With "removed N results this week", this is the list-contribution UX the plan asks for.
- [security] uBO's regex filters run on the backtracking JS engine with only `new RegExp` validation (static-filtering-parser.js:2945; static-net-filtering.js:1261-1268). That confirms §6: compile list regexes with a linear-time engine, or reject them. Borrow the mitigations too:
  - lazy compilation
  - a **literal pre-filter** (extract a required literal from the regex and only run the regex when the URL contains it; static-net-filtering.js:4135)
  - cap rule length and count per list
- [security] **Trusted-source gating** (static-filtering-parser.js:1455-1520; storage.js:414): powerful options are accepted only from trusted lists. For search-hole, subscribed lists may by default only `block`, `lower`, and `allow` their own entries. They may not `pin` or `raise` unless the user marks the list trusted, so a hijacked list cannot promote spam into the AI's context.
- [security] `!#include` must stay inside the parent list's directory: no absolute URLs, no `..` (assets.js:449-450). If we support includes in any format, copy that rule. Abort the whole update if any part fails (assets.js:476-487) so the result is never half-applied.
- [other] **Hostname matching structure.** search-hole matches at most ~100-300 result URLs per search, not millions of requests, so lookup speed is not the problem; **load time and memory** are. Recommended design:
  - For each enabled list, a set of reversed-label or plain hostnames: look up each suffix of the result host, at most ~6 Set probes per result.
  - A separate regex set with literal pre-filters.
  - Persist the compiled hostname set as one sorted, newline-joined blob (or a packed trie) in a SQLite BLOB or a versioned file, so loading is one read plus one `split`, with no per-rule parsing.

  uBO's HNTrie keeps only the broadest suffix (hntrie.js:406-410). We need **every** matching rule and list for explanations, so store `host → [list_id, line]` attribution, or recover provenance lazily like reverselookup.js, but only for hidden results that are displayed.
- [other] Include **pure hostnames from hosts files and plain domain lists** in the same hostname lane, and drop sink entries (`0.0.0.0`, `localhost`, `broadcasthost`), as static-filtering-parser.js:819-820 and 1628-1648 do.
- [testing] Build a **golden decision corpus**, modelled on request-data.js: a fixed set of real lists (only ones whose licenses allow bundling) plus a fixed corpus of result URLs, with expected decisions asserted. Add a `dig`-style **cross-version decision diff** that also reports the slowest cases (platform/dig/snfe.js) and run it in CI on every rules-engine change. Test snapshot serialize/deserialize round trips the way tests/snfe.js does.
- [ui-ux] Drive the dashboard's rule editor (CodeMirror 6) with the **same parser** the engine uses, for highlighting, linting and hints (codemirror/ubo-static-filtering.js:226). One parser removes a whole class of "the editor said OK but the engine dropped it" bugs.
- [ui-ux] The "Block site" action should offer several candidate rules at different specificities (exact host, registrable domain, path prefix) with a live preview of how many logged results each would have hidden. This is the element picker's slider idea (epicker-ui.js:173-300) applied to search results.
- [dashboard-process-model] uBO defers expensive work (optimize after 2 s in 40 ms slices; snapshot write 53 s after the last change). In search-hole, list compilation and snapshot writing belong to the single background-job owner (the lease from §4), never to the request path of a gateway that is serving a search.

## Borrow / avoid
**Borrow**
- The raw → compiled IR → merged snapshot ladder, with version magic numbers and checksums.
- Exact-match `badfilter` cancellation, also exposed as "disable this list rule".
- Layered precedence: a user trusted/allow layer above everything, list rules last; inside lists, block < exception < important.
- `Expires` parsing semantics (units, 4 h floor, 7-day default) and header parsing confined to the first 1 KiB.
- Updater hygiene: oldest first, spaced fetches, emergency refresh at startup, no-progress timeout, HTML/empty rejection, stale-copy check, keep the last good copy, a bad-list registry.
- Catalog fields (origin + bundled fallback + mirrors + support URL), extended with license, format and sha256.
- Trusted-source gating for powerful actions.
- Golden-corpus tests, a cross-version decision diff, and serialize round-trip tests.
- One parser shared by the editor and the engine; candidate rules at several specificities when blocking.

**Avoid**
- Copying any code, test data or catalog content (GPL).
- A backtracking regex engine for list-provided regexes without ReDoS protection.
- Keeping no provenance at match time: search-hole must name rule and list for every hidden result in its log, so attribution must be cheap or precomputed.
- A trie that keeps only the broadest suffix when we need every matching list.
- Silently deleting caches built by another version (uBO has one process; we will have several).
- Mirror shuffling or CDN dependence for first-party lists before we have mirrors. Start with one origin plus a bundled fallback.
- The full ABP option surface (types, party, `$csp`, `$redirect`, cosmetic filters): it is irrelevant to search results. Import only `||domain^`, `@@`, `$important`, `$badfilter`, plain or hosts domains and `/regex/`, and skip the rest with a counted warning.
