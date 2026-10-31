// SPDX-License-Identifier: Apache-2.0
/**
 * Hosts files and plain domain lists (ADR-0008 import mapping: hosts → exact
 * host; plain domains → domain suffix).
 *
 * - hosts: `0.0.0.0 name …`, `127.0.0.1 name …` and `::` / `::1` lines become
 *   exact-host rules, one per name. Reserved names (`localhost`,
 *   `broadcasthost`, `ip6-*`, …) are ignored, matched on the whole name. Lines
 *   that map names to any other address are redirects, not blocks, and are
 *   skipped. A bare name is an exact host too (Pi-hole reads lists that way).
 * - domains: one name per line (`*.d` and `.d` accepted) → the name and its
 *   subdomains. Single-label names are skipped: they would match a whole TLD.
 */
import { isIpHost, normalizeHost } from '../../core/rules/normalize.ts'
import { type ListBuilder, POSITIVE } from './builder.ts'
import { type EachLine, readHeaderComment } from './text.ts'

/** Addresses that mean "block" in a hosts file. */
const SINK_ADDRESSES: ReadonlySet<string> = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::',
  '::0',
  '::1',
  '0:0:0:0:0:0:0:0',
  '0:0:0:0:0:0:0:1',
  '0',
])
const RESERVED_NAME = /^(?:localhost|localhost\.localdomain|local|broadcasthost|ip6-[a-z0-9-]+|0\.0\.0\.0)$/i
const IP_LIKE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:.]*(?:%\S+)?|0)$/i

/** True when `t` looks like a hosts-file line (an address, whitespace, a name). */
export function isHostsLine(t: string): boolean {
  const sp = t.search(/\s/)
  return sp > 0 && IP_LIKE.test(t.slice(0, sp))
}

/** Hosts-file entries of one (comment-free, trimmed) line. */
export function addHostsLine(b: ListBuilder, n: number, line: string, t: string): void {
  const fields = t.split(/\s+/)
  const names = isHostsLine(t) ? fields.slice(1) : fields
  const address = isHostsLine(t) ? fields[0] : undefined
  const real = names.filter((name) => !RESERVED_NAME.test(name.replace(/\.+$/, '')))
  if (real.length === 0) {
    b.ignore()
    return
  }
  if (address === undefined && fields.length > 1) {
    b.skip(n, line, 'not a hosts-file line')
    return
  }
  real.forEach((name, k) => {
    if (address !== undefined && !SINK_ADDRESSES.has(address)) {
      b.skip(n, line, 'maps a name to an address (redirect, not a block)', `${name} → ${address}`)
      return
    }
    const host = normalizeHost(name)
    if (host === null) {
      b.skip(n, line, 'invalid host name', name)
      return
    }
    b.add(n, line, `=${host}`, POSITIVE, false, k)
  })
}

const stripHash = (t: string): string => {
  const i = t.indexOf('#')
  return (i === -1 ? t : t.slice(0, i)).trim()
}

export function parseHosts(b: ListBuilder, each: EachLine): void {
  let header = true
  each((line, n) => {
    const raw = line.trim()
    if (raw.startsWith('#') || raw.startsWith('!')) {
      if (header) readHeaderComment(raw.slice(1), b.header)
      b.ignore()
      return
    }
    const t = stripHash(raw)
    if (t === '') {
      b.ignore()
      return
    }
    header = false
    addHostsLine(b, n, line.trim(), t)
  })
}

export function parseDomains(b: ListBuilder, each: EachLine): void {
  let header = true
  each((line, n) => {
    const raw = line.trim()
    if (raw.startsWith('#') || raw.startsWith('!')) {
      if (header) readHeaderComment(raw.slice(1), b.header)
      b.ignore()
      return
    }
    const t = stripHash(raw)
    if (t === '') {
      b.ignore()
      return
    }
    header = false
    if (/\s/.test(t)) {
      b.skip(n, raw, isHostsLine(t) ? 'hosts-file line in a domains list' : 'not a single domain name')
      return
    }
    const name = t.startsWith('*.') ? t.slice(2) : t.startsWith('.') ? t.slice(1) : t
    const host = normalizeHost(name)
    if (host === null) {
      b.skip(n, raw, 'invalid domain name')
      return
    }
    if (!host.includes('.') && !isIpHost(host)) {
      b.skip(n, raw, 'single-label name (would match a whole TLD)')
      return
    }
    b.add(n, raw, host, POSITIVE)
  })
}
