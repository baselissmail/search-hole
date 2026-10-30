// SPDX-License-Identifier: Apache-2.0
/**
 * Model-proposed rules (Principle 3, ADR-0012 `suggest_rule`): validated, deduplicated on
 * (match, action, scope) and queued. Nothing here applies a rule; only `approve`, which is
 * reachable from the user's CLI and slash commands, does.
 */
import { z } from 'zod'
import { isWeighted, ruleIdBase } from '../core/rules/index.ts'
import { SearchHoleError } from '../shared/errors.ts'
import type { Store } from '../store/index.ts'
import type { AppContext } from './context.ts'
import { FALLBACK_SESSION_REFUSAL, type RulesService } from './rules.ts'
import type { RequestCtx, RuleListing, SuggestRuleInput, SuggestRuleResult } from './types.ts'

const suggestionSchema = z.object({
  match: z.string().trim().min(1, 'match is empty').max(500, 'match is too long'),
  action: z.enum(['block', 'allow', 'pin', 'raise', 'lower', 'normal']),
  weight: z.number().int().min(1).max(10).optional(),
  scope: z.enum(['global', 'session']).optional(),
  profile: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'profile must be a profile name')
    .optional(),
  reason: z.string().trim().min(1, 'reason is empty').max(280, 'reason is longer than 280 characters'),
  evidenceUrl: z.string().url().max(2048).optional(),
})

/** Rebuilds a SuggestRuleInput from parsed data without undefined-valued keys. */
function toInput(d: z.infer<typeof suggestionSchema>): SuggestRuleInput {
  const out: SuggestRuleInput = { match: d.match, action: d.action, reason: d.reason }
  if (d.weight !== undefined) out.weight = d.weight
  if (d.scope !== undefined) out.scope = d.scope
  if (d.profile !== undefined) out.profile = d.profile
  if (d.evidenceUrl !== undefined) out.evidenceUrl = d.evidenceUrl
  return out
}

export interface SuggestionDeps {
  ctx: AppContext
  rules: RulesService
}

/** Text for the user (never a command for the model to run). */
export function howToApprove(host: AppContext['host'], id: number): string {
  if (host === 'claude-code') {
    return `Tell the user: suggestion #${id} is queued; they can apply it with the slash command /search-hole:approve ${id}. Do not run any command yourself.`
  }
  return `Tell the user: suggestion #${id} is queued; they can review and apply it with search-hole's approve command (CLI or dashboard). Do not run any command yourself.`
}

const rejected = (message: string): SuggestRuleResult => ({
  suggestionId: 0,
  status: 'rejected',
  howToApprove: 'Nothing to approve.',
  message,
})

/** Queues a suggestion. Never throws for bad input: it is rejected with a message. */
export async function suggestRule(
  d: SuggestionDeps,
  input: SuggestRuleInput,
  rctx: RequestCtx,
): Promise<SuggestRuleResult> {
  const parsed = suggestionSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return rejected(
      `Invalid suggestion: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    )
  }
  const s = toInput(parsed.data)
  const match = d.rules.parse(s.match)
  if (match === null) return rejected(`The match "${s.match}" is not a valid rule expression.`)
  const scope = s.scope ?? 'global'
  if (scope === 'session' && (!rctx.session || rctx.session.source === 'fallback')) {
    return rejected(FALLBACK_SESSION_REFUSAL)
  }
  const store = await d.ctx.store.write()
  if (!store) return rejected('search-hole cannot save suggestions right now (its database is unavailable).')
  const rc = d.rules.context(rctx, store)
  if (s.profile !== undefined && !rc.profiles.some((p) => p.name === s.profile)) {
    return rejected(`Unknown profile "${s.profile}".`)
  }
  const weight = isWeighted(s.action) ? (s.weight ?? 1) : 1
  const profiles = s.profile === undefined ? undefined : [s.profile]
  const wantedId = ruleIdBase({
    scope,
    match: match.canonical,
    action: s.action,
    weight,
    profiles,
    important: false,
  })
  if (rc.userRules.some((r) => r.id === wantedId)) {
    return {
      suggestionId: 0,
      status: 'duplicate',
      howToApprove: 'Nothing to approve: this rule is already in force.',
      message: 'An identical rule already exists.',
    }
  }
  const dedupeKey = JSON.stringify([scope, s.action, match.canonical])
  const pending = store.suggestions.findPending(dedupeKey)
  if (pending) {
    return {
      suggestionId: pending.id,
      status: 'duplicate',
      howToApprove: howToApprove(d.ctx.host, pending.id),
      message: 'The same suggestion is already waiting for the user.',
    }
  }
  const id = store.suggestions.add({
    ...(rctx.session ? { sessionId: rctx.session.key } : {}),
    rule: { ...s, weight, scope, dedupeKey },
    reason: s.reason,
  })
  if (id === undefined)
    return rejected(`search-hole cannot save suggestions right now: ${store.status().message}`)
  return { suggestionId: id, status: 'queued', howToApprove: howToApprove(d.ctx.host, id) }
}

/** Every suggestion, pending first. */
export async function listSuggestions(
  d: SuggestionDeps,
): Promise<Array<{ id: number; input: SuggestRuleInput; createdAt: string; status: string }>> {
  const store = await d.ctx.store.read()
  if (!store) return []
  const out: Array<{ id: number; input: SuggestRuleInput; createdAt: string; status: string }> = []
  for (const row of store.suggestions.list()) {
    const parsed = suggestionSchema.safeParse(row.rule)
    if (!parsed.success) continue
    out.push({
      id: row.id,
      input: toInput(parsed.data),
      createdAt: new Date(row.createdAt).toISOString(),
      status: row.status,
    })
  }
  return out
}

function pendingRow(store: Store | null, id: number) {
  if (!store) {
    throw new SearchHoleError(
      'store_unavailable',
      'Suggestions live in the search-hole database, which is unavailable.',
      {
        fix: 'Run `searchhole doctor`.',
      },
    )
  }
  const row = store.suggestions.get(id)
  if (!row)
    throw new SearchHoleError('invalid_argument', `There is no suggestion ${id}.`, {
      fix: 'List them with `searchhole suggestions`.',
    })
  if (row.status !== 'pending')
    throw new SearchHoleError('invalid_argument', `Suggestion ${id} is already ${row.status}.`)
  return row
}

/** Applies a pending suggestion as a rule (user action only). */
export async function approveSuggestion(d: SuggestionDeps, id: number): Promise<RuleListing> {
  const store = await d.ctx.store.write()
  const row = pendingRow(store, id)
  const parsed = suggestionSchema.safeParse(row.rule)
  if (!parsed.success) throw new SearchHoleError('invalid_argument', `Suggestion ${id} cannot be read.`)
  const s = toInput(parsed.data)
  const note = `suggestion ${id}: ${s.reason}`.slice(0, 200)
  const add = {
    match: s.match,
    action: s.action,
    ...(s.weight === undefined ? {} : { weight: s.weight }),
    ...(s.profile === undefined ? {} : { profile: s.profile }),
    note,
  }
  let listing: RuleListing
  if ((s.scope ?? 'global') === 'session') {
    if (row.sessionId === null)
      throw new SearchHoleError('invalid_argument', `Suggestion ${id} has no session.`)
    const match = d.rules.parse(s.match)
    if (match === null)
      throw new SearchHoleError('invalid_argument', `Suggestion ${id} has an invalid match.`)
    listing = d.rules.writeSessionRule(
      row.sessionId,
      add,
      match,
      isWeighted(s.action) ? (s.weight ?? 1) : 1,
      store,
    )
  } else {
    listing = await d.rules.add({ ...add, scope: 'global' }, undefined, async () => store)
  }
  store?.suggestions.resolve(id, 'approved')
  return listing
}

/** Rejects a pending suggestion. */
export async function rejectSuggestion(d: SuggestionDeps, id: number): Promise<void> {
  const store = await d.ctx.store.write()
  pendingRow(store, id)
  store?.suggestions.resolve(id, 'rejected')
}
