// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BuiltinResult } from '../../src/app/types.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { fallbackSession, hookSession, setup } from './helpers.ts'

const PIN: BuiltinResult[] = [
  { title: 'P', url: 'https://www.pinfarm.com/a' },
  { title: 'R', url: 'https://react.dev/learn' },
]

const code = (c: string) => (e: unknown) => isSearchHoleError(e) && e.code === c

describe('suggest_rule → approve (Principle 3)', () => {
  it('queues, dedupes, never applies; the user approves; the rule then applies', async () => {
    const h = await setup({
      rules:
        '# keep this comment\nversion: 1\nrules:\n  - { match: w3schools.com, action: block } # inline\n',
    })
    const first = await h.app.suggestRule(
      { match: 'pinfarm.com', action: 'block', reason: 'image farm' },
      hookSession(),
    )
    expect(first.status).toBe('queued')
    expect(first.howToApprove).toBe(
      `Tell the user: suggestion #${first.suggestionId} is queued; they can apply it with the slash command /search-hole:approve ${first.suggestionId}. Do not run any command yourself.`,
    )
    // Not applied yet.
    expect((await h.app.filterBuiltinResults('x', PIN, {})).hidden).toEqual([])
    const again = await h.app.suggestRule({ match: '*.pinfarm.com', action: 'block', reason: 'again' }, {})
    expect(again).toMatchObject({ status: 'duplicate', suggestionId: first.suggestionId })

    const pending = await h.app.suggestions.list()
    expect(pending).toEqual([
      {
        id: first.suggestionId,
        input: { match: 'pinfarm.com', action: 'block', reason: 'image farm', weight: 1, scope: 'global' },
        createdAt: '2026-10-30T12:00:00.000Z',
        status: 'pending',
      },
    ])

    // Approval runs in another process (the CLI behind /search-hole:approve).
    const cli = await h.reopen({ host: 'cli' })
    const listing = await cli.suggestions.approve(first.suggestionId)
    expect(listing).toMatchObject({ scope: 'global', match: 'pinfarm.com', action: 'block' })
    const text = readFileSync(join(h.home, 'rules.yaml'), 'utf8')
    expect(text).toContain('# keep this comment')
    expect(text).toContain('# inline')
    expect(text).toContain('match: pinfarm.com')
    expect((await h.app.filterBuiltinResults('x', PIN, {})).hidden.map((r) => r.url)).toEqual([
      'https://www.pinfarm.com/a',
    ])
    await expect(cli.suggestions.approve(first.suggestionId)).rejects.toSatisfy(code('invalid_argument'))
    // Suggesting an existing rule is a duplicate with nothing to approve.
    expect(await h.app.suggestRule({ match: 'pinfarm.com', action: 'block', reason: 'x' }, {})).toMatchObject(
      {
        status: 'duplicate',
        suggestionId: 0,
      },
    )
  })

  it('rejects invalid matches, unknown profiles and session scope on fallback sessions', async () => {
    const h = await setup()
    expect((await h.app.suggestRule({ match: '/(?=x)/', action: 'block', reason: 'r' }, {})).status).toBe(
      'rejected',
    )
    expect(
      (await h.app.suggestRule({ match: 'a.com', action: 'block', reason: 'r', profile: 'nope' }, {})).status,
    ).toBe('rejected')
    const s = await h.app.suggestRule(
      { match: 'a.com', action: 'block', reason: 'r', scope: 'session' },
      fallbackSession(),
    )
    expect(s.status).toBe('rejected')
    expect(s.message).toMatch(/doesn't identify chats/)
    const ok = await h.app.suggestRule({ match: 'a.com', action: 'block', reason: 'r' }, {})
    await h.app.suggestions.reject(ok.suggestionId)
    expect((await h.app.suggestions.list())[0]?.status).toBe('rejected')
  })

  it('approving a session suggestion writes a session rule for that session only', async () => {
    const h = await setup()
    const ctx = hookSession('chat-a')
    const s = await h.app.suggestRule(
      { match: 'pinfarm.com', action: 'block', reason: 'r', scope: 'session' },
      ctx,
    )
    await (await h.reopen({ host: 'cli' })).suggestions.approve(s.suggestionId)
    expect((await h.app.filterBuiltinResults('x', PIN, ctx)).hidden).toHaveLength(1)
    expect((await h.app.filterBuiltinResults('x', PIN, hookSession('chat-b'))).hidden).toHaveLength(0)
    expect(await h.app.rules.list({ scope: 'session' })).toMatchObject([
      { scope: 'session', match: 'pinfarm.com' },
    ])
  })
})

describe('rules.add / remove / explain', () => {
  it('adds and removes global rules, preserving comments', async () => {
    const h = await setup({ rules: '# mine\nversion: 1\nrules: []\n' })
    const added = await h.app.rules.add({ match: 'react.dev', action: 'raise', weight: 3, note: 'docs' })
    expect(added).toMatchObject({
      scope: 'global',
      match: 'react.dev',
      action: 'raise',
      weight: 3,
      note: 'docs',
    })
    expect(await h.app.rules.add({ match: 'react.dev', action: 'raise', weight: 3 })).toMatchObject({
      id: added.id,
    })
    expect((await h.app.rules.list({ scope: 'global' })).map((r) => r.match)).toEqual(['react.dev'])
    const removed = await h.app.rules.remove('react.dev')
    expect(removed.map((r) => r.id)).toEqual([added.id])
    expect(readFileSync(join(h.home, 'rules.yaml'), 'utf8')).toContain('# mine')
    expect(await h.app.rules.list()).toEqual([])
  })

  it('creates rules.yaml on first add only', async () => {
    const h = await setup()
    await h.app.filterBuiltinResults('x', PIN, {})
    expect(() => readFileSync(join(h.home, 'rules.yaml'))).toThrow()
    await h.app.rules.add({ match: 'pinfarm.com', action: 'block' })
    expect(readFileSync(join(h.home, 'rules.yaml'), 'utf8')).toMatch(/version: 1/)
  })

  it('refuses invalid input and never rewrites a broken file', async () => {
    const h = await setup({ rules: 'version: 1\nrules:\n  - { match: "", action: block }\n' })
    await expect(h.app.rules.add({ match: 'x.com', action: 'raise', weight: 11 })).rejects.toSatisfy(
      code('invalid_argument'),
    )
    await expect(h.app.rules.add({ match: 'x.com', action: 'block' })).rejects.toSatisfy(
      code('rules_invalid'),
    )
    expect(readFileSync(join(h.home, 'rules.yaml'), 'utf8')).toContain('match: ""')
  })

  it('session rules need a real session key (ADR-0005)', async () => {
    const h = await setup()
    await expect(
      h.app.rules.add({ match: 'a.com', action: 'block', scope: 'session' }, fallbackSession()),
    ).rejects.toSatisfy((e: unknown) => isSearchHoleError(e) && /doesn't identify chats/.test(e.why))
    const ctx = hookSession('s')
    await h.app.rules.add({ match: 'pinfarm.com', action: 'block', scope: 'session' }, ctx)
    expect((await h.app.filterBuiltinResults('x', PIN, ctx)).hidden).toHaveLength(1)
    expect(await h.app.builtinBlockedDomains(ctx, 'x')).toEqual(['pinfarm.com'])
    expect(await h.app.builtinBlockedDomains(hookSession('other'), 'x')).toEqual([])
  })

  it('explain renders every match and the deciding one', async () => {
    const h = await setup({
      rules: `version: 1
rules:
  - { match: example.com, action: block }
  - { match: "=docs.example.com", action: allow }
  - { match: docs.example.com, action: raise, weight: 2 }
`,
    })
    const out = await h.app.rules.explain('https://docs.example.com/x')
    expect(out.decision).toBe('kept')
    expect(out.lines.filter((l) => l.startsWith('T3 '))).toHaveLength(3)
    expect(out.lines.find((l) => l.includes('allow =docs.example.com'))).toMatch(/← decides/)
    expect(out.lines.at(-1)).toMatch(/^→ kept, weighted ×1\.30 by raise 2 docs\.example\.com/)
    expect((await h.app.rules.explain('https://example.com/')).decision).toBe('hidden')
  })

  it('explain checks a bare site as https and refuses what is not a site or URL', async () => {
    const h = await setup({ rules: 'version: 1\nrules:\n  - { match: example.com, action: block }\n' })
    const bare = await h.app.rules.explain('example.com')
    expect(bare.decision).toBe('hidden')
    expect(bare.lines[0]).toBe('url: https://example.com')
    expect((await h.app.rules.explain('  example.com/blog/post ')).decision).toBe('hidden')
    expect((await h.app.rules.explain('http://example.com:8080/x')).decision).toBe('hidden')
    expect((await h.app.rules.explain('other.example')).decision).toBe('kept')
    for (const bad of ['notaurl', '', 'two words.com', 'ftp://example.com/file', 'https://']) {
      await expect(h.app.rules.explain(bad)).rejects.toMatchObject({ code: 'invalid_argument' })
    }
  })

  it('explain names the lift an official source gets from the default profile', async () => {
    const h = await setup({})
    const out = await h.app.rules.explain('developer.mozilla.org/en-US/docs/Web')
    expect(out.decision).toBe('kept')
    expect(out.lines.at(-1)).toMatch(/^→ kept, lifted ×1\.45 because profile "default" prefers this source$/)
  })
})

describe('project rules and trust (ADR-0008)', () => {
  const PROJECT = 'version: 1\nrules:\n  - { match: react.dev, action: block }\n'

  it('ignores an untrusted file, applies it once trusted, and drops it when it changes', async () => {
    const h = await setup({ projectRules: PROJECT })
    const results: BuiltinResult[] = [{ title: 'R', url: 'https://react.dev/learn' }]
    expect((await h.app.filterBuiltinResults('x', results, {})).hidden).toEqual([])
    const doctor = await h.app.doctor()
    expect(doctor.checks.find((c) => c.id === 'project')).toMatchObject({
      status: 'warn',
      title: 'untrusted project rules',
    })

    const trusted = await h.app.rules.trust(h.project)
    expect(trusted.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await h.app.filterBuiltinResults('x', results, {})).hidden.map((r) => r.rule?.tier)).toEqual([
      'T2',
    ])

    // search-hole writing an already trusted file keeps it trusted.
    await h.app.rules.add({ match: 'pinfarm.com', action: 'block', scope: 'project' })
    expect((await h.app.filterBuiltinResults('x', PIN, {})).hidden).toHaveLength(2)

    // A hand edit changes the hash: untrusted again.
    writeFileSync(
      join(h.project, '.searchhole.yaml'),
      `${PROJECT}  - { match: example.org, action: block }\n`,
    )
    expect((await h.app.filterBuiltinResults('x', results, {})).hidden).toEqual([])
    expect((await h.app.doctor()).checks.find((c) => c.id === 'project')?.detail).toMatch(
      /changed since you trusted it/,
    )
  })

  it('refuses important in project rules', async () => {
    const h = await setup({ projectRules: 'version: 1\nrules: []\n' })
    await expect(
      h.app.rules.add({ match: 'a.com', action: 'block', scope: 'project', important: true }),
    ).rejects.toSatisfy(code('invalid_argument'))
  })
})

describe('strict loading with the last good rules (ADR-0008)', () => {
  it('keeps the last good rules when rules.yaml breaks', async () => {
    const h = await setup({ rules: 'version: 1\nrules:\n  - { match: pinfarm.com, action: block }\n' })
    expect((await h.app.filterBuiltinResults('x', PIN, {})).hidden).toHaveLength(1)
    writeFileSync(
      join(h.home, 'rules.yaml'),
      'version: 1\nrules:\n  - { match: pinfarm.com, action: explode, weight: 99 }\n  - [broken\n',
    )
    const other = await h.reopen()
    expect((await other.filterBuiltinResults('x', PIN, {})).hidden).toHaveLength(1)
    const check = (await other.doctor()).checks.find((c) => c.id === 'rules')
    expect(check).toMatchObject({
      status: 'warn',
      title: 'rules.yaml has an error; the last good rules are in force',
    })
  })
})

describe('rekeySession (ADR-0005)', () => {
  it('carries session rules over on resume and drops them on clear', async () => {
    const h = await setup()
    const a = hookSession('a')
    await h.app.rules.add({ match: 'pinfarm.com', action: 'block', scope: 'session' }, a)
    const b = hookSession('b')
    expect(await h.app.rekeySession?.('a', b, 'resume')).toEqual({ movedRules: 1 })
    expect((await h.app.filterBuiltinResults('x', PIN, b)).hidden).toHaveLength(1)
    expect((await h.app.filterBuiltinResults('x', PIN, a)).hidden).toHaveLength(0)
    expect(await h.app.rekeySession?.('b', hookSession('c'), 'clear')).toEqual({ movedRules: 0 })
    expect((await h.app.filterBuiltinResults('x', PIN, b)).hidden).toHaveLength(0)
    expect(await h.app.rules.list({ scope: 'session' })).toEqual([])
  })
})
