// SPDX-License-Identifier: Apache-2.0
/**
 * The ENGINE transport (ADR-0009 "What the core owns", ADR-0007 point 5).
 * Adapters stay pure; this is the only code that talks to engine endpoints.
 *
 * - Exact-origin allowlist built from config: a request (or redirect) to any
 *   other origin is refused before a socket opens. A localhost SearXNG is
 *   reachable only because its origin is configured; this transport does not
 *   use the public-web SSRF guard.
 * - Keys are bound to their origin: on any cross-origin redirect every auth
 *   header of the originating engine (plus Authorization, Cookie and
 *   Proxy-Authorization) is stripped and stays stripped. undici alone strips
 *   only Authorization.
 * - Manual redirects (max 5). 301/302 on POST and every 303 become GET
 *   without a body, as browsers do.
 * - Never throws. Network problems come back as `{ networkError, errorClass,
 *   code }` with a message built from the origin only: no path, no query, no
 *   headers, so keys cannot leak into logs.
 * - Response header names are lower-cased; `durationMs` covers the whole call.
 */
import { Agent, type Dispatcher, request } from 'undici'
import { SearchHoleError } from '../shared/errors.ts'
import type { EngineId, ErrorClass, HttpRequest, HttpResponse } from '../shared/types.ts'
import { errorCodeOf, raceAbort } from './abort.ts'
import { decodeText, discardBody, flattenHeaders, headerString, parseContentType, readBody } from './body.ts'
import { USER_AGENT } from './version.ts'

export interface EngineOriginPolicy {
  engineId: EngineId
  /** Header names that carry this engine's credentials (any case), e.g. `X-Subscription-Token`. */
  authHeaderNames: readonly string[]
}

export type TransportErrorCode =
  | 'invalid_request'
  | 'origin_not_allowed'
  | 'redirect_not_allowed'
  | 'too_many_redirects'
  | 'dns'
  | 'refused'
  | 'reset'
  | 'tls'
  | 'timeout'
  | 'cancelled'
  | 'body_too_large'
  | 'network'

export interface TransportFailure {
  /** Safe, key-free description (origin only). */
  networkError: string
  /** Hint for the health table; the pipeline may refine offline vs unreachable (ADR-0009). */
  errorClass: Extract<
    ErrorClass,
    'offline' | 'unreachable' | 'timeout' | 'cancelled' | 'forbidden' | 'malformed' | 'server'
  >
  code: TransportErrorCode
  durationMs: number
}

export type TransportResult = HttpResponse | TransportFailure

/** Key-free trace event for the event bus (no headers, no query string). */
export interface TransportTrace {
  engineId: EngineId | null
  method: HttpRequest['method']
  origin: string
  path: string
  status?: number
  redirects: number
  durationMs: number
  code?: TransportErrorCode
}

export interface EngineTransport {
  (req: HttpRequest, signal: AbortSignal | undefined, timeoutMs: number): Promise<TransportResult>
  /** Closes pooled connections. */
  close(): Promise<void>
}

export interface EngineTransportOptions {
  /** Origin (or any URL on it) → engine policy. Only these origins are reachable. */
  allowedOrigins: ReadonlyMap<string, EngineOriginPolicy>
  maxRedirects?: number
  /** Decoded response cap. Default 16 MiB. */
  maxBodyBytes?: number
  userAgent?: string
  /** Monotonic clock for `durationMs`. Default `performance.now`. */
  now?: () => number
  onTrace?: (event: TransportTrace) => void
  /** Connections per engine origin. Default 4. */
  connectionsPerOrigin?: number
}

/** Narrows a transport result to the failure branch. */
export function isTransportFailure(r: TransportResult): r is TransportFailure {
  return 'networkError' in r
}

const ALWAYS_STRIP = ['authorization', 'cookie', 'proxy-authorization']

function normaliseOrigin(input: string): string | null {
  try {
    const u = new URL(input)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

function classify(
  code: string | undefined,
): Pick<TransportFailure, 'errorClass' | 'code'> & { verb: string } {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'EAI_FAIL':
      return { errorClass: 'offline', code: 'dns', verb: 'could not be resolved' }
    case 'ENETUNREACH':
    case 'ENETDOWN':
      return { errorClass: 'offline', code: 'network', verb: 'is unreachable (no route)' }
    case 'ECONNREFUSED':
      return { errorClass: 'unreachable', code: 'refused', verb: 'refused the connection' }
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
    case 'UND_ERR_CLOSED':
    case 'ECONNABORTED':
      return { errorClass: 'unreachable', code: 'reset', verb: 'closed the connection' }
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
      return { errorClass: 'unreachable', code: 'network', verb: 'is unreachable' }
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'ETIMEDOUT':
      return { errorClass: 'timeout', code: 'timeout', verb: 'timed out' }
    case 'UND_ERR_INVALID_ARG':
    case 'ERR_INVALID_ARG_TYPE':
    case 'ERR_INVALID_ARG_VALUE':
    case 'ERR_INVALID_CHAR':
    case 'ERR_INVALID_HTTP_TOKEN':
      return {
        errorClass: 'malformed',
        code: 'invalid_request',
        verb: 'rejected an invalid request (adapter bug)',
      }
    default:
      if (code && /CERT|TLS|SSL/i.test(code))
        return { errorClass: 'unreachable', code: 'tls', verb: 'failed TLS' }
      return { errorClass: 'unreachable', code: 'network', verb: 'failed' }
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/**
 * Creates the engine transport. Throws `config_invalid` once, at construction,
 * for an allowlist key that is not an http(s) URL. The returned function never
 * throws; it resolves to an HttpResponse (any status) or a TransportFailure.
 */
export function createEngineTransport(opts: EngineTransportOptions): EngineTransport {
  const allowed = new Map<string, EngineOriginPolicy>()
  const allAuthNames = new Set<string>()
  for (const [key, policy] of opts.allowedOrigins) {
    const origin = normaliseOrigin(key)
    if (!origin) {
      throw new SearchHoleError('config_invalid', `Engine origin "${key}" is not an http(s) URL`, {
        fix: 'set the engine endpoint to a full URL such as http://127.0.0.1:8888',
      })
    }
    allowed.set(origin, policy)
    for (const name of policy.authHeaderNames) allAuthNames.add(name.toLowerCase())
  }
  const maxRedirects = opts.maxRedirects ?? 5
  const maxBody = opts.maxBodyBytes ?? 16 * 1024 * 1024
  const ua = opts.userAgent ?? USER_AGENT
  const clock = opts.now ?? (() => performance.now())
  const agent: Dispatcher = new Agent({
    connections: opts.connectionsPerOrigin ?? 4,
    pipelining: 1,
    keepAliveTimeout: 10_000,
  })

  const call = async (
    req: HttpRequest,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<TransportResult> => {
    const started = clock()
    const elapsed = (): number => Math.max(0, Math.round(clock() - started))
    let origin = normaliseOrigin(req.url) ?? ''
    const engine = allowed.get(origin) ?? null
    let redirects = 0
    let currentUrl = req.url

    const trace = (extra: Partial<TransportTrace>): void => {
      if (!opts.onTrace) return
      try {
        opts.onTrace({
          engineId: engine?.engineId ?? null,
          method: req.method,
          origin,
          path: pathOf(currentUrl),
          redirects,
          durationMs: elapsed(),
          ...extra,
        })
      } catch {
        // A broken trace sink must never break a search.
      }
    }
    const fail = (
      code: TransportErrorCode,
      errorClass: TransportFailure['errorClass'],
      message: string,
    ): TransportFailure => {
      trace({ code })
      return { networkError: message, errorClass, code, durationMs: elapsed() }
    }

    if (!origin || (req.method !== 'GET' && req.method !== 'POST')) {
      return fail('invalid_request', 'malformed', 'invalid engine request (bad URL or method)')
    }
    if (!engine) return fail('origin_not_allowed', 'forbidden', `${origin} is not a configured engine origin`)

    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs))
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const ownAuth = new Set(engine.authHeaderNames.map((h) => h.toLowerCase()))
    const stripNames = new Set([...ALWAYS_STRIP, ...ownAuth])

    // Keys are bound to their origin (ADR-0007 point 5): another engine's auth header never leaves here.
    let headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase()
      if (allAuthNames.has(name) && !ownAuth.has(name)) continue
      headers[name] = v
    }
    headers['user-agent'] ??= ua
    headers['accept-encoding'] ??= 'gzip, br'
    let method: HttpRequest['method'] = req.method
    let body: string | undefined = req.body
    let stripped = false

    try {
      for (;;) {
        if (combined.aborted) throw combined.reason
        const pending = request(currentUrl, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          dispatcher: agent,
          signal: combined,
        })
        const res = await raceAbort(pending, combined, (late) => discardBody(late.body))
        const location = headerString(res.headers.location)
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
          discardBody(res.body)
          if (redirects >= maxRedirects) {
            return fail(
              'too_many_redirects',
              'server',
              `${origin} redirected more than ${maxRedirects} times`,
            )
          }
          let next: URL
          try {
            next = new URL(location, currentUrl)
          } catch {
            return fail('redirect_not_allowed', 'forbidden', `${origin} sent an invalid redirect`)
          }
          const nextOrigin = normaliseOrigin(next.href)
          if (!nextOrigin || !allowed.has(nextOrigin)) {
            return fail(
              'redirect_not_allowed',
              'forbidden',
              `${origin} redirected to an origin that is not configured`,
            )
          }
          if (nextOrigin !== origin && !stripped) {
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !stripNames.has(k)))
            stripped = true
          }
          if (
            res.statusCode === 303 ||
            ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')
          ) {
            method = 'GET'
            body = undefined
            const { 'content-type': _ct, 'content-length': _cl, ...rest } = headers
            headers = rest
          }
          redirects++
          origin = nextOrigin
          currentUrl = next.href
          continue
        }
        const read = await readBody(res.body, headerString(res.headers['content-encoding']), maxBody)
        if (read.truncated) {
          return fail('body_too_large', 'malformed', `${origin} sent more than ${maxBody} bytes`)
        }
        const responseHeaders = flattenHeaders(res.headers)
        const ct = parseContentType(responseHeaders['content-type'])
        const text = decodeText(read.bytes, ct.charset, false).text
        trace({ status: res.statusCode })
        return { status: res.statusCode, headers: responseHeaders, text, durationMs: elapsed() }
      }
    } catch (err) {
      if (signal?.aborted) return fail('cancelled', 'cancelled', `request to ${origin} was cancelled`)
      if (timeout.aborted) return fail('timeout', 'timeout', `${origin} timed out after ${timeoutMs} ms`)
      const c = classify(errorCodeOf(err))
      return fail(c.code, c.errorClass, `${origin} ${c.verb}`)
    }
  }

  return Object.assign(call, {
    async close(): Promise<void> {
      await agent.close()
    },
  })
}
