// SPDX-License-Identifier: Apache-2.0
/**
 * `fetch` continuation cursor (ADR-0012): base64url of
 * `{ v, offset, contentHash }`. `offset` indexes the extracted text (UTF-16
 * code units); `contentHash` is a short SHA-256 of that text, so a cursor
 * applied to a changed page is detected and reported as stale.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export interface CursorState {
  offset: number
  contentHash: string
}

const CursorSchema = z.object({
  v: z.literal(1),
  offset: z.number().int().nonnegative().max(1e9),
  contentHash: z.string().regex(/^[0-9a-f]{16}$/),
})

/** Short, stable content hash of extracted text. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Encodes a cursor for `nextCursor`. */
export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify({ v: 1, ...state }), 'utf8').toString('base64url')
}

/** Decodes a cursor; returns null when it is malformed (the caller reports invalid_argument). */
export function decodeCursor(cursor: string): CursorState | null {
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return parsed.success ? { offset: parsed.data.offset, contentHash: parsed.data.contentHash } : null
  } catch {
    return null
  }
}
