// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { classifyMatch, parseMatch, testMatch } from './match.ts'
import { normalizeHost, normalizeUrl } from './normalize.ts'
import { urlPatternToRegex } from './pattern.ts'
import { compileRegex, findNonLinearSyntax } from './regex.ts'

const spoof = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/rules/spoof-cases.json', import.meta.url), 'utf8'),
) as { cases: { match: string; url: string; matches: boolean; note: string }[] }

const matches = (expr: string, url: string): boolean => {
  const m = parseMatch(expr)
  if (!m.ok) throw new Error(m.error)
  const n = normalizeUrl(url)
  return n !== null && testMatch(m.match, n, n.href.toLowerCase())
}

describe('golden match fixtures (test/fixtures/rules/spoof-cases.json)', () => {
  it.each(spoof.cases)('$match vs $url: $note', (c) => {
    expect(matches(c.match, c.url)).toBe(c.matches)
  })
})

describe('normalizeUrl', () => {
  it('normalises losslessly', () => {
    expect(normalizeUrl('HTTPS://WWW.Example.COM.:443/Path/A?b=C&a=1#frag')).toEqual({
      href: 'https://www.example.com/Path/A?b=C&a=1',
      scheme: 'https',
      host: 'www.example.com',
      pathQuery: '/Path/A?b=C&a=1',
      ip: false,
    })
  })
  it('keeps a non-default port, drops userinfo, keeps an empty query marker', () => {
    expect(normalizeUrl('http://u:p@example.com:8080/x?')?.href).toBe('http://example.com:8080/x?')
  })
  it('converts IDNA to punycode', () => {
    expect(normalizeUrl('https://Bücher.de/ü')?.href).toBe('https://xn--bcher-kva.de/%C3%BC')
  })
  it('rejects junk', () => {
    expect(normalizeUrl('not a url')).toBeNull()
    expect(normalizeUrl('mailto:x@example.com')).toBeNull()
  })
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.webUrl({ withFragments: true, withQueryParameters: true }), (u) => {
        const once = normalizeUrl(u)
        if (once === null) return
        expect(normalizeUrl(once.href)).toEqual(once)
      }),
    )
  })
})

describe('normalizeHost', () => {
  it.each([
    ['Example.COM.', 'example.com'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['[::1]', '[::1]'],
    ['x_y.example', 'x_y.example'],
  ])('%s → %s', (input, out) => {
    expect(normalizeHost(input)).toBe(out)
  })
  it.each(['', 'a b.com', 'x.com:80', 'x.com/p', 'u@x.com', '*.x.com', 'x.com?q', '.'])(
    'rejects %j',
    (input) => {
      expect(normalizeHost(input)).toBeNull()
    },
  )
})

describe('domain label boundary (property)', () => {
  const label = fc.stringMatching(/^[a-z0-9]{1,12}$/)
  it('d matches d and sub.d, never <prefix>d or d.<suffix>', () => {
    fc.assert(
      fc.property(label, label, label, (sub, name, extra) => {
        const d = `${name}.com`
        expect(matches(d, `https://${d}/`)).toBe(true)
        expect(matches(d, `https://${sub}.${d}/`)).toBe(true)
        expect(matches(`*.${d}`, `https://${sub}.${d}/`)).toBe(true)
        expect(matches(d, `https://${extra}${d}/`)).toBe(false)
        expect(matches(d, `https://${d}.${extra}.example/`)).toBe(false)
      }),
    )
  })
})

describe('classifyMatch', () => {
  it.each([
    ['pinterest.com', 'domain'],
    ['*.medium.com', 'domain'],
    ['=example.com', 'exact_host'],
    ['github.com/orgname/', 'host_path'],
    ['*.github.com/orgname/', 'host_path'],
    ['=www.github.com/orgname/', 'host_path'],
    ['|https://*.example.*/amp/^', 'url_pattern'],
    ['||example.com^', 'url_pattern'],
    ['*example.com', 'url_pattern'],
    ['https://example.com/x', 'url_pattern'],
    ['/-tutorial-.*\\.xyz$/', 'regex'],
    ['/x/i', 'regex'],
  ] as const)('%s → %s', (text, kind) => {
    expect(classifyMatch(text)).toBe(kind)
  })
  it('rejects a kind that disagrees with the text', () => {
    expect(parseMatch('example.com', 'regex')).toMatchObject({ ok: false })
  })
  it('canonicalises', () => {
    const c = (t: string) => {
      const r = parseMatch(t)
      return r.ok ? r.match.canonical : r.error
    }
    expect(c('*.Medium.COM')).toBe('medium.com')
    expect(c('=WWW.Example.com.')).toBe('=www.example.com')
    expect(c('GitHub.com/Org/')).toBe('github.com/Org/')
    expect(c('|HTTPS://X.COM/^')).toBe('|https://x.com/^')
  })
})

describe('URL patterns', () => {
  it('translates with the Goggles ^ definition', () => {
    const r = urlPatternToRegex('|https://*.example.*/amp/^')
    expect(r).toMatchObject({ ok: true, hasPath: true, literal: '.example.' })
    if (r.ok) expect(r.source).toBe('^https://[^/?#]*\\.example\\.[^/?#]*/amp/(?:[^A-Za-z0-9_.%\\-]|$)')
  })
  it.each([
    ['a*b*c*d', "more than 2 '*'"],
    ['a^b^c^', "more than 2 '^'"],
    ['x'.repeat(501), 'longer than 500'],
    ['*', 'every URL'],
    ['|^|', 'every URL'],
    ['||', 'no content'],
  ])('rejects %j', (p, why) => {
    const r = urlPatternToRegex(p)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(why)
  })
  it('accepts exactly the caps', () => {
    expect(urlPatternToRegex('a*b*c^d^').ok).toBe(true)
    expect(urlPatternToRegex('x'.repeat(500)).ok).toBe(true)
  })
})

describe('regex rules (re2js only)', () => {
  it.each([
    ['(?=a)b', 'lookahead'],
    ['a(?!b)', 'lookahead'],
    ['(?<=a)b', 'lookbehind'],
    ['(?<!a)b', 'lookbehind'],
    ['(a)\\1', 'backreferences'],
    ['(?<n>a)\\k<n>', 'backreferences'],
  ])('rejects %s', (src, why) => {
    const r = compileRegex(src)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(why)
    expect(parseMatch(`/${src}/`).ok).toBe(false)
  })
  it('allows the same characters when escaped or inside a class', () => {
    expect(findNonLinearSyntax('\\(?=x')).toBeNull()
    expect(findNonLinearSyntax('[(?=]x')).toBeNull()
    expect(findNonLinearSyntax('\\Q(?=\\E')).toBeNull()
    expect(findNonLinearSyntax('[\\1]')).toBeNull()
    expect(compileRegex('(?<name>a)(?:b)').ok).toBe(true)
  })
  it('caps length at 1000 and reports RE2 syntax errors', () => {
    expect(compileRegex('a'.repeat(1000)).ok).toBe(true)
    expect(compileRegex('a'.repeat(1001))).toMatchObject({ ok: false })
    expect(compileRegex('a{1001}')).toMatchObject({ ok: false })
    expect(compileRegex('(')).toMatchObject({ ok: false })
  })
  it('stays linear on a classic ReDoS pattern', () => {
    const r = compileRegex('^(a+)+$')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const t0 = performance.now()
    expect(r.re.test(`${'a'.repeat(50_000)}!`)).toBe(false)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})
