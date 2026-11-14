// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES, normalizeUntil, parseCommand, suggestCommand } from '../../src/cli/args.ts'
import { getAdapter } from '../../src/engines/index.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { AVAILABLE_ENGINES, ENGINE_ID_LIST } from '../../src/shared/types.ts'

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)
const parse = (...argv: string[]) => parseCommand(argv, NOW)

function failure(...argv: string[]): { why: string; fix: string | undefined } {
  try {
    parse(...argv)
  } catch (e) {
    if (isSearchHoleError(e)) {
      expect(e.code).toBe('invalid_argument')
      return { why: e.why, fix: e.fix }
    }
    throw e
  }
  throw new Error(`expected a usage error for: ${argv.join(' ')}`)
}

describe('top level', () => {
  it('no arguments, --help and -h mean help', () => {
    expect(parse()).toEqual({ name: 'help' })
    expect(parse('--help')).toEqual({ name: 'help' })
    expect(parse('-h')).toEqual({ name: 'help' })
  })

  it('help takes an optional topic', () => {
    expect(parse('help')).toEqual({ name: 'help' })
    expect(parse('help', 'search')).toEqual({ name: 'help', topic: 'search' })
  })

  it('a command with --help shows that command help', () => {
    expect(parse('search', '--help')).toEqual({ name: 'help', topic: 'search' })
    expect(parse('block', '-h')).toEqual({ name: 'help', topic: 'block' })
    expect(parse('keys', '--help')).toEqual({ name: 'help', topic: 'keys' })
  })

  it('version, --version and -v', () => {
    expect(parse('version')).toEqual({ name: 'version', json: false })
    expect(parse('version', '--json')).toEqual({ name: 'version', json: true })
    expect(parse('--version')).toEqual({ name: 'version', json: false })
    expect(parse('-v')).toEqual({ name: 'version', json: false })
  })

  it('an unknown command names a close match and does not echo the input', () => {
    const f = failure('serch', 'x')
    expect(f.why).toBe('Unknown command.')
    expect(f.fix).toContain('searchhole search')
    expect(failure('sk-secret-value-123').fix).not.toContain('sk-secret')
    expect(suggestCommand('docter')).toBe('doctor')
    expect(suggestCommand('zzzzzzzz')).toBeUndefined()
  })

  it('an unknown option before the command is rejected', () => {
    expect(failure('--verbose', 'search', 'x').why).toBe('Unknown option before the command.')
  })

  it('lists every command word once', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length)
  })
})

describe('search', () => {
  it('parses the query and every option', () => {
    expect(
      parse(
        'search',
        'react compiler',
        '--depth',
        'deep',
        '--profile',
        'coding',
        '--engine',
        'searxng',
        '--engine',
        'tavily',
        '--max-age-days',
        '365',
        '--limit',
        '5',
        '--explain',
        '--json',
      ),
    ).toEqual({
      name: 'search',
      query: 'react compiler',
      depth: 'deep',
      profile: 'coding',
      engines: ['searxng', 'tavily'],
      maxAgeDays: 365,
      limit: 5,
      explain: true,
      json: true,
    })
  })

  it('defaults: no optional fields are present', () => {
    expect(parse('search', 'hello')).toEqual({
      name: 'search',
      query: 'hello',
      engines: [],
      explain: false,
      json: false,
    })
  })

  it('joins several words into one query and accepts a leading dash after --', () => {
    expect(parse('search', 'react', 'compiler')).toMatchObject({ query: 'react compiler' })
    expect(parse('search', '--', '-foo')).toMatchObject({ query: '-foo' })
  })

  it('options may come before or after the query', () => {
    expect(parse('search', '--explain', 'q')).toMatchObject({ query: 'q', explain: true })
  })

  it.each([
    [['search'], 'Missing the search query.'],
    [['search', '  '], 'Missing the search query.'],
    [['search', 'q', '--depth', 'huge'], '--depth must be one of: quick, standard, deep.'],
    [['search', 'q', '--limit', '0'], '--limit must be a whole number from 1 to 100.'],
    [['search', 'q', '--limit', '2.5'], '--limit must be a whole number from 1 to 100.'],
    [
      ['search', 'q', '--max-age-days', '-3'],
      "Option '--max-age-days' got a value that starts with a dash; write --max-age-days=VALUE.",
    ],
    [['search', 'q', '--max-age-days', 'abc'], '--max-age-days must be a whole number from 1 to 36500.'],
    [['search', 'q', '--engine', 'bing'], 'Name an engine:'],
    [['search', 'q', '--depth'], "Option '--depth' needs a value."],
    [['search', 'q', '--nope'], "Unknown option '--nope'."],
  ])('rejects %j', (argv, message) => {
    expect(failure(...argv).why).toContain(message)
  })
})

describe('rule verbs', () => {
  it('parses the full set of options', () => {
    expect(
      parse(
        'raise',
        'github.com/orgname/',
        '--weight',
        '4',
        '--profile',
        'coding',
        '--project',
        '--note',
        'our org',
        '--until',
        '2026-12-31',
        '--yes',
      ),
    ).toEqual({
      name: 'rule',
      action: 'raise',
      match: 'github.com/orgname/',
      weight: 4,
      profile: 'coding',
      scope: 'project',
      note: 'our org',
      until: '2026-12-31',
      important: false,
      yes: true,
      json: false,
    })
  })

  it.each(['block', 'allow', 'pin', 'raise', 'lower', 'normal'] as const)(
    '%s defaults to the global scope',
    (verb) => {
      expect(parse(verb, 'example.com')).toMatchObject({
        name: 'rule',
        action: verb,
        match: 'example.com',
        scope: 'global',
        yes: false,
      })
    },
  )

  it('scope flags are exclusive', () => {
    expect(parse('block', 'a.com', '--session')).toMatchObject({ scope: 'session' })
    expect(parse('block', 'a.com', '--global')).toMatchObject({ scope: 'global' })
    expect(failure('block', 'a.com', '--project', '--session').why).toBe(
      'Use only one of --global, --project and --session.',
    )
  })

  it('--weight only applies to raise and lower, in 1 to 10', () => {
    expect(failure('block', 'a.com', '--weight', '2').why).toBe('--weight applies only to raise and lower.')
    expect(failure('raise', 'a.com', '--weight', '11').why).toBe(
      '--weight must be a whole number from 1 to 10.',
    )
    expect(parse('lower', 'a.com', '--weight', '10')).toMatchObject({ weight: 10 })
  })

  it('needs exactly one match', () => {
    expect(failure('block').why).toContain('Missing match')
    expect(failure('block', 'a.com', 'b.com').why).toContain('one match at a time')
  })

  it('-y is --yes and --important is passed on', () => {
    expect(parse('block', 'a.com', '-y', '--important')).toMatchObject({ yes: true, important: true })
  })

  it('--until accepts a date, an offset date-time or a duration', () => {
    expect(normalizeUntil('block', '2026-12-31', NOW)).toBe('2026-12-31')
    expect(normalizeUntil('block', '2026-12-31T09:00:00Z', NOW)).toBe('2026-12-31T09:00:00Z')
    expect(normalizeUntil('block', '7d', NOW)).toBe('2026-11-06T12:00:00.000Z')
    expect(() => normalizeUntil('block', 'tomorrow', NOW)).toThrow('--until must be')
    expect(() => normalizeUntil('block', '2026-02-30', NOW)).toThrow('--until must be')
    expect(parse('block', 'a.com', '--until', '12h')).toMatchObject({ until: '2026-10-31T00:00:00.000Z' })
  })
})

describe('other commands', () => {
  it('unrule', () => {
    expect(parse('unrule', 'r_abc', '--project', '--yes')).toEqual({
      name: 'unrule',
      target: 'r_abc',
      scope: 'project',
      yes: true,
      json: false,
    })
    expect(failure('unrule').why).toContain('Missing rule id')
  })

  it('rules, explain, suggestions', () => {
    expect(parse('rules')).toEqual({ name: 'rules', json: false })
    expect(parse('rules', '--json', '--session')).toEqual({ name: 'rules', json: true, scope: 'session' })
    expect(parse('explain', 'https://a.com/x', '--profile', 'coding')).toEqual({
      name: 'explain',
      url: 'https://a.com/x',
      profile: 'coding',
      json: false,
    })
    expect(failure('explain').why).toContain('Missing URL')
    expect(parse('suggestions', '--json')).toEqual({ name: 'suggestions', json: true })
  })

  it('log and log show', () => {
    expect(parse('log')).toEqual({ name: 'log', hidden: false, json: false })
    expect(parse('log', '--limit', '5', '--hidden', '--json')).toEqual({
      name: 'log',
      limit: 5,
      hidden: true,
      json: true,
    })
    expect(parse('log', 'show', '12')).toEqual({ name: 'log-show', searchId: 12, json: false })
    expect(failure('log', 'show').why).toContain('Missing search id')
    expect(failure('log', 'show', 'abc').why).toContain('The search id must be a whole number')
    expect(failure('log', 'extra').why).toBe('Too many arguments.')
  })

  it('review, review keep and review unkeep', () => {
    expect(parse('review')).toEqual({ name: 'review', json: false })
    expect(parse('review', '--days', '7', '--json')).toEqual({ name: 'review', days: 7, json: true })
    expect(parse('review', '--help')).toEqual({ name: 'help', topic: 'review' })
    expect(parse('review', 'keep', 'example.com')).toEqual({
      name: 'review-keep',
      site: 'example.com',
      yes: false,
      json: false,
    })
    expect(parse('review', 'unkeep', 'example.com', '-y', '--json')).toEqual({
      name: 'review-unkeep',
      site: 'example.com',
      yes: true,
      json: true,
    })
    for (const days of ['0', '366', 'abc', '1.5', '-3']) {
      expect(failure('review', `--days=${days}`).why, days).toBe(
        '--days must be a whole number from 1 to 365.',
      )
    }
    expect(failure('review', 'keep').why).toContain('Missing site')
    expect(failure('review', 'keep', 'a.com', 'b.com').why).toBe('Too many arguments.')
    expect(failure('review', 'keep', 'a.com', '--days', '7').why).toBe('--days only applies to the listing.')
    const unknown = failure('review', 'dismiss', 'a.com')
    expect(unknown.why).toContain('review keep <site>')
    expect(unknown.fix).toBe('Run `searchhole help review`.')
    expect(suggestCommand('reviw')).toBe('review')
  })

  it('approve, reject, trust, mode', () => {
    expect(parse('approve', '3', '--yes')).toEqual({ name: 'approve', id: 3, yes: true, json: false })
    expect(parse('reject', '4')).toEqual({ name: 'reject', id: 4, yes: false, json: false })
    expect(failure('approve', 'x').why).toContain('whole number')
    expect(parse('trust')).toEqual({ name: 'trust', yes: false, json: false })
    expect(parse('trust', '/work/p')).toEqual({ name: 'trust', dir: '/work/p', yes: false, json: false })
    expect(parse('mode')).toEqual({ name: 'mode', yes: false, json: false })
    expect(parse('mode', 'builtin')).toEqual({ name: 'mode', mode: 'builtin', yes: false, json: false })
    expect(failure('mode', 'fast').why).toBe('The mode must be one of: auto, builtin, engines.')
  })

  it('doctor and searxng', () => {
    expect(parse('doctor', '--probe', '--json')).toEqual({
      name: 'doctor',
      probe: true,
      strict: false,
      json: true,
    })
    expect(parse('doctor', '--strict')).toEqual({ name: 'doctor', probe: false, strict: true, json: false })
    for (const sub of ['up', 'down', 'status', 'apply'] as const) {
      expect(parse('searxng', sub)).toEqual({ name: 'searxng', sub, yes: false, json: false })
    }
    expect(parse('searxng', 'up', '--yes')).toMatchObject({ yes: true })
    expect(failure('searxng').why).toContain('Use searxng up')
    expect(failure('searxng', 'restart').why).toContain('The searxng command must be one of')
  })

  it('mcp --host', () => {
    expect(parse('mcp', '--host', 'claude-code')).toEqual({ name: 'mcp', host: 'claude-code' })
    expect(parse('mcp')).toEqual({ name: 'mcp', host: 'generic' })
    expect(failure('mcp', '--host', 'cli').why).toContain('--host must be one of')
    expect(failure('mcp', '--host', 'emacs').why).toContain('--host must be one of')
  })
})

describe('usage errors never quote what was typed', () => {
  const secret = 'tvly-SECRET-VALUE-1234567890'
  it.each([
    [['suggestions', secret]],
    [['doctor', secret]],
    [['rules', secret]],
    [['version', secret]],
    [['search', 'q', `--=${secret}`]],
    [['search', 'q', `--limit=${secret}`]],
    [['log', secret]],
    [['review', secret]],
    [['review', secret, 'a.com']],
    [['review', `--days=${secret}`]],
    [['review', 'keep', 'a.com', secret]],
    [['mode', secret]],
    [['searxng', secret]],
    [['mcp', '--host', secret]],
    [['explain']],
    [['block', 'a.com', `--weight=${secret}`]],
    [['block', 'a.com', '--until', secret]],
    [['help', 'keys', secret]],
  ])('%j', (argv) => {
    try {
      const cmd = parse(...argv)
      // help <topic> [extra] is not an error; it just must not run anything.
      expect(cmd.name).toBe('help')
    } catch (e) {
      expect(JSON.stringify({ why: (e as Error).message, fix: (e as { fix?: string }).fix })).not.toContain(
        'SECRET-VALUE',
      )
    }
  })

  it('names the option, never the value', () => {
    expect(failure('suggestions', secret).why).toBe('Too many arguments.')
    expect(failure('search', 'q', `--limit=${secret}`).why).toBe(
      '--limit must be a whole number from 1 to 100.',
    )
    expect(failure('search', 'q', '--explain=1').why).toBe("Option '--explain' does not take a value.")
    expect(failure('search', 'q', '--wat=x').why).toBe("Unknown option '--wat'.")
  })
})

describe('aliases', () => {
  it('unblock is unrule, as the slash command is called', () => {
    expect(parse('unblock', 'pinterest.com', '--yes')).toEqual(parse('unrule', 'pinterest.com', '--yes'))
    expect(parse('help', 'unblock')).toEqual({ name: 'help', topic: 'unrule' })
    expect(parse('unblock', '--help')).toEqual({ name: 'help', topic: 'unrule' })
  })
})

describe('keys', () => {
  it('set takes only an engine', () => {
    expect(parse('keys', 'set', 'tavily')).toEqual({ name: 'keys-set', engine: 'tavily' })
    expect(parse('keys', 'status', '--json')).toEqual({ name: 'keys-status', json: true })
    expect(parse('keys', 'remove', 'brave', '--yes')).toEqual({
      name: 'keys-remove',
      engine: 'brave',
      yes: true,
    })
  })

  it('offers only the engines this build can search with', () => {
    // Every engine id that is accepted has an adapter, and every adapter is offered.
    for (const id of ENGINE_ID_LIST) {
      expect([id, getAdapter(id) !== undefined]).toEqual([
        id,
        (AVAILABLE_ENGINES as readonly string[]).includes(id),
      ])
    }
    for (const planned of ['exa', 'mojeek', 'kagi', 'marginalia']) {
      expect(() => parse('keys', 'set', planned)).toThrow(/Name an engine: searxng, brave, tavily\./)
      expect(() => parse('search', 'x', '--engine', planned)).toThrow(/Name an engine/)
      // A key an older version stored for one can still be removed.
      expect(parse('keys', 'remove', planned, '--yes')).toMatchObject({
        name: 'keys-remove',
        engine: planned,
      })
    }
  })

  it('refuses a key on the command line and never repeats it', () => {
    const secret = 'tvly-SECRET-VALUE-1234567890'
    const asValue = failure('keys', 'set', 'tavily', secret)
    expect(asValue.why).toContain('never accepted on the command line')
    const asEngine = failure('keys', 'set', secret)
    expect(asEngine.why).toContain('Name an engine')
    const asOption = failure('keys', 'set', 'tavily', `--value=${secret}`)
    const asFlag = failure('keys', 'set', 'tavily', '--key', secret)
    for (const f of [asValue, asEngine, asOption, asFlag]) {
      expect(JSON.stringify(f)).not.toContain('SECRET-VALUE')
    }
  })

  it('needs a known subcommand', () => {
    expect(failure('keys').why).toContain('Use keys set')
    expect(failure('keys', 'list').why).toContain('Use keys set')
    expect(failure('keys', 'status', 'extra').why).toBe('Too many arguments.')
  })
})
