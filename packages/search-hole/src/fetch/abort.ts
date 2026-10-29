// SPDX-License-Identifier: Apache-2.0
/** Abort helpers shared by the page fetcher and the engine transport. */

/**
 * Rejects with `signal.reason` as soon as `signal` aborts, even while undici
 * is still connecting (it only notices an abort between phases). A result that
 * arrives after the abort is handed to `onLate` so its body can be destroyed.
 */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal, onLate: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      p.then(onLate, () => {})
      reject(signal.reason)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) onLate(v)
        else resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** First string `code` in an error's cause chain (AggregateError members included). */
export function errorCodeOf(err: unknown): string | undefined {
  let cur: unknown = err
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof AggregateError) {
      const inner = cur.errors.find((e: unknown) => e instanceof Error && 'code' in e)
      if (inner) cur = inner
    }
    const code = cur instanceof Error && 'code' in cur ? (cur as { code?: unknown }).code : undefined
    if (typeof code === 'string' && code !== 'UND_ERR_ABORTED') return code
    cur = cur instanceof Error ? cur.cause : undefined
  }
  return undefined
}
