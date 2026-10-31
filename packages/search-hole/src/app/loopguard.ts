// SPDX-License-Identifier: Apache-2.0
/**
 * The per-session loop guard (ADR-0019, foreseen in ADR-0005): a runaway agent can burn the
 * user's engine quota or built-in search fees in minutes. Three limits, each 0 = off:
 *
 * - `searchesPerTurn`: searches in one Claude Code turn (hook-keyed sessions only: their turns
 *   are exact). Reset when the next prompt opens a turn.
 * - `searchesPerHour`: searches per session in a sliding hour. Fallback sessions are
 *   approximate (one key may cover several chats in one process), so they get twice the limit:
 *   a false stop is worse than a late one.
 * - `repeatQuery`: the same search (query, depth, profile, engines) this many times in 10
 *   minutes is refused; its results won't change.
 *
 * Our `search` and the built-in WebSearch count together, and only searches that returned
 * count (`note` after success), so engine failures never use up the budget. State is in memory,
 * per process: the gateway is the source of truth for its sessions (receipts.ts).
 */
import { SearchHoleError } from '../shared/errors.ts'
import type { RequestCtx } from './types.ts'

export interface LoopLimits {
  readonly searchesPerTurn: number
  readonly searchesPerHour: number
  readonly repeatQuery: number
}

export const REPEAT_WINDOW_MS = 10 * 60_000
const HOUR_MS = 60 * 60_000
const MAX_SESSIONS = 256

interface SessionBudget {
  turn: number
  /** Times of searches in the last hour, oldest first. */
  times: number[]
  /** Search key → times in the last `REPEAT_WINDOW_MS`. */
  repeats: Map<string, number[]>
}

/** The repeat key: same normalised query and the same options. */
export function searchKey(query: string, options: readonly (string | undefined)[] = []): string {
  const q = query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  return [q, ...options.map((o) => o ?? '')].join('\u0000')
}

export class LoopGuard {
  private readonly sessions = new Map<string, SessionBudget>()

  constructor(private readonly now: () => number) {}

  private budget(key: string): SessionBudget {
    let b = this.sessions.get(key)
    if (b === undefined) {
      b = { turn: 0, times: [], repeats: new Map() }
      while (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest === undefined) break
        this.sessions.delete(oldest)
      }
    } else this.sessions.delete(key)
    this.sessions.set(key, b)
    const now = this.now()
    while ((b.times[0] ?? now) <= now - HOUR_MS) b.times.shift()
    for (const [k, times] of b.repeats) {
      const kept = times.filter((t) => t > now - REPEAT_WINDOW_MS)
      if (kept.length === 0) b.repeats.delete(k)
      else b.repeats.set(k, kept)
    }
    return b
  }

  /** A `search_limit` error when one more search would pass a limit, else null. */
  check(rctx: RequestCtx, key: string, limits: LoopLimits): SearchHoleError | null {
    const session = rctx.session
    const b = this.budget(session?.key ?? '')
    const hook = session?.source === 'hook'
    if (hook && limits.searchesPerTurn > 0 && b.turn >= limits.searchesPerTurn) {
      return new SearchHoleError(
        'search_limit',
        `search-hole stopped this search: this turn already ran ${b.turn} searches (settings.yaml limits.searchesPerTurn).`,
        {
          fix: 'Answer with what you have, or ask the user whether to keep searching; the limit resets with their next message.',
          details: { limit: 'searchesPerTurn', value: limits.searchesPerTurn },
        },
      )
    }
    const hourly = limits.searchesPerHour * (session === undefined || session.source === 'fallback' ? 2 : 1)
    if (limits.searchesPerHour > 0 && b.times.length >= hourly) {
      return new SearchHoleError(
        'search_limit',
        `search-hole stopped this search: this session ran ${b.times.length} searches in the last hour (settings.yaml limits.searchesPerHour).`,
        {
          fix: 'Answer with what you have and tell the user; they can raise the limit or try again later.',
          details: { limit: 'searchesPerHour', value: hourly },
        },
      )
    }
    const repeats = b.repeats.get(key)?.length ?? 0
    if (limits.repeatQuery > 0 && repeats >= limits.repeatQuery - 1) {
      return new SearchHoleError(
        'search_limit',
        `search-hole stopped this search: the same search already ran ${repeats === 1 ? 'once' : `${repeats} times`} in the last 10 minutes, and its results won't change.`,
        {
          fix: 'Use the earlier results, or change the query.',
          details: { limit: 'repeatQuery', value: limits.repeatQuery },
        },
      )
    }
    return null
  }

  /** Counts a search that returned. */
  note(rctx: RequestCtx, key: string): void {
    const b = this.budget(rctx.session?.key ?? '')
    const now = this.now()
    b.turn++
    b.times.push(now)
    const times = b.repeats.get(key)
    if (times === undefined) b.repeats.set(key, [now])
    else times.push(now)
  }

  /** A new turn (UserPromptSubmit) resets the per-turn count. */
  newTurn(sessionKey: string): void {
    const b = this.sessions.get(sessionKey)
    if (b !== undefined) b.turn = 0
  }
}
