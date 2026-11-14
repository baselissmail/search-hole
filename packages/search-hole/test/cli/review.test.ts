// SPDX-License-Identifier: Apache-2.0
// `searchhole review …` and the opened marks of `searchhole log` (ADR-0025) against a real app:
// every call is a fresh process as far as the app can tell (it is created and closed per run).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app/index.ts'
import type { LogDetail, LogEntry, ReviewList } from '../../src/app/types.ts'
import { type CliDeps, runCli } from '../../src/cli/run.ts'
import { hasHelp, usageText } from '../../src/cli/usage.ts'
import { makeIo } from './helpers.ts'

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)

describe('review against a real app', () => {
  let home = ''
  afterEach(() => {
    if (home !== '') rmSync(home, { recursive: true, force: true })
    home = ''
  })

  const env = (extra: Record<string, string> = {}) => ({
    SEARCHHOLE_HOME: home,
    SEARCHHOLE_LOG: 'silent',
    ...extra,
  })

  async function cli(argv: string[], o: { tty?: boolean; skill?: boolean } = {}) {
    if (home === '') {
      home = mkdtempSync(join(tmpdir(), 'searchhole-cli-review-'))
      mkdirSync(join(home, 'project'))
    }
    const io = makeIo({
      env: env(o.skill ? { SEARCHHOLE_SKILL: '1' } : {}),
      cwd: join(home, 'project'),
      tty: o.tty ?? false,
    })
    const deps: CliDeps = {
      openApp: (opts) => createApp({ ...opts, now: () => NOW, seams: { homedir: home } }),
      startGateway: async () => undefined,
      timeZone: 'UTC',
    }
    const r = await runCli(argv, io, deps)
    return { code: r.code, out: io.out(), err: io.err() }
  }

  /** What a Claude Code session would have logged: three searches and one opened page. */
  async function seed(): Promise<void> {
    const app = await createApp({
      host: 'claude-code',
      version: '0.1.0',
      env: env(),
      cwd: join(home, 'project'),
      now: () => NOW,
      seams: { homedir: home },
    })
    const session = { session: { key: 'cli-review', source: 'hook' as const } }
    for (const q of ['css grid', 'css flexbox', 'css subgrid']) {
      await app.filterBuiltinResults(
        q,
        [
          { title: 'CSS guide', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS' },
          { title: `Farm on ${q}`, url: `https://www.farm.example/${q.replace(' ', '-')}` },
          { title: 'Tutorial', url: 'https://tutorials.example/css' },
        ],
        session,
      )
    }
    await app.recordBuiltinFetch('https://developer.mozilla.org/en-US/docs/Web/CSS', session)
    await app.close()
  }

  it('says there is nothing yet without creating a database', async () => {
    const empty = await cli(['review'])
    expect(empty.code).toBe(0)
    expect(empty.out).toBe(
      'Nothing to review yet. A site shows up here after it appears in 3 searches and the assistant never opens it.\n',
    )
    expect(existsSync(join(home, 'searchhole.db'))).toBe(false)
    expect(JSON.parse((await cli(['review', '--json'])).out)).toEqual({
      days: 30,
      minSearches: 3,
      sites: [],
      total: 0,
      dismissed: [],
    })
  })

  it('lists the sites, then keep, block and unkeep change what it lists', async () => {
    await cli(['review']) // creates the temp home
    await seed()

    const listed = await cli(['review'])
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('2 sites seen in 3 or more searches of the last 30 days and never opened')
    expect(listed.out).toMatch(/farm\.example\s+3\s+3\s+2026-10-30 12:00\s+unknown/)
    expect(listed.out).toMatch(/tutorials\.example\s+3\s+3\s+2026-10-30 12:00/)
    expect(listed.out).toContain('Tutorial  https://tutorials.example/css')
    expect(listed.out).not.toContain('mozilla.org') // its page was opened
    const json = JSON.parse((await cli(['review', '--days', '7', '--json'])).out) as ReviewList
    expect(json.days).toBe(7)
    expect(json.sites.map((s) => [s.domain, s.searches, s.examples.length])).toEqual([
      ['farm.example', 3, 3],
      ['tutorials.example', 3, 1],
    ])

    // keep: gated like the rule verbs, then stored for every later run.
    const gated = await cli(['review', 'keep', 'tutorials.example'])
    expect(gated.code).toBe(2)
    expect(gated.err).toContain('without a terminal')
    expect((await cli(['review', '--json'])).out).toContain('tutorials.example')
    const kept = await cli(['review', 'keep', 'https://tutorials.example/css'], { skill: true })
    expect(kept.code).toBe(0)
    expect(kept.out).toContain('✓ Kept tutorials.example')
    expect((await cli(['review', 'keep', 'tutorials.example', '--yes'])).out).toContain('was kept already')

    // block: the ordinary rule verb; the site leaves the list because a rule now decides it.
    expect((await cli(['block', 'farm.example'], { tty: true })).code).toBe(0)
    const after = await cli(['review'])
    expect(after.out).toContain('Nothing to review yet.')
    expect(after.out).toContain('Kept, so not listed: tutorials.example.')

    const unkept = await cli(['review', 'unkeep', 'tutorials.example'], { tty: true })
    expect(unkept.out).toContain('✓ tutorials.example can show up')
    const again = JSON.parse((await cli(['review', '--json'])).out) as ReviewList
    expect(again.sites.map((s) => s.domain)).toEqual(['tutorials.example'])
    expect(again.dismissed).toEqual([])

    const bad = await cli(['review', 'keep', 'two words'], { tty: true })
    expect(bad.code).toBe(2)
    expect(bad.err).toContain('That is not a site.')
    expect(bad.err).not.toContain('two words')
  })

  it('log and log show carry the opened marks', async () => {
    await cli(['review'])
    await seed()
    const list = await cli(['log'])
    expect(list.out.match(/3 kept · 1 opened/g)).toHaveLength(3)
    const entries = JSON.parse((await cli(['log', '--json'])).out) as LogEntry[]
    expect(entries.map((e) => e.opened)).toEqual([1, 1, 1])
    const show = await cli(['log', 'show', '1'])
    expect(show.out).toContain('3 kept · 0 hidden · opened 1 of 3')
    expect(show.out).toMatch(/kept\s+opened\s+https:\/\/developer\.mozilla\.org/)
    expect(show.out).toMatch(/kept\s+seen\s+https:\/\/www\.farm\.example\/css-grid/)
    const detail = JSON.parse((await cli(['log', 'show', '1', '--json'])).out) as LogDetail
    expect(detail.opened).toBe(1)
    expect(detail.results.map((r) => [r.domain, r.opened])).toEqual([
      ['mozilla.org', true],
      ['farm.example', false],
      ['tutorials.example', false],
    ])
  })
})

describe('help', () => {
  it('lists review among the search and rules commands and has a page for it', () => {
    expect(hasHelp('review')).toBe(true)
    const main = usageText()
    const lines = main.split('\n')
    const at = (word: string): number => lines.findIndex((l) => l.startsWith(`  ${word} `))
    expect(at('review')).toBeGreaterThan(at('log'))
    expect(at('review')).toBeLessThan(at('suggestions'))
    expect(at('review')).toBeLessThan(lines.indexOf('Setup'))
    const page = usageText('review')
    for (const needle of [
      'searchhole review [--days <n>] [--json]',
      'searchhole review keep <site>',
      'searchhole review unkeep <site>',
      'searchhole block <site>',
      'searchhole lower <site>',
      'nothing is sent anywhere',
    ]) {
      expect(page, needle).toContain(needle)
    }
    expect(usageText('log')).toContain('"opened"')
  })
})
