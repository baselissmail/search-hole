// SPDX-License-Identifier: Apache-2.0
/**
 * Lossless URL and host normalisation for rule matching (ADR-0008, "What a rule
 * matches against"). This is deliberately NOT the ADR-0010 dedupe key: scheme,
 * `www.`, path case and the query are all kept.
 */

/** A result URL after lossless normalisation. */
export interface NormalizedUrl {
  /** `scheme://host[:port]` + path + query. No userinfo, no fragment. */
  href: string
  /** Lower-case scheme without the trailing `:`. */
  scheme: string
  /** Lower-case ASCII (punycode) host without port or trailing dot. IPv6 keeps its brackets. */
  host: string
  /** Path plus query exactly as the WHATWG parser serialises them. */
  pathQuery: string
  /** True for IPv4 and IPv6 literals: domain rules then match only the exact address. */
  ip: boolean
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/

/** True when `host` (already normalised) is an IPv4 or bracketed IPv6 literal. */
export function isIpHost(host: string): boolean {
  return host.startsWith('[') || IPV4.test(host)
}

/**
 * Normalises a result URL losslessly: scheme and host lower-cased, IDNA to
 * punycode (WHATWG URL parser), trailing dots and the default port removed, the
 * fragment dropped. Userinfo is dropped too, so `https://good.example@evil.example/`
 * can never satisfy a pattern anchored on `good.example`. Returns null for
 * unparsable URLs and URLs without a host.
 */
export function normalizeUrl(raw: string): NormalizedUrl | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  u.hash = ''
  u.username = ''
  u.password = ''
  const prefix = `${u.protocol}//${u.host}`
  const pathQuery = u.href.startsWith(prefix) ? u.href.slice(prefix.length) : `${u.pathname}${u.search}`
  const host = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (host === '') return null
  const scheme = u.protocol.slice(0, -1).toLowerCase()
  const port = u.port === '' ? '' : `:${u.port}`
  return { href: `${scheme}://${host}${port}${pathQuery}`, scheme, host, pathQuery, ip: isIpHost(host) }
}

/**
 * Normalises a host written in a rule (`Bücher.DE.` → `xn--bcher-kva.de`).
 * Returns null when the text is not a bare host (ports, paths, wildcards,
 * userinfo and whitespace are rejected).
 */
export function normalizeHost(text: string): string | null {
  const t = text.trim().replace(/\.+$/, '')
  if (t === '' || t.length > 253 || /[\s/?#@\\*^|=:]/.test(t.replace(/^\[[0-9a-fA-F:.]+\]$/, ''))) return null
  let u: URL
  try {
    u = new URL(`http://${t}/`)
  } catch {
    return null
  }
  if (u.port !== '' || u.pathname !== '/' || u.username !== '' || u.search !== '') return null
  const host = u.hostname.replace(/\.+$/, '')
  if (isIpHost(host)) return host
  return HOSTNAME.test(host) ? host : null
}

/**
 * Normalises a path (and optional query) written in a rule the same way the
 * WHATWG parser serialises result URLs (percent-encoding, dot segments).
 */
export function normalizePath(path: string): string | null {
  if (!path.startsWith('/') || /[\s#]/.test(path)) return null
  try {
    const u = new URL(`http://h${path}`)
    return u.href.slice('http://h'.length)
  } catch {
    return null
  }
}

/** True when `host` equals `domain` or ends with `.domain` (label boundary). IPs match exactly only. */
export function hostMatchesDomain(host: string, domain: string, hostIsIp: boolean): boolean {
  if (host === domain) return true
  if (hostIsIp) return false
  return host.length > domain.length && host.endsWith(domain) && host[host.length - domain.length - 1] === '.'
}

/** Number of DNS labels in a host (`a.b.c` → 3). */
export function labelCount(host: string): number {
  return host.split('.').length
}
