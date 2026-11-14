// SPDX-License-Identifier: Apache-2.0
// `searchhole setup <client>` wiring: preview, confirm or --yes, write with a backup.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bashChangesRules } from '../../src/gateway/guard.ts'
import { run } from './helpers.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function world() {
  const base = mkdtempSync(join(tmpdir(), 'searchhole setup cli '))
  dirs.push(base)
  const home = join(base, 'home')
  const bundle = join(base, 'pkg', 'dist', 'searchhole.mjs')
  mkdirSync(join(base, 'pkg', 'dist'), { recursive: true })
  writeFileSync(bundle, '// bundle')
  const cursor = join(home, '.cursor', 'mcp.json')
  mkdirSync(join(home, '.cursor'), { recursive: true })
  writeFileSync(cursor, '{ "mcpServers": { "other": { "command": "x" } } }\n')
  return { home, bundle, cursor, deps: { homedir: () => home } }
}

describe('searchhole setup', () => {
  it('--dry-run writes nothing; --yes writes with a backup and keeps other servers', async () => {
    const w = world()
    const dry = await run(['setup', 'cursor', '--dry-run'], { entry: w.bundle }, {}, w.deps)
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('Dry run')
    // The dry run shows the lines it would add, not only the file's name.
    expect(dry.out).toMatch(/^\+ +"search-hole": \{$/m)
    expect(dry.out).toMatch(/^\+ +"command": "node",$/m)
    expect(readFileSync(w.cursor, 'utf8')).not.toContain('search-hole')
    const ok = await run(['setup', 'cursor', '--yes'], { entry: w.bundle }, {}, w.deps)
    expect(ok.code).toBe(0)
    const after = JSON.parse(readFileSync(w.cursor, 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>
    }
    expect(Object.keys(after.mcpServers)).toEqual(['other', 'search-hole'])
    // The real path of the bundle (macOS: /var → /private/var), as setup records it.
    expect(after.mcpServers['search-hole']?.args).toEqual([realpathSync(w.bundle), 'mcp', '--host', 'cursor'])
    expect(readdirSync(join(w.home, '.cursor')).some((f) => f.startsWith('mcp.json.bak-'))).toBe(true)
  })

  it('without a terminal and without --yes it refuses; a "no" writes nothing', async () => {
    const w = world()
    const noTty = await run(['setup', 'cursor'], { entry: w.bundle }, {}, w.deps)
    expect(noTty.code).not.toBe(0)
    const no = await run(
      ['setup', 'cursor'],
      { entry: w.bundle, tty: true, confirmAnswer: false },
      {},
      w.deps,
    )
    expect(no.out).toContain('Nothing written.')
    // The change is shown before the question.
    expect(no.err).toMatch(/^\+ +"search-hole": \{$/m)
    expect(readFileSync(w.cursor, 'utf8')).not.toContain('search-hole')
  })

  it('generic prints the snippet alone on stdout and what to do with it on stderr', async () => {
    const w = world()
    const r = await run(['setup', 'generic'], { entry: w.bundle }, {}, w.deps)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toHaveProperty(['mcpServers', 'search-hole'])
    expect(r.err).toContain('needs an engine')
  })

  it('needs a built bundle and a known app; the model may not run it', async () => {
    const w = world()
    const src = await run(['setup', 'cursor'], { entry: '/repo/src/cli/main.ts' }, {}, w.deps)
    expect(src.code).not.toBe(0)
    const unknown = await run(['setup', 'notepad'], { entry: w.bundle }, {}, w.deps)
    expect(unknown.code).not.toBe(0)
    expect(existsSync(join(w.home, '.vscode'))).toBe(false)
    expect(bashChangesRules('searchhole setup cursor --yes')).toBe(true)
  })
})
