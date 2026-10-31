// SPDX-License-Identifier: Apache-2.0
// Pure gateway pieces: host refinement, request context, session state, the guard matchers.
import { describe, expect, test } from 'vitest'
import { buildRequestCtx, requestContext, resolveProjectDir } from '../../src/gateway/context.ts'
import { isDevelopmentVersion, protocolModeFromEnv } from '../../src/gateway/gateway.ts'
import { bashChangesRules, fileIsProtected } from '../../src/gateway/guard.ts'
import { refineHostProfile } from '../../src/gateway/host.ts'
import { FALLBACK_IDLE_MS, GatewaySessions, STALE_TURN_MS } from '../../src/gateway/session.ts'

describe('refineHostProfile (ADR-0012)', () => {
  test.each([
    ['generic', {}, 'generic'],
    ['generic', { CLAUDECODE: '1' }, 'claude-code'],
    ['claude-code', { CLAUDECODE: '1' }, 'claude-code'],
    ['claude-code', {}, 'claude-code'],
    ['claude-code', { CLAUDECODE: '1', CURSOR_TRACE_ID: 'abc' }, 'cursor'],
    // Claude Code run from a Cursor terminal: its own session variable wins.
    ['claude-code', { CLAUDECODE: '1', CURSOR_TRACE_ID: 'abc', CLAUDE_CODE_SESSION_ID: 's' }, 'claude-code'],
    ['claude-code', { CLAUDECODE: '1', CURSOR_TRACE_ID: '' }, 'claude-code'],
    ['codex', { CLAUDECODE: '0' }, 'codex'],
  ] as const)('%s with %j → %s', (requested, env, expected) => {
    expect(refineHostProfile(requested, env).host).toBe(expected)
  })
})

describe('requestContext (ADR-0013 point 4)', () => {
  test('modern requests read the envelope; vendor keys stay in _meta', () => {
    const info = requestContext(
      {
        mcpReq: {
          envelope: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.312' },
            'io.modelcontextprotocol/clientCapabilities': { elicitation: {} },
          },
          _meta: { 'claudecode/toolUseId': 'toolu_1', progressToken: 7 },
        },
      },
      'legacy',
    )
    expect(info).toEqual({
      era: 'modern',
      protocolVersion: '2026-07-28',
      clientInfo: { name: 'claude-code', version: '2.1.312' },
      capabilities: { elicitation: {} },
      vendorMeta: { 'claudecode/toolUseId': 'toolu_1', progressToken: 7 },
      toolUseId: 'toolu_1',
      progressToken: 7,
    })
  })

  test('legacy connections read the initialize data', () => {
    const info = requestContext({ mcpReq: {} }, 'legacy', {
      getClientVersion: () => ({ name: 'cursor', version: '3.21' }),
      getClientCapabilities: () => ({ roots: {} }),
      getNegotiatedProtocolVersion: () => '2025-11-25',
    })
    expect(info).toEqual({
      era: 'legacy',
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'cursor', version: '3.21' },
      capabilities: { roots: {} },
      vendorMeta: {},
    })
  })

  test('project directory chain (ADR-0005)', () => {
    const proc = { env: {}, cwd: '/work/repo', home: '/home/u' }
    expect(resolveProjectDir({ vendorMeta: {} }, { ...proc, env: { CLAUDE_PROJECT_DIR: '/p/claude' } })).toBe(
      '/p/claude',
    )
    expect(
      resolveProjectDir({ vendorMeta: { 'codex/sandbox-state': { sandboxCwd: '/p/codex' } } }, proc),
    ).toBe('/p/codex')
    expect(resolveProjectDir({ vendorMeta: { 'agent-working-dir': '/p/goose' } }, proc)).toBe('/p/goose')
    expect(resolveProjectDir({ vendorMeta: {} }, proc)).toBe('/work/repo')
    expect(resolveProjectDir({ vendorMeta: {} }, { ...proc, cwd: '/home/u' })).toBeUndefined()
    expect(resolveProjectDir({ vendorMeta: {} }, { ...proc, cwd: '/' })).toBeUndefined()
    expect(resolveProjectDir({ vendorMeta: {} }, { ...proc, env: { CLAUDE_PROJECT_DIR: 'relative' } })).toBe(
      '/work/repo',
    )
  })

  test('buildRequestCtx omits what is unknown', () => {
    const sessions = new GatewaySessions({ host: 'generic', pid: 1, env: {}, now: () => 0 })
    const ctx = buildRequestCtx({ era: 'legacy', vendorMeta: {} }, sessions, {
      env: {},
      cwd: '/',
      home: '/h',
    })
    expect(Object.keys(ctx).sort()).toEqual(['protocolEra', 'session'])
  })
})

describe('GatewaySessions', () => {
  const make = (env: Record<string, string> = {}) => {
    const clock = { now: 1_000_000 }
    return { clock, s: new GatewaySessions({ host: 'claude-code', pid: 7, env, now: () => clock.now }) }
  }

  test('precedence: hook, meta, env, fallback', () => {
    const { s } = make({ CLAUDE_CODE_SESSION_ID: 'env-key' })
    expect(s.resolve({})).toEqual({ key: 'env-key', source: 'env' })
    expect(s.resolve({ 'vscode.conversationId': 'v1' })).toEqual({ key: 'v1', source: 'meta' })
    s.beginTurn('UserPromptSubmit', 'hook-key')
    expect(s.resolve({ 'vscode.conversationId': 'v1' })).toEqual({ key: 'hook-key', source: 'hook' })
  })

  test('the fallback label survives short gaps and renews after 30 idle minutes', () => {
    const { s, clock } = make()
    const first = s.resolve({}).key
    clock.now += FALLBACK_IDLE_MS - 1
    expect(s.resolve({}).key).toBe(first)
    clock.now += FALLBACK_IDLE_MS + 1
    expect(s.resolve({}).key).not.toBe(first)
  })

  test('turn bracketing decisions', () => {
    const { s, clock } = make()
    expect(s.beginTurn('UserPromptSubmit', '')).toEqual({ kind: 'refused', reason: 'no_session' })
    expect(s.beginTurn('SessionStart', 'a', 'weird')).toEqual({ kind: 'noop', reason: 'source' })
    expect(s.beginTurn('UserPromptSubmit', 'a')).toMatchObject({ kind: 'open', key: 'a', rekeyed: true })
    expect(s.beginTurn('SessionStart', 'a', 'compact')).toEqual({ kind: 'noop', reason: 'turn_open' })
    // SessionStart from another session replaces only an idle turn.
    expect(s.beginTurn('SessionStart', 'b', 'clear')).toEqual({ kind: 'refused', reason: 'turn_active' })
    clock.now += STALE_TURN_MS - 1
    s.noteActivity()
    s.noteActivity('other-session') // a hook from another session does not keep this turn alive
    clock.now += STALE_TURN_MS - 1
    expect(s.beginTurn('SessionStart', 'b', 'clear').kind).toBe('refused')
    clock.now += 1
    expect(s.beginTurn('SessionStart', 'b', 'clear')).toMatchObject({
      kind: 'open',
      key: 'b',
      previousKey: 'a',
    })
    // A prompt always replaces the open turn, whatever its key (interrupt, /clear, prompt).
    expect(s.beginTurn('UserPromptSubmit', 'a')).toMatchObject({
      kind: 'open',
      key: 'a',
      replaced: { key: 'b' },
    })
    expect(s.beginTurn('UserPromptSubmit', 'b')).toMatchObject({ kind: 'open', key: 'b', previousKey: 'a' })
    expect(s.endTurn('a')).toEqual({ kind: 'mismatch' })
    expect(s.endTurn('b').kind).toBe('close')
    expect(s.endTurn('b')).toEqual({ kind: 'none' })
    // Same key while a turn is open: the previous turn ended without a Stop.
    s.beginTurn('UserPromptSubmit', 'b')
    expect(s.beginTurn('UserPromptSubmit', 'b')).toMatchObject({ kind: 'open', rekeyed: false })
  })

  test('deny-loop breaker counts search calls', () => {
    const { s } = make()
    expect(s.denyLoopBroken('x', '')).toBe(false)
    s.recordDeny('x', '')
    expect(s.denyLoopBroken('x', '')).toBe(true)
    expect(s.denyLoopBroken('x', 'Explore')).toBe(false)
    s.noteSearchCall()
    expect(s.denyLoopBroken('x', '')).toBe(false)
  })
})

describe('guard matchers', () => {
  test.each([
    ['searchhole block a.com', true],
    ['  searchhole   raise docs.rs 3', true],
    ['echo hi; search-hole lower a.com', true],
    ['echo hi && "searchhole" keys set brave', true],
    ['node ./dist/searchhole.mjs unrule a.com', true],
    ['pnpm dlx search-hole lists add x', true],
    ['searchhole --yes mode engines', true],
    ['searchhole suggestions reject 2', true],
    ['SEARCHHOLE_SKILL=1 searchhole block a.com', false],
    ['searchhole log --hidden', false],
    ['searchhole explain https://a.com', false],
    ['searchhole searxng up', false],
    ['searchhole suggestions', false],
    ['cat .searchhole.yaml', false],
    ['my-searchhole block x', false],
    ['echo searchhole-block', false],
    ['', false],
  ])('%s → %s', (command, denied) => {
    expect(bashChangesRules(command)).toBe(denied)
  })

  test('fileIsProtected: roots and our project file; case-insensitive where the FS is', () => {
    const roots = { dirs: ['/Users/u/.searchhole'], caseInsensitive: true }
    expect(fileIsProtected('/Users/u/.searchhole/rules.yaml', '/', roots)).toBe(true)
    expect(fileIsProtected('/users/U/.SearchHole/settings.yaml', '/', roots)).toBe(true)
    expect(fileIsProtected('/Users/u/.searchhole', '/', roots)).toBe(true)
    expect(fileIsProtected('/Users/u/.searchholex/a', '/', roots)).toBe(false)
    expect(fileIsProtected('../u/.searchhole/x', '/Users/other', roots)).toBe(true)
    expect(fileIsProtected('sub/.searchhole.yaml', '/repo', roots)).toBe(true)
    expect(fileIsProtected('/repo/settings.yaml', '/', roots)).toBe(false)
    expect(fileIsProtected('', '/', roots)).toBe(false)
    expect(fileIsProtected('/users/u/.searchhole/x', '/', { ...roots, caseInsensitive: false })).toBe(false)
  })
})

describe('process settings', () => {
  test('SEARCHHOLE_MCP_PROTOCOL', () => {
    expect(protocolModeFromEnv({})).toBe('auto')
    expect(protocolModeFromEnv({ SEARCHHOLE_MCP_PROTOCOL: 'Legacy' })).toBe('legacy')
    expect(protocolModeFromEnv({ SEARCHHOLE_MCP_PROTOCOL: 'modern' })).toBe('modern')
    expect(protocolModeFromEnv({ SEARCHHOLE_MCP_PROTOCOL: 'bogus' })).toBe('auto')
  })

  test('development versions', () => {
    expect(isDevelopmentVersion('0.0.0')).toBe(true)
    expect(isDevelopmentVersion('0.2.0-dev.3')).toBe(true)
    expect(isDevelopmentVersion('0.1.0')).toBe(false)
  })
})
