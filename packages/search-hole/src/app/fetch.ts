// SPDX-License-Identifier: Apache-2.0
/**
 * The `fetch` pipeline (ADR-0011, ADR-0012, §12.4): the user's rules first, then the safe
 * page fetcher with the same rules wired into every redirect hop and the canonical link.
 * Refusals are returned (never thrown) and every attempt is recorded for the receipt.
 */
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { judgeFreshness } from '../core/freshness.ts'
import { canonicalKey, hostOf, normalizeOriginal, registrableDomain } from '../core/url.ts'
import { fetchFailureReason } from '../fetch/errors.ts'
import { createPageFetcher, type PageFetcher, type PageFetchResult } from '../fetch/fetchPage.ts'
import { isSearchHoleError, SearchHoleError } from '../shared/errors.ts'
import type { RuleRef } from '../shared/types.ts'
import { type FetchWrite, type Store, urlHash } from '../store/index.ts'
import { blockedMessage } from './builtin.ts'
import type { AppContext } from './context.ts'
import type { Receipts } from './receipts.ts'
import type { RulesService } from './rules.ts'
import type { FetchArgs, FetchOutcome, RequestCtx } from './types.ts'

const fetchArgsSchema = z.object({
  url: z.string().trim().min(1, 'url is empty').max(4096, 'url is too long'),
  cursor: z.string().max(512).optional(),
  maxTokens: z.number().int().min(100).max(8000).optional(),
  receiptId: z.string().max(100).optional(),
})

type Refusal = Extract<FetchOutcome, { kind: 'refused' }>['reason']

/** Maps a fetcher failure code onto the facade's refusal reasons. */
function refusalOf(err: unknown): Refusal {
  switch (fetchFailureReason(err)) {
    case 'rule':
    case 'canonical_rule':
      return 'rule'
    case 'ssrf':
    case 'port':
      return 'ssrf'
    case 'robots':
    case 'robots_unavailable':
      return 'robots'
    case 'invalid_url':
    case 'scheme':
    case 'credentials':
    case 'invalid_cursor':
      return 'unsupported'
    default:
      return 'error'
  }
}

export interface FetchDeps {
  ctx: AppContext
  rules: RulesService
  receipts: Receipts
  fetcher: () => PageFetcher
}

/** A lazily created page fetcher (seam config in tests). */
export function lazyFetcher(ctx: AppContext): { get: () => PageFetcher; close: () => Promise<void> } {
  let f: PageFetcher | null = null
  return {
    get: () => {
      f ??= createPageFetcher(ctx.seams.pageFetcher ?? {})
      return f
    },
    close: async () => {
      const cur = f
      f = null
      if (cur) await cur.close().catch(() => undefined)
    },
  }
}

function hashOf(url: string): string {
  const n = normalizeOriginal(url) ?? url
  return urlHash(canonicalKey(n) ?? n)
}

/** Fetches one page under the user's rules. */
export async function runFetch(d: FetchDeps, input: FetchArgs, rctx: RequestCtx): Promise<FetchOutcome> {
  const parsed = fetchArgsSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new SearchHoleError('invalid_argument', `Invalid fetch arguments: ${issue?.message ?? 'invalid'}.`)
  }
  const args = parsed.data
  const started = performance.now()
  const { ctx, rules, receipts } = d
  const store = await ctx.store.write()
  const now = ctx.now()
  const rc = rules.context(rctx, store)
  const { name: profile, profile: profileBody } = rules.resolveProfile(
    rc,
    '',
    undefined,
    ctx.settings.settings.profiles_default,
  )
  const { receiptId } = receipts.assign(rctx, args.receiptId, store)
  const base: Pick<FetchWrite, 'receiptId' | 'sessionId' | 'toolUseId'> = {
    receiptId,
    ...(rctx.session ? { sessionId: rctx.session.key } : {}),
    ...(rctx.toolUseId === undefined ? {} : { toolUseId: rctx.toolUseId }),
  }
  const refuse = (reason: Refusal, message: string, rule?: RuleRef, code?: string): FetchOutcome => {
    const host = hostOf(args.url)
    record(ctx, store, {
      ...base,
      urlHash: hashOf(args.url),
      url: args.url,
      ...(host === null ? {} : { host, registrableDomain: registrableDomain(host) }),
      decision: 'refused',
      reason: code ?? reason,
      ...(rule ? { ruleId: rule.ruleId } : {}),
      latencyMs: performance.now() - started,
    })
    const out: FetchOutcome = { kind: 'refused', receiptId, reason, message }
    if (rule) out.rule = rule
    return out
  }

  // The rules first: a blocked URL never leaves the machine.
  const normalized = normalizeOriginal(args.url)
  if (normalized !== null) {
    const first = rc.ruleSet.decide(normalized, { profile, now })
    if (first.visibility === 'hidden') {
      return refuse('rule', blockedMessage(normalized, first, profile), first.visibilityRule)
    }
  }

  let page: PageFetchResult
  try {
    page = await d.fetcher().fetchPage(args.url, {
      isBlocked: (u) => {
        const n = normalizeOriginal(u)
        if (n === null) return null
        const dec = rc.ruleSet.decide(n, { profile, now: ctx.now() })
        if (dec.visibility === 'kept') return null
        return {
          reason: dec.hiddenReason ?? 'rule',
          ...(dec.visibilityRule ? { rule: dec.visibilityRule } : {}),
        }
      },
      ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(rctx.signal ? { signal: rctx.signal } : {}),
      now: ctx.now,
    })
  } catch (e) {
    const reason = refusalOf(e)
    const message = isSearchHoleError(e) ? e.toUserText() : 'The page could not be fetched.'
    const rule = isSearchHoleError(e) ? ruleOf(e.details?.rule) : undefined
    return refuse(reason, message, rule, fetchFailureReason(e) ?? undefined)
  }

  const finalHost = hostOf(page.finalUrl)
  const finalHash = hashOf(page.finalUrl)
  receipts.rememberUrl(finalHash, page.finalUrl)
  receipts.rememberUrl(hashOf(args.url), args.url)
  const verdict = judgeFreshness(page.dates, profileBody.freshness ?? {}, now)
  record(ctx, store, {
    ...base,
    urlHash: hashOf(args.url),
    finalUrlHash: finalHash,
    url: args.url,
    ...(page.finalUrl === args.url ? {} : { finalUrl: page.finalUrl }),
    ...(finalHost === null ? {} : { host: finalHost, registrableDomain: registrableDomain(finalHost) }),
    status: page.status,
    contentType: page.contentType,
    bytes: page.bytes,
    ...(page.sourceTitle === null ? {} : { title: page.sourceTitle }),
    decision: 'opened',
    dates: page.dates,
    ...(verdict.effective ? { effectiveDate: verdict.effective } : {}),
    latencyMs: performance.now() - started,
  })
  receipts.noteSource(receiptId, {
    url: page.finalUrl,
    ...(page.sourceTitle === null ? {} : { title: page.sourceTitle }),
    status: page.status,
    dates: page.dates,
    sourceType: rules.sourceTypeOf(rc, profile, now)(page.finalUrl),
    freshness: verdict.status,
  })
  return { kind: 'page', receiptId, ...page }
}

/** A RuleRef carried in error details, validated. */
function ruleOf(value: unknown): RuleRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.ruleId !== 'string' || typeof v.tier !== 'string' || typeof v.text !== 'string')
    return undefined
  const tiers = ['T0s', 'T0g', 'T1', 'T2', 'T3', 'T4'] as const
  const tier = tiers.find((t) => t === v.tier)
  if (tier === undefined) return undefined
  const ref: RuleRef = { ruleId: v.ruleId, tier, text: v.text }
  if (typeof v.listId === 'string') ref.listId = v.listId
  if (typeof v.source === 'string') ref.source = v.source
  return ref
}

function record(ctx: AppContext, store: Store | null, w: FetchWrite): void {
  if (!store) return
  try {
    store.fetches.record(w)
  } catch (e) {
    ctx.logger.warn({ err: e }, 'could not log the fetch')
  }
}
