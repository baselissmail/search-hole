# ADR-0015: Settings, data locations, retention and query hygiene

- **Status:** Accepted (2026-10-30; added after adversarial review found these undecided)
- **Related:** [0003](0003-sqlite-driver-and-access-layer.md), [0006](0006-upgrades-migrations-multi-install.md), [0007](0007-key-storage-and-resolution.md), [0008](0008-rule-format-and-precedence.md), [0009](0009-engine-adapter-interface.md)

## Context

Several ADRs say "configurable" without deciding *where* settings live:
- engine URLs, plans and caps;
- fallback chain;
- UI port;
- hook mode;
- retention.

MASTER_PLAN §4 requires a shared home that is "XDG-aware on Linux and the right app-data folder on Windows", plus "retention settings per table". §12.4 requires query hygiene (scan for secrets and internal hostnames before any engine call). P1 needs "live against SearXNG in Docker", but nothing said who manages that container.

## Decision

### 1. Data and config roots (one resolution, used by every process)

1. `SEARCHHOLE_HOME`, if set: config, data and run all live under it.
2. Otherwise, if `~/.searchhole/` exists, use it (the plan's convention, and an escape hatch when launchers see different environments).
3. Otherwise, the platform default:

| OS | Config (`rules.yaml`, `settings.yaml`) | Data (DB, lists, backups, searxng/) | Run (`ui.json`, locks) |
|---|---|---|---|
| macOS | `~/.searchhole/` | `~/.searchhole/` | `~/.searchhole/run/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/searchhole/` | `${XDG_DATA_HOME:-~/.local/share}/searchhole/` | `${XDG_RUNTIME_DIR}/searchhole/` if set, else `<data>/run/` |
| Windows | `%APPDATA%\searchhole\` | `%LOCALAPPDATA%\searchhole\` | `%LOCALAPPDATA%\searchhole\run\` |

- If an expected environment variable is missing (some GUI launchers strip it), fall back to `os.homedir()/.searchhole/`.
- `doctor` prints the resolved roots per connected host and **warns when more than one root holds data**. This catches the "Cursor launched from the dock sees no `XDG_*`" split-brain case.
- In the other ADRs, `~/.searchhole/…` means `<config>`, `<data>` or `<run>` from this table.
- Directories are created `0700` and files `0600`.
- Plugin `${CLAUDE_PLUGIN_DATA}` is used **only for caches** (it is deleted on uninstall).

### 2. Settings file: `<config>/settings.yaml`

Settings live in their own file, separate from `rules.yaml`, because settings contain endpoints and limits that must never come from shared or project files.

```yaml
version: 1
engines:
  searxng:    { enabled: true, url: "http://127.0.0.1:8888", timeoutMs: 6000, weight: 1.0, pushdown: off }
  brave:      { enabled: true, plan: free-credit, caps: { day: 300, month: 900 }, pushdown: blocks, storageRights: false }
  tavily:     { enabled: true, caps: { day: 300, month: 900 } }   # no-Docker default (ADR-0017)
fallback: [searxng, tavily, brave, exa]
profiles_default: standard
retention: { days: 90 }                                # per-table defaults below
ui: { port: 7341, idleMinutes: 30 }
hooks: { mode: steer, guard: true, receiptLine: true } # ADR-0014
queryHygiene: { mode: block, allow: [] }               # point 4
privacy: { wayback: false, sitemap: false }            # ADR-0011 opt-ins
searxng: { managed: true, port: 8888 }                 # point 5
```

- **Validation:**
  - a zod schema, with a JSON Schema published for editors;
  - unknown keys are warnings, preserved on rewrite (ADR-0006 point 9);
  - secrets are refused (ADR-0007).
- **Writers:** the CLI (`searchhole config set …`) and the dashboard, with atomic writes under the config lock.
- **Precedence:** `SEARCHHOLE_*` environment variables override `settings.yaml`, which overrides the defaults. Overridden fields are shown **locked** in the dashboard. Host configs map plugin `userConfig` and MCPB `user_config` onto these environment variables (e.g. `SEARCHHOLE_HOOK_MODE`).
- **`.searchhole.yaml` (project) can't set anything in `settings.yaml`.** Its only reach into settings is selecting configured engines by id inside a profile (ADR-0008).

### 3. Retention defaults (the job runs under the lease, ADR-0006)

| Data | Default | Notes |
|---|---|---|
| `searches`, `results` (decisions, ranks, rule ids), `fetches` (metadata, dates), `receipts`, `sessions` | **90 days** (`retention.days`) | One setting; per-table overrides are possible |
| `result_payloads` (title, snippet, URL where the terms allow) | **per engine** (ADR-0009 point 9); capped at `retention.days` | One row per engine, with its own expiry |
| Fetched page text | **not stored** | Only metadata, dates and the extracted title |
| `daily_stats` rollups | 400 days | Numbers only, so the Overview can show year-over-year |
| `engine_usage` | current + previous period | Needed for caps |
| `suggestions` | pending: until resolved; resolved: +30 days | |
| `gateways` rows | dropped 7 days after `last_seen_at` | |
| DB backups | last 3 | ADR-0006 |

- Deletes run in batches of 10k rows.
- Every bulk delete bumps `meta.data_epoch`. The dashboard tailer sends SSE `reset` when it sees a new epoch (ADR-0003, ADR-0004).
- "Delete all data" in Settings is the same job with `days: 0`, plus removal of the list artifacts.

### 4. Query hygiene (§12.4)

- **Where it runs:** after profile resolution and **before any `buildRequest`** (ADR-0009). The same redactor runs before anything is logged.
- **What it detects:**
  - **Secrets:**
    - known key prefixes (`sk-`, `ghp_`, `xox[bp]-`, `AKIA`, …);
    - JWTs;
    - PEM blocks;
    - connection strings with credentials;
    - long high-entropy tokens.
  - **Internal hostnames:**
    - single-label hosts, `*.internal`, `*.local`, `*.lan`, `*.corp`;
    - RFC 1918 and link-local IPs;
    - user-configured patterns.
  - Detectors are data with fixtures. Regexes go through re2js.
- **What it does:**
  - `mode: block` (default): returns the tool error `query_blocked`, naming the class ("looks like an API key") and never echoing the match.
  - `redact`: replaces the match with `[redacted]` and searches.
  - `off`.
- **Overrides:** an `allow` list of patterns. Hygiene settings live **only** in `settings.yaml`, never in project files.

### 5. Managed SearXNG container

- **Only user actions touch Docker:** `searchhole searxng up | down | apply | status`, and `doctor`, which offers it once (pending Basel's first-run answer, §13). **Gateways never call Docker.**
- **Files** live in `<data>/searxng/`:
  - `compose.yaml`: the official image pinned by digest, bound to `127.0.0.1:8888`;
  - `settings.yml` overlay: `use_default_settings: true`, `search.formats: [html, json]`, limiter off, `server.secret_key` generated at `up` and stored `0600`, never committed.
- `doctor` checks reachability, that `/config` lists the expected engines, and that JSON works (no 403).
- **No hostnames-plugin pushdown in v1** (ADR-0009 point 8). Local filtering is exact and observable.

## Alternatives considered

- **`~/.searchhole/` everywhere** (the plan's header convention). It is kept as the macOS default and as an override everywhere. It is not forced on Linux and Windows, where §4 asks for platform-correct locations.
- **One file for rules and settings.** Rejected: rules are shareable and project-scoped, while settings contain endpoints and limits. Splitting them makes the "project can't set endpoints" rule structural, not a validation detail.
- **Storing fetched page text for later re-reading.** Rejected for v1: privacy and size. The receipt keeps metadata and dates. Re-reading means fetching again.

## Consequences

- Every ADR's "configurable" now points at a concrete key.
- `doctor` gains a "paths" section.
- Linux users who launch hosts from different environments get one warning and one fix (`SEARCHHOLE_HOME` or `~/.searchhole/`).

## Validate early (P1)

- Path-resolution unit tests per OS, including stripped environments.
- The retention job on a 100k-search DB: deletes in under 2 s per 10k batch, no SSE gaps after `reset`, and the epoch is bumped.
- The query-hygiene detector corpus: true positives for each class and false-positive checks on normal developer queries (error strings, package names, version numbers).
