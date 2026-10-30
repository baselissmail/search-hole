// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SearchHoleError } from '../../src/shared/errors.ts'
import { run } from './helpers.ts'

const SECRET = 'tvly-SECRET-VALUE-1234567890'
const SRC = join(import.meta.dirname, '../../src/cli')

describe('keys set never takes the key from argv', () => {
  it('reads a piped key from stdin and hands it to the app, not to the output', async () => {
    const r = await run(['keys', 'set', 'tavily'], { stdin: `${SECRET}\n` })
    expect(r.code).toBe(0)
    expect(r.app.calls).toEqual([{ method: 'keys.set', args: ['tavily', SECRET] }])
    expect(r.io.stdinReads).toBe(1)
    expect(r.io.prompts).toEqual([])
    expect(r.out).toContain('Stored the tavily key in macOS Keychain.')
    expect(r.out + r.err).not.toContain(SECRET)
  })

  it('on a terminal it prompts with echo off (stderr prompt) and does not read stdin', async () => {
    const r = await run(['keys', 'set', 'brave'], { tty: true, hiddenAnswer: `  ${SECRET}  ` })
    expect(r.code).toBe(0)
    expect(r.io.prompts).toEqual(['Paste the brave API key (input is hidden): '])
    expect(r.io.stdinReads).toBe(0)
    expect(r.app.calls).toEqual([{ method: 'keys.set', args: ['brave', SECRET] }])
    expect(r.out + r.err).not.toContain(SECRET)
  })

  it.each([
    [['keys', 'set', 'tavily', SECRET]],
    [['keys', 'set', SECRET]],
    [['keys', 'set', 'tavily', `--key=${SECRET}`]],
    [['keys', 'set', 'tavily', '--key', SECRET]],
    [['keys', 'set', 'tavily', '--value', SECRET]],
    [['keys', 'set', `--api-key=${SECRET}`]],
  ])('refuses %j: exit 2, nothing read, nothing opened, nothing echoed', async (argv) => {
    const r = await run(argv, { stdin: 'would-be-a-key' })
    expect(r.code).toBe(2)
    expect(r.io.stdinReads).toBe(0)
    expect(r.io.prompts).toEqual([])
    expect(r.app.opened).toHaveLength(0)
    expect(r.out + r.err).not.toContain('SECRET-VALUE')
  })

  it('rejects an empty or multi-line input without storing anything', async () => {
    const empty = await run(['keys', 'set', 'tavily'], { stdin: '  \n' })
    expect(empty.code).toBe(2)
    expect(empty.err).toContain('No key was entered.')
    expect(empty.err).toContain('pbpaste | searchhole keys set tavily')
    expect(empty.app.opened).toHaveLength(0)
    const many = await run(['keys', 'set', 'tavily'], { stdin: 'line one\nline two\n' })
    expect(many.code).toBe(2)
    expect(many.err).toContain('more than one line')
    expect(many.err).not.toContain('line one')
    expect(many.app.opened).toHaveLength(0)
  })

  it('removes the key from an error a lower layer might have echoed', async () => {
    const r = await run(
      ['keys', 'set', 'tavily'],
      { stdin: SECRET },
      {
        failWith: new SearchHoleError('invalid_argument', `The key ${SECRET} has a bad shape.`, {
          fix: `Check ${SECRET}.`,
        }),
      },
    )
    expect(r.code).toBe(2)
    expect(r.err).toContain('[redacted]')
    expect(r.err).not.toContain(SECRET)
    const plain = await run(
      ['keys', 'set', 'tavily'],
      { stdin: SECRET },
      { failWith: new Error(`boom ${SECRET}`) },
    )
    expect(plain.err).not.toContain(SECRET)
  })

  it('keys remove asks for --yes without a terminal, then removes', async () => {
    const r = await run(['keys', 'remove', 'brave', '--yes'])
    expect(r.code).toBe(0)
    expect(r.app.calls).toEqual([{ method: 'keys.remove', args: ['brave'] }])
    expect(r.out).toContain('Removed the stored brave key.')
  })
})

describe('source hygiene', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'))

  it('only main.ts mentions process.argv', () => {
    const offenders = files.filter(
      (f) => f !== 'main.ts' && readFileSync(join(SRC, f), 'utf8').includes('process.argv'),
    )
    expect(offenders).toEqual([])
  })

  it('nothing writes to stdout except through the injected stream', () => {
    for (const f of files) {
      const text = readFileSync(join(SRC, f), 'utf8')
      expect(text, f).not.toMatch(/console\.(log|info|error|warn)/)
      if (f !== 'io.ts') expect(text, f).not.toContain('process.stdout')
    }
  })

  it('every file carries the SPDX header (after the shebang in main.ts)', () => {
    for (const f of files) {
      const lines = readFileSync(join(SRC, f), 'utf8').split('\n')
      const first = f === 'main.ts' ? lines[1] : lines[0]
      expect(first, f).toBe('// SPDX-License-Identifier: Apache-2.0')
    }
    expect(readFileSync(join(SRC, 'main.ts'), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})
