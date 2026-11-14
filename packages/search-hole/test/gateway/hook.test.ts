// SPDX-License-Identifier: Apache-2.0
// The `hook` tool event table (ADR-0014, ADR-0018), driven through a real MCP client.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { SUMMARY_WITHHELD } from '../../src/gateway/builtin.ts'
import { GUARD_DENY_REASON } from '../../src/gateway/guard.ts'
import { LOOP_BREAK_NOTE, STEER_REASON, UNREADABLE_NOTE } from '../../src/gateway/hook.ts'
import { SearchHoleError } from '../../src/shared/errors.ts'
import type { FakeAppOptions } from './fake-app.ts'
import { type Connected, callHook, connect, ERAS, type Era, harness } from './helpers.ts'

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/websearch-react-compiler.json', import.meta.url), 'utf8'),
) as { tool_input: Record<string, unknown>; tool_response: { results: unknown[]; [k: string]: unknown } }

/** The hooks.json substitutions arrive as strings; JSON values as JSON strings (spikes addendum). */
const json = (v: unknown): string => JSON.stringify(v)

let open: Connected[] = []
afterEach(async () => {
  for (const c of open) await c.close()
  open = []
})

async function setup(era: Era, fake: FakeAppOptions = {}, env?: Record<string, string>) {
  const h = harness({ fake, ...(env === undefined ? {} : { env }) })
  const c = await connect(h.gateway, era)
  open.push(c)
  const hook = (args: Record<string, string>) => callHook(c.client, args)
  return { h, client: c.client, hook }
}

const pre = (toolName: string, toolInput: unknown, extra: Record<string, string> = {}) => ({
  event: 'PreToolUse',
  sessionId: 's1',
  agentType: '',
  toolName,
  toolInput: json(toolInput),
  ...extra,
})

const post = (toolName: string, toolInput: unknown, toolResponse: unknown) => ({
  event: 'PostToolUse',
  sessionId: 's1',
  toolName,
  toolInput: json(toolInput),
  toolResponse: typeof toolResponse === 'string' ? toolResponse : json(toolResponse),
})

const denyOf = (out: Record<string, unknown>): string | undefined => {
  const spec = out.hookSpecificOutput as Record<string, unknown> | undefined
  return spec?.permissionDecision === 'deny' ? String(spec.permissionDecisionReason) : undefined
}

describe.each(ERAS)('hook tool (%s era)', (era) => {
  describe('turn bracketing and session keys', () => {
    test('UserPromptSubmit opens a turn under the hook key; later calls use it', async () => {
      const { h, client, hook } = await setup(era)
      expect(await hook({ event: 'UserPromptSubmit', sessionId: 's1' })).toEqual({})
      expect(h.app()?.callsTo('openTurn')[0]?.ctx?.session).toEqual({ key: 's1', source: 'hook' })
      await client.callTool({ name: 'search', arguments: { query: 'q' } })
      expect(h.app()?.callsTo('search')[0]?.ctx?.session).toEqual({ key: 's1', source: 'hook' })
    })

    test('SessionStart(clear) between turns re-keys; mid-turn it is ignored', async () => {
      const { h, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      // Auto-compaction mid-turn: same key, no new turn.
      expect(await hook({ event: 'SessionStart', sessionId: 's1', source: 'compact' })).toEqual({})
      expect(h.app()?.callsTo('openTurn').length).toBe(1)
      await hook({ event: 'Stop', sessionId: 's1' })
      expect(await hook({ event: 'SessionStart', sessionId: 's2', source: 'clear' })).toEqual({})
      expect(h.app()?.callsTo('openTurn').at(-1)?.ctx?.session).toEqual({ key: 's2', source: 'hook' })
      expect(h.gateway.sessions.hookKey).toBe('s2')
    })

    test('SessionStart with an unknown or empty source changes nothing', async () => {
      const { h, hook } = await setup(era)
      expect(await hook({ event: 'SessionStart', sessionId: 's9', source: '' })).toEqual({})
      expect(h.gateway.sessions.hookKey).toBeUndefined()
      expect(h.appCreations()).toBe(0)
    })

    test('SessionStart cannot re-key an active turn; a prompt in a new session replaces it at once', async () => {
      const { h, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      expect(await hook({ event: 'SessionStart', sessionId: 's9', source: 'clear' })).toEqual({})
      expect(h.gateway.sessions.hookKey).toBe('s1')
      expect(h.app()?.callsTo('openTurn').length).toBe(1)
      // Interrupt (no Stop), /clear, then a prompt within seconds (review 2026-10-31).
      h.clock.now += 3_000
      await hook({ event: 'UserPromptSubmit', sessionId: 's2' })
      expect(h.gateway.sessions.hookKey).toBe('s2')
      expect(h.app()?.callsTo('closeTurn')[0]?.ctx?.session?.key).toBe('s1')
      expect(h.app()?.callsTo('openTurn').at(-1)?.ctx?.session?.key).toBe('s2')
    })

    test('SessionStart re-keys pass the source to the App (resume/compact carry session rules, clear drops them)', async () => {
      const { h, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      await hook({ event: 'Stop', sessionId: 's1' })
      await hook({ event: 'SessionStart', sessionId: 's2', source: 'clear' })
      await hook({ event: 'SessionStart', sessionId: 's2', source: 'compact' })
      const calls = h.app()?.callsTo('rekeySession') ?? []
      expect(calls.map((c) => [c.args, c.ctx?.session?.key])).toEqual([[['s1', 'clear'], 's2']])
    })

    test('tool hooks act for their own session id', async () => {
      const { h, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      await hook(pre('WebFetch', { url: 'https://react.dev/learn' }, { sessionId: 's2' }))
      expect(h.app()?.callsTo('checkUrl')[0]?.ctx?.session).toEqual({ key: 's2', source: 'hook' })
    })

    test('Stop returns only the receipt systemMessage when the turn searched, else {}', async () => {
      const { client, hook } = await setup(era, {
        receiptLine: 'search-hole · 1 search · 3 results · 0 hidden',
      })
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      expect(await hook({ event: 'Stop', sessionId: 's1' })).toEqual({})
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      await client.callTool({ name: 'search', arguments: { query: 'q' } })
      const out = await hook({ event: 'Stop', sessionId: 's1' })
      expect(out).toEqual({ systemMessage: 'search-hole · 1 search · 3 results · 0 hidden' })
      expect(Object.keys(out)).toEqual(['systemMessage'])
    })

    test('Stop for another session id does not close the turn', async () => {
      const { h, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      expect(await hook({ event: 'Stop', sessionId: 'other' })).toEqual({})
      expect(h.app()?.callsTo('closeTurn').length).toBe(0)
      expect(h.gateway.sessions.turn?.key).toBe('s1')
    })

    test('a search after Stop reopens the turn (suspect Stop); the App reopens the receipt', async () => {
      const { h, client, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      await hook({ event: 'Stop', sessionId: 's1' })
      await client.callTool({ name: 'search', arguments: { query: 'q' } })
      expect(h.app()?.callsTo('openTurn').length).toBe(1)
      expect(h.gateway.sessions.turn?.key).toBe('s1')
    })

    test('a built-in WebSearch after Stop reopens the turn too, so the next Stop closes it', async () => {
      const { h, hook } = await setup(era)
      await hook({ event: 'UserPromptSubmit', sessionId: 's1' })
      await hook({ event: 'Stop', sessionId: 's1' })
      await hook(pre('WebSearch', { query: 'react compiler' }))
      expect(h.gateway.sessions.turn?.key).toBe('s1')
      await hook({ event: 'Stop', sessionId: 's1' })
      expect(h.app()?.callsTo('closeTurn').length).toBe(2)
    })
  })

  describe('PreToolUse WebSearch', () => {
    test('query hygiene denies without echoing the secret', async () => {
      const { hook } = await setup(era)
      const out = await hook(pre('WebSearch', { query: 'why does ghp_A1b2C3d4E5f6 fail' }))
      const reason = denyOf(out)
      expect(reason).toContain('an API key or access token')
      expect(reason).toContain('→')
      expect(reason).not.toContain('ghp_')
    })

    test('engines mode steers to our search; the deny-loop breaker then allows filtered WebSearch', async () => {
      const { h, client, hook } = await setup(era, {
        mode: { configured: 'auto', effective: 'engines' },
        blockedDomains: ['pinterest.com'],
      })
      const first = await hook(pre('WebSearch', { query: 'react compiler' }))
      expect(denyOf(first)).toBe(STEER_REASON)
      expect(STEER_REASON).toContain('mcp__plugin_search-hole_search-hole__search')
      // No search call since the deny: this caller cannot use our tool (e.g. a subagent).
      const second = await hook(pre('WebSearch', { query: 'react compiler' }))
      expect(second).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { query: 'react compiler', blocked_domains: ['pinterest.com'] },
          additionalContext: LOOP_BREAK_NOTE,
        },
      })
      // Once our search is used, WebSearch is steered again.
      await client.callTool({ name: 'search', arguments: { query: 'react compiler' } })
      expect(denyOf(await hook(pre('WebSearch', { query: 'react compiler' })))).toBe(STEER_REASON)
      expect(h.app()?.callsTo('searchMode').length).toBe(3)
    })

    test('the loop guard denies a WebSearch over budget, in any mode', async () => {
      const message =
        'search-hole stopped this search: this turn already ran 40 searches → answer with what you have'
      for (const effective of ['builtin', 'engines'] as const) {
        const { hook } = await setup(era, { mode: { configured: 'auto', effective }, overBudget: message })
        expect(denyOf(await hook(pre('WebSearch', { query: 'react compiler' })))).toBe(message)
      }
    })

    test('a search that fails does not reset the breaker (engines down: no deny loop)', async () => {
      const { client, hook } = await setup(era, {
        mode: { configured: 'engines', effective: 'engines' },
        search: () => {
          throw new SearchHoleError('no_healthy_engine', 'No search engine answered.')
        },
      })
      expect(denyOf(await hook(pre('WebSearch', { query: 'react compiler' })))).toBe(STEER_REASON)
      const failed = await client.callTool({ name: 'search', arguments: { query: 'react compiler' } })
      expect(failed.isError).toBe(true)
      const retry = await hook(pre('WebSearch', { query: 'react compiler' }))
      expect(denyOf(retry)).toBeUndefined()
      expect(JSON.stringify(retry)).toContain(LOOP_BREAK_NOTE)
    })

    test('the deny-loop breaker is per agent type', async () => {
      const { hook } = await setup(era, { mode: { configured: 'engines', effective: 'engines' } })
      expect(denyOf(await hook(pre('WebSearch', { query: 'q' }, { agentType: 'Explore' })))).toBe(
        STEER_REASON,
      )
      expect(denyOf(await hook(pre('WebSearch', { query: 'q' }, { agentType: '' })))).toBe(STEER_REASON)
      expect(denyOf(await hook(pre('WebSearch', { query: 'q' }, { agentType: 'Explore' })))).toBeUndefined()
    })

    test('builtin behaviour merges the user blocks into blocked_domains without auto-allowing', async () => {
      const { h, hook } = await setup(era, { blockedDomains: ['pinterest.com', 'w3schools.com'] })
      const out = await hook(
        pre('WebSearch', {
          query: 'css grid',
          blocked_domains: ['example.org', 'W3Schools.com'],
          mode: 'standard',
        }),
      )
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            query: 'css grid',
            mode: 'standard',
            blocked_domains: ['example.org', 'w3schools.com', 'pinterest.com'],
          },
        },
      })
      const spec = out.hookSpecificOutput as Record<string, unknown>
      expect(spec.permissionDecision).toBeUndefined()
      expect(h.app()?.callsTo('builtinBlockedDomains')[0]?.args).toEqual(['css grid'])
    })

    test('builtin behaviour with nothing to block answers {}', async () => {
      const { hook } = await setup(era)
      expect(await hook(pre('WebSearch', { query: 'css grid' }))).toEqual({})
    })

    test('allowed_domains: blocked ones are removed; all blocked means deny', async () => {
      const { hook } = await setup(era, { blockedDomains: ['pinterest.com'] })
      const out = await hook(
        pre('WebSearch', { query: 'q', allowed_domains: ['react.dev', 'www.pinterest.com'] }),
      )
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { query: 'q', allowed_domains: ['react.dev'] },
        },
      })
      const denied = await hook(pre('WebSearch', { query: 'q', allowed_domains: ['pinterest.com'] }))
      expect(denyOf(denied)).toContain('allowed_domains')
    })

    test('hygiene redact rewrites the query and says so', async () => {
      const { hook } = await setup(era)
      const out = await hook(pre('WebSearch', { query: 'ECONNREFUSED 10.0.0.12 postgres' }))
      const spec = out.hookSpecificOutput as Record<string, unknown>
      expect(spec.updatedInput).toEqual({ query: 'ECONNREFUSED [redacted] postgres' })
      expect(spec.additionalContext).toBe(
        'search-hole removed a private network address from the query before searching.',
      )
    })

    test('a malformed tool_input fails open', async () => {
      const { hook } = await setup(era)
      expect(
        await hook({ event: 'PreToolUse', sessionId: 's1', toolName: 'WebSearch', toolInput: '{not json' }),
      ).toEqual({})
    })
  })

  describe('PostToolUse WebSearch (recorded shape, spikes §6)', () => {
    const run = (fake: FakeAppOptions) => async () => {
      const ctx = await setup(era, fake)
      const out = await ctx.hook(post('WebSearch', FIXTURE.tool_input, FIXTURE.tool_response))
      return { ...ctx, out }
    }

    test('hidden results are removed in the same shape; the summary stays when blocks were upstream', async () => {
      const { h, out } = await run({ blockedDomains: ['logrocket.com', 'debugbear.com'] })()
      const spec = out.hookSpecificOutput as Record<string, unknown>
      expect(spec.hookEventName).toBe('PostToolUse')
      expect(spec.additionalContext).toBe(
        "search-hole applied the user's source rules to this search: hid 2 results · receipt rcpt_BBBBBBBBBBBBBBBBBBBBBB",
      )
      const rebuilt = spec.updatedToolOutput as typeof FIXTURE.tool_response
      expect(Object.keys(rebuilt).sort()).toEqual(['durationSeconds', 'query', 'results', 'searchCount'])
      expect(rebuilt.durationSeconds).toBe(6.214)
      expect(rebuilt.searchCount).toBe(1)
      const [block, summary] = rebuilt.results as [
        { tool_use_id: string; content: { url: string }[] },
        string,
      ]
      expect(block.tool_use_id).toBe('srvtoolu_01KXWbQwq1Bm7bJ1oYf6Xq3d')
      expect(block.content.map((c) => c.url)).not.toContain(
        'https://blog.logrocket.com/react-compiler-complete-guide/',
      )
      expect(block.content.length).toBe(7)
      expect(summary).toBe(FIXTURE.tool_response.results[1])
      const call = h.app()?.callsTo('filterBuiltinResults')[0]
      expect(call?.args[0]).toBe('react compiler')
      expect((call?.args[1] as { url: string }[] | undefined)?.length).toBe(9)
    })

    test('results removed only after the search withhold the summary', async () => {
      const { out } = await run({ postSearchBlocked: ['az.react.dev'] })()
      const spec = out.hookSpecificOutput as Record<string, unknown>
      const rebuilt = spec.updatedToolOutput as typeof FIXTURE.tool_response
      expect(rebuilt.results[1]).toBe(SUMMARY_WITHHELD)
      expect(spec.additionalContext).toBe(
        "search-hole applied the user's source rules to this search: hid 1 result · receipt rcpt_BBBBBBBBBBBBBBBBBBBBBB",
      )
    })

    test('pins come first; the note says what was pinned', async () => {
      const { out } = await run({ pinnedDomains: ['nextjs.org'] })()
      const spec = out.hookSpecificOutput as Record<string, unknown>
      expect(spec.additionalContext).toMatch(
        /^search-hole applied the user's source rules to this search: pinned \d+ results? · receipt rcpt_/,
      )
      const rebuilt = spec.updatedToolOutput as typeof FIXTURE.tool_response
      const block = rebuilt.results[0] as { content: { url: string }[] }
      expect(block.content[0]?.url).toBe(
        'https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler',
      )
      expect(block.content.length).toBe(9)
    })

    test('nothing to change keeps the output and still tells the model the rules ran', async () => {
      const { out } = await run({})()
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            "search-hole applied the user's source rules to this search: checked every result (none matched a rule) · receipt rcpt_BBBBBBBBBBBBBBBBBBBBBB",
        },
      })
    })

    test('the note counts sites excluded upstream from the rewritten tool_input', async () => {
      const input = { ...FIXTURE.tool_input, blocked_domains: ['logrocket.com', 'debugbear.com'] }
      const { hook } = await setup(era, {})
      const out = await hook(post('WebSearch', input, FIXTURE.tool_response))
      const spec = out.hookSpecificOutput as Record<string, unknown>
      expect(spec.additionalContext).toMatch(/excluded 2 blocked sites before the search/)
    })

    test('an unrecognised tool_response fails open with a warning, and says so to the model', async () => {
      const { h, hook } = await setup(era, { blockedDomains: ['logrocket.com'] })
      const said = {
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: UNREADABLE_NOTE },
      }
      expect(await hook(post('WebSearch', { query: 'q' }, { unexpected: true }))).toEqual(said)
      expect(await hook(post('WebSearch', { query: 'q' }, 'not json'))).toEqual(said)
      expect(h.logs().filter((l) => String(l.msg).includes('unrecognised tool_response')).length).toBe(2)
    })

    test('an App failure fails open', async () => {
      const { h, hook } = await setup(era, { failing: ['filterBuiltinResults'] })
      expect(await hook(post('WebSearch', FIXTURE.tool_input, FIXTURE.tool_response))).toEqual({})
      expect(h.logs().some((l) => l.msg === 'hook failed; answering {} (fail open)')).toBe(true)
    })
  })

  describe('WebFetch', () => {
    test('PreToolUse denies blocked sites with the rule message', async () => {
      const { hook } = await setup(era, { blockedDomains: ['pinterest.com'] })
      const out = await hook(pre('WebFetch', { url: 'https://www.pinterest.com/pin/1', prompt: 'summarise' }))
      expect(denyOf(out)).toBe(
        'search-hole: www.pinterest.com is blocked by your rule "block www.pinterest.com"',
      )
      expect(await hook(pre('WebFetch', { url: 'https://react.dev/', prompt: 'summarise' }))).toEqual({})
    })

    test('PostToolUse records the opened page', async () => {
      const { h, hook } = await setup(era)
      expect(
        await hook(post('WebFetch', { url: 'https://react.dev/learn', prompt: 'p' }, { result: 'text' })),
      ).toEqual({})
      expect(h.app()?.callsTo('recordBuiltinFetch')[0]?.args).toEqual(['https://react.dev/learn'])
    })
  })

  describe('rule-change guard', () => {
    test.each([
      'searchhole block example.com',
      'search-hole allow example.com --yes',
      'node "/Users/me/.claude/plugins/search-hole/dist/searchhole.mjs" rules add example.com',
      'npx search-hole pin react.dev',
      'cd /tmp && searchhole --yes trust .',
      'searchhole suggestions approve 3',
      'searchhole review keep example.com --yes',
      'searchhole review unkeep example.com',
    ])('denies %s', async (command) => {
      const { hook } = await setup(era)
      expect(denyOf(await hook(pre('Bash', { command })))).toBe(GUARD_DENY_REASON)
    })

    test.each([
      'ls -la',
      'searchhole search --explain "react compiler"',
      'searchhole doctor',
      'searchhole suggestions',
      'searchhole review --days 7',
      'SEARCHHOLE_SKILL=1 searchhole block example.com',
      'grep -r searchhole src/',
    ])('allows %s without starting the App, fast', async (command) => {
      const { h, hook } = await setup(era)
      // Best of five: the budget is for the code path, not for one scheduling hiccup under load.
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++) {
        const started = performance.now()
        expect(await hook(pre('Bash', { command }))).toEqual({})
        best = Math.min(best, performance.now() - started)
      }
      expect(best).toBeLessThan(50)
      expect(h.appCreations()).toBe(0)
    })

    test('the guard honours hooks.guard: false', async () => {
      const { hook } = await setup(era, { guard: false })
      expect(await hook(pre('Bash', { command: 'searchhole block example.com' }))).toEqual({})
    })

    test.each([
      ['Edit', { file_path: '/home/tester/.searchhole/rules.yaml' }],
      ['Write', { file_path: '/home/tester/.config/searchhole/settings.yaml', content: 'x' }],
      ['MultiEdit', { file_path: '/home/tester/.local/share/searchhole/searchhole.db' }],
      ['Write', { file_path: '/work/project/.searchhole.yaml', content: 'rules: []' }],
      ['Edit', { file_path: '.searchhole.yaml' }],
      ['NotebookEdit', { notebook_path: '/home/tester/.searchhole/notes.ipynb' }],
    ] as const)('denies %s to a search-hole file', async (tool, input) => {
      const { hook } = await setup(era)
      expect(denyOf(await hook(pre(tool, input)))).toBe(GUARD_DENY_REASON)
    })

    test.each([
      ['Edit', { file_path: '/work/project/settings.yaml' }],
      ['Write', { file_path: '/work/project/config/rules.yaml', content: 'groups: []' }],
      ['Edit', { file_path: '/home/tester/.searchhole-notes/x.md' }],
    ] as const)('allows %s to other files', async (tool, input) => {
      const { h, hook } = await setup(era)
      expect(await hook(pre(tool, input))).toEqual({})
      expect(h.appCreations()).toBe(0)
    })
  })

  test('unknown events and tools answer {}', async () => {
    const { hook } = await setup(era)
    expect(await hook({ event: 'Notification', sessionId: 's1' })).toEqual({})
    expect(await hook(pre('Read', { file_path: '/etc/hosts' }))).toEqual({})
  })

  test('exceptions answer {} (fail open)', async () => {
    const { hook } = await setup(era, { failing: ['openTurn', 'checkUrl'] })
    expect(await hook({ event: 'UserPromptSubmit', sessionId: 's1' })).toEqual({})
    expect(await hook(pre('WebFetch', { url: 'https://react.dev/' }))).toEqual({})
  })

  test('lean single fields (command, filePath, url, query) work without toolInput', async () => {
    const { hook } = await setup(era, { blockedDomains: ['pinterest.com'] })
    const bash = { event: 'PreToolUse', sessionId: 's1', toolName: 'Bash', command: 'searchhole block x.com' }
    expect(denyOf(await hook(bash))).toBe(GUARD_DENY_REASON)
    const nb = {
      event: 'PreToolUse',
      sessionId: 's1',
      toolName: 'NotebookEdit',
      filePath: '/home/tester/.searchhole/a.ipynb',
    }
    expect(denyOf(await hook(nb))).toBe(GUARD_DENY_REASON)
    const fetch = {
      event: 'PreToolUse',
      sessionId: 's1',
      toolName: 'WebFetch',
      url: 'https://pinterest.com/x',
    }
    expect(denyOf(await hook(fetch))).toContain('blocked')
    // Missing substitutions arrive as "" and mean "absent".
    expect(await hook({ ...bash, command: '', toolInput: '' })).toEqual({})
  })
})

test('the hook tool does not exist outside the claude-code profile', async () => {
  const h = harness({ host: 'generic', env: {} })
  const c = await connect(h.gateway, 'modern')
  open.push(c)
  await expect(
    c.client.callTool({ name: 'hook', arguments: { event: 'Stop', sessionId: 's1' } }),
  ).rejects.toThrow(/Tool hook not found/)
})
