// SPDX-License-Identifier: Apache-2.0
/**
 * Importer fuzzing (MASTER_PLAN P6 "golden tests and fuzzing"; ADR-0008
 * "Lists are permissive"): arbitrary text and arbitrary near-valid lines, in
 * every format and every list kind, never throw; every rule produced compiles;
 * the counters add up; re-importing is deterministic; the caps hold.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compileRuleSet } from '../../src/core/rules/engine.ts'
import { classifyMatch } from '../../src/core/rules/match.ts'
import { type ImportResult, importList, SKIPPED_SAMPLE, toListInput } from '../../src/lists/import/index.ts'
import type { ListFormat } from '../../src/lists/yaml.ts'
import type { ListKind } from '../../src/shared/types.ts'

const FORMATS: readonly ListFormat[] = [
  'auto',
  'ublacklist',
  'abp',
  'adguard',
  'hosts',
  'domains',
  'goggles',
  'searchhole',
]
const KINDS: readonly ListKind[] = ['block', 'allow', 'official', 'content-farm', 'clone']

/** Fragments of every supported syntax, plus the characters that break naive parsers. */
const TOKENS = [
  '||',
  '@@',
  '@',
  '@3 ',
  '@0',
  '@99 ',
  '^',
  '|',
  '*',
  '$',
  ',',
  '=',
  '~',
  '$important',
  '$badfilter',
  '$important,badfilter',
  '$document',
  '$dnstype=A',
  '$third-party',
  '$match-case',
  '*://',
  '*://*.',
  'https://',
  'http://',
  'ftp://',
  '/',
  '\\',
  '\\/',
  '\\u0041',
  '\\d',
  '.',
  '.+',
  '(?!',
  '(?<=',
  '(',
  ')',
  '(?:',
  '|',
  '[',
  ']',
  '[^]',
  '{2}',
  '{',
  '}',
  '?',
  '+',
  '#',
  '##',
  '#@#',
  '#?#',
  '$$',
  '!',
  '! Title: x',
  '! Expires: 2d',
  '! name: g',
  '!#include x',
  'site=',
  '$site=',
  '$boost',
  '$boost=',
  '$downrank=',
  'discard',
  '$discard',
  'boost',
  'inurl',
  'intitle',
  '0.0.0.0 ',
  '127.0.0.1 ',
  ':: ',
  '192.168.0.1 ',
  'localhost',
  'ip6-x',
  'example.com',
  'www.',
  'xn--',
  'xn--bcher-kva',
  'bücher',
  'ü',
  '\uD800',
  '\uDC00',
  '\u0000',
  ' ',
  '\t',
  '---',
  'name: x',
  'license: MIT',
  'title/',
  'url/',
  'u/',
  '<all_urls>',
  '@if(',
  'version: 1',
  'rules:',
  '  - { match: a.com, action: block }',
  '- match: [',
  '5',
  '12',
  '0x7f',
  '1.2.3',
  'amp',
  '%41',
  'a'.repeat(300),
] as const

const lineArb = fc.array(fc.constantFrom(...TOKENS), { maxLength: 8 }).map((ts) => ts.join(''))
const nearValidArb = fc
  .tuple(fc.array(lineArb, { maxLength: 30 }), fc.constantFrom('\n', '\r\n', '\r'), fc.boolean())
  .map(([lines, sep, bom]) => (bom ? '\uFEFF' : '') + lines.join(sep))
/** Valid lines of every format over a few names, so duplicates, merges and cancels happen. */
const validLineArb = fc
  .tuple(
    fc.constantFrom('a.example', 'www.a.example', 'b.example', 'bücher.example'),
    fc.integer({ min: 0, max: 12 }),
    fc.constantFrom('amp', 'blog', 'x'),
    fc.integer({ min: 0, max: 15 }),
  )
  .map(([d, n, w, k]) => {
    const e = d.replace(/\./g, '\\.')
    return [
      `*://*.${d}/*`,
      `*://${d}/${w}/*`,
      `@*://*.${d}/*`,
      `@${n} *://*.${d}/*`,
      `/^https?:\\/\\/${e}\\//`,
      `||${d}^`,
      `@@||${d}^$important`,
      `||${d}^$badfilter`,
      `||${d}^$important,badfilter`,
      `0.0.0.0 ${d} ${d}`,
      d,
      `$boost=${n},site=${d}`,
      `$discard,site=${d}`,
      '$discard',
      `/${w}/$downrank=${n}`,
      `|https://*.${d}/${w}^`,
    ][k] as string
  })
const validArb = fc.array(fc.oneof(validLineArb, lineArb), { maxLength: 40 }).map((ls) => ls.join('\n'))
const textArb = fc.oneof(
  { weight: 3, arbitrary: nearValidArb },
  { weight: 3, arbitrary: validArb },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 400 }) },
  {
    weight: 1,
    arbitrary: fc.string({ unit: fc.constantFrom(...'|@^*$/\\.#!:= \n\r,~ab0-_()[]{}?+'), maxLength: 300 }),
  },
)

const expectedLines = (text: string): number => {
  const s = text.replace(/^\uFEFF/, '')
  if (s === '') return 0
  const parts = s.split(/\r\n|\r|\n/)
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

function checkInvariants(text: string, format: ListFormat, kind: ListKind, r: ImportResult): void {
  const s = r.stats
  expect(s.entries).toBe(s.accepted + s.duplicates + s.skipped)
  expect(s.accepted + s.companions).toBe(s.rules + s.cancel)
  expect(s.lines - s.ignored).toBeLessThanOrEqual(s.entries)
  if (r.format === 'ublacklist' || r.format === 'goggles' || r.format === 'domains') {
    expect(s.lines - s.ignored).toBe(s.entries)
  }
  expect(s.ignored).toBeLessThanOrEqual(s.lines)
  expect(s.rules).toBe(r.rules.length)
  expect(s.cancel).toBe(r.cancel.length)
  expect(s.regex).toBe(r.rules.filter((x) => x.matchKind === 'regex').length)
  expect(s.patterns).toBe(r.rules.filter((x) => x.matchKind === 'url_pattern').length)
  expect(s.skipped).toBe(Object.values(r.skipReasons).reduce((a, b) => a + b, 0))
  expect(r.skipped.length).toBe(Math.min(s.skipped, SKIPPED_SAMPLE))
  expect(s.bytes).toBe(Buffer.byteLength(text, 'utf8'))
  if (!r.truncated) expect(s.lines).toBe(expectedLines(text))
  if (format !== 'auto') expect(r.format).toBe(format)

  const ids = new Set<string>()
  r.rules.forEach((rule, i) => {
    expect(rule.scope).toBe('list')
    expect(rule.listId).toBe(r.listId)
    expect(rule.order).toBe(i)
    expect(rule.important).toBe(false)
    expect(rule.matchKind).toBe(classifyMatch(rule.match))
    expect(rule.action).not.toBe('pin')
    if (rule.action === 'raise' || rule.action === 'lower') {
      expect(Number.isInteger(rule.weight) && rule.weight >= 1 && rule.weight <= 10).toBe(true)
    } else expect(rule.weight).toBe(1)
    if (kind === 'official') expect(rule.action).toBe('normal')
    if (kind === 'allow' && r.format !== 'searchhole') expect(rule.action).not.toBe('block')
    expect(ids.has(rule.id)).toBe(false)
    ids.add(rule.id)
  })
  if (kind === 'official') expect(r.cancel.every((c) => c.action === 'normal')).toBe(true)

  // Every rule and cancel entry compiles, in enforce and audit mode.
  for (const mode of ['enforce', 'audit'] as const) {
    const compiled = compileRuleSet({ lists: [toListInput(r, mode)] })
    expect(compiled.issues).toEqual([])
    expect(compiled.size.list).toBe(r.rules.length)
  }
}

describe('importer fuzzing', () => {
  it('never throws; output compiles; stats add up; deterministic', () => {
    fc.assert(
      fc.property(textArb, fc.constantFrom(...FORMATS), fc.constantFrom(...KINDS), (text, format, kind) => {
        const opts = { format, listId: 'fz', kind }
        const r = importList(text, opts)
        checkInvariants(text, format, kind, r)
        expect(importList(text, opts)).toEqual(r)
      }),
      { numRuns: 600 },
    )
  })

  it('enforces the caps with a warning', () => {
    fc.assert(
      fc.property(
        nearValidArb,
        fc.constantFrom(...FORMATS),
        fc.constantFrom(...KINDS),
        fc.record({
          rules: fc.integer({ min: 0, max: 6 }),
          regex: fc.integer({ min: 0, max: 2 }),
          bytes: fc.integer({ min: 0, max: 400 }),
        }),
        (text, format, kind, caps) => {
          const r = importList(text, { format, listId: 'cap', kind, caps })
          checkInvariants(text, format, kind, r)
          expect(r.rules.length + r.cancel.length).toBeLessThanOrEqual(caps.rules)
          expect(r.stats.regex).toBeLessThanOrEqual(caps.regex)
          if (r.truncated) expect(r.warnings.some((w) => w.includes('MiB cap'))).toBe(true)
          if (r.skipReasons['over the per-list rule cap']) {
            expect(r.warnings.some((w) => w.includes('rules; the rest were skipped'))).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('reads lines past the byte cap never, and every line within it', () => {
    const text = Array.from({ length: 50 }, (_, i) => `*://*.d${i}.example/*`).join('\n')
    const r = importList(text, { format: 'ublacklist', listId: 'b', kind: 'block', caps: { bytes: 200 } })
    expect(r.truncated).toBe(true)
    expect(r.stats.lines).toBeGreaterThan(0)
    expect(r.stats.lines).toBeLessThan(50)
    expect(r.rules.length).toBe(r.stats.lines)
    expect(r.warnings.join(' ')).toContain('over the 0 MiB cap')
  })
})
