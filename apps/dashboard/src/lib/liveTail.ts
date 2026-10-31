// SPDX-License-Identifier: Apache-2.0
/**
 * The live tail of the search log (ADR-0004 points 5 and 6).
 *
 * - Reads `GET /api/stream?after=<cursor>` with `fetch()` and the bearer token.
 * - On a dropped or failed stream it reconnects with backoff (1 s, 2 s), resuming from the last
 *   search id it saw.
 * - After 3 failures in a row it falls back to polling `GET /api/searches?after=<cursor>` every
 *   2 s, and tries the stream again every 30 s.
 * - A `reset` event stops the tail and asks the owner to refetch the first page; the owner
 *   starts a new tail from the new page's `maxId`.
 *
 * Entries are delivered in small batches (every 200 ms at most) so a busy log re-renders a few
 * times a second, not once per search.
 */
import { ApiFailure } from './api.ts'
import type { LogEntry, SearchPage } from './contract.ts'
import { type SseMessage, SseParser } from './sse.ts'
import { toStreamEvent } from './streamEvents.ts'

export type TailStatus = 'connecting' | 'live' | 'reconnecting' | 'polling'

export interface LiveTailOptions {
  /** Resume after this search id (the first page's `maxId`). */
  after: number
  openStream(after: number, signal: AbortSignal): Promise<Response>
  poll(after: number, limit: number, signal: AbortSignal): Promise<SearchPage>
  onEntries(entries: LogEntry[]): void
  onReset(): void
  onStatus(status: TailStatus): void
  onUnauthorized(): void
}

const MAX_STREAM_FAILURES = 3
const POLL_EVERY_MS = 2000
const POLL_LIMIT = 200
const RETRY_STREAM_AFTER_MS = 30_000
const BATCH_MS = 200

type StreamOutcome = 'stop' | 'failed' | 'dropped'

export function backoffMs(failures: number): number {
  const base = Math.min(8000, 1000 * 2 ** Math.max(0, failures - 1))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const done = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', done)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export class LiveTail {
  readonly #opts: LiveTailOptions
  readonly #ctrl = new AbortController()
  #cursor: number
  #status: TailStatus | null = null
  #queue: LogEntry[] = []
  #batchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: LiveTailOptions) {
    this.#opts = opts
    this.#cursor = opts.after
  }

  start(): void {
    void this.#run()
  }

  stop(): void {
    this.#ctrl.abort()
    if (this.#batchTimer !== null) clearTimeout(this.#batchTimer)
    this.#batchTimer = null
    this.#queue = []
  }

  get #stopped(): boolean {
    return this.#ctrl.signal.aborted
  }

  #setStatus(status: TailStatus): void {
    if (this.#stopped || status === this.#status) return
    this.#status = status
    this.#opts.onStatus(status)
  }

  #enqueue(entries: readonly LogEntry[]): void {
    this.#queue.push(...entries)
    if (this.#batchTimer !== null) return
    this.#batchTimer = setTimeout(() => {
      this.#batchTimer = null
      const batch = this.#queue
      this.#queue = []
      if (!this.#stopped && batch.length > 0) this.#opts.onEntries(batch)
    }, BATCH_MS)
  }

  async #run(): Promise<void> {
    const signal = this.#ctrl.signal
    let failures = 0
    while (!this.#stopped) {
      if (failures >= MAX_STREAM_FAILURES) {
        if (!(await this.#pollFor(RETRY_STREAM_AFTER_MS))) return
        // One more stream attempt; failing it goes straight back to polling.
        failures = MAX_STREAM_FAILURES - 1
      }
      this.#setStatus(failures === 0 ? 'connecting' : 'reconnecting')
      const outcome = await this.#streamOnce()
      if (outcome === 'stop' || this.#stopped) return
      // A stream that delivered data and then closed counts as the first failure, not the next.
      failures = outcome === 'dropped' ? 1 : failures + 1
      if (failures < MAX_STREAM_FAILURES) {
        this.#setStatus('reconnecting')
        if (!(await sleep(backoffMs(failures), signal))) return
      }
    }
  }

  async #streamOnce(): Promise<StreamOutcome> {
    const signal = this.#ctrl.signal
    let res: Response
    try {
      res = await this.#opts.openStream(this.#cursor, signal)
    } catch {
      return this.#stopped ? 'stop' : 'failed'
    }
    if (res.status === 401) {
      void res.body?.cancel().catch(() => {})
      this.#opts.onUnauthorized()
      return 'stop'
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {})
      return 'failed'
    }
    this.#setStatus('live')

    // Written from the parser callbacks, so kept in an object rather than narrowed locals.
    const seen: { delivered: boolean; verdict: StreamOutcome | null } = { delivered: false, verdict: null }
    const parser = new SseParser({
      onComment: () => {
        seen.delivered = true
      },
      onMessage: (message) => {
        seen.delivered = true
        seen.verdict ??= this.#handle(message)
      },
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (seen.verdict === null) {
        const { value, done } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      if (this.#stopped) return 'stop'
    } finally {
      reader.cancel().catch(() => {})
    }
    if (seen.verdict !== null) return seen.verdict
    return seen.delivered ? 'dropped' : 'failed'
  }

  #handle(message: SseMessage): StreamOutcome | null {
    const event = toStreamEvent(message)
    if (!event) return null
    switch (event.event) {
      case 'search':
        if (event.id > this.#cursor) this.#cursor = event.id
        this.#enqueue([event.data])
        return null
      case 'reset':
        this.#queue = []
        this.#opts.onReset()
        return 'stop'
      case 'stream-error':
        return 'failed'
    }
  }

  /** Poll for `ms`, then return true to try the stream again; false means stop. */
  async #pollFor(ms: number): Promise<boolean> {
    const signal = this.#ctrl.signal
    this.#setStatus('polling')
    const until = Date.now() + ms
    while (!this.#stopped) {
      try {
        this.#absorb(await this.#opts.poll(this.#cursor, POLL_LIMIT, signal))
      } catch (err) {
        if (this.#stopped) return false
        if (err instanceof ApiFailure && err.status === 401) {
          this.#opts.onUnauthorized()
          return false
        }
        // Otherwise keep polling: the next round may work.
      }
      if (Date.now() >= until) return true
      if (!(await sleep(POLL_EVERY_MS, signal))) return false
    }
    return false
  }

  #absorb(page: SearchPage): void {
    let top = this.#cursor
    for (const item of page.items) if (item.searchId > top) top = item.searchId
    // A full page may have more behind it: only jump to `maxId` once a page comes back short.
    if (page.items.length < POLL_LIMIT) top = Math.max(top, page.maxId)
    this.#cursor = top
    if (page.items.length > 0) this.#enqueue(page.items)
  }
}
