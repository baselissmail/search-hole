# ItzCrazyKns/Vane
> Ref: `research/refs/vane` @ 348feca (2026-09-01) · License: **MIT** (`LICENSE`, "Copyright (c) 2026 ItzCrazyKns"; `package.json` `"license": "MIT"`). There are no per-directory licenses. The full Docker image **builds AGPL-3.0 SearXNG into itself** at image-build time: `Dockerfile` runs `git clone https://github.com/searxng/searxng`. That AGPL code is not in the repo, but it ships in their image.

## Purpose
Vane (formerly Perplexica) is a self-hosted, Perplexity-style **AI answer engine**. It is a Next.js app that:
- classifies the question
- runs an LLM tool-calling "researcher" loop over SearXNG (web/academic/discussions) and uploaded files
- runs "widgets" (weather, stock, calculator) in parallel
- streams a cited answer with source cards
- ships as one Docker image with SearXNG bundled ("full"), or as a "slim" image pointing at your own SearXNG

Relevance to search-hole:
1. It is the reference for **bundling and configuring SearXNG** (JSON format, compose, first-run).
2. It shows **how a TS app queries SearXNG** and what it ignores.
3. It is a mature **cited-source UI** (source cards, citation pills, a research-step timeline).
4. It is a counter-example: LLM/embedding re-ranking, no rules, no dates, no auth. Those are the gaps search-hole fills (§1 "Why it can win").

## Architecture sketch
```
Browser (React 18, Next 16 app router)                     Docker "full" image (node:24.5.0-slim)
  ├─ /            EmptyChat + Sources/Optimization pickers   ├─ entrypoint.sh
  ├─ /c/[chatId]  Chat → MessageBox → AssistantSteps,        │    ├─ SearXNG: `python -m flask run --host=0.0.0.0 --port=8080` (background, as user searxng)
  │               MessageSources, Citation                    │    ├─ wait: sleep 5, then ≤30× curl localhost:8080 at 1 s; continue even if not ready
  ├─ /discover    news cards                                  │    └─ exec node server.js (Next standalone, :3000)
  └─ /library     chat history                                └─ Playwright chromium-headless-shell (scraper)
        │ POST /api/chat  (NDJSON stream; /api/reconnect/[id] replays)
        ▼
 SearchAgent.searchAsync (src/lib/agents/search/index.ts)
   1. classify()  → {skipSearch, academicSearch, discussionSearch, personalSearch, show*Widget, standaloneFollowUp}
   2. Promise.all[ WidgetExecutor.executeAll , Researcher.research ]
        Researcher: LLM loop (≤2 / 6 / 25 iterations for speed / balanced / quality)
          tools: __reasoning_preamble(plan) · web_search · academic_search · social_search · uploads_search · scrape_url · done
          web_search → executeSearch → searchSearxng(q, {engines?}) → embed+rerank (speed/balanced) | LLM pick+scrape+extract (quality)
   3. writer LLM streams answer with [n] citations over <search_results> context
   └─ persist all blocks as JSON in SQLite messages.responseBlocks
```

## Key modules and data flow
- **SearXNG client**: `src/lib/searxng.ts: searchSearxng`.
  - Builds `GET ${searxngURL}/search?format=json&q=…` and appends `categories`, `engines` (comma-joined), `language`, `pageno` when given.
  - **10 s AbortController timeout**. A non-2xx throws `SearXNG error: ${statusText}`. There are no retries and no health tracking.
  - Reads only `data.results` (typed as `title,url,img_src,thumbnail_src,thumbnail,content,author,iframe_src`) and `data.suggestions`.
  - **Ignores** `publishedDate`, `engine`/`engines`, `score`, `category` and `unresponsive_engines`. These are absent from the `SearxngSearchResult` interface, so they're inferred unused.
  - The URL comes from config `search.searxngURL`, seeded from env `SEARXNG_API_URL` (`src/lib/config/serverRegistry.ts: getSearxngURL`; `src/lib/config/index.ts` uiConfigSections.search).
- **"Sources" (formerly focus modes)**: `type SearchSources = 'web' | 'discussions' | 'academic'` (`src/lib/agents/search/types.ts`). Each one is just a **per-request `engines=` override**:
  - academic → `['arxiv','google scholar','pubmed']` (`…/actions/search/academicSearch.ts`)
  - discussions → `['reddit']` (`…/socialSearch.ts`)
  - web → instance defaults (`…/webSearch.ts`)
  - images → `['bing images','google images']` (`src/lib/agents/media/image.ts`); videos → `['youtube']` (`…/media/video.ts`)
  - Discover issues `site:<outlet> <query>` with `engines:['bing news']` for 3 outlets × up to 4 queries in parallel (`src/app/api/discover/route.ts`)
  - The old per-chat `focusMode` column was dropped. Migration 0002 rewrote every chat to `sources='["web"]'` (`src/lib/db/migrate.ts`, branch `'0002'`).
- **Tool gating**:
  - each `ResearchAction` has `enabled(config)` (source selected AND classifier flag) plus *two* descriptions: a short `getToolDescription` that goes in the tool schema, and a long, mode-specific `getDescription` injected into the system prompt as `<tool name=…>` (`…/researcher/actions/registry.ts`, `…/webSearch.ts`)
  - ≤ 3 queries per search call and ≤ 3 URLs per scrape (`.slice(0, 3)`)
  - `__reasoning_preamble` forces a visible plan first, except in speed mode (`…/actions/plan.ts`)
- **Result handling per mode** (`…/actions/search/baseSearch.ts: executeSearch`):
  - *speed/balanced*:
    - embed the query, then embed **each result separately** (`content || title`)
    - cosine similarity (`src/lib/utils/computeSimilarity.ts`)
    - **drop similarity ≤ 0.5**, sort descending
    - de-duplicate by pairwise embedding cosine **> 0.75**, which is O(n²)
    - keep the **top 20**
    - if embedding fails, fall back to `similarity: 1` (keep everything in engine order)
  - *quality*:
    - an LLM "picker" returns ≤ 3 indices
    - Playwright scrape, then `splitText(content, 4000, 500)` (tokens, js-tiktoken `cl100k_base`, chars/4 fallback; `src/lib/utils/splitText.ts`)
    - an LLM "extractor" produces telegram-style facts per chunk
- **Cross-iteration merge** (`…/researcher/index.ts`): flatten all search outputs and de-duplicate by **exact `metadata.url` string**; on a duplicate, the second result's content is appended to the first. One `source` block is emitted with the result. There is no URL normalization, no engine attribution and no rank fusion.
- **Writer** (`src/lib/prompts/search/writer.ts`):
  - "cite every single … sentence using [number]"
  - widgets are explicitly marked "do NOT CITE"
  - quality mode demands ≥ 2000 words
  - appends the current ISO UTC time; the researcher prompts include "Today's date" (`src/lib/prompts/search/researcher.ts`)
- **Scraper** (`src/lib/scraper.ts`):
  - one shared Playwright `chromium-headless-shell`, behind an `async-mutex`, with a refcount and a **30 s idle kill**
  - navigation timeout 20 s, then `load` (≤ 5 s) plus 500 ms
  - JSDOM + `@mozilla/readability` produce `textContent`
  - stealth: spoofed Chrome 123 UA, `navigator.webdriver` undefined, `--disable-blink-features=AutomationControlled`, `--no-sandbox`
  - **no URL validation or SSRF guard** (grep finds no private-IP or localhost checks)

## Data model and storage
- **SQLite via better-sqlite3 + drizzle-orm**:
  - `src/lib/db/index.ts` opens `${DATA_DIR}/data/db.sqlite`
  - **no pragmas** (no WAL, no busy_timeout)
  - the Docker builder stage installs `python3`, `sqlite3` and pip, presumably for native builds (inferred)
- **Schema** (`src/lib/db/schema.ts`), two tables:
  - `messages(id INTEGER PK, messageId, chatId, backendId, query, createdAt TEXT, responseBlocks TEXT json default '[]', status enum answering|completed|error)`
  - `chats(id TEXT PK, title, createdAt, sources json, files json)`
  - Sources, steps and answers are **all stored as an opaque JSON block array** per message. Sources can't be queried relationally.
- **Blocks** (`src/lib/types.ts`): `text | source | suggestion | widget | research{subSteps: reasoning | searching | search_results | reading | upload_searching | upload_search_results}`. A `Chunk` is `{content, metadata:{title,url,…}}`, with no date or type.
- **Live state**: `SessionManager` (`src/lib/session.ts`):
  - an in-memory `Map` of sessions (kept on `global` in dev), with a **30-min TTL**
  - `emitBlock` and `updateBlock(blockId, rfc6902 patch)`
  - every event is appended to an in-memory log, and `subscribe()` **replays the log** before going live, which is how `/api/reconnect/[id]` resumes a stream
- **Migrations**:
  - a custom runner (`src/lib/db/migrate.ts`) is imported at startup by Next `src/instrumentation.ts`
  - it records `ran_migrations(name UNIQUE)` keyed by the numeric file prefix
  - **data migrations are hand-coded in TS** (`'0001'`, `'0002'`), while the matching drizzle `.sql` files are no-op comments
  - each one does create-new, copy, `DROP TABLE`, `RENAME` **with no transaction**
  - on failure the error is logged and **the app keeps starting** (`instrumentation.ts` catch)

## Config format
- `${DATA_DIR}/data/config.json` (`src/lib/config/index.ts: ConfigManager`) has the shape `{version:1, setupComplete, preferences{}, personalization{}, modelProviders[{id,name,type,chatModels,embeddingModels,config{…API keys…},hash}], search{searxngURL}}`.
- **Secrets are stored in plaintext** in that JSON.
- Writes are plain `fs.writeFileSync` (not atomic).
- **If the JSON fails to parse, the file is overwritten with defaults**, so user config is lost (`initializeConfig`, the `SyntaxError` branch).
- `migrateConfig` is a TODO.
- **Schema-driven settings:** `UIConfigField` = string | select | password | textarea | switch, each with `{key, required, description, scope:'client'|'server', env?}` (`src/lib/config/types.ts`). The same registry:
  - (a) seeds values from env vars on boot (`initializeFromEnv`)
  - (b) renders the Settings dialog and setup wizard (`src/components/Settings/SettingsField.tsx`, `src/components/Setup/SetupWizard.tsx`)
  - Providers coming from env are de-duplicated by `sha256` of the sorted config (`src/lib/utils/hash.ts: hashObj`).
- **Bundled SearXNG config** (`searxng/settings.yml`, 17 lines, MIT as part of Vane):
```yaml
use_default_settings: true
general: { instance_name: 'searxng' }
search: { autocomplete: 'google', formats: [html, json] }   # json is what avoids the 403
server: { secret_key: 'a2fb…852b' }   # committed; comment says overridden by ${SEARXNG_SECRET}
engines: [ { name: wolframalpha, disabled: false } ]
```
  - `searxng/limiter.toml` sets only `[botdetection.ip_limit] link_token = true`. `server.limiter` is never enabled in settings.yml, so this is likely inert (inferred).
  - `searxng/uwsgi.ini` is copied but **unused**: the entrypoint uses Flask's dev server.
  - README "Using Vane with Your Own SearxNG Instance" requires **JSON format enabled** and the **Wolfram Alpha engine enabled**.
- **Docker**: `docker-compose.yaml` runs one service with `image: itzcrazykns1337/vane:latest`, `3000:3000` and named volume `vane-data:/home/vane/data`.
  - The full `Dockerfile`:
    - **clones SearXNG `HEAD` unpinned**
    - creates a venv
    - installs uwsgi plus build tools
    - **grants `searxng ALL=(ALL) NOPASSWD: ALL`**
    - exposes 3000 and 8080
  - `Dockerfile.slim` drops SearXNG and expects `-e SEARXNG_API_URL=…`.
  - CI (`.github/workflows/docker-build.yaml`) builds a `[full, slim]` matrix for amd64 and arm64 and pushes `:latest`, `:slim-latest`, canary and versioned tags.

## Extension points (plugins, hooks)
- **Research actions**: implement `ResearchAction {name, schema(zod), getToolDescription, getDescription, enabled, execute}` and register it in `…/researcher/actions/index.ts` (CONTRIBUTING "Add or change a search capability").
- **Widgets**: `Widget {type, shouldExecute(classification), execute}` in `src/lib/agents/search/widgets/`. Outputs carry `llmContext` (seen by the writer) and `data` (rendered).
- **Model providers**: `src/lib/models/providers/<name>/` (openai, anthropic, gemini, groq, ollama, lmstudio, lemonade, transformers), each declaring UI config fields. `transformers` runs local embeddings (`Xenova/all-MiniLM-L6-v2`, `Xenova/nomic-embed-text-v1`) through `@huggingface/transformers`.
- **HTTP API**: `POST /api/search` takes `{chatModel, embeddingModel, optimizationMode, sources, query, history, systemInstructions, stream}` and returns `{message, sources[{content, metadata{title,url}}]}`. The stream variant sends NDJSON events `init | sources | response | done` (`docs/API/SEARCH.md`).

## Rules / lists: parsing and compilation
n/a. Vane has **no user rules, blocklists or domain preferences**. The README advertises "Search specific domains", but a grep of `src` finds no domain filter; the only `site:` use is the hard-coded Discover outlet list. All filtering is semantic: an embedding similarity ≤ 0.5 is dropped, and an LLM picks in quality mode. It is **not recorded or explained**, because dropped results are discarded before anything is persisted (`baseSearch.ts`).

## Testing strategy
**None.** `package.json` has no test runner and no test scripts. The only workflow is `docker-build.yaml`, and `find` shows no `*.test.*` files. Quality rests on manual use.

## UX patterns worth copying
- **Research-step timeline** (`src/components/AssistantSteps.tsx`):
  - collapsible steps labelled "Searching N queries" → "Found N results" → "Reading N sources", plus the model's plan text
  - each step expands to its queries, or to result chips with favicon and title
  - this maps well onto a receipt timeline: *searched → found → hidden → opened*
- **Source cards** (`src/components/MessageSources.tsx`):
  - a grid of the first **3 cards** (title, favicon, short domain, index number)
  - a 4th card with a **stacked favicon row and "View N more"** opens a modal grid of all sources
  - the index numbers line up with the inline citations
- **Citation pills** (`src/lib/hooks/useChat.tsx` ~L335–375; `src/components/MessageRenderer/Citation.tsx`):
  - `[n]` and `[1, 2]` are rewritten to `<citation href=url>n</citation>`, rendered as a small rounded chip
  - out-of-range numbers are dropped
- **Two orthogonal pickers in the composer**:
  - *Sources* (Web / Academic / Social, multi-select) (`MessageInputActions/Sources.tsx`)
  - *Optimization* (Speed / Balanced / Quality, each with an icon and a one-line description) (`MessageInputActions/Optimization.tsx`)
  - this is analogous to our `profile` × `depth`
- **First-run setup wizard** driven by the same field registry as Settings (`Setup/SetupWizard.tsx`, `Setup/SetupConfig.tsx`), with `setupComplete` gating the app.
- **Stream resume**: the server-side event log plus replay on reconnect means a page refresh mid-answer loses nothing (`session.ts: subscribe`, `/api/reconnect/[id]`).
- **One-command self-host**: `docker run -d -p 3000:3000 -v vane-data:/home/vane/data …` (README), with a slim variant for people who already run SearXNG.

## Performance tricks
- A shared headless browser, lazily launched, with a mutex, refcount and 30 s idle shutdown, saves cold starts without leaking a resident Chromium (`scraper.ts`).
- Parallelism: widgets ∥ research, queries ∥ each other (`Promise.all`), chunk extraction ∥.
- Patch-based streaming (rfc6902 `replace` on `/data/subSteps`) instead of resending whole blocks.
- **Anti-pattern:** one embedding call per search result (`embedText([content])` inside `map`) instead of a single batched call, then O(n²) pairwise dedupe.

## License and what it means for us
- MIT: we may copy small pieces with attribution, e.g. the `searxng/settings.yml` shape or the `SessionManager` replay idea. It is ideas we need, though, not code.
- **Caution on SearXNG**: Vane's image *contains* AGPL SearXNG (cloned at build time). If search-hole ships a bundled SearXNG, do it as a **separate, unmodified, pinned official `searxng/searxng` container** in our `compose.yaml`, never baked into our image. Talking to it over HTTP keeps our code outside AGPL (§5.2). Never copy SearXNG code (§10 license hygiene).

## Implications for search-hole
- [engine-adapter] **SearXNG adapter, learning from Vane's minimal client:**
  - use `GET /search?format=json` with per-request `engines=`/`categories=`/`language=`/`pageno=`/`time_range=`
  - **parse the fields Vane drops**: `publishedDate` (date-extraction tier 1 for SearXNG), `engine`/`engines[]` (attribution for the receipt and per-engine health), `score`, `category`, `unresponsive_engines` (upstream health/CAPTCHA signal, §5.1)
  - keep a ~10 s timeout but add retry/backoff and suspension
  - map **HTTP 403 to "JSON format not enabled"** with a `doctor` hint, instead of Vane's bare `statusText`
- [engine-adapter] **Source types are a per-request push-down** in SearXNG, as Vane's academic → `arxiv,google scholar,pubmed` and discussions → `reddit` show. Our profiles can push `engines`/`categories` per request even though the hostnames plugin is instance-only (§5 step 3), e.g. coding profile → `categories=it`, research → scholarly engines.
- [runtime-packaging] **Bundled SearXNG:**
  - ship `compose.yaml` with the **official image pinned by tag/digest**
  - mount our own minimal `settings.yml` (`use_default_settings: true`, `search.formats: [html, json]`, `server.secret_key` generated at install, *not committed*, limiter decided explicitly)
  - **bind to 127.0.0.1** only, and add a real healthcheck that `doctor` and the gateway read
  - avoid Vane's unpinned `git clone` of HEAD, Flask dev server on 0.0.0.0, NOPASSWD sudo and committed secret
- [runtime-packaging] Vane's full/slim split (bundled vs bring-your-own SearXNG URL via `SEARXNG_API_URL`) is the right shape. Our equivalent is `searchhole doctor` offering "start bundled SearXNG (Docker present)" or "point at existing instance URL", plus validation that JSON is enabled.
- [merge-algorithm] Vane's ranking is **embedding similarity with silent drops** (≤ 0.5), **exact-string URL dedupe** and no engine weighting. It is non-deterministic across embedding models and unexplainable. This confirms our plan: canonical-URL dedupe, then RRF across engines, then rule weights, then pins, then blocks, recording a decision for **every** result including dropped ones (§5 steps 5–6). Never discard a result without a recorded reason.
- [date-extraction] Vane has **no date handling at all**: it ignores SearXNG `publishedDate` and only tells the LLM today's date. Freshness and receipts are a clear differentiator. Use SearXNG `publishedDate` (when its engines supply it) as tier 1 and fall back to page metadata via `fetch`.
- [mcp-tool-surface] Two of Vane's prompt mechanics translate to the MCP world:
  - (a) a **short tool description plus longer, mode-specific guidance** elsewhere (Vane: tool schema vs system prompt; for us: tool `description` vs server `instructions`/skill). This keeps the per-tool token cost low (§2.7).
  - (b) **depth as iteration and query budget**: Vane uses 2/6/25 iterations and ≤ 3 queries per call. Our `quick/standard/deep` guidance in the skill can state similar budgets.
- [mcp-tool-surface] Vane's "sources" are *everything retrieved*, presented as if cited. Our receipt must keep the plan's distinction: **searched / returned / hidden / opened**, never "cited" (§7).
- [ui-ux] **Receipt panel and dashboard:**
  - copy the 3-cards + "View N more" pattern for the in-chat card (it fits Claude's 4–5 data point limit)
  - copy the step timeline for the session receipt
  - copy citation-style index chips for result rows
  - **don't load favicons from `s2.googleusercontent.com`**: Vane leaks every source URL/domain to Google (`MessageSources.tsx`, `AssistantSteps.tsx`), and MCP App CSP blocks it anyway. Use a letter avatar, or favicons fetched and cached by our own fetcher.
- [ui-ux] Vane's domain label regex `url.replace(/.+\/\/|www.|\..+/g,'')` turns `docs.python.org` into `docs`. Use a public-suffix-aware registrable domain plus a mono, middle-truncated full host (§8.4).
- [dashboard-process-model] The **event-log replay on reconnect** (`session.ts`) is the right resume model for our live log. Implement it with SSE `id:` plus `Last-Event-ID`, mapped to SQLite `rowid > last` (§4 runtime topology). Avoid Vane's NDJSON served as `text/event-stream` without SSE framing, and its in-memory-only state (lost on restart).
- [upgrades-migrations] **Anti-patterns to rule out in the ADR:**
  - non-transactional DROP/RENAME data migrations
  - startup that continues after a failed migration
  - config overwritten with defaults on a parse error
  - Ours: migrations in a single transaction under a lock; on a newer or failed schema, go read-only with a clear message (§4); on a bad `rules.yaml`, keep the last good compiled rules, show the parse error, **never overwrite the user's file**; atomic writes (temp file + rename).
- [sqlite-driver] Vane's better-sqlite3 + drizzle is fine inside a Docker image where the native module is compiled at build time. That is the **opposite** of our plugin/npx constraint, so it is no evidence for better-sqlite3 in our case. Its lack of WAL/busy_timeout would also break our multi-writer topology.
- [key-storage] Vane keeps provider API keys **in plaintext `config.json`** and **returns them unmasked from `GET /api/config`**, and `POST /api/config` lets anyone set any key path. For us: keys never in rules/config files (§6 "Refuse secrets"), the dashboard shows only "set / missing / source", never values (§4), and every write endpoint requires the dashboard session token.
- [security] **Vane binds 0.0.0.0 with no auth** on any route. A LAN peer can read keys, change `search.searxngURL` (an SSRF pivot) or run the Playwright scraper against internal URLs (no SSRF guard; `--no-sandbox`; stealth UA). search-hole's `fetch` must have: a private-network/SSRF guard, an honest UA, robots.txt, no browser stealth (§2.8 "Respect the web"), and a dashboard bound to 127.0.0.1 with a token and Host allowlist (smart-doctor pattern).
- [testing] Vane has zero tests, a pipeline that depends on an LLM and embeddings, and no way to replay a search. Our deterministic core (§2.5) plus recorded engine fixtures are what make rules and merging testable offline.
- [distribution] A one-line `docker run` with a named volume and a full/slim image pair is a proven self-host UX for the v2 remote connector (`compose.yaml` with SearXNG, §9.5). A multi-arch (amd64/arm64) build matrix is table stakes.
- [other] Positioning: Vane is a *chat app* that owns the answer, so it can't govern Claude Code, Cursor or Codex searches. Our README comparison row (§1) is accurate. Users who run Vane already have a JSON-enabled SearXNG we can reuse (`SEARXNG_API_URL`-style config).

## Borrow / avoid
**Borrow**
- Minimal SearXNG `settings.yml` (`use_default_settings: true` + `formats: [html, json]`) as the base of our bundled config, plus an explicit secret via env.
- Per-request `engines=` mapping for source types and profiles (academic, discussions, news, images).
- The full/slim (bundled vs BYO URL) deployment split and the `SEARXNG_API_URL`-style override.
- The step timeline ("Searching N queries / Found N results / Reading N sources") and 3-cards + "View N more" source summary for receipts.
- Event-log replay for stream resume (as SSE with `Last-Event-ID`).
- A field registry that drives env import, settings UI and first-run wizard together (type, scope, env var, `password` type), for our engine config, without storing values in plain JSON.
- A lazily launched shared worker with idle shutdown (if we ever add a headless fetcher).

**Avoid**
- Embedding/LLM re-ranking and silent similarity drops in the gateway (breaks "deterministic core" and "explain everything").
- Exact-string URL dedupe; ignoring `publishedDate`, `engine` and `unresponsive_engines` from SearXNG.
- Unpinned SearXNG `git clone`, Flask dev server on 0.0.0.0, NOPASSWD sudo, committed `secret_key`, and baking AGPL SearXNG into our own image.
- No auth on local HTTP APIs; returning secrets from a config endpoint; plaintext keys in config JSON.
- Overwriting config on a parse error; non-transactional migrations; continuing after a failed migration.
- Third-party favicon services (Google s2) that leak browsing to Google.
- Browser stealth (webdriver masking, spoofed UA, `--no-sandbox`) and scraping without an SSRF guard or robots.txt.
- Persisting sources as opaque JSON blobs (we need relational `results` rows for the dashboard and stats).
