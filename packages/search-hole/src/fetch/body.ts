// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded body reading and text decoding shared by the page fetcher and the
 * engine transport. The cap applies to DECODED bytes, so a compression bomb
 * stops at the cap too. Reading beyond the cap aborts the download.
 */
import { pipeline, type Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

export interface BodyRead {
  bytes: Buffer
  /** True when the cap was hit and the download was aborted. */
  truncated: boolean
}

export type HeaderValue = string | string[] | undefined

/** First value of a header that undici may give as a string or array. */
export function headerString(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/** Lower-cases names and joins repeated values with ", ". */
export function flattenHeaders(raw: Record<string, HeaderValue>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

const noop = (): void => {}

/**
 * Abandons a response body. undici emits an AbortError when an unfinished body
 * is destroyed, so a no-op listener goes on first.
 */
export function discardBody(body: Readable): void {
  body.on('error', noop)
  body.destroy()
}

export class UnsupportedEncodingError extends Error {
  readonly code = 'ERR_SEARCHHOLE_ENCODING'
}

function decoderFor(encoding: string | undefined): NodeJS.ReadWriteStream | null {
  const enc = (encoding ?? '').trim().toLowerCase()
  if (enc === '' || enc === 'identity') return null
  if (enc === 'gzip' || enc === 'x-gzip') return createGunzip()
  if (enc === 'br') return createBrotliDecompress()
  if (enc === 'deflate') return createInflate()
  throw new UnsupportedEncodingError(`Unsupported content-encoding: ${enc}`)
}

/**
 * Reads at most `maxBytes` decoded bytes from `body`, decompressing per
 * `contentEncoding`. Destroys the stream when the cap is reached.
 */
export async function readBody(
  body: Readable,
  contentEncoding: string | undefined,
  maxBytes: number,
): Promise<BodyRead> {
  let decoder: NodeJS.ReadWriteStream | null
  try {
    decoder = decoderFor(contentEncoding)
  } catch (err) {
    discardBody(body)
    throw err
  }
  const stream: NodeJS.ReadableStream = decoder ? pipeline(body, decoder, noop) : body
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const room = maxBytes - total
      if (buf.length >= room) {
        if (room > 0) chunks.push(buf.subarray(0, room))
        total += Math.max(room, 0)
        truncated = buf.length > room
        if (truncated) break
        continue
      }
      chunks.push(buf)
      total += buf.length
    }
  } finally {
    if (truncated || !body.readableEnded) discardBody(body)
  }
  return { bytes: Buffer.concat(chunks, total), truncated }
}

/** Parses `type/subtype; charset=x` into a lower-cased MIME type and charset. */
export function parseContentType(value: string | undefined): { mime: string; charset: string | undefined } {
  if (!value) return { mime: '', charset: undefined }
  const [type = '', ...params] = value.split(';')
  let charset: string | undefined
  for (const p of params) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p)
    if (m?.[1]) charset = m[1].toLowerCase()
  }
  return { mime: type.trim().toLowerCase(), charset }
}

/** HTML prescan for `<meta charset>` / `http-equiv` in the first 4 KiB. */
export function sniffHtmlCharset(bytes: Buffer): string | undefined {
  const head = bytes.subarray(0, 4096).toString('latin1')
  const m =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head) ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.-]+)/i.exec(head)
  return m?.[1]?.toLowerCase()
}

function bomCharset(bytes: Buffer): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  return undefined
}

/**
 * Decodes bytes to text: BOM first, then the header charset, then (for HTML)
 * the meta prescan, then UTF-8. Unknown labels fall back to UTF-8.
 */
export function decodeText(
  bytes: Buffer,
  headerCharset: string | undefined,
  html: boolean,
): { text: string; charset: string } {
  const candidates = [bomCharset(bytes), headerCharset, html ? sniffHtmlCharset(bytes) : undefined, 'utf-8']
  for (const label of candidates) {
    if (!label) continue
    try {
      const decoder = new TextDecoder(label, { fatal: false, ignoreBOM: false })
      return { text: decoder.decode(bytes), charset: decoder.encoding }
    } catch {
      // Unknown label: try the next candidate.
    }
  }
  return { text: bytes.toString('utf8'), charset: 'utf-8' }
}
