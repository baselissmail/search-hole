// SPDX-License-Identifier: Apache-2.0
import type { LookupAddress } from 'node:dns'
import { afterEach, describe, expect, it } from 'vitest'
import { createPageFetcher } from '../../src/fetch/fetchPage.ts'
import {
  ALLOW_LOOPBACK_FOR_TESTS,
  assertTestOverrideAllowed,
  checkUrlShape,
  createGuardedLookup,
  GuardError,
  type GuardPolicy,
  loopbackAllowed,
} from '../../src/fetch/guard.ts'
import { classifyAddress } from '../../src/fetch/ip.ts'
import { SearchHoleError } from '../../src/shared/errors.ts'
import { fakeDns, neverBlocked, startServer, type TestServer, testPolicy } from './helpers.ts'

describe('classifyAddress (SSRF matrix)', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'linkLocal'],
    ['100.64.0.1', 'carrierGradeNat'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['198.51.100.7', 'reserved'],
    ['203.0.113.9', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'linkLocal'],
    ['::127.0.0.1', 'ipv4Compatible'],
    ['fe80::1', 'linkLocal'],
    ['fc00::1', 'uniqueLocal'],
    ['fd12:3456::1', 'uniqueLocal'],
    ['fec0::1', 'deprecatedSiteLocal'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'reserved'],
    ['3fff::1', 'reserved'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'linkLocal'],
    ['64:ff9b:1::1', 'rfc6052'],
    ['2002:7f00:1::1', 'loopback'],
    ['2002:c0a8:101::1', 'private'],
    ['2001::1', 'teredo'],
    ['::8.8.8.8', 'ipv4Compatible'],
    ['100::1', 'discard'],
    ['fe80::1%eth0', 'scoped'],
    ['not-an-ip', 'invalid'],
  ])('%s is refused (%s)', (ip, range) => {
    const v = classifyAddress(ip)
    expect(v.allowed).toBe(false)
    if (!v.allowed) expect(v.range).toBe(range)
  })

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is public', (ip) => {
    expect(classifyAddress(ip).allowed).toBe(true)
  })

  it('the loopback override admits loopback only', () => {
    const opts = { allowLoopback: true }
    expect(classifyAddress('127.0.0.1', opts).allowed).toBe(true)
    expect(classifyAddress('::1', opts).allowed).toBe(true)
    expect(classifyAddress('10.0.0.1', opts).allowed).toBe(false)
    expect(classifyAddress('169.254.169.254', opts).allowed).toBe(false)
    expect(classifyAddress('0.0.0.0', opts).allowed).toBe(false)
  })
})

describe('checkUrlShape', () => {
  const reason = (url: string, policy?: GuardPolicy): string => {
    try {
      checkUrlShape(url, policy)
      return 'ok'
    } catch (err) {
      return err instanceof GuardError ? err.reason : 'other'
    }
  }

  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['ftp://example.com/', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,hi', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    ['http://user:pw@example.com/', 'credentials'],
    ['http://user@example.com/', 'credentials'],
    ['http://example.com:22/', 'port'],
    ['http://example.com:25/', 'port'],
    ['http://127.0.0.1/', 'ssrf'],
    ['http://2130706433/', 'ssrf'],
    ['http://0177.0.0.1/', 'ssrf'],
    ['http://0x7f.1/', 'ssrf'],
    ['http://127.1/', 'ssrf'],
    ['http://[::1]/', 'ssrf'],
    ['http://[::ffff:127.0.0.1]/', 'ssrf'],
    ['http://[::127.0.0.1]/', 'ssrf'],
    ['http://0.0.0.0/', 'ssrf'],
    ['http://0/', 'ssrf'],
    ['http://169.254.169.254/latest/meta-data/', 'ssrf'],
    ['http://10.0.0.1/', 'ssrf'],
    ['http://[fd00::1]/', 'ssrf'],
    ['http://localhost/', 'ssrf'],
    ['http://LOCALHOST./', 'ssrf'],
    ['http://api.localhost/', 'ssrf'],
    ['not a url', 'invalid_url'],
  ])('%s → %s', (url, expected) => {
    expect(reason(url)).toBe(expected)
  })

  it.each([
    'https://example.com/',
    'http://example.com:8080/path?q=1',
    'http://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
  ])('%s passes', (url) => {
    expect(reason(url)).toBe('ok')
  })

  it('the test policy admits loopback literals and localhost, nothing else', () => {
    const policy = testPolicy()
    expect(reason('http://127.0.0.1:8080/', policy)).toBe('ok')
    expect(reason('http://localhost:8080/', policy)).toBe('ok')
    expect(reason('http://10.0.0.1/', policy)).toBe('ssrf')
    expect(reason('http://169.254.169.254/', policy)).toBe('ssrf')
  })
})

describe('guarded lookup', () => {
  const lookup = (policy: GuardPolicy, host: string, all: boolean) =>
    new Promise<{ err: Error | null; address: string | LookupAddress[] }>((resolve) => {
      createGuardedLookup(policy)(host, { all, family: 0 }, (err, address) => resolve({ err, address }))
    })

  const dns = fakeDns({
    'public.test': '93.184.216.34',
    'private.test': '10.0.0.5',
    'mixed.test': ['93.184.216.34', '127.0.0.1'],
    'metadata.test': '169.254.169.254',
    'v6.test': ['2606:4700:4700::1111', 'fd00::1'],
  })

  it('returns public answers in both callback shapes', async () => {
    expect((await lookup({ resolve: dns }, 'public.test', true)).address).toEqual([
      { address: '93.184.216.34', family: 4 },
    ])
    expect((await lookup({ resolve: dns }, 'public.test', false)).address).toBe('93.184.216.34')
  })

  it.each(['private.test', 'mixed.test', 'metadata.test', 'v6.test'])(
    'refuses %s when any address is non-public',
    async (host) => {
      const { err } = await lookup({ resolve: dns }, host, true)
      expect(err).toBeInstanceOf(GuardError)
    },
  )

  it('re-checks on every lookup (DNS rebinding: public first, private next)', async () => {
    let calls = 0
    const rebinding = async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
    expect((await lookup({ resolve: rebinding }, 'rebind.test', false)).err).toBeNull()
    expect((await lookup({ resolve: rebinding }, 'rebind.test', false)).err).toBeInstanceOf(GuardError)
  })

  it('passes resolver errors through', async () => {
    const { err } = await lookup({ resolve: dns }, 'nxdomain.test', true)
    expect((err as { code?: string }).code).toBe('ENOTFOUND')
  })
})

describe('guarded agent against a real socket', () => {
  let server: TestServer
  afterEach(async () => {
    await server?.close()
  })

  it('refuses a hostname that resolves to loopback when the override is off', async () => {
    server = await startServer((_req, res) => {
      res.end('secret')
    })
    const fetcher = createPageFetcher({
      guard: { resolve: fakeDns({ 'evil.test': '127.0.0.1' }) },
      robots: false,
    })
    const err = await fetcher
      .fetchPage(`http://evil.test:${server.port}/`, { isBlocked: neverBlocked })
      .catch((e: unknown) => e)
    await fetcher.close()
    expect(err).toBeInstanceOf(SearchHoleError)
    expect((err as SearchHoleError).code).toBe('fetch_blocked')
    expect((err as SearchHoleError).details).toMatchObject({
      reason: 'ssrf',
      address: '127.0.0.1',
      range: 'loopback',
    })
    expect(server.seen).toHaveLength(0)
  })

  it('the same hostname works under the test-only override', async () => {
    server = await startServer((_req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end('hello')
    })
    const fetcher = createPageFetcher({
      guard: testPolicy(fakeDns({ 'evil.test': '127.0.0.1' })),
      robots: false,
    })
    const out = await fetcher.fetchPage(`http://evil.test:${server.port}/`, { isBlocked: neverBlocked })
    await fetcher.close()
    expect(out.text).toBe('hello')
    expect(server.seen[0]?.host).toBe(`evil.test:${server.port}`)
  })
})

describe('test-only override', () => {
  it('cannot come from parsed config', () => {
    const fromJson = JSON.parse(
      '{"allowLoopbackForTests":true,"ALLOW_LOOPBACK_FOR_TESTS":true}',
    ) as GuardPolicy
    expect(loopbackAllowed(fromJson)).toBe(false)
    const lookalike = { [Symbol('search-hole/allow-loopback-for-tests')]: true } as unknown as GuardPolicy
    expect(loopbackAllowed(lookalike)).toBe(false)
    const registered = {
      [Symbol.for('search-hole/allow-loopback-for-tests')]: true,
    } as unknown as GuardPolicy
    expect(loopbackAllowed(registered)).toBe(false)
    const cloned = structuredClone({ [ALLOW_LOOPBACK_FOR_TESTS]: true }) as GuardPolicy
    expect(loopbackAllowed(cloned)).toBe(false)
  })

  it('is refused outside a test runner', () => {
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV }
    delete process.env.VITEST
    process.env.NODE_ENV = 'production'
    try {
      expect(() => assertTestOverrideAllowed(testPolicy())).toThrow(GuardError)
      expect(() => createPageFetcher({ guard: testPolicy() })).toThrow(GuardError)
      expect(() => assertTestOverrideAllowed({})).not.toThrow()
    } finally {
      if (saved.VITEST === undefined) delete process.env.VITEST
      else process.env.VITEST = saved.VITEST
      if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved.NODE_ENV
    }
  })
})
