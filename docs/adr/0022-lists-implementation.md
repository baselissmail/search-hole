# ADR-0022: Lists end to end: sources, artifacts, refresh and guards

- **Status:** Accepted (2026-11-01)
- **Related:** [0006](0006-upgrades-migrations-multi-install.md), [0008](0008-rule-format-and-precedence.md), [0015](0015-settings-data-locations-retention.md), [0016](0016-licensing.md), [0017](0017-first-run-and-default-engines.md) point 7, [0019](0019-loop-guard.md), [0020](0020-dashboard-v1.md), [SYNTHESIS §6](../research/SYNTHESIS.md), MASTER_PLAN §6 "Importers and compilers"

## Context

ADR-0008 fixed what a list means (kinds, `enforce`/`audit`/`disabled`, `$badfilter`, permissive import, caps, a compiled matcher). ADR-0006 fixed how background jobs and compiled artifacts behave across processes and versions. ADR-0017 point 7 fixed the starter set. P6 part 1 shipped the importers, the matcher, the first-party lists, the catalog and the vendored starter copies. This ADR records how they are wired: where lists come from, how they are stored, refreshed and guarded, and how they reach every search.

## Decision

### 1. Four sources, one id space

| Source | What | Mode comes from | Refreshed |
|---|---|---|---|
| `bundled` | the first-party lists compiled into search-hole | `lists.<id>.mode`, else the registry default | never (they update with search-hole) |
| `vendored` | the ADR-0017 starter set, shipped as copies (`dist/lists/<id>.txt`, from `lists/vendor/`) | `lists.<id>.mode`, else the catalog's recommended mode | from the catalog URL |
| `subscribed` | `subscriptions:` in the global `rules.yaml` (a catalog id or any HTTPS URL) | the subscription's `mode` | from its URL |
| `local` | a file imported with `searchhole lists import` | `lists.<id>.mode`, else `enforce` | never (import it again) |

- User choices live in the global `rules.yaml` only, written with the locked, comment-preserving writer (ADR-0006 point 9). `subscriptions:` keeps the ADR-0008 schema. The new top-level `lists:` map (`lists: { laylavish-huge-ai: { mode: enforce } }`) sets the mode of every list that has no subscription. It is additive: an older binary warns "unknown top-level field" and ignores it. A project file may hold neither key.
- Ids are lower case (`[a-z0-9][a-z0-9._-]{0,63}`), because they name folders. A subscription named after a first-party list is ignored (doctor says so). A subscription named after a starter list replaces it; with the catalog URL it keeps the shipped copy as its offline fallback.
- `searchhole lists add <starter-id>` turns a starter list back on; built-in lists can be disabled, never removed.

### 2. Artifacts on disk

```text
<data>/lists/
  generation                   rewritten after every change; one stat per request detects it
  <id>/                        vendored or subscribed
    source.txt                 the last good copy, as downloaded
    source.json                { contentSha256, bytes, fetchedAt, url, etag, lastModified }
    compiled-<compiler>.json   the compiled artifact
  local/<id>/                  source.txt, manifest.json, compiled-<compiler>.json
```

- **Artifact format:** one JSON header line (`magic`, compiler version, list id, kind, requested format, content SHA-256, body SHA-256 and length), then the body (import metadata, rules as compact tuples, the `$badfilter` cancel set). A reader checks the header, then the body checksum, then the shape.
- **Keyed by** `(list id, content SHA-256, kind, requested format, compiler version)`. Any difference means "rebuild from `source.txt`" (or the shipped copy). A corrupt, truncated, older or foreign artifact is rebuilt, never a crash, and never fatal for the search.
- **Writes are atomic** (temp file, fsync, rename), in the order text, artifact, pointer (`source.json`), so a reader never sees a pointer before its text.
- **Versions:** `LIST_COMPILER_VERSION` is bumped when importer output or the encoding changes. A new copy prunes artifacts of *older* compilers (they describe old content). A newer compiler's artifact is never deleted (ADR-0006 point 8); if it describes old content, that process sees the mismatch and rebuilds.
- **Cache writes from read paths** (a rebuild during a search or a hook) happen only once search-hole has a data folder, so a first hook on a fresh install creates nothing.

### 3. Loading

- `RulesService` asks the lists service for the enabled set on every request. The set is cached per process and keyed by the `rules.yaml` hash (already computed) and the `generation` stamp, so an unchanged request costs one `stat`.
- The compiled rule set (user rules plus every enabled list) is cached by that key too. Above 100,000 list rules at most 4 compiled sets are kept (each holds every list rule).
- Enforced typed lists (`official`, `content-farm`, `clone`, from any source) feed source typing. Audit lists never type a source, feed `prefer` or pushdown.
- The built-in default profile prefers `official-docs` **and `official-health`** (annotation lists: they reorder, never hide).
- Measured on the development machine (Node 26, the default 9 lists, 2,908 rules): cold from artifacts ~3 ms to load plus ~11 ms to compile the rule set; cold from the shipped text (first run, which also writes the artifacts) ~80 ms.

### 4. Refresh

- **One process at a time:** every refresh holds the `lists:refresh` lease (30 s, renewed every 10 s; ADR-0006 point 7). Each outcome write is fenced by the lease epoch, and the lease is renewed just before a new copy is written. Read-only processes never refresh.
- **Background:** a gateway (not the CLI) checks for due lists after a real request (`search`, `fetch`, the built-in result filter), at most once per 15 minutes per process, 2 s later, never on the request's path. It takes the lease without waiting, re-checks each list after taking it, and is aborted when the gateway closes (stdin EOF).
- **On demand:** `searchhole lists update [id…] [--force]` and the dashboard. The terminal waits up to 20 s for another holder; otherwise the list is reported as skipped.
- **When due:** `update` (default `7d`, at least 1 h), shortened by the list's own `Expires` header but never below 6 h. A failure retries after 1 h, doubling up to the interval. A shipped copy counts from its vendoring date.
- **Validators:** `If-None-Match` / `If-Modified-Since` are sent only when the stored copy is the one the database describes. A 304, or identical bytes, renews the times only.

### 5. Guards (SYNTHESIS §6 "List hijack guard")

- **Transport:** HTTPS only, on the URL and on every redirect (at most 5); the page fetcher's SSRF guard (URL shape plus a DNS lookup that refuses any non-public address, checked at connect time); a 64 MiB cap on decoded bytes (gzip and brotli bombs stop at the cap); a 60 s deadline; binary bodies refused. No cookies, no credentials, an honest user agent.
- **`sha256` pin:** the SHA-256 of the downloaded bytes must match, else the copy is refused with `sha256_mismatch` and the copy in force stays. A pin therefore freezes a list until the user changes it.
- **Shrink guard:** a copy with under half the rules of the copy in force (the shipped copy counts) is refused with `shrink_guard`; `--force` accepts it. A copy with no usable rule is refused with `empty`.
- **Any failure keeps the last good copy.** The `lists` row records the stable code and a message; `searchhole doctor` reports failures, shrink-guard and pin refusals, lists never downloaded, stale lists (not verified for 3 intervals and at least 21 days; `info` for a shipped copy, `warn` otherwise) and ignored list settings.
- Local imports have no shrink guard (the user chose the file) and are never refreshed.

### 6. Audit mode, end to end

- The engine resolves T4 twice (ADR-0008); adding an audit list never changes visibility, weights, pins, source types or pushdown.
- **The model never sees audit verdicts:** the gateway drops `would_hide`/`would_show` from the search text and from `structuredContent` flags. They stay in the log, in `--explain` and in the dashboard.
- Migration 0003 adds `results.audit_list_id` (the audit list behind a "would hide"), so each list's contribution is counted. `lists` rows gain name, source, skipped count, failures, next check, last verification and an error detail. Both are additive.

### 7. Contribution

Per list, from the search log over the last 7 days: results it hid (`decision = hidden`, `reason = list`, the deciding `list_id`) and, for audit lists, results it would have hidden (`audit_list_id`). Retention shorter than 7 days lowers the counts; nothing else is stored.

### 8. Surfaces

- App: `lists?: { list, catalog, add, remove, setMode, update, import }` (optional, like `dashboard`).
- Dashboard API: `GET /api/lists`, `GET /api/lists/catalog`, `POST /api/lists` (add), `POST /api/lists/:id/mode`, `POST /api/lists/:id/update`, `POST /api/lists/update`, `POST /api/lists/remove`.
- CLI: `searchhole lists`, `lists catalog`, `lists add`, `lists remove`, `lists enforce|audit|disable`, `lists update [--force]`, `lists import`. Every change goes through the actor gate (`--yes` without a terminal), and `lists` is already a guarded verb for the model's shell (ADR-0014).
- Slash command `/search-hole:lists` (user-only, `disable-model-invocation`).

### 9. Allowlist goggles (decision recorded here)

A goggle with a generic `$discard` keeps only what it matches. Its instructions get `allow` companions, so matched results stay visible under a profile with `default: block`, and its discards become list-important so they stay final. **Side effect, accepted:** inside T4 an `allow` beats a plain `block`, so those companions also beat other lists' plain blocks for the same results. A user rule still beats both.

## Alternatives considered

- **Artifacts as DB blobs.** Rejected by ADR-0006 point 8; files also let a process load lists without the database.
- **Recompiling every list at start.** Rejected: ~80 ms for the starter set, seconds for a 418k-rule list.
- **A lease per list.** One `lists:refresh` lease is simpler, and refreshes are sequential anyway.
- **Letting `Expires` lengthen the interval or go below 6 h.** Rejected: the user's `update` is the ceiling; a floor protects the list hosts.

## Consequences

- The starter set works offline from the first search. A fresh install contacts `raw.githubusercontent.com` once a week per enabled starter list, with search-hole's user agent and nothing else. Disabling a list stops its refresh.
- **Deferred:**
  - Compiling in a `worker_threads` Worker under a `compile:<id>:<version>` lease (ADR-0006 point 7). The import runs inline: a 10 MB list blocks its process for about a second while it is refreshed or rebuilt. Rebuilds are idempotent and atomic, so concurrent inline rebuilds are safe, only redundant.
  - A settings switch to turn background refresh off without disabling lists.
  - Importing a list from the dashboard (file upload).

## Validate

- Tests: store queries and fencing; the fetcher against a local server (ETag/304, redirects, size cap, binary, private addresses); artifact round trip and damage; registry defaults; shrink guard and `--force`; pin mismatch; corrupt artifact rebuild; the audit property through `search` and the built-in filter, including the model-facing text; contribution counts; the starter set offline; CLI parse, gate and runs with YAML comments kept; dashboard routes; doctor; the built bundle finding `dist/lists/`.
- Next: a 418k-rule subscription end to end (refresh time, artifact size, load time against the ADR-0008 target of 50 ms).
