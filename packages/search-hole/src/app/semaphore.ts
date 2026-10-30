// SPDX-License-Identifier: Apache-2.0
/** A tiny counting semaphore: per-engine in-flight limits for one process (ADR-0009). */

/** Limits how many calls run at once; extra callers wait in FIFO order. */
export class Semaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly max: number) {}

  /** Calls in flight right now. */
  get inFlight(): number {
    return this.active
  }

  /** Runs `fn` once a slot is free. A caller whose signal aborts while waiting gives up its place. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= Math.max(1, this.max)) {
      await new Promise<void>((resolve, reject) => {
        const go = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          const i = this.waiting.indexOf(go)
          if (i >= 0) this.waiting.splice(i, 1)
          reject(signal?.reason ?? new Error('aborted'))
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        this.waiting.push(go)
      })
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
