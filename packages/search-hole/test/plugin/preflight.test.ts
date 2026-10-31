// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PLUGIN_DIR, readJson, readText, tempDir } from './helpers.ts'

// The preflight is for sh, bash and PowerShell. PowerShell cannot run here, so only the sh half is executed.
const posix = process.platform !== 'win32'
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((s) => existsSync(s))

const Output = z.object({ systemMessage: z.string() }).strict()
const PREFLIGHT = join(PLUGIN_DIR, 'hooks', 'preflight.ps1')

/** A directory that becomes the whole PATH: it holds a fake `node` that prints `version`, or no node at all. */
function fakePath(version?: string): string {
  const dir = tempDir('searchhole fake path ')
  if (version !== undefined) {
    const node = join(dir, 'node')
    writeFileSync(node, `#!/bin/sh\necho ${version}\n`)
    chmodSync(node, 0o755)
  }
  return dir
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

/** Runs the preflight exactly as the hook does (`sh -c` of the command from hooks.json). */
function runHook(shell: string, root: string, path: string): Run {
  const hooks = z
    .object({
      hooks: z.object({
        SessionStart: z.array(z.object({ hooks: z.array(z.object({ command: z.string().optional() })) })),
      }),
    })
    .parse(readJson(root, 'hooks', 'hooks.json'))
  const command = hooks.hooks.SessionStart[0]?.hooks[0]?.command
  if (command === undefined) throw new Error('no preflight command in hooks.json')
  const res = spawnSync(shell, ['-c', command], {
    env: { PATH: path, CLAUDE_PLUGIN_ROOT: root },
    encoding: 'utf8',
    // A socket on stdin makes bash read ~/.bashrc (it assumes a remote shell); hooks have no stdin of ours.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

/** Parses the output: undefined for "prints nothing", else the decoded systemMessage. */
function message(run: Run): string | undefined {
  if (run.stdout === '') return undefined
  return Output.parse(JSON.parse(run.stdout)).systemMessage
}

describe('preflight.ps1 as a file', () => {
  it('is an sh/PowerShell polyglot with the nightshift header and attribution', () => {
    const lines = readText(PREFLIGHT).split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1]).toBe("echo --% >/dev/null;: ' | Out-Null")
    expect(lines[2]).toBe("<#'")
    const text = readText(PREFLIGHT)
    expect(text).toContain('nightshift')
    expect(text).toContain('MIT')
    expect(text).toContain('SPDX-License-Identifier: Apache-2.0')
  })

  it('closes the PowerShell block comment after the sh body, and the tail exits 0', () => {
    const text = readText(PREFLIGHT)
    const closers = text.split('\n').filter((l) => l.trim() === '#>')
    expect(closers).toHaveLength(1)
    expect(text.indexOf('exit 0\n#>')).toBeGreaterThan(0)
    expect(text.trimEnd().endsWith('exit 0')).toBe(true)
    expect(text).toContain('preflight-windows.ps1')
  })

  it('is ASCII only (the arrow is a JSON escape), so no console encoding can mangle it', () => {
    for (const file of ['preflight.ps1', 'preflight-windows.ps1']) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject every non-ASCII byte
      expect(readText(PLUGIN_DIR, 'hooks', file), file).toMatch(/^[\x00-\x7f]*$/)
    }
  })

  it('has a Windows half that prints the same message shape and always exits 0', () => {
    const win = readText(PLUGIN_DIR, 'hooks', 'preflight-windows.ps1')
    expect(win).toContain('systemMessage')
    expect(win).toContain('22.19')
    expect(win).toContain('exit 0')
    expect(win).not.toMatch(/exit [1-9]/)
  })
})

describe.skipIf(!posix)('preflight.ps1 under sh', () => {
  it('passes `sh -n` (syntax check of the whole polyglot)', () => {
    for (const shell of SHELLS) {
      const res = spawnSync(shell, ['-n', PREFLIGHT], { encoding: 'utf8' })
      expect(res.status, `${shell}: ${res.stderr}`).toBe(0)
    }
  })

  for (const shell of SHELLS) {
    describe(shell, () => {
      it('prints install guidance as valid JSON when node is missing from PATH, and exits 0', () => {
        const run = runHook(shell, PLUGIN_DIR, fakePath())
        expect(run.status).toBe(0)
        const msg = message(run)
        expect(msg).toBeDefined()
        expect(msg).toContain('Node.js 22.19')
        expect(msg).toContain('not found')
        expect(msg).toContain('/mcp → reconnect search-hole')
        expect(run.stderr).toBe('')
      })

      it('prints an upgrade message for Node older than 22.19', () => {
        for (const version of ['v20.11.0', 'v18.19.1', 'v22.12.9', 'v22.0.0', 'v22.13.0', 'v22.18.9']) {
          const run = runHook(shell, PLUGIN_DIR, fakePath(version))
          expect(run.status, version).toBe(0)
          expect(message(run), version).toContain(`found ${version}`)
          expect(message(run), version).toContain('reconnect search-hole')
        }
      })

      it('prints nothing for Node 22.19 or newer', () => {
        for (const version of ['v22.19.0', 'v22.19.1', 'v22.20.0', 'v24.14.1', 'v26.13.0', 'v100.0.0']) {
          const run = runHook(shell, PLUGIN_DIR, fakePath(version))
          expect(run.status, version).toBe(0)
          expect(run.stdout, version).toBe('')
          expect(run.stderr, version).toBe('')
        }
      })

      it('stays silent and exits 0 when the node version cannot be parsed', () => {
        for (const version of ['garbage', '', 'v', 'vx.y.z', 'v22']) {
          const run = runHook(shell, PLUGIN_DIR, fakePath(version))
          expect(run.status, JSON.stringify(version)).toBe(0)
          expect(run.stdout, JSON.stringify(version)).toBe('')
        }
      })
    })
  }

  it('works from a plugin root whose path contains spaces, as the hook quotes it', () => {
    const root = join(tempDir('searchhole root with spaces '), 'search hole')
    mkdirSync(root, { recursive: true })
    cpSync(join(PLUGIN_DIR, 'hooks'), join(root, 'hooks'), { recursive: true })
    const run = runHook('/bin/sh', root, fakePath())
    expect(run.status).toBe(0)
    expect(message(run)).toContain('Node.js 22.19')
  })

  it('prints exactly one JSON line', () => {
    const run = runHook('/bin/sh', PLUGIN_DIR, fakePath())
    expect(run.stdout.endsWith('\n')).toBe(true)
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(1)
  })
})
