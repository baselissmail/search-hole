// SPDX-License-Identifier: Apache-2.0
/**
 * Turns raw SSE messages into the contract's `StreamEvent`s. Anything malformed is dropped
 * rather than trusted: a bad line must never break the table.
 */
import type { LogEntry, StreamEvent } from './contract.ts'
import type { SseMessage } from './sse.ts'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The fields the log table reads, checked before a row is shown. */
export function isLogEntry(value: unknown): value is LogEntry {
  if (!isObject(value)) return false
  return (
    typeof value.searchId === 'number' &&
    Number.isSafeInteger(value.searchId) &&
    value.searchId > 0 &&
    typeof value.query === 'string' &&
    typeof value.at === 'string' &&
    (value.mode === 'engines' || value.mode === 'builtin') &&
    Array.isArray(value.engines) &&
    value.engines.every((e) => typeof e === 'string') &&
    isCount(value.kept) &&
    isCount(value.hidden) &&
    isCount(value.latencyMs) &&
    (value.client === undefined || typeof value.client === 'string')
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function toStreamEvent(message: SseMessage): StreamEvent | null {
  const data = parseJson(message.data)
  switch (message.event) {
    case 'search': {
      if (!isLogEntry(data)) return null
      const id = Number(message.id)
      return { event: 'search', id: Number.isSafeInteger(id) && id > 0 ? id : data.searchId, data }
    }
    // A reset is honoured even with an unreadable payload: missing one would leave stale rows.
    case 'reset':
      return {
        event: 'reset',
        data: { reason: isObject(data) && data.reason === 'pruned' ? 'pruned' : 'epoch' },
      }
    case 'stream-error':
      return {
        event: 'stream-error',
        data: {
          message:
            isObject(data) && typeof data.message === 'string' ? data.message : 'The live stream failed.',
        },
      }
    default:
      return null
  }
}
