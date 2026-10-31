// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VERSION } from '../../src/cli/version.ts'

const MAIN = join(import.meta.dirname, '../../src/cli/main.ts')
const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true })
})

/** Runs the real entry point in a child process (Node strips the types itself). */
function cli(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'searchhole-main-'))
  dirs.push(home)
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    input: opts.input ?? '',
    env: { PATH: join(home, 'no-docker-here'), SEARCHHOLE_HOME: home, NO_COLOR: '1', ...opts.env },
    timeout: 20_000,
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('the real entry point', () => {
  it('prints the version and help with exit 0', () => {
    expect(cli(['version'])).toMatchObject({ code: 0, out: `${VERSION}\n`, err: '' })
    const help = cli(['help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: searchhole <command>')
  })

  it('a usage error prints why → fix on stderr and exits 2', () => {
    const r = cli(['frobnicate'])
    expect(r.code).toBe(2)
    expect(r.out).toBe('')
    expect(r.err).toBe('error: Unknown command. → Run `searchhole help` for the commands.\n')
  })

  it('keys set with a key in argv fails without echoing it or reading stdin', () => {
    const r = cli(['keys', 'set', 'tavily', 'tvly-SECRET-VALUE-123'], { input: 'other-secret' })
    expect(r.code).toBe(2)
    expect(r.out + r.err).not.toContain('SECRET-VALUE')
    expect(r.out + r.err).not.toContain('other-secret')
  })

  it('searxng status works with no Docker installed (real runner, real settings loader)', () => {
    const r = cli(['searxng', 'status', '--json'])
    expect(r.code).toBe(0)
    const status = JSON.parse(r.out) as Record<string, unknown>
    expect(status).toMatchObject({
      docker: 'missing',
      container: 'absent',
      port: 8888,
      url: 'http://127.0.0.1:8888',
      managed: true,
    })
  })

  it('searxng up without Docker is a user error that points at Tavily', () => {
    const r = cli(['searxng', 'up', '--yes'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('Docker is not installed')
    expect(r.err).toContain('searchhole keys set tavily')
  })

  it('a rule verb without a terminal and without --yes is refused before the app loads', () => {
    const r = cli(['block', 'example.com'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('was run without a terminal')
  })

  it('mcp starts the real gateway: only protocol on stdout, exit 0 when stdin closes', () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0' },
      },
    }
    const r = cli(['mcp', '--host', 'generic'], { input: `${JSON.stringify(initialize)}\n` })
    expect(r.code).toBe(0)
    const lines = r.out.split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
    const reply = JSON.parse(lines[0] ?? '{}') as {
      result?: { serverInfo?: { name?: string; version?: string } }
    }
    expect(reply.result?.serverInfo).toMatchObject({ name: 'search-hole', version: VERSION })
  })
})
