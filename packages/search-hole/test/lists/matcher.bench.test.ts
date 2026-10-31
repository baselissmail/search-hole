// SPDX-License-Identifier: Apache-2.0
/**
 * Matcher benchmark (ADR-0008 "Compiled matcher"; STATUS: "the P6 list matcher
 * needs a host prefilter"). A synthetic uBlacklist list, mostly domains plus
 * URL patterns and regexes, is imported, compiled and queried; the test prints
 * import time, compile time and `decide()` p50/p95 per URL.
 *
 * CI runs a small list with generous limits. The full size (418k rules, 20k of
 * them patterns or regexes, like Super-SEO-Spam-Suppressor plus heavy regex
 * lists) runs with `SEARCHHOLE_BENCH=full`, against the target p95 < 1 ms.
 */
import { describe, expect, it } from 'vitest'
import { compileRuleSet } from '../../src/core/rules/engine.ts'
import { importList, toListInput } from '../../src/lists/import/index.ts'

const FULL = process.env.SEARCHHOLE_BENCH === 'full'
const TOTAL = FULL ? 418_000 : 40_000
const PATTERNS = FULL ? 20_000 : 4_000
const URLS = FULL ? 5_000 : 1_000

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = prng(418)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
const word = (min: number, max: number): string => {
  const n = min + Math.floor(rnd() * (max - min + 1))
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(rnd() * 26))
  return s
}
const TLDS = ['com', 'net', 'org', 'io', 'xyz', 'info', 'co.uk', 'de', 'site', 'online']
const domain = (): string => `${word(5, 12)}.${pick(TLDS)}`
const esc = (s: string): string => s.replace(/[.]/g, '\\.')

function syntheticList(): { text: string; domains: string[]; paths: string[] } {
  const lines: string[] = ['# synthetic benchmark list (generated)']
  const domains: string[] = []
  const paths: string[] = []
  for (let i = 0; i < TOTAL - PATTERNS; i++) {
    const d = domain()
    domains.push(d)
    lines.push(`*://*.${d}/*`)
  }
  for (let i = 0; i < PATTERNS; i++) {
    const d = domain()
    const w = word(3, 8)
    paths.push(w)
    switch (i % 6) {
      case 0:
        lines.push(`*://*.${d}/${w}`)
        break
      case 1:
        lines.push(`https://${d}/${w}*`)
        break
      case 2:
        lines.push(`*://*/${w}-${word(3, 6)}/*`)
        break
      case 3:
        lines.push(`/^https?:\\/\\/(www\\.)?${esc(d)}\\/${w}/`)
        break
      case 4:
        lines.push(`/${w}.+\\/${word(4, 6)}/`)
        break
      default:
        lines.push(`/[a-z]+-${w}\\.(com|net)\\//`)
    }
  }
  return { text: `${lines.join('\n')}\n`, domains, paths }
}

const ms = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10
const pct = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0

describe(`matcher benchmark (${FULL ? 'full' : 'CI size'}: ${TOTAL.toLocaleString('en-US')} rules)`, () => {
  it('imports, compiles and decides within budget', () => {
    const { text, domains, paths } = syntheticList()

    let t0 = performance.now()
    const imported = importList(text, { format: 'auto', listId: 'bench', kind: 'block' })
    const importMs = ms(t0)
    expect(imported.format).toBe('ublacklist')
    expect(imported.stats.rules).toBe(TOTAL - imported.stats.duplicates)
    expect(imported.stats.skipped).toBe(0)

    t0 = performance.now()
    const rules = compileRuleSet({ lists: [toListInput(imported)] })
    const compileMs = ms(t0)
    expect(rules.issues).toEqual([])

    const urls: string[] = []
    for (let i = 0; i < URLS; i++) {
      const r = rnd()
      if (r < 0.15) urls.push(`https://www.${pick(domains)}/${word(4, 9)}`)
      else if (r < 0.25) urls.push(`https://${domain()}/${pick(paths)}-${word(3, 6)}/x`)
      else
        urls.push(
          `https://${rnd() < 0.5 ? 'www.' : ''}${domain()}/${word(3, 9)}/${word(5, 12)}?q=${word(3, 6)}`,
        )
    }
    const opts = { profile: 'default', now: Date.parse('2026-10-31T00:00:00Z') }
    for (const u of urls.slice(0, 200)) rules.decide(u, opts)
    const times: number[] = []
    let hidden = 0
    for (const u of urls) {
      const s = performance.now()
      if (rules.decide(u, opts).visibility === 'hidden') hidden++
      times.push(performance.now() - s)
    }
    times.sort((a, b) => a - b)
    const p50 = pct(times, 0.5)
    const p95 = pct(times, 0.95)
    console.log(
      `[bench] ${JSON.stringify({
        rules: imported.stats.rules,
        patterns: imported.stats.patterns,
        regex: imported.stats.regex,
        prefilter: rules.prefilter,
        importMs,
        compileMs,
        decideP50ms: Number(p50.toFixed(4)),
        decideP95ms: Number(p95.toFixed(4)),
        decideMaxMs: Number(pct(times, 1).toFixed(3)),
        urls: urls.length,
        hidden,
      })}`,
    )
    expect(hidden).toBeGreaterThan(0)
    expect(rules.prefilter.rest).toBe(0)
    expect(p95).toBeLessThan(FULL ? 1 : 5)
  }, 120_000)
})
