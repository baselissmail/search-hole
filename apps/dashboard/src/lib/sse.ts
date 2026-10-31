// SPDX-License-Identifier: Apache-2.0
/**
 * A `text/event-stream` parser that follows the WHATWG HTML event-stream rules, fed with decoded
 * text in chunks of any size. The live tail reads the stream with `fetch()` (EventSource can't
 * send the Authorization header, ADR-0004 point 4), so it parses the lines itself.
 *
 * - Lines end with CRLF, LF or CR; a CRLF split across two chunks counts once.
 * - `event:`, `data:`, `id:` and `retry:` fields; other fields are ignored.
 * - Lines starting with `:` are comments (`: ping` keepalives).
 * - A blank line dispatches the event. Several `data:` lines join with `\n`.
 * - The last event id persists across events, as in EventSource.
 * - A partial event at the end of the stream is dropped, never dispatched.
 */

export interface SseMessage {
  /** The `event:` field, or `message` when there was none. */
  event: string
  data: string
  /** The last event id in effect when the event was dispatched (`''` if none yet). */
  id: string
}

export interface SseHandlers {
  onMessage(message: SseMessage): void
  onComment?(text: string): void
  onRetry?(ms: number): void
}

const LF = 10
const CR = 13
const COLON = 58

export class SseParser {
  readonly #handlers: SseHandlers
  #pending = ''
  #startOfStream = true
  /** The previous chunk ended with CR, so a leading LF in this chunk completes that CRLF. */
  #afterCR = false
  #data: string[] = []
  #event = ''
  #lastId = ''

  constructor(handlers: SseHandlers) {
    this.#handlers = handlers
  }

  get lastEventId(): string {
    return this.#lastId
  }

  push(chunk: string): void {
    if (chunk === '') return
    let text = chunk
    if (this.#startOfStream) {
      this.#startOfStream = false
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    if (this.#afterCR && text.charCodeAt(0) === LF) text = text.slice(1)
    this.#afterCR = false

    const buffer = this.#pending + text
    let lineStart = 0
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i)
      if (c !== LF && c !== CR) continue
      this.#line(buffer.slice(lineStart, i))
      if (c === CR) {
        if (i + 1 < buffer.length) {
          if (buffer.charCodeAt(i + 1) === LF) i++
        } else {
          this.#afterCR = true
        }
      }
      lineStart = i + 1
    }
    this.#pending = buffer.slice(lineStart)
  }

  #line(line: string): void {
    if (line === '') {
      this.#dispatch()
      return
    }
    if (line.charCodeAt(0) === COLON) {
      const text = line.slice(1)
      this.#handlers.onComment?.(text.startsWith(' ') ? text.slice(1) : text)
      return
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        this.#event = value
        break
      case 'data':
        this.#data.push(value)
        break
      case 'id':
        if (!value.includes('\u0000')) this.#lastId = value
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.#handlers.onRetry?.(Number(value))
        break
      default:
        break
    }
  }

  #dispatch(): void {
    if (this.#data.length === 0) {
      this.#event = ''
      return
    }
    const message: SseMessage = {
      event: this.#event || 'message',
      data: this.#data.join('\n'),
      id: this.#lastId,
    }
    this.#data = []
    this.#event = ''
    this.#handlers.onMessage(message)
  }
}
