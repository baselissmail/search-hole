// SPDX-License-Identifier: Apache-2.0
/**
 * Claude Code built-in search mode (ADR-0018): which mode is in effect, the domains to
 * inject into WebSearch `blocked_domains`, filtering and reordering of WebSearch results, and
 * the WebFetch rule check and record. These run from hooks, so reads never create the
 * database; only recording a result (a real tool result) opens it for writing.
 */

import { performance } from 'node:perf_hooks'
import { redact } from '../core/hygiene.ts'
import { classifySource } from '../core/sourcetype.ts'
import { canonicalKey, hostOf, normalizeOriginal, registrableDomain } from '../core/url.ts'
import { retentionDaysFor } from '../shared/settings.ts'
import type { HiddenReason, ResultFlag, RuleDecision, RuleRef } from '../shared/types.ts'
import { type BuiltinRecordedResult, type Store, urlHash } from '../store/index.ts'
import { type AppContext, configuredMode } from './context.ts'
import type { Engines } from './engines.ts'
import type { Receipts } from './receipts.ts'
import { type RuleContext, type RulesService, safeBlockHosts } from './rules.ts'
import type { BuiltinFilterResult, BuiltinResult, RequestCtx, SearchMode } from './types.ts'

/**
 * Most domains injected into WebSearch `blocked_domains`. Anthropic does not document a
 * cap (spikes §6 "cap unknown"); 200 keeps the hook payload small and is easy to revisit.
 */
export const BUILTIN_BLOCKED_DOMAINS_CAP = 200

export interface BuiltinDeps {
  ctx: AppContext
  engines: Engines
  rules: RulesService
  receipts: Receipts
}

/**
 * ADR-0018: `auto` works as engines while one engine is healthy; `engines` does until every
 * configured engine has failed (unknown counts as usable), then falls back to filtered built-in.
 */
export async function searchMode(
  d: BuiltinDeps,
): Promise<{ configured: SearchMode; effective: 'engines' | 'builtin' }> {
  const configured = configuredMode(d.ctx)
  if (configured === 'builtin') return { configured, effective: 'builtin' }
  const store = await d.ctx.store.read()
  const resolved = await d.engines.resolveAll(store)
  for (const r of resolved) {
    if (!r.configured) continue
    const state = await d.engines.state(r, store)
    if (state === 'healthy' || (configured === 'engines' && state === 'unknown'))
      return { configured, effective: 'engines' }
  }
  return { configured, effective: 'builtin' }
}

function profileFor(d: BuiltinDeps, rc: RuleContext, query: string): string {
  return d.rules.resolveProfile(rc, query, undefined, d.ctx.settings.settings.profiles_default).name
}

/** Domain and exact-host blocks for `blocked_domains`, user tiers first, allows excluded, capped. */
export async function builtinBlockedDomains(
  d: BuiltinDeps,
  rctx: RequestCtx,
  query: string,
): Promise<string[]> {
  const store = await d.ctx.store.read()
  const rc = d.rules.context(rctx, store)
  return safeBlockHosts(rc.userRules, profileFor(d, rc, query), d.ctx.now())
    .map((b) => b.host)
    .slice(0, BUILTIN_BLOCKED_DOMAINS_CAP)
}

interface Decided {
  result: BuiltinResult
  rank: number
  url: string
  decision: RuleDecision
}

function flagsOf(decision: RuleDecision): ResultFlag[] {
  const flags: ResultFlag[] = []
  if (decision.pin) flags.push('pinned')
  const factor = decision.weight.factor * decision.preferFactor
  if (factor > 1) flags.push('raised')
  else if (factor < 1) flags.push('lowered')
  return flags
}

/**
 * Applies the rules to built-in WebSearch results: hidden results are dropped, pins move
 * first (pin order, then rank), the rest are reordered by raise/lower (rank breaks ties).
 * Logs a `builtin` search (decisions only) and adds it to the receipt.
 */
export async function filterBuiltinResults(
  d: BuiltinDeps,
  query: string,
  results: readonly BuiltinResult[],
  rctx: RequestCtx,
): Promise<BuiltinFilterResult> {
  const started = performance.now()
  const store = await d.ctx.store.write()
  const now = d.ctx.now()
  const rc = d.rules.context(rctx, store)
  const profile = profileFor(d, rc, query)
  const { receiptId } = d.receipts.assign(rctx, undefined, store)

  const items: Decided[] = results.map((result, i) => {
    const url = normalizeOriginal(result.url) ?? result.url
    return { result, rank: i + 1, url, decision: rc.ruleSet.decide(url, { profile, now }) }
  })
  const hidden = items.filter((x) => x.decision.visibility === 'hidden')
  const kept = items.filter((x) => x.decision.visibility === 'kept')
  const pinned = kept
    .filter((x) => x.decision.pin !== undefined)
    .sort((a, b) => (a.decision.pin?.order ?? 0) - (b.decision.pin?.order ?? 0) || a.rank - b.rank)
  const factor = (x: Decided): number => x.decision.weight.factor * x.decision.preferFactor
  const rest = kept
    .filter((x) => x.decision.pin === undefined)
    .sort((a, b) => factor(b) - factor(a) || a.rank - b.rank)
  const ordered = [...pinned, ...rest]

  const hiddenOut: BuiltinFilterResult['hidden'] = hidden.map((x) => {
    const reason: HiddenReason = x.decision.hiddenReason ?? 'rule'
    const out: BuiltinResult & { reason: HiddenReason; rule?: RuleRef } = { ...x.result, reason }
    if (x.decision.visibilityRule) out.rule = x.decision.visibilityRule
    return out
  })

  const queryRedacted = redact(query, { hosts: true })
  const sourceType = d.rules.sourceTypeOf(rc, profile, now)
  const outRank = new Map(ordered.map((x, i) => [x, i + 1]))
  const recorded: BuiltinRecordedResult[] = items.map((x) => {
    const pos = outRank.get(x)
    const rule = x.decision.visibilityRule ?? x.decision.pin?.rule ?? x.decision.weight.rule
    const isHidden = x.decision.visibility === 'hidden'
    return {
      url: x.url,
      ...(x.result.title ? { title: x.result.title } : {}),
      rank: x.rank,
      visibility: x.decision.visibility,
      flags: flagsOf(x.decision),
      sourceType: sourceType(x.url),
      ...(pos === undefined ? {} : { outRank: pos }),
      ...(isHidden ? { reason: x.decision.hiddenReason ?? 'rule' } : {}),
      ...(rule === undefined ? {} : { rule }),
    }
  })
  if (store) {
    try {
      store.recordBuiltinSearch({
        receiptId,
        ...(rctx.session ? { sessionId: rctx.session.key } : {}),
        queryRedacted,
        profile,
        latencyMs: performance.now() - started,
        ...(rctx.toolUseId === undefined ? {} : { toolUseId: rctx.toolUseId }),
        retentionDays: retentionDaysFor(d.ctx.settings.settings.retention, 'resultPayloads'),
        results: recorded,
      })
    } catch (e) {
      d.ctx.logger.warn({ err: e }, 'could not log the built-in search')
    }
  }
  const byReason: Partial<Record<HiddenReason, number>> = {}
  for (const h of hiddenOut) byReason[h.reason] = (byReason[h.reason] ?? 0) + 1
  d.receipts.noteSearch(receiptId, {
    query: queryRedacted,
    at: new Date(now).toISOString(),
    mode: 'builtin',
    engines: [],
    kept: ordered.length,
    hidden: hiddenOut.length,
    hiddenByReason: byReason,
  })
  return {
    receiptId,
    kept: ordered.map((x) => x.result),
    hidden: hiddenOut,
    removedPostSearch: hiddenOut.length > 0,
    pinned: pinned.length,
  }
}

/** The user-facing refusal for a blocked URL. */
export function blockedMessage(url: string, decision: RuleDecision, profile: string): string {
  const host = hostOf(url) ?? url
  if (decision.hiddenReason === 'allowlist_mode') {
    return `search-hole: ${host} is not on the allowlist of profile "${profile}".`
  }
  const rule = decision.visibilityRule?.text
  return rule === undefined
    ? `search-hole: ${host} is blocked by your rules.`
    : `search-hole: ${host} is blocked by your rule "${rule}".`
}

/** Rule check for a URL about to be opened (WebFetch or our fetch). */
export async function checkUrl(
  d: BuiltinDeps,
  url: string,
  rctx: RequestCtx,
  storeOverride?: Store | null,
): Promise<{ allowed: true } | { allowed: false; message: string; rule?: RuleRef }> {
  const store = storeOverride === undefined ? await d.ctx.store.read() : storeOverride
  const rc = d.rules.context(rctx, store)
  const profile = profileFor(d, rc, '')
  const normalized = normalizeOriginal(url)
  if (normalized === null) return { allowed: true }
  const decision = rc.ruleSet.decide(normalized, { profile, now: d.ctx.now() })
  if (decision.visibility === 'kept') return { allowed: true }
  const out: { allowed: false; message: string; rule?: RuleRef } = {
    allowed: false,
    message: blockedMessage(normalized, decision, profile),
  }
  if (decision.visibilityRule) out.rule = decision.visibilityRule
  return out
}

/** Records a page Claude Code's WebFetch opened, for the receipt. */
export async function recordBuiltinFetch(d: BuiltinDeps, url: string, rctx: RequestCtx): Promise<void> {
  const store = await d.ctx.store.write()
  const { receiptId } = d.receipts.assign(rctx, undefined, store)
  const normalized = normalizeOriginal(url) ?? url
  const hash = urlHash(canonicalKey(normalized) ?? normalized)
  const host = hostOf(normalized)
  d.receipts.rememberUrl(hash, normalized)
  if (store) {
    try {
      store.fetches.record({
        receiptId,
        ...(rctx.session ? { sessionId: rctx.session.key } : {}),
        ...(rctx.toolUseId === undefined ? {} : { toolUseId: rctx.toolUseId }),
        urlHash: hash,
        url: normalized,
        ...(host === null ? {} : { host, registrableDomain: registrableDomain(host) }),
        decision: 'opened',
        reason: 'builtin_webfetch',
      })
    } catch (e) {
      d.ctx.logger.warn({ err: e }, 'could not log the WebFetch')
    }
  }
  d.receipts.noteSource(receiptId, {
    url: normalized,
    dates: [],
    sourceType: classifySource(normalized, { typedLists: () => [] }),
    freshness: 'unknown',
  })
}
