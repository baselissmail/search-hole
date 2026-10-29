// SPDX-License-Identifier: Apache-2.0
/**
 * SearXNG adapter (ADR-0009, ADR-0017). Quirks, each covered by a fixture or test:
 * - `json` is off in a default install: HTTP 403 means `json_disabled`, not `forbidden`.
 * - `engines=` and `categories=` are unioned, so we send `engines=` without `categories`.
 * - `language` is always explicit (otherwise it follows Accept-Language), and
 *   `Accept-Language: en` keeps the upstream error messages in stable English.
 * - The `results` array is not in rank order (a category-grouping pass): we rank by `score`.
 * - `publishedDate` is an ISO string without a timezone, present only for some upstreams.
 * - `unresponsive_engines` lists upstream failures as `[name, message]`; a "Suspended: "
 *   prefix means SearXNG itself has benched that upstream.
 * - With `time_range`, SearXNG silently skips upstreams that lack support.
 * The clock is injected (`now`) because `time_range` is derived from `sinceDate`.
 */

import { z } from 'zod'
import type {
  AdapterCtx,
  EngineAdapter,
  EngineCapabilities,
  EngineDefaults,
  EnginePlan,
  EngineRetention,
  ErrorClass,
  HttpRequest,
  HttpResponse,
  ParseOutcome,
  RawResult,
  UpstreamDiag,
} from '../shared/types.ts'
import { bodySnippet, cleanText, cleanUrl, parseJson, redactDetail, scrubQuery } from './common.ts'
import { engineDate } from './dates.ts'
import { classifyHttp, parseRetryAfter } from './errors.ts'

const DAY_MS = 86_400_000

const capabilities: EngineCapabilities = {
  domainInclude: null,
  domainExclude: null,
  dateFilter: { buckets: ['day', 'week', 'month', 'year'] },
  goggles: false,
  dates: 'published',
  maxPerCall: 50,
  paging: true,
  requiresKey: false,
  endpoint: 'user',
  officialApi: true,
  billed: false,
  attribution: null,
}

const retention: EngineRetention = { log: 'full', payloadTtlHours: null }

/** timeoutMs is SearXNG's own budget (`timeout_limit`, 4 s) plus 1.5 s of margin (searxng.md). */
const defaults: EngineDefaults = {
  timeoutMs: 5500,
  concurrency: 4,
  overFetch: 2,
  retry: { sameEngineRetries: 1, backoffMs: 250 },
}

const itemSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullish().catch(undefined),
  content: z.string().nullish().catch(undefined),
  engine: z.string().nullish().catch(undefined),
  engines: z.array(z.string()).nullish().catch(undefined),
  score: z.number().nullish().catch(undefined),
  publishedDate: z.string().nullish().catch(undefined),
})

const envelopeSchema = z.looseObject({
  results: z.array(z.unknown()),
  unresponsive_engines: z.array(z.unknown()).nullish().catch(undefined),
})

const unresponsiveSchema = z.tuple([z.string(), z.unknown()], z.unknown())

/** Maps SearXNG's English error phrases (`exception_classname_to_text`) onto our error classes. */
export function classifyUpstreamMessage(message: string): ErrorClass | 'unknown' {
  const m = message.toLowerCase()
  if (m.includes('captcha')) return 'captcha'
  if (m.includes('too many requests') || m.includes('rate limit')) return 'rate_limited'
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout'
  if (m.includes('access denied') || m.includes('forbidden')) return 'forbidden'
  if (m.includes('parsing error') || m.includes('unexpected crash')) return 'malformed'
  if (
    m.includes('connection error') ||
    m.includes('network error') ||
    m.includes('ssl error') ||
    m.includes('proxy error')
  )
    return 'unreachable'
  if (m.includes('server api error') || m.includes('api error') || m.includes('http error')) return 'server'
  return 'unknown'
}

function parseUpstream(raw: readonly unknown[] | null | undefined): UpstreamDiag[] {
  const out: UpstreamDiag[] = []
  for (const entry of raw ?? []) {
    const parsed = unresponsiveSchema.safeParse(entry)
    if (!parsed.success) continue
    const name = cleanText(parsed.data[0], 80)
    if (name === '') continue
    const text = cleanText(typeof parsed.data[1] === 'string' ? parsed.data[1] : '', 120)
    const suspended = /^suspended\s*:?\s*/i.test(text)
    const message = text.replace(/^suspended\s*:?\s*/i, '')
    out.push({ name, errorClass: classifyUpstreamMessage(message), message, suspended })
  }
  return out
}

/** Smallest SearXNG `time_range` bucket that covers `sinceDate`, or undefined when older than a year. */
function timeRangeFor(sinceDate: string | undefined, now: number): string | undefined {
  if (sinceDate === undefined) return undefined
  const since = Date.parse(`${sinceDate}T00:00:00Z`)
  if (Number.isNaN(since)) return undefined
  const days = Math.ceil((now - since) / DAY_MS)
  if (days <= 1) return 'day'
  if (days <= 7) return 'week'
  if (days <= 31) return 'month'
  if (days <= 366) return 'year'
  return undefined
}

/** `timeout_limit` in whole seconds so that our client timeout is that plus 1.5 s; omitted when too short. */
function timeoutLimitFor(timeoutMs: number): number | undefined {
  const seconds = Math.floor((timeoutMs - 1500) / 1000)
  return seconds >= 1 ? seconds : undefined
}

function upstreamEngineNames(names: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const n of names ?? []) {
    const t = n.trim()
    if (/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}$/.test(t) && !out.includes(t)) out.push(t)
  }
  return out
}

function errorOutcome(
  res: HttpResponse,
  errorClass: ErrorClass,
  now: number,
  why: string,
  query: string,
): ParseOutcome {
  const retryAfterMs = errorClass === 'rate_limited' ? parseRetryAfter(res.headers, now) : undefined
  const detail = redactDetail(`SearXNG HTTP ${res.status}: ${scrubQuery(why, query)}`, [])
  return retryAfterMs === undefined
    ? { kind: 'error', errorClass, detail }
    : { kind: 'error', errorClass, retryAfterMs, detail }
}

/** Builds a SearXNG adapter around a clock (epoch ms). */
export function createSearxngAdapter(opts: { now: () => number }): EngineAdapter {
  const { now } = opts

  return {
    id: 'searxng',
    displayName: 'SearXNG',
    capabilities,
    retention,
    defaults,

    setup(ctx: AdapterCtx) {
      if (!ctx.endpoint)
        return { active: false, reason: 'no_endpoint', detail: 'No SearXNG URL is configured.' }
      try {
        const u = new URL(ctx.endpoint)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return {
            active: false,
            reason: 'no_endpoint',
            detail: 'The SearXNG URL must start with http:// or https://.',
          }
        }
      } catch {
        return { active: false, reason: 'no_endpoint', detail: 'The SearXNG URL is not a valid URL.' }
      }
      return { active: true }
    },

    buildRequest(plan: EnginePlan, ctx: AdapterCtx): HttpRequest {
      const params = new URLSearchParams()
      params.set('q', plan.query)
      params.set('format', 'json')
      params.set('language', plan.language.trim() === '' ? 'all' : plan.language.trim())
      params.set('safesearch', String(plan.safesearch))
      params.set('pageno', '1')
      const engines = upstreamEngineNames(plan.upstreamEngines)
      if (engines.length > 0) params.set('engines', engines.join(','))
      const range = timeRangeFor(plan.sinceDate, now())
      if (range) params.set('time_range', range)
      const limit = timeoutLimitFor(ctx.timeoutMs)
      if (limit !== undefined) params.set('timeout_limit', String(limit))
      const base = (ctx.endpoint ?? '').replace(/\/+$/, '')
      return {
        method: 'GET',
        url: `${base}/search?${params.toString()}`,
        headers: { Accept: 'application/json', 'Accept-Language': 'en' },
      }
    },

    parseResponse(res: HttpResponse, plan: EnginePlan, _ctx: AdapterCtx): ParseOutcome {
      const clock = now()
      if (res.status === 403) {
        return errorOutcome(
          res,
          'json_disabled',
          clock,
          'JSON output is disabled (enable "json" in search.formats)',
          plan.query,
        )
      }
      if (res.status < 200 || res.status >= 300) {
        const cls = classifyHttp(res.status, res.headers, bodySnippet(res.text)) ?? 'malformed'
        return errorOutcome(res, cls, clock, bodySnippet(res.text, 120), plan.query)
      }

      const json = parseJson(res.text)
      if (!json.ok) return errorOutcome(res, 'malformed', clock, 'the response is not JSON', plan.query)
      const envelope = envelopeSchema.safeParse(json.value)
      if (!envelope.success)
        return errorOutcome(res, 'malformed', clock, 'the response has no results array', plan.query)

      const upstream = parseUpstream(envelope.data.unresponsive_engines)

      const parsed: Array<{ index: number; score: number | null; raw: z.infer<typeof itemSchema> }> = []
      envelope.data.results.forEach((entry, index) => {
        const item = itemSchema.safeParse(entry)
        if (!item.success || cleanUrl(item.data.url) === null) return
        parsed.push({ index, score: item.data.score ?? null, raw: item.data })
      })
      parsed.sort((a, b) => {
        if (a.score === b.score) return a.index - b.index
        if (a.score === null) return 1
        if (b.score === null) return -1
        return b.score - a.score || a.index - b.index
      })

      const results: RawResult[] = []
      for (const { raw } of parsed.slice(0, Math.max(plan.count, 0))) {
        const url = cleanUrl(raw.url)
        if (url === null) continue
        const title = cleanText(raw.title, 300)
        const via = raw.engines && raw.engines.length > 0 ? raw.engines : raw.engine ? [raw.engine] : []
        const date = engineDate(raw.publishedDate, 'engine:searxng.publishedDate', clock)
        results.push({
          engine: 'searxng',
          rank: results.length + 1,
          url,
          title: title === '' ? url : title,
          snippet: cleanText(raw.content, 1000),
          dates: date ? [date] : [],
          ...(via.length > 0 ? { via: via.map((v) => cleanText(v, 60)).filter((v) => v !== '') } : {}),
        })
      }

      if (results.length === 0) return upstream.length > 0 ? { kind: 'empty', upstream } : { kind: 'empty' }
      return upstream.length > 0 ? { kind: 'ok', results, upstream } : { kind: 'ok', results }
    },
  }
}

/** The default SearXNG adapter (wall clock). */
export const searxngAdapter: EngineAdapter = createSearxngAdapter({ now: () => Date.now() })
