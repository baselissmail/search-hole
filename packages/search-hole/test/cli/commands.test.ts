// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import type { AddRuleInput, RequestCtx, SearchArgs } from '../../src/app/types.ts'
import { exitCodeFor } from '../../src/cli/errors.ts'
import { VERSION } from '../../src/cli/version.ts'
import { SearchHoleError } from '../../src/shared/errors.ts'
import { type Call, run, sampleDoctor, sampleOutcome } from './helpers.ts'

const call = (calls: Call[], method: string): Call => {
  const hit = calls.find((c) => c.method === method)
  if (hit === undefined) throw new Error(`no ${method} call; saw ${calls.map((c) => c.method).join(', ')}`)
  return hit
}

describe('help and version', () => {
  it('print without opening the app', async () => {
    const help = await run(['help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: searchhole <command>')
    expect(help.app.opened).toHaveLength(0)
    const topic = await run(['help', 'keys'])
    expect(topic.out).toContain('A key is never accepted as an argument')
    expect((await run([])).out).toContain('Usage: searchhole <command>')
    const ver = await run(['version'])
    expect(ver.out).toBe(`${VERSION}\n`)
    expect(VERSION).toBe('0.1.0')
    expect(JSON.parse((await run(['version', '--json'])).out)).toMatchObject({ version: '0.1.0' })
    expect((await run(['--version'])).out).toBe('0.1.0\n')
    expect(ver.app.opened).toHaveLength(0)
  })

  it('every command word has a help page', async () => {
    for (const topic of [
      'search',
      'block',
      'raise',
      'unrule',
      'rules',
      'explain',
      'log',
      'suggestions',
      'approve',
      'trust',
      'mode',
      'keys',
      'doctor',
      'searxng',
      'mcp',
      'version',
    ]) {
      const r = await run(['help', topic])
      expect(r.code, topic).toBe(0)
      expect(r.out, topic).toContain('Usage: searchhole')
    }
    const unknown = await run(['help', 'nonsense'])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('There is no help page for that command.')
  })

  it('documents SEARCHHOLE_SKILL, --yes and the exit codes', async () => {
    const out = (await run(['help'])).out
    expect(out).toContain('SEARCHHOLE_SKILL=1')
    expect(out).toContain('--yes')
    expect(out).toContain('Exit codes')
  })
})

describe('search', () => {
  it('passes only what was asked for, with the CLI context', async () => {
    const r = await run(
      [
        'search',
        'react compiler',
        '--depth',
        'deep',
        '--engine',
        'searxng',
        '--max-age-days',
        '90',
        '--limit',
        '7',
        '--profile',
        'coding',
      ],
      { cwd: '/work/project' },
    )
    expect(r.code).toBe(0)
    const [args, ctx] = call(r.app.calls, 'search').args as [SearchArgs, RequestCtx]
    expect(args).toEqual({
      query: 'react compiler',
      depth: 'deep',
      profile: 'coding',
      engines: ['searxng'],
      maxAgeDays: 90,
      limit: 7,
    })
    expect(ctx).toEqual({ projectDir: '/work/project', client: { name: 'searchhole-cli', version: '0.1.0' } })
    expect(r.app.opened).toEqual([{ host: 'cli', version: '0.1.0', env: {}, cwd: '/work/project' }])
    expect(r.app.closed).toBe(1)
  })

  it('a bare query sends no optional fields', async () => {
    const r = await run(['search', 'hello'])
    expect(call(r.app.calls, 'search').args[0]).toEqual({ query: 'hello' })
  })

  it('inside Claude Code the session and project come from the environment', async () => {
    const r = await run(['search', 'x'], {
      env: { CLAUDE_CODE_SESSION_ID: 'sess-123', CLAUDE_PROJECT_DIR: '/projects/app' },
      cwd: '/elsewhere',
    })
    const ctx = call(r.app.calls, 'search').args[1] as RequestCtx
    expect(ctx.session).toEqual({ key: 'sess-123', source: 'env' })
    expect(ctx.projectDir).toBe('/projects/app')
  })

  it('an unsubstituted placeholder is not a session', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal, unsubstituted host placeholder
    const r = await run(['search', 'x'], { env: { CLAUDE_CODE_SESSION_ID: '${CLAUDE_CODE_SESSION_ID}' } })
    expect((call(r.app.calls, 'search').args[1] as RequestCtx).session).toBeUndefined()
  })

  it('prints compact text, the explain account, or JSON', async () => {
    const compact = await run(['search', 'q'])
    expect(compact.out).toContain('search-hole · 2 results')
    expect(compact.out).not.toContain('Hidden (')
    const explain = await run(['search', 'q', '--explain'])
    expect(explain.out).toContain('Hidden (3)')
    expect(explain.out).toContain('Engines')
    expect(explain.out).toContain('Warnings')
    const asJson = await run(['search', 'q', '--json'])
    expect(JSON.parse(asJson.out)).toEqual(JSON.parse(JSON.stringify(sampleOutcome())))
  })

  it('a blocked query is a user error: why → fix on stderr, exit 2, nothing on stdout', async () => {
    const r = await run(
      ['search', 'sk-abc'],
      {},
      {
        failWith: new SearchHoleError('query_blocked', 'The query looks like an API key.', {
          fix: 'Remove the key and search again.',
        }),
      },
    )
    expect(r.code).toBe(2)
    expect(r.out).toBe('')
    expect(r.err).toBe('error: The query looks like an API key. → Remove the key and search again.\n')
    expect(r.app.closed).toBe(1)
  })
})

describe('exit codes', () => {
  it('2 for user errors, 1 for internal ones', () => {
    expect(exitCodeFor(new SearchHoleError('config_invalid', 'x'))).toBe(2)
    expect(exitCodeFor(new SearchHoleError('no_healthy_engine', 'x'))).toBe(2)
    expect(exitCodeFor(new SearchHoleError('invalid_argument', 'x'))).toBe(2)
    expect(exitCodeFor(new SearchHoleError('internal', 'x'))).toBe(1)
    expect(exitCodeFor(new Error('boom'))).toBe(1)
    expect(exitCodeFor('weird')).toBe(1)
  })

  it('usage errors exit 2 and point at help', async () => {
    const r = await run(['search'])
    expect(r.code).toBe(2)
    expect(r.err).toBe('error: Missing the search query. → Run `searchhole help search`.\n')
    expect(r.app.opened).toHaveLength(0)
    const unknown = await run(['frobnicate'])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('Unknown command.')
  })

  it('an unexpected exception exits 1 with a redacted message and no stack by default', async () => {
    const r = await run(
      ['rules'],
      {},
      { failWith: new Error('boom with key sk-abcdefghijklmnopqrstuvwxyz0123456789') },
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('error: Unexpected failure: boom with key')
    expect(r.err).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789')
    expect(r.err).not.toContain('    at ')
    const debug = await run(['rules'], { env: { SEARCHHOLE_LOG: 'debug' } }, { failWith: new Error('boom') })
    expect(debug.err).toContain('    at ')
  })

  it('an internal SearchHoleError exits 1', async () => {
    const r = await run(
      ['rules'],
      {},
      { failWith: new SearchHoleError('internal', 'lock timeout', { fix: 'try again' }) },
    )
    expect(r.code).toBe(1)
    expect(r.err).toBe('error: lock timeout → try again\n')
  })

  it('Ctrl-C reports Cancelled and exits 130', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await run(['search', 'x'], { signal: ac.signal }, { failWith: new Error('aborted') })
    expect(r.code).toBe(130)
    expect(r.err).toBe('Cancelled.\n')
  })
})

describe('rule verbs and the non-interactive guard (ADR-0012 point 4)', () => {
  const added = (r: { app: { calls: Call[] } }): AddRuleInput =>
    call(r.app.calls, 'rules.add').args[0] as AddRuleInput

  it('a person at a terminal needs no --yes and leaves no actor mark', async () => {
    const r = await run(['block', 'pinterest.com', '--note', 'noisy'], { tty: true })
    expect(r.code).toBe(0)
    expect(added(r)).toEqual({ match: 'pinterest.com', action: 'block', scope: 'global', note: 'noisy' })
    expect(r.out).toContain('✓ block pinterest.com (global) as r_new0000001')
    expect(r.out).toContain('Undo with: searchhole unrule r_new0000001')
  })

  it('without a terminal and without --yes nothing is changed and the app is never opened', async () => {
    for (const argv of [
      ['block', 'a.com'],
      ['allow', 'a.com'],
      ['pin', 'a.com'],
      ['raise', 'a.com'],
      ['lower', 'a.com'],
      ['normal', 'a.com'],
      ['unrule', 'r_x'],
      ['approve', '3'],
      ['reject', '3'],
      ['trust'],
      ['mode', 'builtin'],
      ['keys', 'remove', 'brave'],
    ]) {
      const r = await run(argv)
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.err, argv.join(' ')).toContain('was run without a terminal')
      expect(r.err, argv.join(' ')).toContain('--yes')
      expect(r.app.opened, argv.join(' ')).toHaveLength(0)
    }
  })

  it('--yes without a terminal works and marks the change non-interactive', async () => {
    const r = await run(['block', 'a.com', '--yes'])
    expect(r.code).toBe(0)
    expect(added(r).note).toBe('[actor: non-interactive]')
    const withNote = await run(['block', 'a.com', '--yes', '--note', 'because'])
    expect(added(withNote).note).toBe('because [actor: non-interactive]')
  })

  it('SEARCHHOLE_SKILL=1 needs no --yes and marks the change as a skill', async () => {
    const r = await run(['lower', 'medium.com', '--weight', '3'], { env: { SEARCHHOLE_SKILL: '1' } })
    expect(r.code).toBe(0)
    expect(added(r)).toMatchObject({ action: 'lower', weight: 3, note: '[actor: skill]' })
    const other = await run(['block', 'a.com'], { env: { SEARCHHOLE_SKILL: 'yes' } })
    expect(other.code).toBe(2)
  })

  it('maps every option onto the rule', async () => {
    const r = await run(
      [
        'raise',
        'github.com/orgname/',
        '--weight',
        '4',
        '--profile',
        'coding',
        '--project',
        '--until',
        '2026-12-31',
        '--important',
        '--note',
        'ours',
      ],
      { tty: true, env: { CLAUDE_PROJECT_DIR: '/projects/app' } },
    )
    expect(added(r)).toEqual({
      match: 'github.com/orgname/',
      action: 'raise',
      scope: 'project',
      weight: 4,
      profile: 'coding',
      important: true,
      until: '2026-12-31',
      note: 'ours',
    })
    expect((call(r.app.calls, 'rules.add').args[1] as RequestCtx).projectDir).toBe('/projects/app')
  })

  it('--session needs a Claude Code session and passes it along', async () => {
    const none = await run(['block', 'a.com', '--session'], { tty: true })
    expect(none.code).toBe(2)
    expect(none.err).toContain('There is no Claude Code session to attach this rule to.')
    expect(none.app.opened).toHaveLength(0)
    const ok = await run(['block', 'a.com', '--session'], {
      tty: true,
      env: { CLAUDE_CODE_SESSION_ID: 's-1' },
    })
    expect(ok.code).toBe(0)
    expect(added(ok).scope).toBe('session')
    expect((call(ok.app.calls, 'rules.add').args[1] as RequestCtx).session).toEqual({
      key: 's-1',
      source: 'env',
    })
  })

  it('--until 7d is stored as an absolute date', async () => {
    const r = await run(['block', 'a.com', '--until', '7d'], { tty: true })
    expect(added(r).until).toBe('2026-11-06T12:00:00.000Z')
  })

  it('--json prints the rule', async () => {
    const r = await run(['pin', 'react.dev', '--json'], { tty: true })
    expect(JSON.parse(r.out)).toMatchObject({ id: 'r_new0000001', action: 'pin', match: 'react.dev' })
  })

  it('unrule removes by id or match, passes the scope, and fails when nothing matched', async () => {
    const r = await run(['unrule', 'pinterest.com', '--project'], { tty: true })
    expect(r.code).toBe(0)
    expect(call(r.app.calls, 'rules.remove').args).toEqual(['pinterest.com', { scope: 'project' }])
    expect(r.out).toContain('✓ removed r_blk0000002')
    const noScope = await run(['unrule', 'r_x'], { tty: true })
    expect(call(noScope.app.calls, 'rules.remove').args).toEqual(['r_x', undefined])
    const none = await run(['unrule', 'nothing'], { tty: true }, { removeResult: [] })
    expect(none.code).toBe(2)
    expect(none.err).toContain('No rule has that id or match text.')
  })
})

describe('read-only commands', () => {
  it('rules lists, filters and prints JSON', async () => {
    const r = await run(['rules'])
    expect(r.out).toContain('pinterest.com')
    expect(call(r.app.calls, 'rules.list').args).toEqual([undefined])
    const filtered = await run(['rules', '--session', '--json'])
    expect(call(filtered.app.calls, 'rules.list').args).toEqual([{ scope: 'session' }])
    expect(JSON.parse(filtered.out)).toHaveLength(3)
  })

  it('explain passes the profile', async () => {
    const r = await run(['explain', 'https://pinterest.com/pin/1', '--profile', 'coding'])
    expect(call(r.app.calls, 'rules.explain').args).toEqual([
      'https://pinterest.com/pin/1',
      { profile: 'coding' },
    ])
    expect(r.out).toContain('hidden by rule')
  })

  it('log defaults to 20 entries, supports --hidden and --limit, and log show prints one search', async () => {
    const r = await run(['log'])
    expect(call(r.app.calls, 'log.recent').args).toEqual([{ limit: 20 }])
    expect(r.out).toContain('#12')
    const hidden = await run(['log', '--hidden', '--limit', '3', '--json'])
    expect(call(hidden.app.calls, 'log.recent').args).toEqual([{ limit: 3, hiddenOnly: true }])
    expect(JSON.parse(hidden.out)).toHaveLength(2)
    const show = await run(['log', 'show', '12'])
    expect(call(show.app.calls, 'log.detail').args).toEqual([12])
    expect(show.out).toContain('Search #12: react compiler')
    const missing = await run(['log', 'show', '99'], {}, { detail: undefined })
    expect(missing.code).toBe(2)
    expect(missing.err).toContain('There is no search #99 in the log.')
  })

  it('suggestions lists the queue', async () => {
    const r = await run(
      ['suggestions'],
      {},
      {
        suggestions: [
          {
            id: 5,
            input: { match: 'spam.example', action: 'block', reason: 'copy' },
            createdAt: '2026-10-30T10:00:00Z',
            status: 'pending',
          },
        ],
      },
    )
    expect(r.out).toContain('#5')
    expect(r.out).toContain('block spam.example')
  })

  it('doctor shows the report with exit 0 even when a check fails; --strict exits 1', async () => {
    const bad = await run(['doctor', '--probe'])
    expect(bad.code).toBe(0)
    expect(call(bad.app.calls, 'doctor').args).toEqual([{ probe: true }])
    expect(bad.out).toContain('1 problem to fix')
    const strict = await run(['doctor', '--strict'])
    expect(strict.code).toBe(1)
    expect(strict.out).toContain('1 problem to fix')
    const fine = await run(
      ['doctor', '--json', '--strict'],
      {},
      { doctor: { ...sampleDoctor(), checks: [{ id: 'node', status: 'ok', title: 'Node' }] } },
    )
    expect(fine.code).toBe(0)
    expect(call(fine.app.calls, 'doctor').args).toEqual([undefined])
    expect(JSON.parse(fine.out).version).toBe('0.1.0')
  })

  it('keys status shows presence and source only', async () => {
    const r = await run(['keys', 'status'])
    expect(r.out).toContain('tavily')
    expect(r.out).toContain('keychain')
    expect(JSON.parse((await run(['keys', 'status', '--json'])).out)).toHaveLength(2)
  })
})

describe('approve, reject, trust, mode', () => {
  it('approve and reject, interactive', async () => {
    const a = await run(['approve', '3'], { tty: true })
    expect(call(a.app.calls, 'suggestions.approve').args).toEqual([3])
    expect(a.out).toContain('✓ block spam.example')
    const b = await run(['reject', '3'], { tty: true })
    expect(call(b.app.calls, 'suggestions.reject').args).toEqual([3])
    expect(b.out).toContain('Rejected suggestion #3.')
  })

  it('trust resolves the directory and defaults to the project', async () => {
    const dflt = await run(['trust'], { tty: true, env: { CLAUDE_PROJECT_DIR: '/projects/app' } })
    expect(call(dflt.app.calls, 'rules.trust').args).toEqual(['/projects/app'])
    expect(dflt.out).toContain('Trusted /projects/app/.searchhole.yaml (sha256 aaaaaaaaaaaa…)')
    const rel = await run(['trust', '../other'], { tty: true, cwd: '/work/project' })
    expect(call(rel.app.calls, 'rules.trust').args).toEqual(['/work/other'])
    const cwdOnly = await run(['trust'], { tty: true, cwd: '/work/project' })
    expect(call(cwdOnly.app.calls, 'rules.trust').args).toEqual(['/work/project'])
  })

  it('mode shows or sets the Claude Code mode', async () => {
    const show = await run(['mode'])
    expect(show.out).toContain('auto (working as builtin)')
    expect(show.app.calls.map((c) => c.method)).toEqual(['searchMode'])
    const set = await run(
      ['mode', 'engines'],
      { tty: true },
      { mode: { configured: 'engines', effective: 'engines' } },
    )
    expect(call(set.app.calls, 'settings.setMode').args).toEqual(['engines'])
    expect(set.out).toContain('Mode set. engines (working as engines)')
    const skill = await run(['mode', 'builtin', '--json'], { env: { SEARCHHOLE_SKILL: '1' } })
    expect(JSON.parse(skill.out)).toEqual({ configured: 'auto', effective: 'builtin' })
  })
})

describe('mcp', () => {
  it('starts the gateway with the host, version, env and cwd, waits for it to close, and prints nothing on stdout', async () => {
    const seen: unknown[] = []
    let closed = false
    const r = await run(
      ['mcp', '--host', 'claude-code'],
      { env: { A: '1' }, cwd: '/w' },
      {},
      {
        startGateway: async (opts) => {
          seen.push(opts)
          return {
            closed: new Promise<void>((resolve) =>
              setTimeout(() => {
                closed = true
                resolve()
              }, 20),
            ),
          }
        },
      },
    )
    expect(r.code).toBe(0)
    expect(closed).toBe(true)
    expect(r.keepAlive).toBe(false)
    expect(r.out).toBe('')
    expect(r.err).toBe('')
    expect(seen).toEqual([{ host: 'claude-code', version: '0.1.0', env: { A: '1' }, cwd: '/w' }])
    expect(r.app.opened).toHaveLength(0)
  })

  it('a gateway that returns no handle is left running (keepAlive)', async () => {
    const r = await run(['mcp'], {}, {}, { startGateway: async () => undefined })
    expect(r).toMatchObject({ code: 0, keepAlive: true, out: '' })
  })

  it('a gateway failure goes to stderr only', async () => {
    const r = await run(
      ['mcp', '--host', 'zed'],
      {},
      {},
      {
        startGateway: async () => {
          throw new SearchHoleError('store_unavailable', 'The database is locked.', {
            fix: 'Close other copies.',
          })
        },
      },
    )
    expect(r.code).toBe(2)
    expect(r.out).toBe('')
    expect(r.err).toContain('The database is locked. → Close other copies.')
    expect(r.keepAlive).toBe(false)
  })

  it('a bad host is a usage error', async () => {
    const r = await run(['mcp', '--host', 'emacs'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('--host must be one of')
  })
})
