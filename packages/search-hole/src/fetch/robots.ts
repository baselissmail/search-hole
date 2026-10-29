// SPDX-License-Identifier: Apache-2.0
/**
 * robots.txt policy (§12.4, Principle 8) with an in-memory cache per origin.
 *
 * Status handling follows RFC 9309 §2.3.1:
 * - 2xx: parse it (first 512 KiB) and respect `Disallow` for our product token.
 * - 4xx other than 429 (and redirect loops): no usable robots.txt → allow all.
 * - 429, 5xx and network errors: "unreachable" → disallow, but only
 *   temporarily (cached `errorTtlMs`, default 5 min) so the next attempt
 *   re-checks soon instead of locking the site out for 24 h.
 * Successful and 4xx results are cached for `ttlMs` (default and maximum 24 h).
 * `Crawl-delay` is ignored: we fetch single pages on demand, never crawl.
 */
import robotsParserModule from 'robots-parser'
import { ROBOTS_TOKEN } from './version.ts'

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined
  getMatchingLineNumber(url: string, ua?: string): number
}
type RobotsParser = (url: string, contents: string) => Robot

// robots-parser is CommonJS (`module.exports = fn`) with an ESM-style d.ts; accept both shapes.
const robotsParser: RobotsParser = ((robotsParserModule as unknown as { default?: RobotsParser }).default ??
  robotsParserModule) as unknown as RobotsParser

export const ROBOTS_MAX_BYTES = 512 * 1024
const DAY_MS = 86_400_000

/** `transient`: the failure came from our own cancellation or deadline, so it is not cached. */
export type RobotsFetchResult = { status: number; text: string } | { networkError: string; transient?: true }

/** Fetches `<origin>/robots.txt`; must apply the SSRF guard and follow redirects. */
export type RobotsFetch = (robotsUrl: string, signal: AbortSignal | undefined) => Promise<RobotsFetchResult>

export type RobotsVerdict =
  | { allowed: true; basis: 'rules' | 'no_robots' }
  | { allowed: false; reason: 'disallowed' | 'unavailable'; robotsUrl: string; detail: string }

export interface RobotsChecker {
  /** Checks one URL; never throws for robots problems (they become verdicts). */
  check(url: string, signal?: AbortSignal): Promise<RobotsVerdict>
  /** Drops every cached entry. */
  clear(): void
}

export interface RobotsOptions {
  fetchRobots: RobotsFetch
  now?: () => number
  /** Product token matched against `User-agent:` lines. Default `search-hole`. */
  token?: string
  /** Cache lifetime for usable answers, capped at 24 h. */
  ttlMs?: number
  /** Cache lifetime for the temporary disallow after 429/5xx/network errors. */
  errorTtlMs?: number
  /** Most origins kept in memory (oldest evicted first). Default 1000. */
  maxEntries?: number
}

type Entry =
  | { kind: 'rules'; robot: Robot; expiresAt: number }
  | { kind: 'allow_all'; expiresAt: number }
  | { kind: 'unavailable'; detail: string; expiresAt: number }

/** Builds a robots checker with its own cache. */
export function createRobotsChecker(opts: RobotsOptions): RobotsChecker {
  const now = opts.now ?? Date.now
  const token = opts.token ?? ROBOTS_TOKEN
  const ttl = Math.min(opts.ttlMs ?? DAY_MS, DAY_MS)
  const errorTtl = opts.errorTtlMs ?? 5 * 60_000
  const maxEntries = opts.maxEntries ?? 1000
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Promise<Entry>>()

  const remember = (origin: string, entry: Entry): Entry => {
    cache.delete(origin)
    cache.set(origin, entry)
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return entry
  }

  const load = async (origin: string, robotsUrl: string, signal: AbortSignal | undefined): Promise<Entry> => {
    let res: RobotsFetchResult
    try {
      res = await opts.fetchRobots(robotsUrl, signal)
    } catch (err) {
      res = { networkError: err instanceof Error ? err.message : String(err) }
    }
    const t = now()
    if ('networkError' in res) {
      const entry: Entry = { kind: 'unavailable', detail: res.networkError, expiresAt: t + errorTtl }
      return res.transient ? entry : remember(origin, entry)
    }
    if (res.status === 429 || res.status >= 500) {
      return remember(origin, { kind: 'unavailable', detail: `HTTP ${res.status}`, expiresAt: t + errorTtl })
    }
    if (res.status >= 200 && res.status < 300) {
      const text = res.text.length > ROBOTS_MAX_BYTES ? res.text.slice(0, ROBOTS_MAX_BYTES) : res.text
      return remember(origin, { kind: 'rules', robot: robotsParser(robotsUrl, text), expiresAt: t + ttl })
    }
    return remember(origin, { kind: 'allow_all', expiresAt: t + ttl })
  }

  return {
    async check(url, signal) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { allowed: true, basis: 'no_robots' }
      }
      const origin = parsed.origin
      const robotsUrl = `${origin}/robots.txt`
      let entry = cache.get(origin)
      if (!entry || entry.expiresAt <= now()) {
        let pending = inflight.get(origin)
        if (!pending) {
          pending = load(origin, robotsUrl, signal).finally(() => inflight.delete(origin))
          inflight.set(origin, pending)
        }
        entry = await pending
      }
      if (entry.kind === 'allow_all') return { allowed: true, basis: 'no_robots' }
      if (entry.kind === 'unavailable') {
        return {
          allowed: false,
          reason: 'unavailable',
          robotsUrl,
          detail: `robots.txt could not be read (${entry.detail}); retry in a few minutes`,
        }
      }
      const allowed = entry.robot.isAllowed(parsed.href, token)
      if (allowed === false) {
        const line = entry.robot.getMatchingLineNumber(parsed.href, token)
        return {
          allowed: false,
          reason: 'disallowed',
          robotsUrl,
          detail: line > 0 ? `disallowed by robots.txt line ${line}` : 'disallowed by robots.txt',
        }
      }
      return { allowed: true, basis: 'rules' }
    },
    clear() {
      cache.clear()
    },
  }
}
