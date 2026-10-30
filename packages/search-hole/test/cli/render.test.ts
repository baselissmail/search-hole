// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  describeWarning,
  formatTime,
  renderDoctor,
  renderKeysStatus,
  renderLog,
  renderLogDetail,
  renderMode,
  renderRuleAdded,
  renderRules,
  renderSearch,
  renderSearxngStatus,
  renderSuggestions,
  renderTable,
  renderUrlExplain,
  visibleLength,
} from '../../src/cli/render.ts'
import { colorEnabled, createStyle, PLAIN } from '../../src/cli/style.ts'
import type { Warning } from '../../src/shared/types.ts'
import {
  makeIo,
  merged,
  sampleDoctor,
  sampleLog,
  sampleLogDetail,
  sampleOutcome,
  sampleRules,
  stripAnsi,
} from './helpers.ts'

const plain = { style: PLAIN, timeZone: 'UTC' }
const snap = (name: string): string => `./__snapshots__/${name}.txt`

describe('search rendering', () => {
  it('search --explain: kept with reasons, hidden with rules, engines, warnings', async () => {
    await expect(`${renderSearch(sampleOutcome(), plain, true)}\n`).toMatchFileSnapshot(
      snap('search-explain'),
    )
  })

  it('default search output is compact and points at --explain when something was hidden', async () => {
    const text = renderSearch(sampleOutcome(), plain, false)
    await expect(`${text}\n`).toMatchFileSnapshot(snap('search-compact'))
    expect(text).toContain('Add --explain to see why.')
  })

  it('explain names every hidden result, its reason and the deciding rule', () => {
    const text = renderSearch(sampleOutcome(), plain, true)
    expect(text).toContain('[rule] Pin 123')
    expect(text).toContain('r_blk0000002 (global) "pinterest.com" @ rules.yaml:9')
    expect(text).toContain('[list] React Tutorial')
    expect(text).toContain('r_lst0000003 (list dev-filter) "||w3schools.com^"')
    expect(text).toContain('[stale] Old post')
    expect(text).toContain(
      'older than the freshness limit; date 2019-02-01 (published, medium, jsonld:datePublished, time zone assumed)',
    )
    expect(text).toContain('pinned (order 1) by r_pin0000001')
    expect(text).toContain('raised ×1.5 by r_rai0000004')
    expect(text).toContain('audit: would be hidden by r_lst0000003')
  })

  it('an empty outcome says so', () => {
    const o = {
      ...sampleOutcome(),
      results: [],
      hidden: [],
      hiddenSummary: { count: 0, byReason: {}, topDomains: [] },
      warnings: [],
    }
    expect(renderSearch(o, plain, false)).toContain('No results.')
    const explained = renderSearch(o, plain, true)
    expect(explained).toContain('Kept (0)\n  none')
    expect(explained).toContain('Hidden (0)\n  none')
  })

  it('mentions hidden results that were counted but not listed', () => {
    const o = sampleOutcome()
    const text = renderSearch({ ...o, hiddenSummary: { ...o.hiddenSummary, count: 9 } }, plain, true)
    expect(text).toContain('(6 more hidden results are not listed)')
    const one = renderSearch({ ...o, hiddenSummary: { ...o.hiddenSummary, count: 4 } }, plain, true)
    expect(one).toContain('(1 more hidden result is not listed)')
  })

  it('shows a coverage result and a required-date refusal', () => {
    const o = sampleOutcome()
    const text = renderSearch(
      {
        ...o,
        results: [merged({ url: 'https://a.example/x', title: 'A', keptReason: 'coverage' })],
        hidden: [merged({ url: 'https://b.example/y', title: 'B', hiddenReason: 'date_required' })],
      },
      plain,
      true,
    )
    expect(text).toContain('kept so every engine that answered is represented (deep)')
    expect(text).toContain('[no date] B')
    expect(text).toContain('the profile requires a date and none was found')
  })

  it('describes every warning code', () => {
    const all: Warning[] = [
      { code: 'no_official_source' },
      { code: 'single_source' },
      { code: 'all_stale' },
      { code: 'coverage_skipped' },
      { code: 'receipt_expired', previous: 'rcpt_old' },
      { code: 'engine_fallback', from: 'brave', to: 'tavily' },
      { code: 'spend_cap_local', engine: 'brave' },
      { code: 'logging_unavailable', detail: 'database is read-only' },
      { code: 'list_compiling', listId: 'dev-filter' },
    ]
    for (const w of all) expect(describeWarning(w).length).toBeGreaterThan(10)
    expect(describeWarning({ code: 'receipt_expired', previous: 'rcpt_old' })).toContain('rcpt_old')
  })
})

describe('rules, log and the rest', () => {
  it('rules', async () => {
    await expect(`${renderRules(sampleRules(), plain)}\n`).toMatchFileSnapshot(snap('rules'))
    expect(renderRules([], plain)).toBe('No rules yet. Try `searchhole block <domain>`.')
  })

  it('a rule confirmation shows an undo hint', async () => {
    const [first] = sampleRules()
    if (first === undefined) throw new Error('fixture')
    await expect(`${renderRuleAdded(first, plain)}\n`).toMatchFileSnapshot(snap('rule-added'))
  })

  it('log and log show', async () => {
    await expect(`${renderLog(sampleLog(), plain)}\n`).toMatchFileSnapshot(snap('log'))
    await expect(`${renderLogDetail(sampleLogDetail(), plain)}\n`).toMatchFileSnapshot(snap('log-show'))
    expect(renderLog([], plain)).toBe('Nothing logged yet.')
  })

  it('doctor', async () => {
    await expect(`${renderDoctor(sampleDoctor(), plain)}\n`).toMatchFileSnapshot(snap('doctor'))
  })

  it('suggestions, keys status, mode, explain url', async () => {
    const out = [
      renderSuggestions(
        [
          {
            id: 3,
            input: {
              match: 'spam.example',
              action: 'block',
              reason: 'SEO copy of the docs',
              scope: 'global',
            },
            createdAt: '2026-10-30T11:00:00.000Z',
            status: 'pending',
          },
        ],
        plain,
      ),
      renderSuggestions([], plain),
      renderKeysStatus(
        [
          { engine: 'tavily', present: true, source: 'keychain' },
          { engine: 'brave', present: false, source: 'missing' },
        ],
        plain,
      ),
      renderMode({ configured: 'auto', effective: 'builtin' }, plain),
      renderUrlExplain(
        'https://pinterest.com/pin/1',
        { decision: 'hidden by rule', lines: ['T3 global: block pinterest.com'] },
        plain,
      ),
    ].join('\n---\n')
    await expect(`${out}\n`).toMatchFileSnapshot(snap('misc'))
  })

  it('searxng status', async () => {
    const base = {
      name: 'search-hole-searxng',
      port: 8888,
      url: 'http://127.0.0.1:8888',
      dataDir: '/home/u/.searchhole/searxng',
      managed: true,
    }
    const out = [
      renderSearxngStatus(
        { ...base, docker: 'ok', container: 'running', imageMatches: true, portMatches: true, healthy: true },
        plain,
      ),
      renderSearxngStatus(
        {
          ...base,
          docker: 'ok',
          container: 'absent',
          imageMatches: false,
          portMatches: false,
          healthy: false,
        },
        plain,
      ),
      renderSearxngStatus(
        {
          ...base,
          docker: 'missing',
          container: 'absent',
          imageMatches: false,
          portMatches: false,
          healthy: false,
        },
        plain,
      ),
      renderSearxngStatus(
        {
          ...base,
          docker: 'daemon_down',
          container: 'absent',
          imageMatches: false,
          portMatches: false,
          healthy: false,
        },
        plain,
      ),
    ].join('\n---\n')
    await expect(`${out}\n`).toMatchFileSnapshot(snap('searxng-status'))
  })
})

describe('helpers', () => {
  it('formats times in the requested zone', () => {
    expect(formatTime('2026-10-30T14:02:11.000Z', 'UTC')).toBe('2026-10-30 14:02')
    expect(formatTime('2026-10-30T23:30:00.000Z', 'Asia/Beirut')).toBe('2026-10-31 01:30')
    expect(formatTime('not a date')).toBe('not a date')
  })

  it('measures and aligns text without counting colour codes', () => {
    const s = createStyle(true)
    expect(visibleLength(s.red('abc'))).toBe(3)
    const rows = renderTable([
      [s.bold('a'), 'x'],
      ['bbb', 'y'],
    ])
    expect(rows.map(stripAnsi)).toEqual(['a    x', 'bbb  y'])
  })
})

describe('colour', () => {
  it('is on only for a TTY with NO_COLOR unset and TERM not dumb', () => {
    expect(colorEnabled({}, true)).toBe(true)
    expect(colorEnabled({}, false)).toBe(false)
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false)
    expect(colorEnabled({ NO_COLOR: '' }, true)).toBe(true)
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false)
  })

  it('plain style never emits escape codes; coloured style does', () => {
    expect(PLAIN.red('x')).toBe('x')
    expect(createStyle(true).red('x')).toContain('\u001b[31m')
    const text = renderSearch(sampleOutcome(), { style: createStyle(true), timeZone: 'UTC' }, true)
    expect(text).toContain('\u001b[')
    expect(stripAnsi(text)).toBe(renderSearch(sampleOutcome(), plain, true))
  })

  it('the CLI colours stdout only on a TTY and honours NO_COLOR', async () => {
    const { run } = await import('./helpers.ts')
    const tty = await run(['rules'], { stdoutTTY: true })
    expect(tty.out).toContain('\u001b[')
    const noColor = await run(['rules'], { stdoutTTY: true, env: { NO_COLOR: '1' } })
    expect(noColor.out).not.toContain('\u001b[')
    const piped = await run(['rules'])
    expect(piped.out).not.toContain('\u001b[')
    expect(makeIo().stdout.isTTY).toBe(false)
  })
})
