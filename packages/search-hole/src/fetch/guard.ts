// SPDX-License-Identifier: Apache-2.0
/**
 * SSRF guard for page fetches (SYNTHESIS §6 Security, MASTER_PLAN §12.4).
 *
 * Two layers, because Node skips `lookup` for IP-literal hosts:
 * 1. `checkUrlShape` refuses non-http(s) schemes, credentials in the URL,
 *    browser "bad ports", `localhost` names and IP literals that are not
 *    public unicast. It runs on the initial URL and on every redirect hop.
 * 2. `createGuardedAgent` builds an undici Agent whose connector re-checks IP
 *    literals at socket time and whose `lookup` checks EVERY resolved address
 *    (any non-public address fails the whole lookup, so mixed answers and
 *    DNS rebinding are refused). The checked address is the one connected to,
 *    so there is no check-then-connect gap.
 *
 * Engine endpoints do not use this guard (ADR-0009); see transport.ts.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent, buildConnector } from 'undici'
import { classifyAddress, normaliseAddress, stripBrackets } from './ip.ts'

/**
 * Test-only override key. It allows loopback (127.0.0.0/8, ::1) and nothing
 * else. A symbol key cannot come out of YAML, JSON or env-derived config, and
 * `assertTestOverrideAllowed` additionally refuses it outside a test runner.
 */
export const ALLOW_LOOPBACK_FOR_TESTS: unique symbol = Symbol('search-hole/allow-loopback-for-tests')

/** Resolves a hostname to every address (tests inject one to simulate DNS). */
export type ResolveAll = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>

export interface GuardPolicy {
  /** Injected resolver (tests, DNS-rebinding simulation). Defaults to `dns.lookup(all)`. */
  resolve?: ResolveAll
  /** Refuse addresses assigned to this machine's own interfaces. Default true. */
  blockLocalInterfaces?: boolean
  readonly [ALLOW_LOOPBACK_FOR_TESTS]?: true
}

export type GuardReason = 'scheme' | 'credentials' | 'port' | 'ssrf' | 'invalid_url'

/** Thrown (or passed to undici) when the guard refuses a URL or an address. */
export class GuardError extends Error {
  readonly code = 'ERR_SEARCHHOLE_GUARD'
  readonly reason: GuardReason
  readonly host: string
  readonly address: string | undefined
  readonly range: string | undefined

  constructor(reason: GuardReason, message: string, host: string, address?: string, range?: string) {
    super(message)
    this.name = 'GuardError'
    this.reason = reason
    this.host = host
    this.address = address
    this.range = range
  }
}

/** Finds a GuardError anywhere in an error's cause chain (undici may wrap). */
export function findGuardError(err: unknown): GuardError | null {
  let cur: unknown = err
  for (let i = 0; i < 8 && cur; i++) {
    if (cur instanceof GuardError) return cur
    if (cur instanceof AggregateError) {
      for (const e of cur.errors) {
        const hit = findGuardError(e)
        if (hit) return hit
      }
    }
    cur = cur instanceof Error ? cur.cause : undefined
  }
  return null
}

/** WHATWG Fetch "bad ports": cross-protocol targets browsers refuse too. */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** True when the policy carries the test-only loopback override. */
export function loopbackAllowed(policy: GuardPolicy | undefined): boolean {
  return policy?.[ALLOW_LOOPBACK_FOR_TESTS] === true
}

/**
 * Refuses the test-only override outside a test runner, so production code
 * cannot enable it even by mistake.
 */
export function assertTestOverrideAllowed(policy: GuardPolicy | undefined): void {
  if (!loopbackAllowed(policy)) return
  const env = process.env
  if (env.VITEST === undefined && env.NODE_ENV !== 'test') {
    throw new GuardError(
      'ssrf',
      'The loopback override is test-only and cannot be enabled here.',
      'localhost',
    )
  }
}

function localAddresses(): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) out.add(normaliseAddress(info.address))
  }
  return out
}

/** Checks one resolved or literal address against the policy. */
export function checkAddress(
  host: string,
  address: string,
  policy: GuardPolicy | undefined,
): GuardError | null {
  const allowLoopback = loopbackAllowed(policy)
  const verdict = classifyAddress(address, { allowLoopback })
  if (!verdict.allowed) {
    return new GuardError(
      'ssrf',
      `${host} points to a non-public address (${verdict.address}, ${verdict.range})`,
      host,
      verdict.address,
      verdict.range,
    )
  }
  if (policy?.blockLocalInterfaces !== false) {
    const isLoopbackOverride = allowLoopback && classifyAddress(address).allowed === false
    if (!isLoopbackOverride && localAddresses().has(normaliseAddress(verdict.address))) {
      return new GuardError(
        'ssrf',
        `${host} points to this machine (${verdict.address})`,
        host,
        verdict.address,
        'local',
      )
    }
  }
  return null
}

/**
 * Validates scheme, credentials, port and literal host of a URL (no DNS).
 * Returns the parsed URL or throws a GuardError.
 */
export function checkUrlShape(input: string | URL, policy?: GuardPolicy): URL {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href)
  } catch {
    throw new GuardError('invalid_url', 'Not a valid absolute URL', String(input))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GuardError(
      'scheme',
      `Only http and https URLs can be fetched (got ${url.protocol})`,
      url.hostname,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new GuardError('credentials', 'URLs with embedded credentials are refused', url.hostname)
  }
  if (url.port !== '' && BAD_PORTS.has(Number(url.port))) {
    throw new GuardError('port', `Port ${url.port} is refused (non-web service port)`, url.hostname)
  }
  const host = stripBrackets(url.hostname).replace(/\.$/, '').toLowerCase()
  if (host === '') throw new GuardError('invalid_url', 'URL has no host', url.href)
  if (isIP(host) !== 0) {
    const err = checkAddress(host, host, policy)
    if (err) throw err
  } else if ((host === 'localhost' || host.endsWith('.localhost')) && !loopbackAllowed(policy)) {
    throw new GuardError('ssrf', `${host} is a local name`, host, undefined, 'loopback')
  }
  return url
}

const defaultResolve: ResolveAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, order: 'verbatim' }, (err, addresses: LookupAddress[]) => {
      if (err) reject(err)
      else resolve(addresses)
    })
  })

/** A `net.connect` lookup that refuses the whole answer if ANY address is non-public. */
export function createGuardedLookup(policy: GuardPolicy | undefined): LookupFunction {
  const resolve = policy?.resolve ?? defaultResolve
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (all) => {
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0
        const addresses = all.filter((a) => wanted === 0 || a.family === wanted)
        if (addresses.length === 0) {
          const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: 'ENOTFOUND',
            hostname,
          })
          callback(err, '', 0)
          return
        }
        for (const a of all) {
          const blocked = checkAddress(hostname, a.address, policy)
          if (blocked) {
            callback(blocked, '', 0)
            return
          }
        }
        if (options.all)
          callback(
            null,
            addresses.map((a) => ({ address: a.address, family: a.family })),
          )
        else {
          const first = addresses[0]
          callback(null, first?.address ?? '', first?.family ?? 4)
        }
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), '', 0),
    )
  }
}

export interface GuardedAgentOptions {
  policy?: GuardPolicy
  /** Concurrent connections per origin (§12.4: 1–2). Default 2. */
  connectionsPerOrigin?: 1 | 2
  /** TCP+TLS connect timeout. Default 10 s. */
  connectTimeoutMs?: number
}

/** An undici Agent that can only reach public unicast addresses. */
export function createGuardedAgent(opts: GuardedAgentOptions = {}): Agent {
  const policy = opts.policy
  assertTestOverrideAllowed(policy)
  const base = buildConnector({
    lookup: createGuardedLookup(policy),
    timeout: opts.connectTimeoutMs ?? 10_000,
  })
  const connect: buildConnector.connector = (options, callback) => {
    const host = stripBrackets(options.hostname)
    if (isIP(host) !== 0) {
      const blocked = checkAddress(host, host, policy)
      if (blocked) {
        callback(blocked, null)
        return
      }
    }
    base(options, callback)
  }
  return new Agent({
    connect,
    connections: opts.connectionsPerOrigin ?? 2,
    pipelining: 1,
    keepAliveTimeout: 4_000,
  })
}
