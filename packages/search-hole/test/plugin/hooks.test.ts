// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the ${...} strings are Claude Code placeholders, not templates
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HOOK_SERVER, HOOK_TOOL, PLUGIN_DIR, readJson, readText } from './helpers.ts'

const CommandHook = z
  .object({
    type: z.literal('command'),
    command: z.string(),
    onFailure: z.enum(['continue', 'block']).optional(),
    timeout: z.number().optional(),
  })
  .strict()

const McpToolHook = z
  .object({
    type: z.literal('mcp_tool'),
    server: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.string()),
    timeout: z.number().optional(),
  })
  .strict()

const HookEntry = z.discriminatedUnion('type', [CommandHook, McpToolHook])
const Group = z.object({ matcher: z.string().optional(), hooks: z.array(HookEntry).min(1) }).strict()
const HooksFile = z.object({
  description: z.string().optional(),
  hooks: z.record(z.string(), z.array(Group)),
})

const file = HooksFile.parse(readJson(PLUGIN_DIR, 'hooks', 'hooks.json'))
const raw = readText(PLUGIN_DIR, 'hooks', 'hooks.json')

/** The single mcp_tool hook of an event's first group, or undefined. */
function mcpHooks(event: string) {
  return (file.hooks[event] ?? []).flatMap((g) => g.hooks).flatMap((h) => (h.type === 'mcp_tool' ? [h] : []))
}

describe('hooks.json structure (ADR-0014)', () => {
  it('registers exactly the five events', () => {
    expect(Object.keys(file.hooks).sort()).toEqual([
      'PostToolUse',
      'PreToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ])
  })

  it('has one group per event (PreToolUse: one per input shape), matchers only where the ADR has them', () => {
    for (const [event, groups] of Object.entries(file.hooks)) {
      if (event !== 'PreToolUse' && event !== 'PostToolUse') expect(groups, event).toHaveLength(1)
    }
    // Web tools get the whole input; Bash and file tools get one lean field, so Write bodies never travel.
    expect(file.hooks.PreToolUse?.map((g) => g.matcher)).toEqual([
      'WebSearch|WebFetch',
      'Bash',
      'Edit|Write|MultiEdit',
      'NotebookEdit',
    ])
    // WebFetch's response is the whole page and unused: only its URL travels.
    expect(file.hooks.PostToolUse?.map((g) => g.matcher)).toEqual(['WebSearch', 'WebFetch'])
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      expect(file.hooks[event]?.[0]?.matcher, event).toBeUndefined()
    }
  })

  it('uses only matcher syntax that Claude Code treats as an exact tool list', () => {
    for (const groups of Object.values(file.hooks)) {
      for (const g of groups) if (g.matcher !== undefined) expect(g.matcher).toMatch(/^[A-Za-z0-9_|-]+$/)
    }
  })

  it('SessionStart: shell-form preflight first (non-blocking, 5 s), then the mcp_tool hook', () => {
    const hooks = file.hooks.SessionStart?.[0]?.hooks ?? []
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toEqual({
      type: 'command',
      command: '. "${CLAUDE_PLUGIN_ROOT}/hooks/preflight.ps1"',
      onFailure: 'continue',
      timeout: 5,
    })
    expect(hooks[1]).toMatchObject({
      type: 'mcp_tool',
      server: HOOK_SERVER,
      tool: HOOK_TOOL,
      input: { event: 'SessionStart', sessionId: '${session_id}', source: '${source}' },
    })
  })

  it('UserPromptSubmit and Stop send the event and the session id only', () => {
    expect(mcpHooks('UserPromptSubmit').map((h) => h.input)).toEqual([
      { event: 'UserPromptSubmit', sessionId: '${session_id}' },
    ])
    expect(mcpHooks('Stop').map((h) => h.input)).toEqual([{ event: 'Stop', sessionId: '${session_id}' }])
  })

  it('PreToolUse sends the agent type and tool name, plus the input in the leanest form per tool', () => {
    const common = {
      event: 'PreToolUse',
      sessionId: '${session_id}',
      agentType: '${agent_type}',
      toolName: '${tool_name}',
    }
    expect(mcpHooks('PreToolUse').map((h) => h.input)).toEqual([
      { ...common, toolInput: '${tool_input}' },
      { ...common, command: '${tool_input.command}' },
      { ...common, filePath: '${tool_input.file_path}' },
      { ...common, filePath: '${tool_input.notebook_path}' },
    ])
  })

  it('PostToolUse sends WebSearch input and response as JSON strings, WebFetch only its URL', () => {
    expect(mcpHooks('PostToolUse').map((h) => h.input)).toEqual([
      {
        event: 'PostToolUse',
        sessionId: '${session_id}',
        toolName: '${tool_name}',
        toolInput: '${tool_input}',
        toolResponse: '${tool_response}',
      },
      {
        event: 'PostToolUse',
        sessionId: '${session_id}',
        toolName: '${tool_name}',
        url: '${tool_input.url}',
      },
    ])
  })

  it('every mcp_tool hook calls the gateway hook tool on the plugin-scoped server name', () => {
    const all = Object.keys(file.hooks).flatMap(mcpHooks)
    expect(all).toHaveLength(9)
    for (const hook of all) {
      expect(hook.server).toBe(HOOK_SERVER)
      expect(hook.tool).toBe(HOOK_TOOL)
    }
  })

  it('each hook reports the event it is registered under', () => {
    for (const event of Object.keys(file.hooks)) {
      for (const hook of mcpHooks(event)) expect(hook.input.event).toBe(event)
    }
  })

  it('substitutes only the paths that the 2.1.312 spike verified', () => {
    const verified = new Set([
      'session_id',
      'source',
      'agent_type',
      'tool_name',
      'tool_input',
      'tool_input.command', // verified in spike §1
      'tool_input.file_path', // the docs' own example
      'tool_input.notebook_path', // same mechanism; confirm in the E2E
      'tool_input.url', // same mechanism; confirm in the E2E (an unsubstituted value is ignored)
      'tool_response',
      'CLAUDE_PLUGIN_ROOT',
    ])
    const used = [...raw.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1] ?? '')
    expect(used.length).toBeGreaterThan(0)
    for (const name of used) expect(verified, name).toContain(name)
  })

  it('has the only command hook on SessionStart (the gateway answers everything else)', () => {
    const commands = Object.entries(file.hooks).flatMap(([event, groups]) =>
      groups.flatMap((g) => g.hooks).flatMap((h) => (h.type === 'command' ? [event] : [])),
    )
    expect(commands).toEqual(['SessionStart'])
  })

  it('sets a timeout on every mcp_tool hook so a stuck gateway cannot stall a tool call', () => {
    for (const hook of Object.keys(file.hooks).flatMap(mcpHooks)) {
      expect(hook.timeout).toBeGreaterThan(0)
      expect(hook.timeout).toBeLessThanOrEqual(30)
    }
  })

  it('points the preflight command at files that exist, with the root variable quoted', () => {
    expect(existsSync(join(PLUGIN_DIR, 'hooks', 'preflight.ps1'))).toBe(true)
    expect(existsSync(join(PLUGIN_DIR, 'hooks', 'preflight-windows.ps1'))).toBe(true)
    const command = file.hooks.SessionStart?.[0]?.hooks[0]
    expect(command?.type === 'command' && command.command).toContain(
      '"${CLAUDE_PLUGIN_ROOT}/hooks/preflight.ps1"',
    )
  })

  it('never puts a user_config placeholder in a hook (shell-form hooks reject them)', () => {
    expect(raw).not.toContain('user_config')
  })
})
