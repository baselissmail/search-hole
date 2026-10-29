// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { classifyHttp, classifyNetworkError, parseRetryAfter, requestNeverLeft } from './errors.ts'

const NOW = Date.parse('2026-10-30T12:00:00Z')

describe('classifyHttp', () => {
  const none = {}
  it.each([
    [200, none, '', null],
    [204, none, '', null],
    [301, none, '', 'malformed'],
    [302, none, '', 'malformed'],
    [400, none, '', 'malformed'],
    [401, none, '', 'auth'],
    [402, none, '', 'quota'],
    [403, none, 'Forbidden', 'forbidden'],
    [404, none, '', 'malformed'],
    [408, none, '', 'timeout'],
    [422, none, '', 'malformed'],
    [429, none, 'Too Many Requests', 'rate_limited'],
    [432, none, '', 'quota'],
    [433, none, '', 'quota'],
    [500, none, '', 'server'],
    [502, none, '', 'server'],
    [503, none, '', 'server'],
    [504, none, '', 'server'],
  ] as const)('status %i gives %s', (status, headers, body, expected) => {
    expect(classifyHttp(status, headers, body)).toBe(expected)
  })

  it('reads quota out of a 429 body', () => {
    expect(classifyHttp(429, {}, '{"error":{"code":"QUOTA_LIMITED"}}')).toBe('quota')
    expect(classifyHttp(429, {}, 'You have exceeded your monthly usage limit')).toBe('quota')
  })

  it('does not mistake "rate limit exceeded for plan" for a quota', () => {
    expect(classifyHttp(429, {}, 'Request rate limit exceeded for plan.')).toBe('rate_limited')
  })

  it('detects challenge pages as captcha', () => {
    expect(classifyHttp(403, {}, '<title>Attention Required! | Cloudflare</title>')).toBe('captcha')
    expect(classifyHttp(403, { 'cf-mitigated': 'challenge' }, '')).toBe('captcha')
    expect(classifyHttp(429, {}, 'Please solve the CAPTCHA')).toBe('captcha')
    expect(classifyHttp(503, {}, 'unusual traffic from your network')).toBe('captcha')
  })
})

describe('classifyNetworkError', () => {
  it.each([
    ['ECONNREFUSED', 'unreachable'],
    ['ECONNRESET', 'unreachable'],
    ['EHOSTUNREACH', 'unreachable'],
    ['UND_ERR_SOCKET', 'unreachable'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'unreachable'],
    ['something unexpected', 'unreachable'],
    ['ENOTFOUND', 'offline'],
    ['EAI_AGAIN', 'offline'],
    ['ENETUNREACH', 'offline'],
    ['AbortError', 'cancelled'],
    ['ABORT_ERR', 'cancelled'],
    ['ETIMEDOUT', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['TimeoutError', 'timeout'],
    ['TimeoutError: The operation was aborted due to timeout', 'timeout'],
  ] as const)('%s gives %s', (code, expected) => {
    expect(classifyNetworkError(code)).toBe(expected)
  })
})

describe('requestNeverLeft', () => {
  it('is true only when the connection failed before sending', () => {
    for (const code of [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      expect(requestNeverLeft(code)).toBe(true)
    }
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'AbortError',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ]) {
      expect(requestNeverLeft(code)).toBe(false)
    }
  })
})

describe('parseRetryAfter', () => {
  it('reads Retry-After in seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '120' }, NOW)).toBe(120_000)
    expect(parseRetryAfter({ 'retry-after': '1.5' }, NOW)).toBe(1500)
    expect(parseRetryAfter({ 'retry-after': '0' }, NOW)).toBe(0)
  })

  it('reads Retry-After as an HTTP date', () => {
    expect(parseRetryAfter({ 'retry-after': 'Fri, 30 Oct 2026 12:02:00 GMT' }, NOW)).toBe(120_000)
    expect(parseRetryAfter({ 'retry-after': 'Fri, 30 Oct 2026 11:00:00 GMT' }, NOW)).toBe(0)
  })

  it('prefers retry-after-ms over Retry-After', () => {
    expect(parseRetryAfter({ 'retry-after-ms': '250', 'retry-after': '10' }, NOW)).toBe(250)
  })

  it('treats a small x-ratelimit-reset as seconds and a large one as a Unix epoch', () => {
    expect(parseRetryAfter({ 'x-ratelimit-reset': '45' }, NOW)).toBe(45_000)
    const epoch = Math.floor(NOW / 1000) + 90
    expect(parseRetryAfter({ 'x-ratelimit-reset': String(epoch) }, NOW)).toBe(90_000)
    expect(parseRetryAfter({ 'x-ratelimit-reset': String(epoch * 1000) }, NOW)).toBe(90_000)
  })

  it('picks the exhausted window of Brave-style comma-separated headers', () => {
    const headers = { 'x-ratelimit-reset': '1, 1419704', 'x-ratelimit-remaining': '0, 4880' }
    expect(parseRetryAfter(headers, NOW)).toBe(1000)
    const monthly = { 'x-ratelimit-reset': '1, 1419704', 'x-ratelimit-remaining': '1, 0' }
    expect(parseRetryAfter(monthly, NOW)).toBe(1_419_704_000)
    const unknown = { 'x-ratelimit-reset': '7, 3600' }
    expect(parseRetryAfter(unknown, NOW)).toBe(7000)
  })

  it('takes the smallest of the x-ratelimit-reset-* durations', () => {
    expect(
      parseRetryAfter(
        {
          'x-ratelimit-reset-requests': '1m30s',
          'x-ratelimit-reset-tokens': '250ms',
          'x-ratelimit-reset-requests-day': '2h',
        },
        NOW,
      ),
    ).toBe(250)
    expect(parseRetryAfter({ 'x-ratelimit-reset-tokens-minute': '20' }, NOW)).toBe(20_000)
  })

  it('returns undefined when the server says nothing useful', () => {
    expect(parseRetryAfter({}, NOW)).toBeUndefined()
    expect(parseRetryAfter({ 'retry-after': 'soon' }, NOW)).toBeUndefined()
    expect(parseRetryAfter({ 'x-ratelimit-reset': 'later' }, NOW)).toBeUndefined()
  })

  it('accepts mixed-case header names', () => {
    expect(parseRetryAfter({ 'Retry-After': '5' }, NOW)).toBe(5000)
  })

  it('never returns a negative, non-finite or absurd value', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            'retry-after',
            'retry-after-ms',
            'x-ratelimit-reset',
            'x-ratelimit-remaining',
            'x-ratelimit-reset-requests',
          ),
          fc.string(),
        ),
        (headers) => {
          const ms = parseRetryAfter(headers, NOW)
          if (ms !== undefined) {
            expect(Number.isFinite(ms)).toBe(true)
            expect(ms).toBeGreaterThanOrEqual(0)
            expect(ms).toBeLessThanOrEqual(366 * 24 * 60 * 60_000)
          }
        },
      ),
    )
  })
})
