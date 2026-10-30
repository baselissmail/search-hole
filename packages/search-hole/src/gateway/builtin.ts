// SPDX-License-Identifier: Apache-2.0
/**
 * Claude Code's built-in WebSearch, as the hooks see it (ADR-0018, spikes §6 and addendum).
 *
 * `tool_response` (a JSON string when substituted into an `mcp_tool` hook input):
 * `{ query, results: [ { tool_use_id, content: [ { title, url } ... ] } | "<summary text>" ],
 *    durationSeconds, searchCount }`: titles and URLs only, no snippets, no dates.
 *
 * `updatedToolOutput` must match that shape or Claude Code silently ignores it (hooks docs,
 * PostToolUse decision control), so the rebuild keeps every field it does not change.
 */
import { z } from 'zod'
import type { BuiltinFilterResult, BuiltinResult } from '../app/types.ts'

/** Replaces the search step's summary when results were removed only after the search. */
export const SUMMARY_WITHHELD = '(summary withheld by search-hole: it may cite sources your rules hid)'

/**
 * Most domains we inject into `blocked_domains`. The real cap is unknown (ADR-0018 "validate
 * early"); this bound keeps the request small until the spike finds it.
 */
export const MAX_BLOCKED_DOMAINS = 200

const itemSchema = z.looseObject({ title: z.string().optional(), url: z.string().min(1) })
const blockSchema = z.looseObject({ tool_use_id: z.string().optional(), content: z.array(itemSchema) })
const responseSchema = z.looseObject({
  query: z.string().optional(),
  results: z.array(z.union([z.string(), blockSchema])),
  durationSeconds: z.number().optional(),
  searchCount: z.number().optional(),
})

const inputSchema = z.looseObject({
  query: z.string().optional(),
  allowed_domains: z.array(z.string()).optional(),
  blocked_domains: z.array(z.string()).optional(),
})

export type WebSearchItem = z.output<typeof itemSchema>
export type WebSearchBlock = z.output<typeof blockSchema>
export type WebSearchResponse = z.output<typeof responseSchema>
export type WebSearchInput = z.output<typeof inputSchema>

/** Parses a JSON string (or an already-parsed value) defensively; null on any mismatch. */
export function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  const text = raw.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The WebSearch `tool_response`, or null when it does not have the recorded shape. */
export function parseWebSearchResponse(raw: unknown): WebSearchResponse | null {
  const parsed = responseSchema.safeParse(parseJsonValue(raw))
  return parsed.success ? parsed.data : null
}

/** The WebSearch `tool_input`, or null when it is not an object of the documented shape. */
export function parseWebSearchInput(raw: unknown): WebSearchInput | null {
  const parsed = inputSchema.safeParse(parseJsonValue(raw))
  return parsed.success ? parsed.data : null
}

/** Every result in display order (blocks in order, items in order). */
export function collectResults(resp: WebSearchResponse): BuiltinResult[] {
  const out: BuiltinResult[] = []
  for (const entry of resp.results) {
    if (typeof entry === 'string') continue
    for (const item of entry.content) out.push({ title: item.title ?? '', url: item.url })
  }
  return out
}

const sameOrder = (a: readonly BuiltinResult[], b: readonly BuiltinResult[]): boolean =>
  a.length === b.length && a.every((r, i) => r.url === b[i]?.url)

/**
 * Rebuilds the response with only the kept items, in the App's order (pins first). All kept
 * items go into the first result block (the order is global across blocks); other blocks are
 * dropped. A summary string is replaced only when results were removed after the search
 * (`removedPostSearch`); otherwise it is kept. Returns null when nothing changed, so the hook
 * can leave the original output alone.
 */
export function rebuildWebSearchResponse(
  resp: WebSearchResponse,
  filter: Pick<BuiltinFilterResult, 'kept' | 'hidden' | 'removedPostSearch'>,
): WebSearchResponse | null {
  const original = collectResults(resp)
  if (filter.hidden.length === 0 && !filter.removedPostSearch && sameOrder(original, filter.kept)) return null
  const byUrl = new Map<string, WebSearchItem[]>()
  for (const entry of resp.results) {
    if (typeof entry === 'string') continue
    for (const item of entry.content) {
      const queue = byUrl.get(item.url)
      if (queue === undefined) byUrl.set(item.url, [item])
      else queue.push(item)
    }
  }
  const keptItems: WebSearchItem[] = filter.kept.map(
    (k) => byUrl.get(k.url)?.shift() ?? { title: k.title, url: k.url },
  )
  const results: WebSearchResponse['results'] = []
  let placed = false
  for (const entry of resp.results) {
    if (typeof entry === 'string') {
      results.push(filter.removedPostSearch ? SUMMARY_WITHHELD : entry)
    } else if (!placed) {
      results.push({ ...entry, content: keptItems })
      placed = true
    }
  }
  return { ...resp, results }
}

const cleanDomain = (d: string): string => d.trim().toLowerCase().replace(/^\*\./, '').replace(/\.+$/, '')

/** `existing` first, then `add`, normalised, deduplicated and capped. */
export function mergeDomains(existing: readonly string[] | undefined, add: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(existing ?? []), ...add]) {
    const d = cleanDomain(raw)
    if (d === '' || seen.has(d)) continue
    seen.add(d)
    out.push(d)
    if (out.length >= MAX_BLOCKED_DOMAINS) break
  }
  return out
}

/** True when `domain` is `blocked` or a subdomain of it. */
export function coveredBy(domain: string, blocked: readonly string[]): boolean {
  const d = cleanDomain(domain)
  return blocked.some((b) => {
    const c = cleanDomain(b)
    return c !== '' && (d === c || d.endsWith(`.${c}`))
  })
}

/** The rewritten WebSearch input, or why the search should not run at all. */
export type BuiltinInputPlan =
  | { kind: 'unchanged' }
  | { kind: 'rewrite'; input: Record<string, unknown> }
  | { kind: 'all_allowed_blocked' }

/**
 * Applies user blocks to a WebSearch input. The web search tool takes `allowed_domains` *or*
 * `blocked_domains`, not both, so when the model restricted the search to some domains we
 * drop the blocked ones from that list instead (and refuse when none is left, since an empty
 * list would mean an unrestricted search). Otherwise blocks are merged into `blocked_domains`.
 */
export function planBuiltinInput(
  input: WebSearchInput,
  blocked: readonly string[],
  query: string,
): BuiltinInputPlan {
  const base: Record<string, unknown> = { ...input, query }
  const queryChanged = input.query !== query
  const allowed = input.allowed_domains ?? []
  if (allowed.length > 0) {
    const remaining = allowed.filter((d) => !coveredBy(d, blocked))
    if (remaining.length === 0) return { kind: 'all_allowed_blocked' }
    if (remaining.length === allowed.length && !queryChanged) return { kind: 'unchanged' }
    return { kind: 'rewrite', input: { ...base, allowed_domains: remaining } }
  }
  if (blocked.length === 0) return queryChanged ? { kind: 'rewrite', input: base } : { kind: 'unchanged' }
  const merged = mergeDomains(input.blocked_domains, blocked)
  const before = input.blocked_domains ?? []
  if (!queryChanged && merged.length === before.length && merged.every((d, i) => d === before[i])) {
    return { kind: 'unchanged' }
  }
  return { kind: 'rewrite', input: { ...base, blocked_domains: merged } }
}
