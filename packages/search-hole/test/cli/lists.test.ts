// SPDX-License-Identifier: Apache-2.0
// `searchhole lists …` (ADR-0022): parsing, the actor gate, and runs against a real app.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app/index.ts'
import type { ListStatus } from '../../src/app/types.ts'
import { parseCommand } from '../../src/cli/args.ts'
import { type CliDeps, runCli } from '../../src/cli/run.ts'
import { hasHelp, usageText } from '../../src/cli/usage.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { makeIo } from './helpers.ts'

describe('parsing', () => {
  it('reads every lists sub-command', () => {
    expect(parseCommand(['lists'])).toEqual({ name: 'lists', json: false })
    expect(parseCommand(['lists', '--json'])).toEqual({ name: 'lists', json: true })
    expect(parseCommand(['lists', 'catalog'])).toEqual({ name: 'lists-catalog', json: false })
    expect(
      parseCommand([
        'lists',
        'add',
        'https://example.com/l.txt',
        '--name',
        'mine',
        '--kind',
        'content-farm',
        '--format',
        'domains',
        '--mode',
        'audit',
        '--update',
        '1d',
        '--sha256',
        'A'.repeat(64),
        '--no-fetch',
        '--yes',
      ]),
    ).toEqual({
      name: 'lists-add',
      source: 'https://example.com/l.txt',
      listName: 'mine',
      kind: 'content-farm',
      format: 'domains',
      mode: 'audit',
      update: '1d',
      sha256: 'a'.repeat(64),
      fetch: false,
      yes: true,
      json: false,
    })
    expect(parseCommand(['lists', 'enforce', 'laylavish-huge-ai'])).toMatchObject({
      name: 'lists-mode',
      mode: 'enforce',
    })
    expect(parseCommand(['lists', 'audit', 'x'])).toMatchObject({ name: 'lists-mode', mode: 'audit' })
    expect(parseCommand(['lists', 'disable', 'x'])).toMatchObject({ name: 'lists-mode', mode: 'disabled' })
    expect(parseCommand(['lists', 'remove', 'x', '-y'])).toEqual({
      name: 'lists-remove',
      id: 'x',
      yes: true,
      json: false,
    })
    expect(parseCommand(['lists', 'update'])).toEqual({
      name: 'lists-update',
      ids: [],
      force: false,
      yes: false,
      json: false,
    })
    expect(parseCommand(['lists', 'update', 'a', 'b', '--force'])).toMatchObject({
      ids: ['a', 'b'],
      force: true,
    })
    expect(parseCommand(['lists', 'import', 'f.txt', '--name', 'mine', '--kind', 'block'])).toEqual({
      name: 'lists-import',
      file: 'f.txt',
      listName: 'mine',
      kind: 'block',
      yes: false,
      json: false,
    })
    expect(parseCommand(['lists', '--help'])).toEqual({ name: 'help', topic: 'lists' })
  })

  it('refuses malformed input with a fix', () => {
    const fails = (argv: string[], text: string) => {
      try {
        parseCommand(argv)
      } catch (e) {
        expect(isSearchHoleError(e) && e.code).toBe('invalid_argument')
        expect(isSearchHoleError(e) ? e.why : '').toContain(text)
        return
      }
      throw new Error(`${argv.join(' ')} parsed`)
    }
    fails(['lists', 'frobnicate'], 'Use lists')
    fails(['lists', 'add'], 'Missing')
    fails(['lists', 'add', 'x', '--update', 'weekly'], '--update')
    fails(['lists', 'add', 'x', '--sha256', 'abc'], '--sha256')
    fails(['lists', 'add', 'x', '--kind', 'evil'], '--kind')
    fails(['lists', 'enforce', 'Bad/../id'], 'list id')
    fails(['lists', 'import', 'f.txt', '--kind', 'block'], '--name')
    fails(['lists', 'import', 'f.txt', '--name', 'x'], '--kind')
    fails(['lists', 'remove', 'x', '--force'], 'does not apply')
  })

  it('has a help page', () => {
    expect(hasHelp('lists')).toBe(true)
    expect(usageText('lists')).toContain('lists import <file> --name <id> --kind <kind>')
    expect(usageText()).toContain('lists ')
  })
})

describe('runs against a real app', () => {
  let home = ''
  afterEach(() => {
    if (home !== '') rmSync(home, { recursive: true, force: true })
    home = ''
  })

  async function cli(argv: string[], o: { tty?: boolean; skill?: boolean } = {}) {
    if (home === '') {
      home = mkdtempSync(join(tmpdir(), 'searchhole-cli-lists-'))
      mkdirSync(join(home, 'project'))
    }
    const io = makeIo({
      env: { SEARCHHOLE_HOME: home, SEARCHHOLE_LOG: 'silent', ...(o.skill ? { SEARCHHOLE_SKILL: '1' } : {}) },
      cwd: join(home, 'project'),
      tty: o.tty ?? false,
    })
    const deps: CliDeps = {
      openApp: (opts) => createApp({ ...opts, seams: { homedir: home } }),
      startGateway: async () => undefined,
      timeZone: 'UTC',
    }
    const r = await runCli(argv, io, deps)
    return { code: r.code, out: io.out(), err: io.err() }
  }

  it('lists, then changes a mode only with a terminal, --yes or the skill marker (YAML comments kept)', async () => {
    const table = await cli(['lists'])
    expect(table.code).toBe(0)
    expect(table.out).toMatch(/rjaus-pinterest\s+enforce\s+vendored\s+block\s+50/)
    expect(table.out).toMatch(/laylavish-huge-ai\s+audit/)
    writeFileSync(join(home, 'rules.yaml'), '# mine\nversion: 1\n')

    const gated = await cli(['lists', 'enforce', 'laylavish-huge-ai'])
    expect(gated.code).toBe(2)
    expect(gated.err).toContain('without a terminal')

    const ok = await cli(['lists', 'enforce', 'laylavish-huge-ai', '--yes'])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('✓ laylavish-huge-ai: enforce')
    const skill = await cli(['lists', 'disable', 'rjaus-pinterest'], { skill: true })
    expect(skill.code).toBe(0)
    const yaml = readFileSync(join(home, 'rules.yaml'), 'utf8')
    expect(yaml).toContain('# mine')
    expect(yaml).toContain('laylavish-huge-ai: { mode: enforce }')
    expect(yaml).toContain('rjaus-pinterest: { mode: disabled }')

    const json = JSON.parse((await cli(['lists', '--json'])).out) as ListStatus[]
    expect(json.find((l) => l.id === 'rjaus-pinterest')?.mode).toBe('disabled')

    const removed = await cli(['lists', 'remove', 'github-clones', '--yes'])
    expect(removed.code).toBe(2)
    expect(removed.err).toContain('lists disable github-clones')
  })

  it('catalog, import and update', async () => {
    const catalog = JSON.parse((await cli(['lists', 'catalog', '--json'])).out) as Array<{
      id: string
      starter: boolean
      enabled: boolean
    }>
    expect(catalog.find((c) => c.id === 'super-seo-spam-suppressor')).toMatchObject({
      starter: false,
      enabled: false,
    })
    expect(catalog.find((c) => c.id === 'rjaus-pinterest')).toMatchObject({ starter: true, enabled: true })
    expect((await cli(['lists', 'catalog'])).out).toContain('super-seo-spam-suppressor')

    writeFileSync(join(home, 'project', 'mine.txt'), 'spam.example\nspam2.example\n')
    const imported = await cli([
      'lists',
      'import',
      'mine.txt',
      '--name',
      'mine',
      '--kind',
      'block',
      '--yes',
      '--json',
    ])
    expect(imported.code).toBe(0)
    expect(JSON.parse(imported.out)).toMatchObject({ id: 'mine', source: 'local', ruleCount: 2 })
    const update = await cli(['lists', 'update', 'mine', 'github-clones', '--yes'])
    expect(update.code).toBe(0)
    expect(update.out).toContain('- mine: imported')
    expect(update.out).toContain('- github-clones: built in')
    expect((await cli(['explain', 'https://spam.example/'])).out).toContain('hidden')
  })
})
