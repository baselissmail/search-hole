// SPDX-License-Identifier: Apache-2.0
/** The P1 adapter registry: SearXNG, Brave and Tavily (ADR-0017). Exa, Mojeek, Kagi and Marginalia follow in P1.x. */

import type { EngineAdapter, EngineId } from '../shared/types.ts'
import { type BraveAdapter, braveAdapter, createBraveAdapter } from './brave.ts'
import { createSearxngAdapter, searxngAdapter } from './searxng.ts'
import { createTavilyAdapter, type TavilyAdapter, tavilyAdapter } from './tavily.ts'

export { type BraveAdapter, braveAdapter, createBraveAdapter } from './brave.ts'
export { engineDate, parseEngineDate } from './dates.ts'
export { classifyHttp, classifyNetworkError, parseRetryAfter, requestNeverLeft } from './errors.ts'
export { classifyUpstreamMessage, createSearxngAdapter, searxngAdapter } from './searxng.ts'
export { createTavilyAdapter, type TavilyAdapter, tavilyAdapter } from './tavily.ts'

/** The default adapters keyed by engine id (wall clock). */
export const p1Adapters: Readonly<Record<'searxng' | 'brave' | 'tavily', EngineAdapter>> = {
  searxng: searxngAdapter,
  brave: braveAdapter,
  tavily: tavilyAdapter,
}

/** Builds the P1 adapters around an injected clock (for tests and replay). */
export function createP1Adapters(opts: { now: () => number }): {
  searxng: EngineAdapter
  brave: BraveAdapter
  tavily: TavilyAdapter
} {
  return {
    searxng: createSearxngAdapter(opts),
    brave: createBraveAdapter(opts),
    tavily: createTavilyAdapter(opts),
  }
}

/** Looks up a shipped adapter by id; undefined for engines not yet implemented. */
export function getAdapter(id: EngineId): EngineAdapter | undefined {
  return id === 'searxng' || id === 'brave' || id === 'tavily' ? p1Adapters[id] : undefined
}
