// SPDX-License-Identifier: Apache-2.0
/**
 * What the card shows (ADR-0021 point 6), computed from the panel data. Pure, so it is tested in
 * Node. The data arrives from the receipt result: `_meta["search-hole/panel"]` on hosts that
 * render apps, or `structuredContent.receipts` as a fallback (no actions then).
 */
import type { PanelData } from '../../../packages/search-hole/src/gateway/panel.ts'

export type { PanelData }
export type PanelReceipt = PanelData['receipts'][number]
export type PanelSource = PanelReceipt['sources'][number]

export interface CardModel {
  searches: number
  builtin: number
  kept: number
  hidden: number
  /** The most common hidden reason, if any. */
  topHiddenReason?: string
  opened: number
  official: number
  stale: number
  sources: PanelSource[]
}

const META_KEY = 'search-hole/panel'
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The panel data from a tool result, or null when it carries none. Never throws. */
export function readPanelData(result: unknown): PanelData | null {
  if (!isRecord(result)) return null
  const meta = isRecord(result._meta) ? result._meta[META_KEY] : undefined
  if (isRecord(meta) && Array.isArray(meta.receipts)) {
    return {
      receipts: meta.receipts as PanelData['receipts'],
      blockable: Array.isArray(meta.blockable) ? (meta.blockable as PanelData['blockable']) : [],
      suggestions: Array.isArray(meta.suggestions) ? (meta.suggestions as PanelData['suggestions']) : [],
      ...(typeof meta.dashboardUrl === 'string' ? { dashboardUrl: meta.dashboardUrl } : {}),
      host: (typeof meta.host === 'string' ? meta.host : 'generic') as PanelData['host'],
    }
  }
  const structured = result.structuredContent
  if (isRecord(structured) && Array.isArray(structured.receipts)) {
    return {
      receipts: structured.receipts as PanelData['receipts'],
      blockable: [],
      suggestions: [],
      host: 'generic',
    }
  }
  return null
}

export function cardModel(data: PanelData): CardModel {
  const searches = data.receipts.flatMap((r) => r.searches)
  const sources = data.receipts.flatMap((r) => r.sources)
  const reasons = new Map<string, number>()
  for (const s of searches) {
    for (const [reason, n] of Object.entries(s.hiddenByReason))
      reasons.set(reason, (reasons.get(reason) ?? 0) + (n ?? 0))
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    searches: searches.length,
    builtin: searches.filter((s) => s.mode === 'builtin').length,
    kept: searches.reduce((n, s) => n + s.kept, 0),
    hidden: searches.reduce((n, s) => n + s.hidden, 0),
    ...(top === undefined || top[1] === 0 ? {} : { topHiddenReason: top[0] }),
    opened: sources.length,
    official: sources.filter((s) => s.sourceType === 'official' || s.sourceType === 'docs').length,
    stale: sources.filter((s) => s.freshness === 'stale').length,
    sources,
  }
}

/** The registrable site of a URL as the gateway computed it, matched by host suffix. */
export function siteOf(url: string, blockable: PanelData['blockable']): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return blockable.find((b) => host === b.site || host.endsWith(`.${b.site}`))?.site
}

/** The command a user types instead of a panel button, on this host. */
export function fallbackCommand(host: PanelData['host'], verb: 'block' | 'approve', value: string): string {
  return host === 'claude-code' ? `/search-hole:${verb} ${value}` : `searchhole ${verb} ${value}`
}

const REASONS: Readonly<Record<string, string>> = {
  rule: 'your rules',
  list: 'a list',
  stale: 'too old',
  date_required: 'no date',
  allowlist_mode: 'not on the allowlist',
}
export const reasonLabel = (reason: string): string => REASONS[reason] ?? reason

/** Only http(s) URLs become links; anything else stays text. */
export function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}
