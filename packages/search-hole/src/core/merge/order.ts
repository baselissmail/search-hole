// SPDX-License-Identifier: Apache-2.0
/** Output order and the deep coverage guarantee (ADR-0010 §5, §7). */
import type { EngineId, ResultFlag } from '../../shared/types.ts'
import { type Draft, orderFlags } from './group.ts'
import { scoreKey } from './score.ts'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * ADR-0010 §5: pins first in pin order, then adjusted score descending, then the
 * deterministic tie-break: best raw rank ascending, engine order, canonical key.
 * Pins sharing one pin order are ordered by the same score and tie-break.
 */
export function compareDrafts(a: Draft, b: Draft): number {
  const pa = a.result.decision.pin
  const pb = b.result.decision.pin
  if (pa && !pb) return -1
  if (!pa && pb) return 1
  if (pa && pb && pa.order !== pb.order) return pa.order - pb.order
  return (
    scoreKey(b.result.adjusted) - scoreKey(a.result.adjusted) ||
    a.bestRank - b.bestRank ||
    a.bestEngineIdx - b.bestEngineIdx ||
    cmp(a.result.canonicalKey, b.result.canonicalKey)
  )
}

/** Adds flags, keeping `FLAG_ORDER`. */
export function withFlags(d: Draft, ...flags: ResultFlag[]): Draft {
  const result = { ...d.result, flags: orderFlags(new Set([...d.result.flags, ...flags])) }
  return { ...d, result }
}

/** The top N and what fell below it, after the coverage swaps. */
export interface Placed {
  top: Draft[]
  rest: Draft[]
  /** True when some engine couldn't be covered because no slot was eligible. */
  skipped: boolean
}

/**
 * ADR-0010 §7 deep coverage guarantee. For each responding engine (in plan order) with no
 * result in the top N, its best-ordered kept result below N is swapped into the lowest slot
 * holding neither a pin nor an earlier coverage result. A slot whose result is the only
 * one in the top N from some other engine is not eligible either, since swapping it out
 * would break that engine's guarantee. No eligible slot → skipped (`coverage_skipped`).
 * An engine with no kept result at all has nothing to swap in and is passed over.
 */
export function placeWithCoverage(
  ordered: readonly Draft[],
  limit: number,
  responded: readonly EngineId[],
): Placed {
  const top = ordered.slice(0, limit)
  let rest = ordered.slice(limit)
  let skipped = false
  const coverage = new Set<number>()
  if (top.length === 0) return { top, rest, skipped }
  for (const engine of responded) {
    if (top.some((d) => d.result.engines.includes(engine))) continue
    const incomingIdx = rest.findIndex((d) => d.result.engines.includes(engine))
    const incoming = rest[incomingIdx]
    if (!incoming) continue
    const carriers = (e: EngineId): number => top.filter((d) => d.result.engines.includes(e)).length
    let slot = -1
    for (let i = top.length - 1; i >= 0; i--) {
      const d = top[i]
      if (!d || d.result.decision.pin || coverage.has(i)) continue
      const soleCarrier = d.result.engines.some(
        (e) => carriers(e) === 1 && !incoming.result.engines.includes(e),
      )
      if (soleCarrier) continue
      slot = i
      break
    }
    const outgoing = top[slot]
    if (!outgoing) {
      skipped = true
      continue
    }
    const swapped = withFlags(incoming, 'coverage')
    top[slot] = { ...swapped, result: { ...swapped.result, keptReason: 'coverage' } }
    coverage.add(slot)
    rest = [...rest.slice(0, incomingIdx), ...rest.slice(incomingIdx + 1), outgoing]
    rest.sort(compareDrafts)
  }
  return { top, rest, skipped }
}
