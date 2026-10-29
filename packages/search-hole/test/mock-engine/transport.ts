// SPDX-License-Identifier: Apache-2.0
/**
 * A tiny test-only transport over global fetch (redirect: 'manual'). It exists so the
 * fan-out can be tested against the mock engine server; the production transport (undici,
 * origin-pinned, SSRF-aware) is a different module.
 */

import type { Transport } from '../../src/core/fanout.ts'

/** The most useful error code: undici puts the system code on `error.cause`. */
function networkCode(e: unknown): string {
  if (typeof e === 'object' && e !== null) {
    const cause = (e as { cause?: unknown }).cause
    if (typeof cause === 'object' && cause !== null) {
      const code = (cause as { code?: unknown }).code
      if (typeof code === 'string') return code
    }
    const name = (e as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return 'unreachable'
}

/** fetch-backed transport: never throws, never follows redirects. */
export const fetchTransport: Transport = async (req, signal) => {
  const started = performance.now()
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { ...req.headers },
      redirect: 'manual',
      signal,
      ...(req.body === undefined ? {} : { body: req.body }),
    })
    const text = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    return { status: res.status, headers, text, durationMs: Math.round(performance.now() - started) }
  } catch (e) {
    return { networkError: networkCode(e) }
  }
}
