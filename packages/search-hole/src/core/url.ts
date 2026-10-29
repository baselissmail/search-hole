// SPDX-License-Identifier: Apache-2.0
/**
 * URL normalisation (ADR-0008 "What a rule matches against", ADR-0010 §1).
 *
 * Two different normal forms, never mixed up:
 * - `normalizeOriginal` is lossless and is what rules match against.
 * - `canonicalKey` is the dedupe key. It is lossy on purpose (scheme, `www.`, tracking
 *   parameters, AMP and mobile variants) and is **never** used for rule matching.
 *
 * Pure: WHATWG `URL` (a global) does IDNA and host lowercasing; `tldts` supplies the
 * Public Suffix List.
 */
import { getDomain, parse as parseHost } from 'tldts'

// ── Data (extendable) ────────────────────────────────────────────────────

/** Query parameters that carry tracking state and never identify a page. */
export interface TrackingParams {
  /** Lower-cased parameter names removed exactly. */
  exact: readonly string[]
  /** Lower-cased prefixes: any parameter starting with one is removed. */
  prefixes: readonly string[]
}

/** A query parameter that marks an AMP variant when it has one of `values` (lower-cased). */
export interface AmpParam {
  name: string
  values: readonly string[]
}

/** Every lossy rule `canonicalKey` applies, as data, so tests and settings can extend it. */
export interface CanonicalRules {
  trackingParams: TrackingParams
  /** Leading host labels dropped while they are subdomain labels (`www.`, `amp.`, `m.`, `mobile.`). */
  hostPrefixLabels: readonly string[]
  /** Labels dropped when they sit right above the registrable domain (`en.m.wikipedia.org`). */
  mobileInnerLabels: readonly string[]
  /** Whole path segments that mark an AMP variant (`/amp/`). */
  ampPathSegments: readonly string[]
  /** Last-segment suffix rewrites (`story.amp` → `story`, `story.amp.html` → `story.html`). */
  ampPathSuffixes: readonly (readonly [from: string, to: string])[]
  /** Query parameters that mark an AMP variant (`?amp`, `?outputType=amp`). */
  ampParams: readonly AmpParam[]
  /** Parameters AMP caches and viewers append. */
  ampCacheParams: readonly string[]
}

/** ADR-0010 §1 tracking list. */
export const TRACKING_PARAMS: TrackingParams = {
  exact: [
    'fbclid',
    'gclid',
    'dclid',
    'gbraid',
    'wbraid',
    'igshid',
    'mc_cid',
    'mc_eid',
    'mkt_tok',
    'msclkid',
    'ref',
    'ref_src',
    'spm',
    'ved',
    '_hsenc',
    '_hsmi',
  ],
  prefixes: ['utm_', 'oly_', 'vero_'],
}

/** The defaults from ADR-0010 §1. */
export const DEFAULT_CANONICAL_RULES: CanonicalRules = {
  trackingParams: TRACKING_PARAMS,
  hostPrefixLabels: ['www', 'amp', 'm', 'mobile'],
  mobileInnerLabels: ['m', 'mobile'],
  ampPathSegments: ['amp'],
  ampPathSuffixes: [
    ['.amp.html', '.html'],
    ['.amp', ''],
  ],
  ampParams: [
    { name: 'amp', values: ['', '1', 'true'] },
    { name: 'outputtype', values: ['amp'] },
  ],
  ampCacheParams: ['amp_js_v', 'amp_gsa', 'usqp'],
}

const AMP_CACHE_SUFFIX = '.cdn.ampproject.org'
const AMP_CACHE_PATH = /^\/[cvir]\/(s\/)?([^/]+)(\/.*)?$/
const GOOGLE_AMP_PATH = /^\/amp\/(s\/)?([^/]+)(\/.*)?$/
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

// ── Parsing ──────────────────────────────────────────────────────────────

/** Parses an absolute http(s) URL with a non-empty host; null for anything else. */
export function parseHttpUrl(input: string): URL | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = stripTrailingDots(u.hostname)
  if (host === '') return null
  if (host !== u.hostname) u.hostname = host
  return u
}

function stripTrailingDots(host: string): string {
  let end = host.length
  while (end > 0 && host.charCodeAt(end - 1) === 46) end--
  return host.slice(0, end)
}

/**
 * Lossless normalisation (ADR-0008): lowercase scheme and host, IDNA to punycode, drop the
 * trailing dot, the default port and the fragment. Scheme, `www.`, userinfo, path and query
 * are kept. Returns null for anything that is not an absolute http(s) URL.
 */
export function normalizeOriginal(url: string): string | null {
  const u = parseHttpUrl(url)
  if (!u) return null
  u.hash = ''
  return u.href
}

/** The normalised host of an http(s) URL (lowercase, punycode, no trailing dot), or null. */
export function hostOf(url: string): string | null {
  return parseHttpUrl(url)?.hostname ?? null
}

/**
 * Registrable domain from the Public Suffix List, including its private section, so
 * `alice.github.io` and `bob.github.io` are different sources. Falls back to the host
 * itself for IP addresses and hosts without a registrable part (`localhost`).
 */
export function registrableDomain(host: string): string {
  const h = stripTrailingDots(host.toLowerCase())
  return getDomain(h, { allowPrivateDomains: true }) ?? h
}

// ── Canonical key ────────────────────────────────────────────────────────

/** A canonical key plus how many variant marks (AMP, mobile, tracking) were removed. */
export interface Canonical {
  /** `//host[:port]/path[?sorted-query]`: scheme-less on purpose, never a fetchable URL. */
  key: string
  /** 0 for a clean URL; used to prefer the cleanest member as the display URL. */
  marks: number
}

/**
 * Dedupe key (ADR-0010 §1). Ignores the scheme, strips a leading `www.`, drops the
 * fragment and the default ports, removes tracking parameters, sorts the remaining
 * parameters (stable, so repeated keys keep their order), removes trailing slashes except
 * at the root, keeps path case and collapses AMP and mobile variants. Accepts its own
 * output (`//host/...`), so it is idempotent. Null for non-http(s) input.
 */
export function canonicalKey(url: string, rules: CanonicalRules = DEFAULT_CANONICAL_RULES): string | null {
  return canonicalize(url, rules)?.key ?? null
}

/** Like `canonicalKey`, also counting the variant marks it removed. */
export function canonicalize(url: string, rules: CanonicalRules = DEFAULT_CANONICAL_RULES): Canonical | null {
  let u = parseHttpUrl(url.trimStart().startsWith('//') ? `https:${url.trim()}` : url)
  if (!u) return null
  let marks = 0
  // Each unwrap strictly shortens the URL, so the loop terminates.
  for (let inner = unwrapAmp(u); inner; inner = unwrapAmp(u)) {
    u = inner
    marks++
  }
  const host = stripHostVariants(u.hostname, rules)
  if (host.marks) marks++
  const port = u.port === '80' || u.port === '443' ? '' : u.port
  const path = normalizePath(u.pathname, rules)
  if (path.marks) marks++
  const query = normalizeQuery(u.search, rules)
  marks += query.marks
  const q = query.text === '' ? '' : `?${query.text}`
  return { key: `//${host.text}${port === '' ? '' : `:${port}`}${path.text}${q}`, marks }
}

interface Stripped {
  text: string
  marks: number
}

/**
 * Unwraps AMP caches. `cdn.ampproject.org` URLs are unwrapped only when the cache subdomain
 * matches the inner host's cache encoding, so a cache URL can't claim another origin.
 * Google's AMP viewer (`google.<tld>/amp/s/<host>/...`) is unwrapped too.
 */
function unwrapAmp(u: URL): URL | null {
  const host = u.hostname
  if (host.endsWith(AMP_CACHE_SUFFIX)) {
    const m = AMP_CACHE_PATH.exec(u.pathname)
    if (!m?.[2]?.includes('.')) return null
    const inner = parseHttpUrl(`${m[1] ? 'https' : 'http'}://${m[2]}${m[3] ?? '/'}${u.search}`)
    if (!inner) return null
    const sub = host.slice(0, -AMP_CACHE_SUFFIX.length)
    return ampCacheSubdomain(inner.hostname) === sub ? inner : null
  }
  const parsed = parseHost(host)
  if (parsed.domainWithoutSuffix !== 'google' || !parsed.domain) return null
  if (host !== parsed.domain && host !== `www.${parsed.domain}`) return null
  const m = GOOGLE_AMP_PATH.exec(u.pathname)
  if (!m?.[2]?.includes('.')) return null
  return parseHttpUrl(`${m[1] ? 'https' : 'http'}://${m[2]}${m[3] ?? '/'}${u.search}`)
}

/**
 * AMP cache subdomain for an ASCII host: `-` → `--`, `.` → `-`, wrapped in `0-…-0` when the
 * result would look like an IDN label. IDN and over-long hosts use a hash form we don't
 * verify, so they return null and stay wrapped.
 */
function ampCacheSubdomain(host: string): string | null {
  if (host.includes('xn--') || !/^[a-z0-9.-]+$/.test(host)) return null
  let s = host.replaceAll('-', '--').replaceAll('.', '-')
  if (s[2] === '-' && s[3] === '-') s = `0-${s}-0`
  return s.length > 63 ? null : s
}

function stripHostVariants(host: string, rules: CanonicalRules): Stripped {
  const domain = registrableDomain(host)
  if (domain === host || !host.endsWith(`.${domain}`)) return { text: host, marks: 0 }
  const labels = host.slice(0, -(domain.length + 1)).split('.')
  let wwwOnly = true
  let removed = 0
  for (let changed = true; changed && labels.length > 0; ) {
    changed = false
    const first = labels[0]
    if (first !== undefined && rules.hostPrefixLabels.includes(first)) {
      if (first !== 'www') wwwOnly = false
      labels.shift()
      removed++
      changed = true
    }
    const last = labels[labels.length - 1]
    if (last !== undefined && rules.mobileInnerLabels.includes(last)) {
      wwwOnly = false
      labels.pop()
      removed++
      changed = true
    }
  }
  const text = labels.length > 0 ? `${labels.join('.')}.${domain}` : domain
  // `www.` is an always-on normalisation, not a variant mark.
  return { text, marks: removed > 0 && !wwwOnly ? 1 : 0 }
}

/** Uppercases percent-escape hex and decodes escaped unreserved characters (RFC 3986 §6.2.2). */
function normalizeEscapes(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16))
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`
  })
}

function normalizePath(pathname: string, rules: CanonicalRules): Stripped {
  let path = normalizeEscapes(pathname)
  let marks = 0
  // Every step only shortens the path, so iterate to a fixpoint (keeps the key idempotent).
  for (let prev = ''; prev !== path; ) {
    prev = path
    const segments = path.split('/')
    const kept = segments.filter((s, i) => i === 0 || !rules.ampPathSegments.includes(s))
    if (kept.length !== segments.length) marks++
    while (kept.length > 1 && kept[kept.length - 1] === '') kept.pop()
    const last = kept[kept.length - 1]
    if (kept.length > 1 && last !== undefined) {
      for (const [from, to] of rules.ampPathSuffixes) {
        if (last.length > from.length && last.endsWith(from)) {
          kept[kept.length - 1] = last.slice(0, -from.length) + to
          marks++
          break
        }
      }
    }
    path = kept.join('/') || '/'
  }
  return { text: path.startsWith('/') ? path : `/${path}`, marks }
}

function isTracking(name: string, tracking: TrackingParams): boolean {
  return tracking.exact.includes(name) || tracking.prefixes.some((p) => name.startsWith(p))
}

function isAmpParam(name: string, value: string, rules: CanonicalRules): boolean {
  if (rules.ampCacheParams.includes(name)) return true
  const lv = value.toLowerCase()
  return rules.ampParams.some((p) => p.name === name && p.values.includes(lv))
}

function normalizeQuery(search: string, rules: CanonicalRules): Stripped {
  const kept: [string, string][] = []
  let tracking = false
  let amp = false
  for (const [name, value] of new URLSearchParams(search)) {
    const lower = name.toLowerCase()
    if (isTracking(lower, rules.trackingParams)) tracking = true
    else if (isAmpParam(lower, value, rules)) amp = true
    else kept.push([name, value])
  }
  // Array.prototype.sort is stable: repeated keys keep their relative order.
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return { text: new URLSearchParams(kept).toString(), marks: (tracking ? 1 : 0) + (amp ? 1 : 0) }
}
