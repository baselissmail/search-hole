// SPDX-License-Identifier: Apache-2.0
/**
 * The list fetcher (ADR-0008 "Lists", ADR-0022; SYNTHESIS §6 "List hijack guard"): downloads a
 * subscribed or starter list for the refresh job.
 *
 * - HTTPS only, on the first URL and on every redirect (at most 5, each re-checked).
 * - Public hosts only: the page fetcher's SSRF guard (`checkUrlShape` plus the guarded undici
 *   agent, whose DNS lookup refuses any non-public address), so a list URL can never reach
 *   this machine or the local network.
 * - Conditional: `If-None-Match` / `If-Modified-Since` from the last good copy; a 304 is an
 *   answer, not an error.
 * - Bounded: a 64 MiB cap on decoded bytes (gzip and brotli included, so a compression bomb
 *   stops at the cap) and a 60 s total deadline.
 * - Text only: a body with NUL bytes in its first 8 KiB is refused as binary.
 *
 * Never throws: every failure is a coded outcome the refresh job records. No cookies, no
 * credentials, an honest user agent.
 */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { type Dispatcher, request } from 'undici'
import { errorCodeOf, raceAbort } from './abort.ts'
import { discardBody, headerString, readBody, UnsupportedEncodingError } from './body.ts'
import {
  checkUrlShape,
  createGuardedAgent,
  findGuardError,
  GuardError,
  type GuardPolicy,
  loopbackAllowed,
} from './guard.ts'
import { stripBrackets } from './ip.ts'
import { USER_AGENT } from './version.ts'

/** ADR-0008 per-list cap. */
export const LIST_MAX_BYTES = 64 * 1024 * 1024
export const LIST_TIMEOUT_MS = 60_000
export const LIST_MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const SNIFF_BYTES = 8 * 1024

export type ListFetchErrorCode =
  | 'not_https'
  | 'blocked_address'
  | 'http_status'
  | 'too_large'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'too_many_redirects'
  | 'not_text'

export interface ListFetchRequest {
  url: string
  /** Validators of the copy in force; sent only when present. */
  etag?: string | null
  lastModified?: string | null
  signal?: AbortSignal
}

export type ListFetchOutcome =
  | {
      kind: 'ok'
      /** The body as UTF-8 text (a leading BOM kept; the importers drop it). */
      text: string
      /** Decoded body bytes. */
      bytes: number
      /** SHA-256 (hex) of the decoded body bytes, for `sha256` pinning. */
      bytesSha256: string
      etag: string | null
      lastModified: string | null
      finalUrl: string
    }
  | { kind: 'not_modified'; etag: string | null; lastModified: string | null; finalUrl: string }
  | { kind: 'error'; code: ListFetchErrorCode; message: string; status?: number }

export interface ListFetcher {
  fetch(req: ListFetchRequest): Promise<ListFetchOutcome>
  close(): Promise<void>
}

export interface ListFetcherConfig {
  /**
   * SSRF policy. Production code passes nothing. With the test-only loopback override,
   * `http://127.0.0.1` URLs are accepted too (a test server needs no certificate).
   */
  guard?: GuardPolicy
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  userAgent?: string
}

const isLoopbackHost = (host: string): boolean => {
  const h = stripBrackets(host).toLowerCase()
  if (h === 'localhost') return true
  if (isIP(h) === 4) return h.startsWith('127.')
  return h === '::1'
}

/** Creates a list fetcher with its own guarded connection pool. */
export function createListFetcher(config: ListFetcherConfig = {}): ListFetcher {
  const policy = config.guard
  const agent = createGuardedAgent({ ...(policy === undefined ? {} : { policy }), connectionsPerOrigin: 2 })
  const maxBytes = Math.min(config.maxBytes ?? LIST_MAX_BYTES, LIST_MAX_BYTES)
  const timeoutMs = config.timeoutMs ?? LIST_TIMEOUT_MS
  const maxRedirects = config.maxRedirects ?? LIST_MAX_REDIRECTS
  const ua = config.userAgent ?? USER_AGENT

  /** HTTPS and a public host shape, or the failure. */
  const check = (raw: string): URL | Extract<ListFetchOutcome, { kind: 'error' }> => {
    let url: URL
    try {
      url = checkUrlShape(raw, policy)
    } catch (e) {
      if (e instanceof GuardError) {
        if (e.reason === 'ssrf') return { kind: 'error', code: 'blocked_address', message: e.message }
        if (e.reason === 'scheme')
          return { kind: 'error', code: 'not_https', message: 'Lists are fetched over HTTPS only.' }
        return { kind: 'error', code: 'not_https', message: e.message }
      }
      return { kind: 'error', code: 'network', message: 'Not a valid URL.' }
    }
    const testHttp = url.protocol === 'http:' && loopbackAllowed(policy) && isLoopbackHost(url.hostname)
    if (url.protocol !== 'https:' && !testHttp) {
      return {
        kind: 'error',
        code: 'not_https',
        message: `Lists are fetched over HTTPS only (got ${url.protocol}//).`,
      }
    }
    return url
  }

  const fetchList = async (req: ListFetchRequest): Promise<ListFetchOutcome> => {
    const first = check(req.url)
    if (!(first instanceof URL)) return first
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const headers: Record<string, string> = {
      'user-agent': ua,
      accept: 'text/plain, text/*;q=0.9, */*;q=0.5',
      'accept-encoding': 'gzip, br',
    }
    if (req.etag) headers['if-none-match'] = req.etag
    if (req.lastModified) headers['if-modified-since'] = req.lastModified
    let url = first
    try {
      for (let hop = 0; ; hop++) {
        if (signal.aborted) throw signal.reason
        const p = request(url, { method: 'GET', headers, dispatcher: agent, signal })
        const res: Dispatcher.ResponseData = await raceAbort(p, signal, (late) => discardBody(late.body))
        const location = headerString(res.headers.location)
        if (REDIRECTS.has(res.statusCode) && location) {
          discardBody(res.body)
          if (hop >= maxRedirects) {
            return {
              kind: 'error',
              code: 'too_many_redirects',
              message: `More than ${maxRedirects} redirects.`,
            }
          }
          let next: string
          try {
            next = new URL(location, url.href).href
          } catch {
            return { kind: 'error', code: 'network', message: `${url.host} sent an invalid redirect.` }
          }
          const checked = check(next)
          if (!(checked instanceof URL)) return checked
          url = checked
          continue
        }
        const etag = headerString(res.headers.etag) ?? null
        const lastModified = headerString(res.headers['last-modified']) ?? null
        if (res.statusCode === 304) {
          discardBody(res.body)
          return { kind: 'not_modified', etag, lastModified, finalUrl: url.href }
        }
        if (res.statusCode !== 200) {
          discardBody(res.body)
          return {
            kind: 'error',
            code: 'http_status',
            status: res.statusCode,
            message: `${url.host} answered HTTP ${res.statusCode}.`,
          }
        }
        const body = await readBody(res.body, headerString(res.headers['content-encoding']), maxBytes)
        if (body.truncated) {
          return {
            kind: 'error',
            code: 'too_large',
            message: `The list is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB.`,
          }
        }
        if (body.bytes.subarray(0, SNIFF_BYTES).includes(0)) {
          return { kind: 'error', code: 'not_text', message: 'The download is binary, not a text list.' }
        }
        return {
          kind: 'ok',
          text: new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(body.bytes),
          bytes: body.bytes.length,
          bytesSha256: createHash('sha256').update(body.bytes).digest('hex'),
          etag,
          lastModified,
          finalUrl: url.href,
        }
      }
    } catch (err) {
      const guard = findGuardError(err)
      if (guard) return { kind: 'error', code: 'blocked_address', message: guard.message }
      if (req.signal?.aborted)
        return { kind: 'error', code: 'cancelled', message: 'The refresh was cancelled.' }
      if (timeout.aborted) {
        return {
          kind: 'error',
          code: 'timeout',
          message: `${url.host} did not answer within ${timeoutMs / 1000} s.`,
        }
      }
      if (err instanceof UnsupportedEncodingError)
        return { kind: 'error', code: 'not_text', message: err.message }
      const code = errorCodeOf(err)
      return {
        kind: 'error',
        code: code !== undefined && /TIMEOUT|ETIMEDOUT/.test(code) ? 'timeout' : 'network',
        message: `Could not download from ${url.host}${code ? ` (${code})` : ''}.`,
      }
    }
  }

  return {
    fetch: fetchList,
    async close() {
      await agent.close()
    },
  }
}
