// SPDX-License-Identifier: Apache-2.0
// The real stdio entry (serveStdio) in both eras: in-process over streams, and a spawned
// process whose stdout must carry nothing but JSON-RPC.
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, test } from 'vitest'
import { serveGatewayStdio } from '../../src/gateway/gateway.ts'
import { harness } from './helpers.ts'

type Json = Record<string, unknown>

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.312' },
}

/** A line-oriented JSON-RPC peer over a pair of streams. */
function wire(stdin: PassThrough, stdout: PassThrough) {
  const raw: string[] = []
  const waiting = new Map<number, (msg: Json) => void>()
  let buf = ''
  stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      raw.push(line)
      const msg = JSON.parse(line) as Json
      if (typeof msg.id === 'number') waiting.get(msg.id)?.(msg)
      nl = buf.indexOf('\n')
    }
  })
  let nextId = 1
  return {
    raw,
    request(method: string, params: Json = {}): Promise<Json> {
      const id = nextId++
      const reply = new Promise<Json>((resolve) => waiting.set(id, resolve))
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return reply
    },
    notify(method: string, params: Json = {}): void {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

function serve(env: Record<string, string> = {}) {
  const h = harness({ host: 'claude-code', env: { CLAUDE_PROJECT_DIR: '/work/project', ...env } })
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const handle = serveGatewayStdio(h.gateway, { stdin, stdout })
  return { h, stdin, stdout, handle, peer: wire(stdin, stdout) }
}

const resultOf = (msg: Json): Json => {
  if (msg.result === undefined) throw new Error(`error reply: ${JSON.stringify(msg.error)}`)
  return msg.result as Json
}

describe('stdio in-process', () => {
  test('legacy: initialize, tools/list, a hook call; stdin EOF releases the App', async () => {
    const { h, stdin, handle, peer } = serve()
    const init = resultOf(
      await peer.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '3.21' },
      }),
    )
    expect(init.protocolVersion).toBe('2025-11-25')
    expect(typeof init.instructions).toBe('string')
    peer.notify('notifications/initialized')
    const list = resultOf(await peer.request('tools/list'))
    expect((list.tools as { name: string }[]).map((t) => t.name)).toEqual([
      'search',
      'fetch',
      'receipt',
      'suggest_rule',
      'hook',
    ])
    const call = resultOf(
      await peer.request('tools/call', {
        name: 'search',
        arguments: { query: 'react compiler' },
      }),
    )
    expect(call.isError).not.toBe(true)
    // Same instance for the whole connection: the legacy client identity reaches the App.
    expect(h.app()?.callsTo('search')[0]?.ctx?.client).toEqual({ name: 'cursor', version: '3.21' })
    expect(h.app()?.callsTo('search')[0]?.ctx?.protocolEra).toBe('legacy')
    stdin.end()
    await handle.closed
    expect(h.app()?.closed).toBe(true)
    for (const line of peer.raw) expect(JSON.parse(line)).toHaveProperty('jsonrpc', '2.0')
  })

  test('modern: server/discover then calls with the envelope; a discover probe alone creates no App', async () => {
    const { h, stdin, handle, peer } = serve()
    const discover = resultOf(await peer.request('server/discover', { _meta: MODERN_META }))
    expect(discover.supportedVersions).toEqual(['2026-07-28'])
    expect(discover.ttlMs).toBe(3_600_000)
    expect(discover.instructions).toBeTypeOf('string')
    expect(h.appCreations()).toBe(0)
    const list = resultOf(await peer.request('tools/list', { _meta: MODERN_META }))
    expect(list.cacheScope).toBe('private')
    const hook = resultOf(
      await peer.request('tools/call', {
        name: 'hook',
        arguments: { event: 'UserPromptSubmit', sessionId: 's1' },
        _meta: MODERN_META,
      }),
    )
    expect(hook.content).toEqual([{ type: 'text', text: '{}' }])
    expect(h.app()?.callsTo('openTurn')[0]?.ctx).toMatchObject({
      session: { key: 's1', source: 'hook' },
      protocolEra: 'modern',
      client: { name: 'claude-code', version: '2.1.312' },
    })
    stdin.end()
    await handle.closed
    expect(h.app()?.closed).toBe(true)
  })

  test('SEARCHHOLE_MCP_PROTOCOL=legacy refuses the discover probe, so clients fall back', async () => {
    const { stdin, handle, peer } = serve({ SEARCHHOLE_MCP_PROTOCOL: 'legacy' })
    const probe = await peer.request('server/discover', { _meta: MODERN_META })
    expect(probe.error).toBeDefined()
    const init = resultOf(
      await peer.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'c', version: '1' },
      }),
    )
    expect(init.protocolVersion).toBe('2025-11-25')
    stdin.end()
    await handle.closed
  })

  test('SEARCHHOLE_MCP_PROTOCOL=modern refuses a 2025 initialize', async () => {
    const { stdin, handle, peer } = serve({ SEARCHHOLE_MCP_PROTOCOL: 'modern' })
    const init = await peer.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    })
    expect((init.error as Json | undefined)?.code).toBe(-32022)
    const discover = resultOf(await peer.request('server/discover', { _meta: MODERN_META }))
    expect(discover.supportedVersions).toEqual(['2026-07-28'])
    stdin.end()
    await handle.closed
  })

  test('handle.close() tears the connection down', async () => {
    const { handle } = serve()
    await handle.close()
    await expect(handle.closed).resolves.toBeUndefined()
  })
})

const ENTRY = fileURLToPath(new URL('./fixtures/stdio-entry.ts', import.meta.url))
const childEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  SEARCHHOLE_LOG: 'info',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'spawn-session',
  CLAUDE_PROJECT_DIR: '/work/project',
}

describe('stdio in a spawned process', () => {
  test('stdout carries only JSON-RPC (both eras); logs go to stderr; EOF exits the process', async () => {
    const child = spawn(process.execPath, [ENTRY], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8')
    })
    const send = (msg: Json) => child.stdin.write(`${JSON.stringify(msg)}\n`)
    const lines = () => out.split('\n').filter((l) => l !== '')
    const waitFor = async (n: number) => {
      for (let i = 0; i < 200 && lines().length < n; i++) await new Promise((r) => setTimeout(r, 25))
    }
    // A modern probe, answered without pinning... then this client continues in the 2026 era.
    send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: MODERN_META } })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN_META } })
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'hook',
        arguments: { event: 'PreToolUse', toolName: 'Bash', toolInput: '{"command":"ls"}' },
        _meta: MODERN_META,
      },
    })
    await waitFor(3)
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    child.stdin.end()
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 8_000)),
    ])
    if (code === 'timeout') child.kill()
    expect(code).toBe(0)
    const parsed = lines().map((l) => JSON.parse(l) as Json)
    expect(parsed.length).toBe(3)
    for (const msg of parsed) expect(msg.jsonrpc).toBe('2.0')
    const listed = parsed[1]?.result as { tools: { name: string }[] } | undefined
    const names = (listed?.tools ?? []).map((t) => t.name)
    expect(names.at(-1)).toBe('hook') // CLAUDECODE=1 refined 'generic' to claude-code
    expect(err).toContain('"msg":"gateway serving on stdio"')
    expect(err).toContain('stdio-entry: closed')
  })

  test('an SDK client negotiates the 2026 era over real stdio', async () => {
    const client = new Client(
      { name: 'test-host', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    )
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: childEnv, stderr: 'ignore' }),
    )
    expect(client.getProtocolEra()).toBe('modern')
    const result = await client.callTool({ name: 'search', arguments: { query: 'react compiler' } })
    expect(result.isError).not.toBe(true)
    await client.close()
  })

  test('an SDK client in the default (2025) mode also works', async () => {
    const client = new Client({ name: 'test-host', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: childEnv, stderr: 'ignore' }),
    )
    expect(client.getProtocolEra()).toBe('legacy')
    const { tools } = await client.listTools()
    expect(tools.length).toBe(5)
    await client.close()
  })
})
