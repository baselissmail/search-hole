// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  canonicalKey,
  DEFAULT_CANONICAL_RULES,
  hostOf,
  normalizeOriginal,
  registrableDomain,
} from './url.ts'

describe('normalizeOriginal (lossless, ADR-0008)', () => {
  it.each([
    ['HTTPS://Example.COM:443/Path?Q=1#frag', 'https://example.com/Path?Q=1'],
    ['http://example.com:80/a', 'http://example.com/a'],
    ['https://example.com:8443/a', 'https://example.com:8443/a'],
    ['https://example.com./a', 'https://example.com/a'],
    ['https://bücher.de/x', 'https://xn--bcher-kva.de/x'],
    ['https://www.example.com/a/?utm_source=x&b=2&a=1', 'https://www.example.com/a/?utm_source=x&b=2&a=1'],
    ['http://user:pw@example.com/', 'http://user:pw@example.com/'],
    ['  https://example.com/  ', 'https://example.com/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOriginal(input)).toBe(expected)
  })

  it('keeps scheme, www., path case, query order and trailing slash', () => {
    expect(normalizeOriginal('http://WWW.Example.com/A/B/?z=1&a=2')).toBe(
      'http://www.example.com/A/B/?z=1&a=2',
    )
  })

  it.each([
    'ftp://example.com/',
    'javascript:alert(1)',
    'mailto:a@b.com',
    'not a url',
    '//example.com/a',
    '',
    'https://',
  ])('rejects %j', (input) => {
    expect(normalizeOriginal(input)).toBeNull()
  })

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (u) => {
        const n = normalizeOriginal(u)
        if (n !== null) expect(normalizeOriginal(n)).toBe(n)
      }),
    )
  })
})

describe('hostOf and registrableDomain', () => {
  it('normalises the host', () => {
    expect(hostOf('https://WWW.Bücher.DE./x')).toBe('www.xn--bcher-kva.de')
    expect(hostOf('mailto:x@y.z')).toBeNull()
  })

  it.each([
    ['a.b.example.co.uk', 'example.co.uk'],
    ['www.example.com', 'example.com'],
    ['alice.github.io', 'alice.github.io'],
    ['www.alice.github.io', 'alice.github.io'],
    ['Example.COM.', 'example.com'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
  ])('%s → %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected)
  })
})

describe('canonicalKey (ADR-0010 §1)', () => {
  const same: [string, string][] = [
    ['http://example.com/a', 'https://example.com/a'],
    ['https://www.example.com/a', 'https://example.com/a'],
    ['https://EXAMPLE.com./a', 'https://example.com/a'],
    ['https://example.com:443/a', 'https://example.com/a'],
    ['http://example.com:80/a', 'https://example.com/a'],
    ['https://example.com/a#section', 'https://example.com/a'],
    ['https://example.com/a/', 'https://example.com/a'],
    ['https://example.com/a//', 'https://example.com/a'],
    ['https://example.com/a?utm_source=x&utm_medium=y', 'https://example.com/a'],
    ['https://example.com/a?UTM_Source=x', 'https://example.com/a'],
    ['https://example.com/a?fbclid=1&gclid=2&ref=hn&ref_src=t&spm=1&ved=2', 'https://example.com/a'],
    ['https://example.com/a?_hsenc=1&_hsmi=2&oly_enc_id=3&vero_id=4&mc_cid=5', 'https://example.com/a'],
    ['https://example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2'],
    ['https://example.com/a?q=a+b', 'https://example.com/a?q=a%20b'],
    ['https://example.com/%7Euser', 'https://example.com/~user'],
    ['https://example.com/a%2fb', 'https://example.com/a%2Fb'],
    ['https://amp.example.com/a', 'https://example.com/a'],
    ['https://m.example.com/a', 'https://example.com/a'],
    ['https://mobile.example.com/a', 'https://example.com/a'],
    ['https://en.m.wikipedia.org/wiki/RRF', 'https://en.wikipedia.org/wiki/RRF'],
    ['https://example.com/news/amp/story', 'https://example.com/news/story'],
    ['https://example.com/story/amp/', 'https://example.com/story'],
    ['https://example.com/story.amp', 'https://example.com/story'],
    ['https://example.com/story.amp.html', 'https://example.com/story.html'],
    ['https://example.com/story?amp', 'https://example.com/story'],
    ['https://example.com/story?amp=1', 'https://example.com/story'],
    ['https://example.com/story?outputType=amp', 'https://example.com/story'],
    ['https://www-example-com.cdn.ampproject.org/c/s/www.example.com/story', 'https://example.com/story'],
    [
      'https://www-example--news-com.cdn.ampproject.org/c/s/www.example-news.com/a/amp/',
      'https://example-news.com/a',
    ],
    ['https://0-ab--cd-com-0.cdn.ampproject.org/c/s/ab-cd.com/a', 'https://ab-cd.com/a'],
    [
      'https://example-com.cdn.ampproject.org/v/s/example.com/a?amp_js_v=0.1&usqp=mq331AQ',
      'https://example.com/a',
    ],
    ['https://www.google.com/amp/s/www.example.com/story', 'https://example.com/story'],
    ['https://google.co.uk/amp/s/example.com/story', 'https://example.com/story'],
    ['https://bücher.de/x', 'https://xn--bcher-kva.de/x'],
    ['https://ｇｏｏｇｌｅ.com/', 'https://google.com/'],
  ]

  it.each(same)('%s ≡ %s', (a, b) => {
    expect(canonicalKey(a)).not.toBeNull()
    expect(canonicalKey(a)).toBe(canonicalKey(b))
  })

  const different: [string, string][] = [
    ['https://youtube.com/watch?v=AAA', 'https://youtube.com/watch?v=BBB'],
    ['https://example.com/a?x=1&x=2', 'https://example.com/a?x=2&x=1'],
    ['https://example.com/Path', 'https://example.com/path'],
    ['https://example.com:8080/a', 'https://example.com/a'],
    ['https://example.com/a', 'https://notexample.com/a'],
    ['https://www.com/', 'https://com/'],
    ['https://m.co/a', 'https://co/a'],
    ['https://www.co.uk/a', 'https://co.uk/a'],
    ['https://old.reddit.com/r/x', 'https://reddit.com/r/x'],
    ['https://alice.github.io/', 'https://bob.github.io/'],
    ['https://example.com/story?amp=no', 'https://example.com/story'],
    ['https://example.com/campaign?utm=1', 'https://example.com/campaign'],
    ['https://example.com/ampere', 'https://example.com/'],
    ['https://amp.dev/about', 'https://dev/about'],
    // A cache URL whose subdomain doesn't encode the inner host is not unwrapped.
    ['https://evil-com.cdn.ampproject.org/c/s/www.example.com/story', 'https://example.com/story'],
    ['https://www-example--news-com.cdn.ampproject.org/c/s/example-news.com/a', 'https://example-news.com/a'],
  ]

  it.each(different)('%s ≢ %s', (a, b) => {
    expect(canonicalKey(a)).not.toBe(canonicalKey(b))
  })

  it('has a scheme-less, documented shape', () => {
    expect(canonicalKey('https://www.Example.com/A/?b=2&a=1#x')).toBe('//example.com/A?a=1&b=2')
    expect(canonicalKey('https://example.com')).toBe('//example.com/')
    expect(canonicalKey('https://example.com/?')).toBe('//example.com/')
    expect(canonicalKey('https://example.com:8080/x')).toBe('//example.com:8080/x')
    expect(canonicalKey('https://[::1]:8080/x/')).toBe('//[::1]:8080/x')
  })

  it('accepts its own output', () => {
    expect(canonicalKey('//example.com/a?b=1')).toBe('//example.com/a?b=1')
  })

  it.each(['ftp://example.com/', 'mailto:a@b.com', 'javascript:alert(1)', 'example.com/a', ''])(
    'rejects %j',
    (u) => {
      expect(canonicalKey(u)).toBeNull()
    },
  )

  it('counts variant marks, but not www., scheme or trailing slash', () => {
    expect(canonicalize('http://www.example.com/a/')?.marks).toBe(0)
    expect(canonicalize('https://example.com/a?utm_source=x')?.marks).toBe(1)
    expect(canonicalize('https://m.example.com/a')?.marks).toBe(1)
    expect(canonicalize('https://amp.example.com/amp/a?amp=1&utm_source=x')?.marks).toBe(4)
    expect(canonicalize('https://www-example-com.cdn.ampproject.org/c/s/www.example.com/a')?.marks).toBe(1)
  })

  it('treats the tracking list as data', () => {
    const rules = {
      ...DEFAULT_CANONICAL_RULES,
      trackingParams: { exact: [...DEFAULT_CANONICAL_RULES.trackingParams.exact, 'si'], prefixes: [] },
    }
    expect(canonicalKey('https://example.com/a?si=1', rules)).toBe('//example.com/a')
    expect(canonicalKey('https://example.com/a?si=1')).toBe('//example.com/a?si=1')
    expect(canonicalKey('https://example.com/a?utm_x=1', rules)).toBe('//example.com/a?utm_x=1')
  })

  describe('spoofing', () => {
    it.each([
      ['https://google.com@evil.com/', 'evil.com'],
      ['https://evil.com\\@google.com/', 'evil.com'],
      ['https://google.com.evil.com/', 'evil.com'],
      ['https://www.google.com.evil.com/', 'evil.com'],
      ['https://google.com%2eevil.com/', 'evil.com'],
      ['https://evil.com#@google.com', 'evil.com'],
      ['https://evil.com?@google.com', 'evil.com'],
      ['https://amp.google.com.evil.com/', 'evil.com'],
    ])('%s stays on %s', (u, domain) => {
      const key = canonicalKey(u)
      expect(key).not.toBeNull()
      const host = new URL(`https:${key}`).hostname
      expect(registrableDomain(host)).toBe(domain)
      expect(key).not.toBe(canonicalKey('https://google.com/'))
    })

    it('keeps homoglyph hosts apart (IDNA punycode)', () => {
      expect(canonicalKey('https://gооgle.com/')).toBe('//xn--ggle-55da.com/') // Cyrillic о
      expect(canonicalKey('https://gооgle.com/')).not.toBe(canonicalKey('https://google.com/'))
      expect(canonicalKey('https://www.раураl.com/')).not.toBe(canonicalKey('https://paypal.com/'))
    })

    it('never strips into the registrable domain', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('www', 'm', 'amp', 'mobile'),
          fc.constantFrom('com', 'co.uk', 'github.io', 'org'),
          (label, suffix) => {
            const key = canonicalKey(`https://${label}.${suffix}/`)
            expect(key).toBe(`//${label}.${suffix}/`)
          },
        ),
      )
    })
  })

  describe('properties', () => {
    const variantUrl = fc
      .record({
        scheme: fc.constantFrom('http', 'https'),
        prefix: fc.constantFrom('', 'www.', 'm.', 'amp.', 'mobile.', 'en.m.', 'docs.'),
        domain: fc.constantFrom('example.com', 'example.co.uk', 'alice.github.io', 'bücher.de', 'x-y.org'),
        port: fc.constantFrom('', ':80', ':443', ':8080'),
        segments: fc.array(fc.constantFrom('a', 'B', 'amp', 'x.amp', '%7Ey', '%2f', '', 'é', 'a b'), {
          maxLength: 4,
        }),
        trailing: fc.boolean(),
        params: fc.array(
          fc.tuple(
            fc.constantFrom('v', 'q', 'utm_source', 'amp', 'outputType', 'ref', 'Z', 'a'),
            fc.constantFrom('', '1', 'amp', 'x y', '+', '%2B', 'é'),
          ),
          { maxLength: 4 },
        ),
        hash: fc.constantFrom('', '#top', '#'),
      })
      .map(({ scheme, prefix, domain, port, segments, trailing, params, hash }) => {
        const path = `/${segments.join('/')}${trailing ? '/' : ''}`
        const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : ''
        return `${scheme}://${prefix}${domain}${port}${path}${query}${hash}`
      })

    const anyUrl = fc.oneof(variantUrl, fc.webUrl({ withQueryParameters: true, withFragments: true }))

    it('is idempotent: canon(canon(u)) = canon(u)', () => {
      fc.assert(
        fc.property(anyUrl, (u) => {
          const k = canonicalKey(u)
          if (k !== null) expect(canonicalKey(k)).toBe(k)
        }),
        { numRuns: 2000 },
      )
    })

    it('agrees with the lossless form: canon(normalizeOriginal(u)) = canon(u)', () => {
      fc.assert(
        fc.property(anyUrl, (u) => {
          const n = normalizeOriginal(u)
          if (n !== null) expect(canonicalKey(n)).toBe(canonicalKey(u))
        }),
      )
    })

    it('never merges different v= values', () => {
      fc.assert(
        fc.property(variantUrl, fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (base, v1, v2) => {
          fc.pre(v1 !== v2)
          const u = new URL(base)
          u.searchParams.delete('v')
          const a = new URL(u)
          a.searchParams.set('v', v1)
          const b = new URL(u)
          b.searchParams.set('v', v2)
          expect(canonicalKey(a.href)).not.toBe(canonicalKey(b.href))
        }),
        { numRuns: 1000 },
      )
    })

    it('ignores parameter order and tracking parameters', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(fc.tuple(fc.constantFrom('a', 'b', 'c', 'v', 'q'), fc.string()), {
            selector: ([k]) => k,
            maxLength: 5,
          }),
          fc.constantFrom('utm_source', 'fbclid', 'gclid', 'ref'),
          (params, tracker) => {
            const a = new URL('https://example.com/p')
            for (const [k, v] of params) a.searchParams.append(k, v)
            const b = new URL('https://www.example.com/p')
            for (const [k, v] of [...params].reverse()) b.searchParams.append(k, v)
            b.searchParams.append(tracker, 'x')
            expect(canonicalKey(a.href)).toBe(canonicalKey(b.href))
          },
        ),
      )
    })
  })
})
