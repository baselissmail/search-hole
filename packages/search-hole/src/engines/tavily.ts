// SPDX-License-Identifier: Apache-2.0
/**
 * Tavily Search adapter (ADR-0009, ADR-0017): the no-Docker, no-card default engine.
 * Quirks, each covered by a fixture:
 * - `POST /search` with a JSON body and `Authorization: Bearer <key>`.
 * - `include_published_date: true` is always sent; without it `published_date` is absent.
 *   `published_date` is a medium-confidence published date, in ISO or RFC 2822 form.
 * - `search_depth` is `basic` (1 credit) except at `deep` depth (`advanced`, 2 credits).
 * - `include_domains` is capped at 300 and `exclude_domains` at 150; block rules from
 *   `pushdownBlockHosts` and query `-site:` excludes are sent as `exclude_domains`.
 * - `start_date` (YYYY-MM-DD) carries `sinceDate`.
 * - HTTP 432 and 433 mean plan or pay-as-you-go limits: `quota`. 429 is a plain rate limit.
 * - The current Tavily terms have no caching clause, so retention is `full` (ADR-0009 point 9).
 * Results keep Tavily's own order (it returns them by relevance).
 */

import { z } from 'zod'
import type {
  AdapterCtx,
  EngineAdapter,
  EngineCapabilities,
  EngineDefaults,
  EnginePlan,
  EngineRetention,
  HttpRequest,
  HttpResponse,
  ParseOutcome,
  RawResult,
} from '../shared/types.ts'
import {
  bodySnippet,
  cleanText,
  cleanUrl,
  isHeaderSafeKey,
  normalizeHosts,
  parseJson,
  redactDetail,
  scrubQuery,
  secretsOf,
} from './common.ts'
import { engineDate } from './dates.ts'
import { classifyHttp, parseRetryAfter } from './errors.ts'

const ORIGIN = 'https://api.tavily.com'
const MAX_RESULTS = 20
const MAX_INCLUDE = 300
const MAX_EXCLUDE = 150
const MAX_QUERY_CHARS = 400

const capabilities: EngineCapabilities = {
  domainInclude: { max: MAX_INCLUDE },
  domainExclude: { max: MAX_EXCLUDE },
  dateFilter: 'range',
  goggles: false,
  dates: 'published',
  maxPerCall: MAX_RESULTS,
  paging: false,
  requiresKey: true,
  endpoint: 'fixed',
  officialApi: true,
  billed: true,
  attribution: null,
}

const retention: EngineRetention = { log: 'full', payloadTtlHours: null }

const defaults: EngineDefaults = {
  timeoutMs: 12_000,
  concurrency: 4,
  overFetch: 2,
  retry: { sameEngineRetries: 1, backoffMs: 250 },
}

const resultSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullish().catch(undefined),
  content: z.string().nullish().catch(undefined),
  published_date: z.string().nullish().catch(undefined),
})

const envelopeSchema = z.looseObject({ results: z.array(z.unknown()) })

const errorSchema = z.looseObject({
  detail: z
    .union([z.string(), z.looseObject({ error: z.string() })])
    .nullish()
    .catch(undefined),
})

function excludeHosts(plan: EnginePlan): string[] {
  return normalizeHosts([...plan.excludeDomains, ...plan.pushdownBlockHosts], MAX_EXCLUDE)
}

/** A Tavily adapter that also reports how many block rules a request pushes upstream. */
export type TavilyAdapter = EngineAdapter & { pushedRuleCount(plan: EnginePlan): number }

/** Builds a Tavily adapter around a clock (epoch ms) used for date sanity checks. */
export function createTavilyAdapter(opts: { now: () => number }): TavilyAdapter {
  const { now } = opts

  return {
    id: 'tavily',
    displayName: 'Tavily',
    capabilities,
    retention,
    defaults,

    pushedRuleCount(plan: EnginePlan): number {
      const pushed = new Set(normalizeHosts(plan.pushdownBlockHosts, Number.MAX_SAFE_INTEGER))
      return excludeHosts(plan).filter((h) => pushed.has(h)).length
    },

    setup(ctx: AdapterCtx) {
      if (!ctx.apiKey) return { active: false, reason: 'missing_key', detail: 'No Tavily API key is set.' }
      if (!isHeaderSafeKey(ctx.apiKey)) {
        return { active: false, reason: 'missing_key', detail: 'The Tavily API key has invalid characters.' }
      }
      return { active: true }
    },

    buildRequest(plan: EnginePlan, ctx: AdapterCtx): HttpRequest {
      const body: Record<string, unknown> = {
        query: plan.query.trim().slice(0, MAX_QUERY_CHARS),
        max_results: Math.min(Math.max(Math.trunc(plan.count), 1), MAX_RESULTS),
        search_depth: plan.depth === 'deep' ? 'advanced' : 'basic',
        include_published_date: true,
      }
      const exclude = excludeHosts(plan)
      if (exclude.length > 0) body.exclude_domains = exclude
      const include = normalizeHosts(plan.includeDomains, MAX_INCLUDE)
      if (include.length > 0) body.include_domains = include
      if (plan.sinceDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(plan.sinceDate))
        body.start_date = plan.sinceDate

      const base = (ctx.endpoint ?? ORIGIN).replace(/\/+$/, '')
      return {
        method: 'POST',
        url: `${base}/search`,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.apiKey ?? ''}`,
        },
        body: JSON.stringify(body),
      }
    },

    parseResponse(res: HttpResponse, plan: EnginePlan, ctx: AdapterCtx): ParseOutcome {
      const clock = now()

      if (res.status < 200 || res.status >= 300) {
        const parsed = parseJson(res.text)
        const body = parsed.ok ? errorSchema.safeParse(parsed.value) : null
        const rawDetail = body?.success ? body.data.detail : undefined
        const message = typeof rawDetail === 'string' ? rawDetail : rawDetail?.error
        const errorClass =
          classifyHttp(res.status, res.headers, `${message ?? ''} ${bodySnippet(res.text)}`) ?? 'malformed'
        const why = scrubQuery(cleanText(message ?? bodySnippet(res.text, 120), 120), plan.query)
        const detail = redactDetail(`Tavily HTTP ${res.status}: ${why}`, secretsOf(ctx))
        const retryAfterMs =
          errorClass === 'rate_limited' || errorClass === 'quota'
            ? parseRetryAfter(res.headers, clock)
            : undefined
        return retryAfterMs === undefined
          ? { kind: 'error', errorClass, detail }
          : { kind: 'error', errorClass, retryAfterMs, detail }
      }

      const json = parseJson(res.text)
      if (!json.ok)
        return { kind: 'error', errorClass: 'malformed', detail: 'Tavily HTTP 200: the response is not JSON' }
      const envelope = envelopeSchema.safeParse(json.value)
      if (!envelope.success) {
        return {
          kind: 'error',
          errorClass: 'malformed',
          detail: 'Tavily HTTP 200: the response has no results array',
        }
      }

      const results: RawResult[] = []
      for (const entry of envelope.data.results) {
        if (results.length >= Math.max(plan.count, 0)) break
        const item = resultSchema.safeParse(entry)
        if (!item.success) continue
        const url = cleanUrl(item.data.url)
        if (url === null) continue
        const date = engineDate(item.data.published_date, 'engine:tavily.published_date', clock)
        const title = cleanText(item.data.title, 300)
        results.push({
          engine: 'tavily',
          rank: results.length + 1,
          url,
          title: title === '' ? url : title,
          snippet: cleanText(item.data.content, 1000),
          dates: date ? [date] : [],
        })
      }
      return results.length === 0 ? { kind: 'empty' } : { kind: 'ok', results }
    },
  }
}

/** The default Tavily adapter (wall clock). */
export const tavilyAdapter: TavilyAdapter = createTavilyAdapter({ now: () => Date.now() })
