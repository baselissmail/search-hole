// SPDX-License-Identifier: Apache-2.0
/**
 * The live log's URL state (MASTER_PLAN §8.4 point 4): the filter, the selected row and the
 * expanded row live in typed search params, so a view can be shared and restored. Unknown or
 * malformed values are dropped, never trusted.
 */

export interface LogSearch {
  /** Only searches that hid results. */
  hidden?: true | undefined
  /** The selected search (id). */
  selected?: number | undefined
  /** The selected result of the expanded search: its 1-based position in the list. */
  result?: number | undefined
  /** The expanded search (id). */
  expanded?: number | undefined
}

function positiveInt(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,15}$/.test(value)
        ? Number(value)
        : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function flag(value: unknown): true | undefined {
  return value === true || value === 1 || value === '1' || value === 'true' ? true : undefined
}

export function parseLogSearch(raw: Record<string, unknown>): LogSearch {
  const out: LogSearch = {}
  const hidden = flag(raw.hidden)
  const selected = positiveInt(raw.selected)
  const expanded = positiveInt(raw.expanded)
  // A result only means something inside the search it belongs to.
  const result = selected !== undefined && selected === expanded ? positiveInt(raw.result) : undefined
  if (hidden) out.hidden = hidden
  if (selected !== undefined) out.selected = selected
  if (expanded !== undefined) out.expanded = expanded
  if (result !== undefined) out.result = result
  return out
}
