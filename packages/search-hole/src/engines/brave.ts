// SPDX-License-Identifier: Apache-2.0
/**
 * Brave Search API adapter (ADR-0009, ADR-0017). Quirks, each covered by a fixture:
 * - Auth is the `X-Subscription-Token` header; the key never appears in a URL or an error detail.
 * - `text_decorations=false`, otherwise snippets carry highlight markup.
 * - `count` is at most 20 (one billed call); pages (`offset`) are not used in P1.
 * - Dates: `article.date` and `page_age` (ISO, no timezone, "published, may be modified") are
 *   medium-confidence published dates. The human-readable `age` is never parsed.
 * - `freshness` is pushed only as an explicit `YYYY-MM-DDtoYYYY-MM-DD` range, and only when
 *   the plan carries `sinceDate` (the planner sets it only when the profile requires dates).
 * - Block rules are pushed as an inline goggle (`$discard,site=<host>` lines, at most 2000).
 *   Large goggles go by POST (the JSON body shape is assumed from llm-context; unverified).
 *   `web.mutated_by_goggles` reports whether the goggle was applied.
 * - `query.altered` is the spellcheck rewrite and is reported, not hidden.
 * - 429 is either `RATE_LIMITED` (per-second window) or `QUOTA_LIMITED` (monthly); the
 *   comma-separated `X-RateLimit-*` headers say which window ran out.
 * - Storage terms forbid keeping titles and snippets: retention is decisions-only.
 * The clock is injected (`now`) for the freshness range end date and for quota reset times.
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
  FoundDate,
  HttpRequest,
  HttpResponse,
  ParseOutcome,
  QuotaInfo,
  RawResult,
} from '../shared/types.ts'
import {
  bodySnippet,
  cleanText,
  cleanUrl,
  isHeaderSafeKey,
  normalizeHosts,
  parseJson,
  primaryLanguage,
  redactDetail,
  scrubQuery,
  secretsOf,
} from './common.ts'
import { engineDate } from './dates.ts'
import { classifyHttp, parseRetryAfter } from './errors.ts'

const ORIGIN = 'https://api.search.brave.com'
const PATH = '/res/v1/web/search'
const MAX_RESULTS = 20
const MAX_GOGGLE_RULES = 2000
/** Above this URL length the request goes by POST. */
const GET_URL_LIMIT = 3000
const MAX_QUERY_CHARS = 400
const MAX_QUERY_WORDS = 50
const MONTH_S = 30 * 24 * 60 * 60
const SAFESEARCH = ['off', 'moderate', 'strict'] as const
/** Languages passed as `search_lang`; unverified against a live key, so kept to common two-letter codes. */
const SEARCH_LANGS = new Set([
  'ar',
  'cs',
  'da',
  'de',
  'en',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'hu',
  'it',
  'ko',
  'nl',
  'pl',
  'ro',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
])

const capabilities: EngineCapabilities = {
  domainInclude: null,
  domainExclude: { max: MAX_GOGGLE_RULES },
  dateFilter: 'range',
  goggles: true,
  dates: 'published',
  maxPerCall: MAX_RESULTS,
  paging: true,
  requiresKey: true,
  endpoint: 'fixed',
  officialApi: true,
  billed: true,
  attribution: null,
}

const retention: EngineRetention = { log: 'decisions-only', payloadTtlHours: null }

const defaults: EngineDefaults = {
  timeoutMs: 8000,
  concurrency: 4,
  overFetch: 2,
  retry: { sameEngineRetries: 1, backoffMs: 250 },
}

const resultSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullish().catch(undefined),
  description: z.string().nullish().catch(undefined),
  page_age: z.string().nullish().catch(undefined),
  extra_snippets: z.array(z.string()).nullish().catch(undefined),
  article: z
    .looseObject({ date: z.string().nullish().catch(undefined) })
    .nullish()
    .catch(undefined),
})

const envelopeSchema = z.looseObject({
  query: z
    .looseObject({ altered: z.string().nullish().catch(undefined) })
    .nullish()
    .catch(undefined),
  web: z
    .looseObject({
      results: z.array(z.unknown()).nullish().catch(undefined),
      mutated_by_goggles: z.boolean().nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
})

const errorSchema = z.looseObject({
  error: z
    .looseObject({
      code: z.string().nullish().catch(undefined),
      detail: z.string().nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
})

function limitQuery(query: string): string {
  const words = query.trim().split(/\s+/).slice(0, MAX_QUERY_WORDS).join(' ')
  return words.length <= MAX_QUERY_CHARS ? words : words.slice(0, MAX_QUERY_CHARS).trim()
}

/** Hosts to discard upstream: valid, de-duplicated, user rules first (the caller's order), capped. */
function goggleHosts(plan: EnginePlan): string[] {
  return normalizeHosts(plan.pushdownBlockHosts, MAX_GOGGLE_RULES)
}

function listNumbers(raw: string | undefined): number[] {
  return (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^\d+(?:\.\d+)?$/.test(p))
    .map(Number)
}

/** True when the longest rate-limit window (the last of several) has no calls left. */
function monthlyExhausted(headers: Readonly<Record<string, string>>): boolean {
  const remaining = listNumbers(headers['x-ratelimit-remaining'])
  return remaining.length > 1 && remaining[remaining.length - 1] === 0
}

/** Quota from the `X-RateLimit-*` headers; the last window is the longest (monthly) one. */
function quotaFromHeaders(headers: Readonly<Record<string, string>>, now: number): QuotaInfo | undefined {
  const limit = listNumbers(headers['x-ratelimit-limit']).at(-1)
  const remaining = listNumbers(headers['x-ratelimit-remaining']).at(-1)
  const reset = listNumbers(headers['x-ratelimit-reset']).at(-1)
  const info: QuotaInfo = {}
  if (limit !== undefined) info.limit = limit
  if (remaining !== undefined) info.remaining = remaining
  if (reset !== undefined && reset >= 0 && reset < MONTH_S * 12)
    info.resetAt = new Date(now + reset * 1000).toISOString()
  return Object.keys(info).length > 0 ? info : undefined
}

function errorClassFor(res: HttpResponse, code: string | null | undefined): ErrorClass {
  switch (code) {
    case 'RATE_LIMITED':
      return 'rate_limited'
    case 'QUOTA_LIMITED':
      return 'quota'
    case 'OPTION_NOT_IN_PLAN':
      return 'forbidden'
    case 'SUBSCRIPTION_TOKEN_INVALID':
      return 'auth'
    default:
      break
  }
  const cls = classifyHttp(res.status, res.headers, bodySnippet(res.text)) ?? 'malformed'
  return cls === 'rate_limited' && monthlyExhausted(res.headers) ? 'quota' : cls
}

/** A Brave adapter that also reports how many block rules a request pushes upstream. */
export type BraveAdapter = EngineAdapter & { pushedRuleCount(plan: EnginePlan): number }

/** Builds a Brave adapter around a clock (epoch ms). */
export function createBraveAdapter(opts: { now: () => number }): BraveAdapter {
  const { now } = opts

  return {
    id: 'brave',
    displayName: 'Brave Search',
    capabilities,
    retention,
    defaults,

    pushedRuleCount(plan: EnginePlan): number {
      return goggleHosts(plan).length
    },

    setup(ctx: AdapterCtx) {
      if (!ctx.apiKey)
        return { active: false, reason: 'missing_key', detail: 'No Brave Search API key is set.' }
      if (!isHeaderSafeKey(ctx.apiKey)) {
        return {
          active: false,
          reason: 'missing_key',
          detail: 'The Brave Search API key has invalid characters.',
        }
      }
      return { active: true }
    },

    buildRequest(plan: EnginePlan, ctx: AdapterCtx): HttpRequest {
      const fields: Array<[string, string]> = [
        ['q', limitQuery(plan.query)],
        ['count', String(Math.min(Math.max(Math.trunc(plan.count), 1), MAX_RESULTS))],
        ['text_decorations', 'false'],
        ['safesearch', SAFESEARCH[plan.safesearch]],
      ]
      const lang = primaryLanguage(plan.language)
      if (lang !== null && SEARCH_LANGS.has(lang)) fields.push(['search_lang', lang])
      if (plan.sinceDate !== undefined) {
        const today = new Date(now()).toISOString().slice(0, 10)
        if (/^\d{4}-\d{2}-\d{2}$/.test(plan.sinceDate) && plan.sinceDate <= today) {
          fields.push(['freshness', `${plan.sinceDate}to${today}`])
        }
      }
      const hosts = goggleHosts(plan)
      if (hosts.length > 0) fields.push(['goggles', hosts.map((h) => `$discard,site=${h}`).join('\n')])

      const base = (ctx.endpoint ?? ORIGIN).replace(/\/+$/, '')
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Subscription-Token': ctx.apiKey ?? '',
      }
      const url = `${base}${PATH}?${new URLSearchParams(fields).toString()}`
      if (url.length <= GET_URL_LIMIT) return { method: 'GET', url, headers }

      const body: Record<string, string | number | boolean> = {}
      for (const [k, v] of fields) body[k] = k === 'count' ? Number(v) : k === 'text_decorations' ? false : v
      return {
        method: 'POST',
        url: `${base}${PATH}`,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    },

    parseResponse(res: HttpResponse, plan: EnginePlan, ctx: AdapterCtx): ParseOutcome {
      const clock = now()
      const secrets = secretsOf(ctx)

      if (res.status < 200 || res.status >= 300) {
        const parsed = parseJson(res.text)
        const body = parsed.ok ? errorSchema.safeParse(parsed.value) : null
        const err = body?.success ? body.data.error : undefined
        const errorClass = errorClassFor(res, err?.code)
        const why = scrubQuery(
          cleanText(err?.detail ?? err?.code ?? bodySnippet(res.text, 120), 120),
          plan.query,
        )
        const detail = redactDetail(`Brave HTTP ${res.status}: ${why}`, secrets)
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
        return { kind: 'error', errorClass: 'malformed', detail: 'Brave HTTP 200: the response is not JSON' }
      const envelope = envelopeSchema.safeParse(json.value)
      if (!envelope.success) {
        return { kind: 'error', errorClass: 'malformed', detail: 'Brave HTTP 200: unexpected response shape' }
      }

      const quota = quotaFromHeaders(res.headers, clock)
      const entries = envelope.data.web?.results ?? []
      const results: RawResult[] = []
      for (const entry of entries) {
        if (results.length >= Math.max(plan.count, 0)) break
        const item = resultSchema.safeParse(entry)
        if (!item.success) continue
        const url = cleanUrl(item.data.url)
        if (url === null) continue
        const dates: FoundDate[] = []
        const articleDate = engineDate(item.data.article?.date, 'engine:brave.article.date', clock)
        if (articleDate) dates.push(articleDate)
        const pageAge = engineDate(item.data.page_age, 'engine:brave.page_age', clock)
        if (pageAge) dates.push(pageAge)
        const title = cleanText(item.data.title, 300)
        const snippet = cleanText(item.data.description || item.data.extra_snippets?.[0], 1000)
        results.push({
          engine: 'brave',
          rank: results.length + 1,
          url,
          title: title === '' ? url : title,
          snippet,
          dates,
        })
      }

      if (results.length === 0) return quota ? { kind: 'empty', quota } : { kind: 'empty' }

      const out: Extract<ParseOutcome, { kind: 'ok' }> = { kind: 'ok', results }
      if (quota) out.quota = quota
      const altered = cleanText(envelope.data.query?.altered, 400)
      if (altered !== '' && altered.toLowerCase() !== plan.query.trim().toLowerCase())
        out.alteredQuery = altered
      const mutated = envelope.data.web?.mutated_by_goggles
      if (goggleHosts(plan).length > 0 && typeof mutated === 'boolean') out.pushdownApplied = mutated
      return out
    },
  }
}

/** The default Brave adapter (wall clock). */
export const braveAdapter: BraveAdapter = createBraveAdapter({ now: () => Date.now() })
