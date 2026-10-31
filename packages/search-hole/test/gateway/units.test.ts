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
    // Mentions in quoted arguments of other commands are not invocations (review 2026-10-31).
    ['git commit -m "docs: search-hole mode auto is the default"', false],
    ['gh pr create --title "Make search-hole block lists faster"', false],
    ['grep -rn "searchhole block" docs/', false],
    ["rg -n 'search-hole pin' README.md", false],
    ["git commit -F - <<'EOF'\nfix: searchhole block now works\nEOF", false],
    ['echo "run: searchhole block x" > notes.txt', false],
    ['ls packages/search-hole/src/core/rules && cat packages/search-hole/src/app/rules.ts', false],
    // ...but nested commands still run.
    ['bash -c "searchhole block evil.com"', true],
    ["sh -lc 'cd /tmp && search-hole pin docs.rs'", true],
    ['eval "searchhole block x"', true],
    ['echo "$(searchhole block x)"', true],
    ['echo `searchhole allow y`', true],
    ['bash <<EOF\nsearchhole block x\nEOF', true],
    ['(searchhole block x)', true],
    ['if true; then searchhole block x; fi', true],
    // Runners and wrappers the old matcher missed.
    ['pnpm -C packages/search-hole dev block evil.com', true],
    ['cd packages/search-hole && node src/cli/main.ts block x', true],
    ['node packages/search-hole/src/cli/main.ts block x', true],
    ['npx search-hole@0.1.1 block x', true],
    ['npx -y -p search-hole searchhole block x', true],
    ['echo evil.com | xargs searchhole block', true],
    ['env FOO=1 sudo -u me searchhole keys set tavily', true],
    ['timeout 5 searchhole block x', true],
    ['pnpm dev block x', false],
    ['node src/cli/main.ts block x', false],
    // The skill marker counts only on the command it prefixes.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the skills' literal Claude Code placeholder
    ['SEARCHHOLE_SKILL=1 node "${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs" pin docs.rs', false],
    ['SEARCHHOLE_SKILL=1 true; searchhole block x', true],
  ])('%s → %s', (command, denied) => {
    expect(bashChangesRules(command)).toBe(denied)
  })

  test('Bash writes into search-hole files are denied; reads and other files are not', () => {
    const files = {
      roots: { dirs: ['/Users/u/.searchhole', '/Users/u/.config/searchhole'], caseInsensitive: true },
      baseDir: '/repo',
      home: '/Users/u',
    }
    const denied = (c: string) => bashChangesRules(c, files)
    expect(denied('echo "- {match: x, action: allow}" >> ~/.config/searchhole/rules.yaml')).toBe(true)
    expect(denied('cat > $HOME/.searchhole/settings.yaml <<EOF\nhooks: {guard: false}\nEOF')).toBe(true)
    expect(denied('printf x | tee -a /Users/u/.searchhole/rules.yaml')).toBe(true)
    expect(denied('cp /tmp/rules.yaml ~/.searchhole/rules.yaml')).toBe(true)
    expect(denied("sed -i '' 's/block/allow/' ~/.config/searchhole/rules.yaml")).toBe(true)
    expect(denied('echo x > sub/.searchhole.yaml')).toBe(true)
    expect(denied('rm -rf ~/.searchhole')).toBe(true)
    expect(denied('cat ~/.searchhole/rules.yaml')).toBe(false)
    expect(denied('cp ~/.searchhole/rules.yaml /tmp/backup.yaml')).toBe(false)
    expect(denied('grep block ~/.config/searchhole/rules.yaml 2>&1 > /tmp/out')).toBe(false)
    expect(denied('sed -n 1,5p ~/.config/searchhole/rules.yaml')).toBe(false)
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
