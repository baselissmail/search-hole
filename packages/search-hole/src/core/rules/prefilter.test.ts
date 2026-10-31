// SPDX-License-Identifier: Apache-2.0
/**
 * The pattern prefilter must never change what matches: its literal and host
 * extraction is checked for soundness against re2js itself, and the bucketed
 * index is checked against a linear scan over adversarial URLs.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type ParsedMatch, parseMatch, testMatch } from './match.ts'
import { isIpHost, normalizeHost, normalizeUrl } from './normalize.ts'
import { PatternIndex, patternHostKey, requiredLiterals } from './prefilter.ts'
import { compileRegex } from './regex.ts'

describe('requiredLiterals', () => {
  it.each([
    ['^https?:\\/\\/(www\\.)?example\\.com\\/', ['http', '://', 'example.com/']],
    ['ab?c', ['a', 'c']],
    ['abc+d', ['abc', 'd']],
    ['a{0,2}b', ['b']],
    ['xa{2,}y', ['xa', 'y']],
    ['\\012xy', ['xy']],
    ['[abc]def', ['def']],
    ['[]a]bc', ['bc']],
    ['[[:alpha:]]bc', ['bc']],
    ['(?i)Foo', ['foo']],
    ['\\x{263a}abc\\pLde\\p{Greek}fg', ['abc', 'de', 'fg']],
    ['\\Qa.b\\Ecd', ['cd']],
    ['pinterest.+\\/user', ['pinterest', '/user']],
    ['(a|b)cd', ['cd']],
    ['a*?bc', ['bc']],
  ])('%s → %j', (src, runs) => {
    expect(requiredLiterals(src)).toEqual(runs)
  })

  it.each(['a|b', 'x{', 'a{,3}', '(ab', 'ab)', '[ab'])('gives up on %s', (src) => {
    expect(requiredLiterals(src)).toBeNull()
  })

  // A regex built from atoms, with a string that the regex matches by construction.
  type Gen = { src: string; sample: string }
  const ALPHA = ['a', 'b', 'c', 'K', 'S', 'x', '1', '-', '_', '/', ':', '%', '=', '&']
  const atom: fc.Arbitrary<Gen> = fc.letrec<{ atom: Gen; seq: Gen }>((tie) => ({
    atom: fc.oneof(
      { weight: 6, arbitrary: fc.constantFrom(...ALPHA).map((c) => ({ src: c, sample: c })) },
      {
        weight: 2,
        arbitrary: fc.constantFrom('.', '/', '?', '+', '(').map((c) => ({ src: `\\${c}`, sample: c })),
      },
      { weight: 1, arbitrary: fc.constantFrom('a', 'Z', '7', '%').map((c) => ({ src: '.', sample: c })) },
      { weight: 1, arbitrary: fc.constantFrom('a', 'b').map((c) => ({ src: '[ab]', sample: c })) },
      { weight: 1, arbitrary: fc.constantFrom('3', '9').map((c) => ({ src: '\\d', sample: c })) },
      {
        weight: 1,
        arbitrary: fc
          .tuple(tie('seq') as fc.Arbitrary<Gen>, tie('seq') as fc.Arbitrary<Gen>, fc.boolean())
          .map(([l, r, left]) => ({ src: `(?:${l.src}|${r.src})`, sample: left ? l.sample : r.sample })),
      },
    ),
    seq: fc
      .array(
        fc.tuple(
          tie('atom') as fc.Arbitrary<Gen>,
          fc.constantFrom('', '', '', '?', '*', '+', '{2}', '{0,1}', '{1,}', '*?'),
          fc.nat({ max: 2 }),
        ),
        { minLength: 1, maxLength: 6 },
      )
      .map((parts) =>
        parts.reduce<Gen>(
          (acc, [a, q, k]) => {
            const min = q === '' || q === '+' || q === '{1,}' ? 1 : q === '{2}' ? 2 : 0
            const max = q === '' ? 1 : q === '?' || q === '{0,1}' ? 1 : q === '{2}' ? 2 : 3
            const reps = Math.min(max, min + k)
            return { src: acc.src + a.src + q, sample: acc.sample + a.sample.repeat(reps) }
          },
          { src: '', sample: '' },
        ),
      ),
  })).seq

  it('every literal run occurs (lower-cased) in any URL the regex matches', () => {
    fc.assert(
      fc.property(atom, fc.boolean(), fc.string({ maxLength: 4 }), (g, ci, pad) => {
        const compiled = compileRegex(g.src, ci)
        fc.pre(compiled.ok)
        if (!compiled.ok) return
        const runs = requiredLiterals(g.src)
        if (runs === null) return
        const href = `https://h.example/${encodeURIComponent(pad)}${ci ? g.sample.toUpperCase() : g.sample}`
        const lower = href.toLowerCase()
        if (!compiled.re.test(href)) return
        for (const r of runs) expect(lower.includes(r), `${g.src} on ${href}: missing ${r}`).toBe(true)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('patternHostKey', () => {
  it.each([
    ['||example.com^', 'example.com'],
    ['||example.com/amp/', 'example.com'],
    ['||example.com:8080/', 'example.com'],
    ['||example.com|', 'example.com'],
    ['|https://*.example.com/', 'example.com'],
    ['|http*://example.com/x', 'example.com'],
    ['|*://example.com^', 'example.com'],
    ['||example.com', null],
    ['||example.com*', null],
    ['|https://*example.com/', null],
    ['|https://*.example.*/amp/^', null],
    ['example.com/', null],
    ['*example.com^', null],
    ['||*.example.com^', null],
  ])('%s → %s', (p, key) => {
    expect(patternHostKey(p)).toBe(key)
  })
})

// ── Index ≡ linear scan ──────────────────────────────────────────────────

const HOSTS = ['example.com', 'www.example.com', 'a.b.example.com', 'example.co', 'notexample.com', 'x.io']
const host = fc.constantFrom(...HOSTS)
const word = fc.constantFrom('amp', 'blog', 'user', 'pinterest', 'r', 'rust', 'a', 'ab', 'abc', 'docs', '%41')
const patternArb: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(host, word).map(([h, w]) => `||${h}^${w}`),
  fc.tuple(host, word).map(([h, w]) => `||${h}/${w}/`),
  fc.tuple(host, word).map(([h, w]) => `|https://*.${h}/${w}`),
  fc.tuple(host, word).map(([h, w]) => `|http*://${h}/${w}|`),
  fc.tuple(host, word).map(([h, w]) => `|https://*${h}/*${w}`),
  fc.tuple(word, word).map(([a, b]) => `*${a}*${b}`),
  fc.tuple(word, word).map(([a, b]) => `/${a}/${b}^`),
  host.map((h) => `||${h}`),
  word.map((w) => `*.${w}`),
  fc.tuple(host, word).map(([h, w]) => `/^https?:\\/\\/(?:[^/]+\\.)?${h.replace(/\./g, '\\.')}\\/${w}/`),
  fc.tuple(word, word).map(([a, b]) => `/${a}.+\\/${b}/i`),
  fc.tuple(word, word).map(([a, b]) => `/(?:${a}|${b})x/`),
  word.map((w) => `/${w.toUpperCase()}/`),
  word.map((w) => `/${w}/i`),
  fc.constantFrom('/\\d{3}/', '/^https:/', '/[a-z]{2}\\.io/', '/k/i', '/S/i'),
)
const urlArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('https', 'http', 'HTTPS', 'ftp'),
      fc.oneof(host, fc.constantFrom('EXAMPLE.com', 'ex!ample.com', '[::1]', '1.2.3.4', 'xn--bcher-kva.de')),
      fc.constantFrom('', ':8080'),
      fc.array(word, { maxLength: 3 }),
      fc.constantFrom('', '?q=amp', '?u=https://example.com/amp/', '#frag', '/ü', '/K'),
    )
    .map(([s, h, port, path, tail]) => `${s}://${h}${port}/${path.join('/')}${tail}`),
  fc.webUrl({ withQueryParameters: true, withFragments: true }),
)

interface E {
  id: number
  match: ParsedMatch
}

describe('PatternIndex', () => {
  it('returns exactly the entries a linear scan returns', () => {
    fc.assert(
      fc.property(
        fc.array(patternArb, { maxLength: 40 }),
        fc.array(urlArb, { minLength: 1, maxLength: 8 }),
        (pats, urls) => {
          const index = new PatternIndex<E>()
          const all: E[] = []
          pats.forEach((p, id) => {
            const parsed = parseMatch(p)
            if (!parsed.ok || (parsed.match.kind !== 'url_pattern' && parsed.match.kind !== 'regex')) return
            const e = { id, match: parsed.match }
            all.push(e)
            index.add(e)
          })
          for (const raw of urls) {
            const url = normalizeUrl(raw)
            if (!url) continue
            const lower = url.href.toLowerCase()
            const test = (e: E) => testMatch(e.match, url, lower)
            const got: E[] = []
            index.collect(url, lower, test, got)
            const want = all.filter(test)
            expect(got.map((e) => e.id).sort((a, b) => a - b)).toEqual(want.map((e) => e.id))
          }
        },
      ),
      { numRuns: 400 },
    )
  })

  it('buckets host-anchored patterns by host and regexes by a literal', () => {
    const index = new PatternIndex<E>()
    for (const [i, p] of [
      '||a.com^x',
      '|https://*.b.com/',
      '*amp*',
      '/pinterest.+\\/user/',
      '/\\d+/',
    ].entries()) {
      const parsed = parseMatch(p)
      if (parsed.ok) index.add({ id: i, match: parsed.match })
    }
    expect(index.stats).toEqual({ host: 2, gram: 2, rest: 1 })
  })
})

// ── normalizeHost fast path ──────────────────────────────────────────────

/** normalizeHost as it was before the ASCII fast path: always through the URL parser. */
function slowNormalizeHost(text: string): string | null {
  const t = text.trim().replace(/\.+$/, '')
  if (t === '' || t.length > 253 || /[\s/?#@\\*^|=:]/.test(t.replace(/^\[[0-9a-fA-F:.]+\]$/, ''))) return null
  let u: URL
  try {
    u = new URL(`http://${t}/`)
  } catch {
    return null
  }
  if (u.port !== '' || u.pathname !== '/' || u.username !== '' || u.search !== '') return null
  const h = u.hostname.replace(/\.+$/, '')
  if (isIpHost(h)) return h
  return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(h) ? h : null
}

describe('normalizeHost fast path', () => {
  const label = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/),
    fc.constantFrom(
      'xn--bcher-kva',
      'XN--zz',
      'xn--',
      '0x',
      '0x7f',
      '0X1g',
      '123',
      '0',
      '08',
      '1e3',
      '-a',
      'a-',
    ),
  )
  it('agrees with the URL parser on dotted ASCII names', () => {
    fc.assert(
      fc.property(
        fc.array(label, { minLength: 1, maxLength: 5 }),
        fc.constantFrom('', '.', '..'),
        (labels, dot) => {
          const text = labels.join('.') + dot
          expect(normalizeHost(text)).toBe(slowNormalizeHost(text))
        },
      ),
      { numRuns: 3000 },
    )
  })
  it.each(['1.2.3', '0x7f.1', 'a.0x10', 'foo.123', 'Example.COM', 'xn--bcher-kva.de', 'a..b', 'a_b.com'])(
    '%s',
    (text) => {
      expect(normalizeHost(text)).toBe(slowNormalizeHost(text))
    },
  )
})
