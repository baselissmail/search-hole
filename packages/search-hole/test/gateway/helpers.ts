// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway test harness: a Gateway over a FakeApp, and MCP clients connected to it in both
 * protocol eras, in-process (`createMcpHandler` + `handler.fetch`, per the SDK testing docs).
 */
import { Writable } from 'node:stream'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { HostProfile } from '../../src/app/types.ts'
import { Gateway } from '../../src/gateway/gateway.ts'
import { createLogger, type Logger } from '../../src/shared/log.ts'
import { FakeApp, type FakeAppOptions } from './fake-app.ts'

export type Era = 'modern' | 'legacy'
export const ERAS: readonly Era[] = ['modern', 'legacy']

/** A logger that keeps its JSON lines in memory. */
export function memoryLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'))
      cb()
    },
  })
  const logger = createLogger({ destination: stream, level: 'debug' })
  const lines = (): Record<string, unknown>[] =>
    chunks
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  return { logger, lines }
}

export interface Harness {
  gateway: Gateway
  /** The App, once the gateway created it. */
  app: () => FakeApp | undefined
  appCreations: () => number
  logs: () => Record<string, unknown>[]
  clock: { now: number }
}

export interface HarnessOptions {
  host?: HostProfile
  env?: Record<string, string | undefined>
  cwd?: string
  home?: string
  fake?: FakeAppOptions
  version?: string
  failCreate?: number
}

/** A Gateway with a FakeApp factory and a manual clock. */
export function harness(opts: HarnessOptions = {}): Harness {
  let app: FakeApp | undefined
  let creations = 0
  let failures = opts.failCreate ?? 0
  const clock = { now: Date.parse('2026-10-30T10:00:00Z') }
  const { logger, lines } = memoryLogger()
  const gateway = new Gateway(
    {
      host: opts.host ?? 'claude-code',
      version: opts.version ?? '0.1.0',
      env: opts.env ?? { CLAUDE_PROJECT_DIR: '/work/project' },
      cwd: opts.cwd ?? '/work/project',
    },
    {
      createApp: async (appOpts) => {
        creations++
        if (failures > 0) {
          failures--
          throw new Error('store unavailable')
        }
        app = new FakeApp(appOpts, opts.fake)
        return app
      },
      logger,
      now: () => clock.now,
      pid: 4242,
      home: opts.home ?? '/home/tester',
      platform: 'linux',
    },
  )
  return { gateway, app: () => app, appCreations: () => creations, logs: lines, clock }
}

export interface Connected {
  client: Client
  close: () => Promise<void>
}

/** Connects an SDK client in the given era through `createMcpHandler` in-process. */
export async function connect(
  gateway: Gateway,
  era: Era,
  opts: { capabilities?: Record<string, unknown> } = {},
): Promise<Connected> {
  const handler = createMcpHandler(gateway.factory)
  const transport = new StreamableHTTPClientTransport(new URL('http://gateway.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  })
  const client = new Client(
    { name: 'test-host', version: '1.0.0' },
    {
      ...(era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}),
      ...(opts.capabilities === undefined ? {} : { capabilities: opts.capabilities }),
    },
  )
  await client.connect(transport)
  if (client.getProtocolEra() !== era) throw new Error(`expected ${era}, got ${client.getProtocolEra()}`)
  return {
    client,
    close: async () => {
      await client.close()
      await handler.close()
    },
  }
}

/** The single text block of a tool result. */
export function textOf(result: { content?: unknown }): string {
  const content = result.content
  if (!Array.isArray(content) || content.length !== 1) throw new Error('expected one content block')
  const block: unknown = content[0]
  if (typeof block !== 'object' || block === null || !('text' in block) || typeof block.text !== 'string') {
    throw new Error('expected a text block')
  }
  return block.text
}

/** Calls the `hook` tool and parses its JSON answer. */
export async function callHook(
  client: Client,
  args: Record<string, string>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: 'hook', arguments: args })
  if (result.isError === true) throw new Error(`hook returned isError: ${textOf(result)}`)
  return JSON.parse(textOf(result)) as Record<string, unknown>
}
