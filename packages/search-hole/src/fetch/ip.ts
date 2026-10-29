// SPDX-License-Identifier: Apache-2.0
/**
 * Address classification for the SSRF guard (SYNTHESIS §6 Security, §12.4).
 * Only public unicast passes. IPv4-mapped, NAT64 (64:ff9b::/96) and 6to4
 * addresses are unwrapped and the embedded IPv4 address is checked instead.
 * On top of ipaddr.js's own ranges, an explicit deny list covers ranges it
 * labels `unicast` but that are not reachable public hosts (IPv4-compatible
 * `::a.b.c.d`, NAT64 local-use, documentation, and so on).
 */
import ipaddr from 'ipaddr.js'

export type AddressVerdict =
  | { allowed: true; address: string }
  | { allowed: false; address: string; range: string }

export interface ClassifyOptions {
  /** Test-only: also accept 127.0.0.0/8 and ::1 (see guard.ts). */
  allowLoopback?: boolean
}

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number]

/** Belt and braces: ranges that must never pass even if ipaddr.js calls them unicast. */
const EXTRA_DENY: ReadonlyArray<[string, Cidr]> = (
  [
    ['unspecified', '0.0.0.0/8'],
    ['private', '10.0.0.0/8'],
    ['carrierGradeNat', '100.64.0.0/10'],
    ['loopback', '127.0.0.0/8'],
    ['linkLocal', '169.254.0.0/16'],
    ['private', '172.16.0.0/12'],
    ['reserved', '192.0.0.0/24'],
    ['documentation', '192.0.2.0/24'],
    ['reserved', '192.88.99.0/24'],
    ['private', '192.168.0.0/16'],
    ['benchmarking', '198.18.0.0/15'],
    ['documentation', '198.51.100.0/24'],
    ['documentation', '203.0.113.0/24'],
    ['multicast', '224.0.0.0/4'],
    ['reserved', '240.0.0.0/4'],
    ['ipv4Compatible', '::/96'],
    ['ipv4Mapped', '::ffff:0:0/96'],
    ['nat64LocalUse', '64:ff9b:1::/48'],
    ['discard', '100::/64'],
    ['reserved', '2001::/23'],
    ['documentation', '2001:db8::/32'],
    ['documentation', '3fff::/20'],
    ['segmentRouting', '5f00::/16'],
    ['uniqueLocal', 'fc00::/7'],
    ['linkLocal', 'fe80::/10'],
    ['siteLocal', 'fec0::/10'],
    ['multicast', 'ff00::/8'],
  ] as const
).map(([name, cidr]) => [name, ipaddr.parseCIDR(cidr)])

/**
 * Re-serialises an IPv6 literal with the WHATWG URL parser, the same parser
 * that produced the hostname. This removes parser differentials: ipaddr.js
 * reads the dotted `::8.8.8.8` as IPv4-mapped, while the OS (and WHATWG) treat
 * it as IPv4-compatible `::808:808`. IPv4 input is returned unchanged.
 */
function canonicalIpv6(ip: string): string | null {
  if (!ip.includes(':')) return ip
  try {
    return stripBrackets(new URL(`http://[${ip}]/`).hostname)
  } catch {
    return null
  }
}

/** Canonical text form (IPv4-mapped unwrapped), for set comparisons; the input when unparsable. */
export function normaliseAddress(ip: string): string {
  const shown = canonicalIpv6(stripBrackets(ip.trim()).split('%')[0] ?? '') ?? ''
  if (!ipaddr.isValid(shown)) return shown
  const addr = ipaddr.parse(shown)
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (addr as ipaddr.IPv6).toIPv4Address().toString()
  }
  return addr.toString()
}

/** Strips `[...]` around an IPv6 literal. */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function embeddedIpv4(addr: ipaddr.IPv6): ipaddr.IPv4 | null {
  if (addr.isIPv4MappedAddress()) return addr.toIPv4Address()
  const p = addr.parts
  const [p0 = 0, p1 = 0, p2 = 0, p3 = 0, p4 = 0, p5 = 0, p6 = 0, p7 = 0] = p
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): last 32 bits.
  if (p0 === 0x64 && p1 === 0xff9b && p2 === 0 && p3 === 0 && p4 === 0 && p5 === 0) {
    return new ipaddr.IPv4([p6 >> 8, p6 & 0xff, p7 >> 8, p7 & 0xff])
  }
  // 6to4 2002::/16 (RFC 3056): bits 16–47.
  if (p0 === 0x2002) return new ipaddr.IPv4([p1 >> 8, p1 & 0xff, p2 >> 8, p2 & 0xff])
  return null
}

function deny(addr: ipaddr.IPv4 | ipaddr.IPv6): string | null {
  for (const [name, cidr] of EXTRA_DENY) {
    if (addr.kind() === cidr[0].kind() && addr.match(cidr)) return name
  }
  return null
}

function verdictFor(addr: ipaddr.IPv4 | ipaddr.IPv6, shown: string, opts: ClassifyOptions): AddressVerdict {
  const range = addr.range()
  if (range === 'loopback' && opts.allowLoopback) return { allowed: true, address: shown }
  if (range !== 'unicast') return { allowed: false, address: shown, range }
  const extra = deny(addr)
  if (extra) return { allowed: false, address: shown, range: extra }
  return { allowed: true, address: shown }
}

/**
 * Classifies one IP address string (IPv4, or IPv6 with or without brackets).
 * Anything unparsable, scoped (`%zone`) or not public unicast is refused.
 */
export function classifyAddress(ip: string, opts: ClassifyOptions = {}): AddressVerdict {
  const shown = stripBrackets(ip.trim())
  if (shown.includes('%')) return { allowed: false, address: shown, range: 'scoped' }
  const canonical = canonicalIpv6(shown)
  if (canonical === null || !ipaddr.isValid(canonical))
    return { allowed: false, address: shown, range: 'invalid' }
  const addr = ipaddr.parse(canonical)
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6
    const inner = embeddedIpv4(v6)
    if (inner) {
      if (!v6.isIPv4MappedAddress()) {
        // The wrapper itself must be a translation prefix, never e.g. a mapped loopback.
        const outer = v6.range()
        if (outer !== 'rfc6052' && outer !== '6to4') return { allowed: false, address: shown, range: outer }
      }
      return verdictFor(inner, shown, opts)
    }
  }
  return verdictFor(addr, shown, opts)
}
