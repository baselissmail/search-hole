# ADR-0011: Date-extraction chain

- **Status:** Accepted (2026-10-30)
- **Related:** [0009](0009-engine-adapter-interface.md), [0010](0010-merge-algorithm-and-weights.md)

## Context

Receipts and freshness rules need each source's real publish and update dates with an honest confidence. §7 proposes a best-first chain: engine dates, page metadata (via `metascraper-date`), HTTP `Last-Modified`, sitemap, a Wayback first capture (opt-in), and later an `htmldate` sidecar. Findings:

- **`metascraper-date` 5.58.4 (MIT)** prefers **modified over published** in its default `date` field. Its helpers package **hard-depends on the native `re2` and on `jsdom`**, which breaks our zero-native-deps, single-bundle goal ([platform-facts-engines-lists-versions.md](../research/platform-facts-engines-lists-versions.md) answer 15).
- **Engine date semantics differ:**

| Engine | Field | Meaning |
|---|---|---|
| Brave | `page_age` | ISO, no timezone; "published (may be modified)" |
| Brave | `page_fetched` | crawl time, not a publish date |
| Exa | `publishedDate` | an estimate |
| Mojeek | `date` | last-modified |
| Tavily | `published_date` | optional |
| SearXNG | `publishedDate` | only from some upstreams; none from Google, Bing or DuckDuckGo |
| Kagi | `time` | ISO |

  ([brave-search-skills.md](../research/brave-search-skills.md), [searxng.md](../research/searxng.md), [mcp-omnisearch.md](../research/mcp-omnisearch.md))
- **Competitors drop dates entirely** (agent-search, Vane, one-search-mcp, and mcp-omnisearch's Brave adapter), so freshness is a differentiator ([agent-search.md](../research/agent-search.md), [vane.md](../research/vane.md)).
- **`htmldate` 1.11.0** scores F ≈ 0.949 on its own benchmark, but it is Python.

## Decision

1. **Our own extractor**, in `core/dates` (pure parsing) and `fetch/` (I/O), with **no `metascraper`, no `jsdom` and no native `re2`.**
   - HTML is tokenised with **htmlparser2** (streaming, small, MIT).
   - Only the `<head>` and the first 512 KiB of `<body>` are scanned, which is enough for metadata and article headers.
2. **The data model is typed dates, not "the date":**
   ```ts
   type FoundDate = {
     value: string                // ISO 8601, normalised to UTC
     kind: 'published' | 'modified' | 'crawled' | 'existed_by'
     method: 'engine:brave.page_age' | 'jsonld:datePublished' | 'og:article:modified_time' | 'http:last-modified' | 'url-path' | …
     confidence: 'high' | 'medium' | 'low'
     tzAssumed: boolean
   }
   ```
   `results` and `fetches` store all found dates (as a JSON array) plus the derived `effective_date`, `effective_kind` and `effective_confidence`, so the receipt can say "updated 2025-03 (JSON-LD), published 2022-11".
3. **Chain and confidence defaults** (best first; every source is kept and nothing is overwritten):

| # | Source | Kind | Confidence |
|---|---|---|---|
| 1 | Engine fields: Tavily `published_date`; Kagi `time`; Brave `article.date`; Brave `page_age`; Exa `publishedDate`; Mojeek `date`; SearXNG `publishedDate` | published, except Mojeek: modified | Tavily, Kagi, Brave `article.date`: high. Brave `page_age`, SearXNG: medium. Exa: medium, marked estimated. Mojeek: medium |
| 2 | JSON-LD (walking `@graph`; Article / NewsArticle / BlogPosting / TechArticle / WebPage / ScholarlyArticle): `datePublished` / `dateModified` | published / modified | high |
| 3 | OpenGraph `article:published_time` / `article:modified_time`, `og:updated_time` | published / modified | high |
| 4 | `itemprop="datePublished"` / `"dateModified"`; `<meta name>` in `date`, `dc.date`, `dcterms.created`, `dcterms.modified`, `last-modified`, `article.published`, `sailthru.date`, `parsely-pub-date` | published / modified | medium |
| 5 | `<time datetime>` inside `<article>`/header (first one) | published | medium |
| 6 | URL path date (`/2023/04/12/`, `/2023-04-12-`) | published | medium (day), low (month only) |
| 7 | HTTP `Last-Modified` | modified | **low**, and **ignored if within 5 minutes of fetch time** (a dynamic page sending "now") |
| 8 | Brave `page_fetched` / an engine crawl time | crawled | (never used for freshness) |
| 9 | Sitemap `<lastmod>` | modified | P6+, **opt-in** (extra request) |
| 10 | Wayback CDX first capture | existed_by | **opt-in, off by default** (a third-party network call) |
| 11 | `htmldate` sidecar | — | later, optional |

4. **Effective date for freshness** (used by ADR-0010): the most recent date of kind `published`/`modified` with confidence high or medium. If only low-confidence dates exist, the effective date is unknown and the result is flagged `date_uncertain`.
5. **Parsing rules:**
   - strict ISO 8601 and RFC 2822 first, then a short list of explicit formats;
   - **no natural-language parsing in v1**, so no "2 days ago": Brave's human-readable `age` is never parsed when `page_age` exists;
   - a date without a timezone is taken as UTC and marked `tzAssumed`;
   - dates in the future (more than 1 day ahead) or before 1995-01-01 are rejected.
6. **Search results carry only engine dates** (step 1). Steps 2–7 run on pages the model actually opens with `fetch`. The receipt says "date from search engine" vs "date from page", so users know which sources were really checked.

## Alternatives considered

- **`metascraper-date`.** Rejected: its default is modified-first, and its dependency tree includes native `re2` and `jsdom`. It could be revisited with `METASCRAPER_RE2=false` and `jsdom` marked external, but our selector set is small enough to own and test.
- **`chrono-node` for relative and natural dates.** Rejected for v1. It is weight and ambiguity we don't need for machine-readable metadata. Add it only if the P1 corpus shows real misses.
- **Fetching every search result's page to date it.** Rejected. It is too many network calls, too slow, and impolite (Principle 8). Dates for unopened results come from engines.

## Consequences

- Receipts can show both dates and the method, matching "every receipt line can be traced back to the raw data" (Principle 2).
- Freshness accuracy depends on engine coverage. SearXNG results from Google, Bing and DuckDuckGo come undated, so the receipt will often say "date unknown" for those until the model opens them. That is an honest limit to document.

## Validate early (P1)

- Build a **golden corpus** of about 100 saved pages with hand-verified published and modified dates: docs sites, news, blogs, GitHub release pages, Stack Overflow, and pages with conflicting metadata. Measure precision and recall per method. Target: F ≥ 0.85 on published dates.
  - Before reusing any of `htmldate`'s test data, check its licence: the code is Apache-2.0, but the test pages' rights are unclear. Prefer our own captures, with a URL list in the repo and the pages stored as fixtures under fair use for testing (to be decided in P1).
