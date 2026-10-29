# brave/brave-search-skills
> Ref: `research/refs/brave-search-skills` @ 62793e0 (2026-08-12) · License: **MIT** (`LICENSE`, "Copyright (c) 2026 Brave Software"). There are no per-directory licenses. `clawhub/bx-search/SKILL.md` frontmatter declares `license: MIT-0` for that one packaged skill (the repo `LICENSE` stays plain MIT). MIT allows reuse with the copyright and permission notice kept; the "≤ 10 lines" quoting limit is our own house rule, not a license term.

## Purpose
Brave's official **Agent Skills** (agentskills.io format) that teach coding agents to call the Brave Search API with `curl`, or with Brave's `bx` CLI (a separate repo, `brave/brave-search-cli`, not in our refs). There is one skill per endpoint: web, news, images, videos, llm-context, answers, local-*, suggest and spellcheck. There is also an all-in-one `bx` skill and a ClawHub-packaged `bx-search`. It is distributed as a Claude Code plugin marketplace and via curl/tar for other agents.

Why it matters:
1. It is the most up-to-date description we have of the **Brave Search API surface** our Brave adapter targets: params, limits, response date fields and Goggles over the API.
2. It is a worked example of **skill design** for search, which feeds our `/search-hole` skill (§9.1) and the MCP server `instructions` (§4).

## Architecture sketch
```
.claude-plugin/marketplace.json   name "brave-search", 1 plugin "brave-search-skills" v1.5.0, source "./", strict:false, skills: [13 paths]
AGENTS.md                         cross-agent index: table of skill → description; "read skills/<name>/SKILL.md"
skills/<name>/SKILL.md            12 real dirs + `skills/search -> bx` (symlink alias)
clawhub/bx-search/SKILL.md        ClawHub/OpenClaw package with versioned frontmatter + per-OS binary install metadata
docs/api-key-setup.md             per-agent key setup, ordered "most to least secure"
.github/workflows/validate.yml    shell+jq lint of skills/marketplace/AGENTS.md
.github/workflows/release-clawhub.yml  manual publish of clawhub/bx-search (version from frontmatter)
```
There is no code. Every `skills/*` skill is a single `SKILL.md` of 74–322 lines (the ClawHub `bx-search` one is 374), with **no `references/` subfiles, no scripts and no `allowed-tools`** (own `find`).

## Key modules and data flow
- Agent → skill text → `curl https://api.search.brave.com/res/v1/<endpoint>` with header `X-Subscription-Token: ${BRAVE_SEARCH_API_KEY}`, or → `bx <cmd>` (JSON on stdout, errors on stderr).
- Endpoints: `/res/v1/web/search`, `/news/search`, `/images/search`, `/videos/search`, `/llm/context`, `/chat/completions`, `/local/place_search`, `/local/pois`, `/local/descriptions`, `/suggest/search`, `/spellcheck/search` (README "Available Skills" table) and `/web/rich` (`skills/web-search/SKILL.md` "Rich Callback Endpoint").
- **Both GET and POST** are accepted on web, news and llm-context. POST is recommended "for long queries or complex Goggles" (`skills/web-search/SKILL.md` "Endpoint"; `skills/news-search/SKILL.md`). Only llm-context shows a POST example (JSON body, `Content-Type: application/json`, `{"q": ...}`); the web and news POST body format is not documented in this repo (unverified: assume the same JSON shape).
- **Key resolution in `bx`:** `--api-key` flag > `BRAVE_SEARCH_API_KEY` env > config file at `~/Library/Application Support/brave-search/api_key` (macOS), `~/.config/brave-search/api_key` (Linux), `%APPDATA%\brave-search\api_key` (Windows). `bx config set-key` with no argument prompts, which keeps the key out of shell history (`clawhub/bx-search/SKILL.md` "Configuring the API Key").

## Data model and storage
Brave **response fields that matter to our adapter, merge and receipts** (from the skills' field tables):
- **Web** (`skills/web-search/SKILL.md` "Response Fields"):
  - per result: `web.results[].{title,url,description,age,page_age,language,meta_url{scheme,netloc,hostname,path},profile{name,url,long_name,img},extra_snippets[≤5],article{author,publisher,date},schemas,content_type,fetched_content_timestamp}`
  - per response: `web.mutated_by_goggles` (bool), `query.{original,altered,cleaned,more_results_available,search_operators{applied,cleaned_query,sites}}`, `mixed{main,top,side}`
- **Dates:**
  - `page_age` is an *ISO datetime with no timezone* (example `"2025-04-12T14:22:41"`), described as "publication date"
  - `age` is *human-readable*: either relative ("2 days ago") or absolute ("February 12, 2025" in videos)
  - news/videos/images also return `page_fetched`, an ISO datetime **with `Z`** giving the last crawl (`skills/news-search/SKILL.md` "Response Fields"; `skills/videos-search/SKILL.md`)
  - `include_fetch_metadata=true` adds `fetched_content_timestamp` (int)
- **LLM Context** (`skills/llm-context/SKILL.md` "Response Fields"):
  - `grounding.generic[].{url,title,snippets[]}`
  - `sources[url].age` is a **4-slot array**: [full date, `YYYY-MM-DD`, relative age, ISO 8601 with `Z`], or `[]` when the date is unknown
  - `enable_source_metadata` adds `site_name`, `favicon`, `thumbnail`, `description`
  - its `freshness` parameter doc defines the age used by the *filter* as "the most relevant date reported by the content, **such as its published or last modified date**". The web and news docs describe the `page_age` *field* as the publication date, so whether `page_age` can be a modified date is an inference (unverified)
- **Errors:**
  - stderr shape `{"type":"ErrorResponse","error":{"code":"RATE_LIMITED","status":429,...}}` (`clawhub/bx-search/SKILL.md` "Exit Codes")
  - documented error texts: "Invalid API Key", "Rate Limited", "**Option Not in Plan**", the last meaning the endpoint needs a higher tier (`docs/api-key-setup.md` "Troubleshooting")

## Config format
- **SKILL.md frontmatter** uses only `name` and `description` in all 12 `skills/*` (own awk over files).
- `clawhub/bx-search/SKILL.md` adds:
  - `version: 1.4.0`, `license: MIT-0`
  - `metadata.openclaw.{requires.bins:["bx"], primaryEnv:"BRAVE_SEARCH_API_KEY", homepage, install:[{id,kind:"download",os,bins,label,url}…]}`, giving per-OS/arch binary downloads (linux amd64/arm64, darwin arm64, windows amd64/arm64)
  - `repo`, `issues`
- **Marketplace** (`.claude-plugin/marketplace.json`, MIT):
```json
{ "name": "brave-search", "owner": { "name": "Brave Software" },
  "plugins": [{ "name": "brave-search-skills", "source": "./", "version": "1.5.0",
                "strict": false, "skills": ["./skills/answers", "./skills/bx", "..."] }] }
```
- **Key placement advice** (`docs/api-key-setup.md`, README "Prerequisites"), ordered most to least secure:
  - Claude Code `~/.claude/settings.json` → `env.BRAVE_SEARCH_API_KEY`, or `.claude/settings.local.json` per project
  - Codex `~/.codex/config.toml` `[shell_environment_policy] set = {…}`
  - direnv `.envrc`, then a shell profile
  - the stated rationale (paraphrased from `docs/api-key-setup.md`): coding agents can read shell environment variables and profile files, so scoped agent-native config limits exposure. The order is given per agent ("listed from most to least secure"), not as one global ranking

## Extension points (plugins, hooks)
- Skills are the only extension. `strict:false` in marketplace.json lets the plugin entry list skill paths without a `plugin.json`.
- An **alias by symlink**: `skills/search -> bx` gives a second directory name. Its frontmatter still says `name: bx`, which breaks the "name == dir" rule; `validate.yml` deliberately skips symlinks, so this isn't caught.
- `bx --extra KEY=VALUE` (repeatable) passes arbitrary API params, an escape hatch for new API features (`skills/bx/SKILL.md` "Notes").

## Rules / lists: parsing and compilation
**Goggles over the API** (repeated nearly verbatim in web-search, news-search, llm-context and bx):
- The `goggles` param takes a **hosted URL** or **inline rules**:
  - "Inline rules need no registration"
  - hosted ones must be on GitHub/GitLab, carry `! name/description/author` and be registered (`skills/web-search/SKILL.md` "Goggles (Custom Ranking)")
- Inline rules are separated by `\n` (`%0A`). The quick reference covers `$boost=N,site=D`, `$downrank=N,site=D`, `$discard,site=D`, `/path/$boost=N`, `*pattern*$boost=N` and a generic `$discard` meaning allowlist mode, with "N is an integer 1–10".
- **Param type differs per endpoint:**
  - web: `string`
  - news: "string or array … **repeat param for multiple**"
  - llm-context: "string/list"
  - so several goggles per request may be accepted on news and llm-context, even though the Brave UI applies one at a time (see goggles-quickstart.md)
- **Brave turns `site:` operators into Goggles internally.** The skills present explicit goggles as better than `site:` chains because they don't bloat the query and allow "hundreds of rules" (`clawhub/bx-search/SKILL.md` "Why Agents Should Use Goggles").
- `bx` **domain shortcuts** `--include-site D` (allowlist) and `--exclude-site D` (blocklist) "generate Goggles rules internally" and are **mutually exclusive** with `--goggles` (`skills/bx/SKILL.md` "Domain Shortcuts").
- Goggles can come from a file (`--goggles @/path`) or stdin (`@-`). Goggles work on `context`, `web` and `news` only.
- **Freshness** `freshness=pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD`, where pd = 24 h, pw = 7 d, pm = 31 d and py = 365 d (`skills/web-search/SKILL.md` "Freshness Values").
- **`result_filter`** (comma-separated): `discussions, faq, infobox, news, query, videos, web, locations`.

**Request limits relevant to over-fetch:**

| Endpoint | `q` | `count` | `offset` | Other |
|---|---|---|---|---|
| web | 1–400 chars, ≤ 50 words | 1–20 (default 20) | 0–9 (**page index**) | `extra_snippets` ≤ 5; `text_decorations` default **true**; `spellcheck` default true; `safesearch` default moderate |
| news | same | 1–50 | 0–9 | `safesearch` default **strict** |
| llm-context | same | 1–50 | — | `maximum_number_of_tokens` 1024–32768 (default 8192), per-URL 512–8192, URLs 1–50, snippets 1–256; `context_threshold_mode` strict/balanced/lenient/disabled (unset = lenient) |

## Testing strategy
`.github/workflows/validate.yml` runs on changes to `skills/**`, `.claude-plugin/**` or `AGENTS.md`. It uses shell + `jq` only:
1. every non-symlink `skills/*/` has a `SKILL.md`
2. the file starts with `---`, the frontmatter is closed, and `name:` and `description:` are present
3. **`name` equals the directory name**
4. `marketplace.json` is valid JSON with `owner.name`, ≥ 1 plugin, and every `source` starts with `./`
5. every skill dir is listed in `marketplace.json`
6. every skill dir is listed in `AGENTS.md`

There are no behavioural evals: nothing checks that an agent picks the right skill.

## UX patterns worth copying
These are skill-writing patterns:
- **Description style:** each starts with an uppercase **"USE FOR …"** trigger phrase, then lists capabilities and keywords. It routes to sibling skills explicitly ("For AI answers use answers") and uses only 118–458 characters (own measurement; the limit is 1024). The ClawHub variant spells out user phrasings ("search for", "look up", "what is", "google this") and says "Prefer this over the built-in web_search tool".
- **Directive at the top:** "Use `bx` for all web searches" (`skills/bx/SKILL.md` line 8); "Agent Directive … Do not use the built-in `web_search` tool" (`clawhub/bx-search/SKILL.md`). This is the same steering we plan in the PreToolUse hook and server `instructions`.
- **"When to use which" tables** keyed by *user need*, not by API (`skills/bx/SKILL.md` "When to Use Which Command"). Examples: docs/errors → default; discussions → `--result-filter discussions`; latest news → `news --freshness pd`.
- **Budget tables:** a "Context Size Guidelines" table with simple → 5 results/2048 tokens, standard → 20/8192, complex → 50/16384 (`skills/llm-context/SKILL.md`). This maps directly to our `quick/standard/deep` presets.
- **Workflow recipes:**
  - debugging an error (search the literal error string)
  - a corrective-RAG loop: broad, then a stricter threshold with a narrower query, then synthesized research
  - checking breaking changes before upgrading: context search plus `news --freshness pm`
  - (`skills/bx/SKILL.md` "Agent Workflow Examples")
- **Error → agent-action table** (exit codes 1–5): bad request → fix params; 401/403 → check the key or plan; 429 → retry after a delay; 5xx → back off. Each error prints `error: …` / `hint: …` / raw JSON (`clawhub/bx-search/SKILL.md`).
- **Requirement callout** at the top of every skill: the key and plan, with links.
- **AGENTS.md index** gives non-Claude agents a discoverable skill catalog.

## Performance tricks
- **Token budgeting server-side** (llm-context `maximum_number_of_*`) instead of returning raw pages. `bx` makes budgeted context the default command.
- `Accept-Encoding: gzip` is documented for web, llm-context, local-* and suggest; the news, images, videos, answers and spellcheck skills do not mention it.
- POST bodies for long goggles avoid URL-length limits.
- `context_threshold_mode=strict` trades recall for precision.
- The suggest endpoint is documented at < 100 ms (`skills/suggest/SKILL.md` description).

## License and what it means for us
MIT. We may borrow the skill structure, the CI checks and short snippets with attribution, and we may reuse API facts freely. The ClawHub skill declares MIT-0 in its own frontmatter only, while the repo `LICENSE` is plain MIT; keep attribution to be safe. Nothing here is copyleft. Brave's *API terms* (storage rights, §5.2 of the plan) are separate and not covered by this repo.

## Implications for search-hole
- [engine-adapter] **Brave adapter request rules:**
  - send `X-Subscription-Token`
  - validate `q` (≤ 400 chars, ≤ 50 words) before calling
  - **set `text_decorations=false`** so snippets carry no highlight markup (inferred: the default is `true`, "Include highlight markers")
  - over-fetch with `count=20` (the web maximum). That this is one billed call is inferred from "$5/month free credits (~1,000 free queries)" (`clawhub/bx-search/SKILL.md:93`); the repo states no per-result charge. `offset` is documented only as "Page offset for pagination (0-9)"; reading it as a page index, with a 200-result ceiling, is an inference
  - use POST when the compiled inline goggle is large (body format: see the POST caveat above)
  - record `query.altered` (spellcheck rewrite) in the search log so users see when Brave changed their query
- [engine-adapter] **Use `web.mutated_by_goggles`** as push-down verification. If a goggle was sent and this flag is false, note it in the receipt and engine health. It also helps the "Goggles only re-rank the recall set" honesty.
- [engine-adapter] **Error mapping for health and quota:**
  - parse `error.code`/`status`
  - 401/403 → "key invalid" or "**option not in plan**" (a distinct, actionable status). The repo documents "Option Not in Plan" only as an error text, and bx exit code 3 as "Auth/permission error (401/403) ... check API key or plan"; that the plan error arrives as 401/403 is inferred
  - 429 → suspend with backoff
  - 5xx → retry once, then fall back
  - this mirrors `bx` exit codes 3/4/5
- [engine-adapter] **Freshness push-down:**
  - map `maxAgeDays` to an exact range `YYYY-MM-DDtoYYYY-MM-DD` (today − N … today); the buckets pd/pw/pm/py are coarse
  - caveat (inferred, undocumented): Brave's filter probably drops results with no known date
  - that conflicts with our "flag, don't drop unknown dates" (§5 step 7), so push freshness down **only when the profile has `requireDate: true`**, or over-fetch an unfiltered call
- [date-extraction] **Brave date fields, in priority order:**
  1. `page_age`: ISO, **no timezone** (the docs never name the zone, so parsing as UTC is our assumption). Label it "page date (published; may be modified)", medium confidence: the web and news docs call it the publication date, and only the llm-context `freshness` doc mentions "published or last modified".
  2. `article.date` when present.
  3. llm-context `sources[url].age[3]` (ISO, `Z`).
  - Never parse `age` (human text) when `page_age` exists.
  - `page_fetched` / `fetched_content_timestamp` is a **crawl time, not a publish date**. Store it separately as "last seen alive by engine" (useful for the dead-link heuristic).
- [rule-format-precedence] The `bx --include-site/--exclude-site` shortcuts look like the right UX for most users (our judgment; the repo has no usage data). Expose `allow-only`/`exclude` sugar in the CLI and slash commands that compiles to rules, keep goggles for power users, and make the two mutually exclusive per invocation to avoid surprises.
- [lists-subscriptions] Several goggles per request may be accepted on news and llm-context (array/repeat). Web documents only a string, so the Brave compiler should **merge into one inline goggle** for portability.
- [mcp-tool-surface] **Skill and instructions design for §9.1:**
  - a "USE FOR …" description under ~300 chars that names sibling capabilities (search vs fetch vs receipt)
  - a top-line directive to prefer `search-hole` over built-in WebSearch
  - a "when to use quick/standard/deep" table keyed by user need, mirroring the llm-context budget table
  - recipes (look up official docs, check breaking changes with freshness, debug an error string)
  - an error → action table (no healthy engine → tell the user to run `searchhole doctor`; a hidden result the user wants → `suggest_rule`, never claim it was applied)
- [mcp-tool-surface] Brave's "Context Size Guidelines" (5/2048, 20/8192, 50/16384) is a useful sanity anchor for our output caps (`search` ≤ ~2.5k tokens at standard): our results are links plus snippets, not extracted page text, so they should be well under Brave's numbers.
- [key-storage] Adopt the **same env var name `BRAVE_SEARCH_API_KEY`** so users who already followed Brave's setup (Claude Code `settings.json` env, Codex `shell_environment_policy`, direnv) work with zero config, and `doctor` can say "found in env". `bx` stores its key in a plaintext file per OS. Detect it at most with explicit user consent; don't silently read another tool's secret.
- [distribution] marketplace.json with `"strict": false` plus an explicit `skills` list is a minimal working plugin manifest. ClawHub/OpenClaw metadata (`requires.bins`, `primaryEnv`, per-OS `install` downloads) is a template if we ship standalone binaries (runtime option b) to that ecosystem. Also ship an `AGENTS.md` index for agents that don't read plugin manifests.
- [testing] Copy `validate.yml`'s checks into our CI (name == dir, frontmatter closed, every skill listed in the marketplace). Add `description ≤ 1024` ourselves: Brave's workflow does not check length. Add what Brave lacks: **plugin evals** (§9.1) that check the model actually routes to our tool.
- [security] Echo Brave's key-hygiene guidance in our docs: prefer host-native secret config (`userConfig` with `sensitive: true`, MCPB keychain) over shell exports, and never accept keys as CLI flags (they show up in process listings, as `bx` warns).

## Borrow / avoid
**Borrow**
- "USE FOR …" description pattern, top-line directive, need-keyed "when to use" tables, workflow recipes and error → action tables for our skill and server `instructions`.
- `validate.yml`-style lint (name == dir, frontmatter, marketplace/AGENTS.md coverage) as a cheap CI gate next to `claude plugin validate --strict`.
- Brave API facts: `page_age`/`page_fetched` semantics, `mutated_by_goggles`, `query.altered`, `count`/`offset` ranges, the freshness formats, and POST for big goggles.
- `BRAVE_SEARCH_API_KEY` as the canonical env name; key resolution order flag > env > per-OS config file (minus the flag).
- Include/exclude-site sugar that compiles into goggles.

**Avoid**
- Symlink skill aliases whose frontmatter `name` doesn't match the directory, and CI that skips them.
- Copy-pasting the same Goggles section into four skills: one source of truth plus links (progressive disclosure via `references/`) costs fewer tokens and drifts less.
- Long multi-endpoint skills (300+ lines). Our skill should stay short; the gateway carries the mechanics.
- Pushing freshness to Brave when unknown-date results should be flagged rather than dropped.
- Parsing the human-readable `age` string when `page_age` is available.

## Verification
- Date: 2026-10-29. Checked against `research/refs/brave-search-skills` @ 62793e0. Claims checked: 58 (license files and per-skill frontmatter, marketplace and skill inventory, endpoint list, request parameter tables for web, news and llm-context, response and date fields, error and exit-code tables, key-resolution order, `validate.yml` checks, description-length measurement, and every bullet under "Implications for search-hole").
- Confirmed with no change: MIT `LICENSE` (Brave Software, 2026), `marketplace.json` contents (v1.5.0, `strict: false`, 13 paths, `skills/search -> bx` symlink with `name: bx`), ClawHub `license: MIT-0` and `version: 1.4.0`, parameter ranges and defaults (web `count` 1-20, `offset` 0-9, `text_decorations` true; news `count` 1-50 and `safesearch` strict; llm-context token and URL limits), `goggles` type per endpoint (string, string-or-array, string/list), `web.mutated_by_goggles`, `query.altered`, `page_age` / `page_fetched` / four-slot llm-context `age`, freshness formats, exit codes 3/4/5, description lengths 118-458, frontmatter `name` + `description` only.
- Corrections made:
  1. "Accept-Encoding: gzip is supported on all endpoints": the repo documents it for six skills only (web, llm-context, local-*, suggest).
  2. `page_age` as "published or last modified": the llm-context `freshness` doc says that about the filter's page age; web and news call the `page_age` field the publication date. Bullet and data-model line now mark the modified-date reading as an inference, and the UTC parsing as an assumption.
  3. POST: only llm-context shows a body format (JSON); the web and news POST body format is undocumented in the repo, so the "use POST for large goggles" bullet now says to verify it (input to the Brave push-down design).
  4. "One billed call", "offset is a page index" and "ceiling of 200 results" are inferences, not repo statements; labelled.
  5. "Option Not in Plan" arriving as 401/403 is inferred (the repo gives only an error text and exit code 3 "check API key or plan").
  6. Misquoted rationale in `docs/api-key-setup.md`; replaced with a paraphrase, and noted that the "most to least secure" order is per agent.
  7. `validate.yml` does not check description length; the "≤ 1024" check is ours.
  8. ClawHub file is 374 lines (the "74-322" range is for `skills/*`); `/web/rich` is cited from `skills/web-search/SKILL.md`, not the README table.
  9. License section: the "≤ 10 lines" quoting limit is a house rule, not an MIT term; MIT-0 is declared in one frontmatter only, so keep attribution.
  10. "Right UX for 90% of users" had no source; reworded as our judgment.
- No GPL/AGPL/EUPL code is in this note. The one JSON excerpt is a condensed MIT excerpt of `marketplace.json`.

