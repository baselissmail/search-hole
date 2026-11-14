// SPDX-License-Identifier: Apache-2.0
// `searchhole uninstall --purge` (ADR-0006 point 13): only known entries, never unsafe roots.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planUninstall, runUninstall, unsafeRoot } from '../../src/cli/uninstall.ts'
import { bashChangesRules } from '../../src/gateway/guard.ts'
import type { EngineId } from '../../src/shared/types.ts'
import { run } from './helpers.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'searchhole uninstall '))
  dirs.push(d)
  return d
}

describe('uninstall', () => {
  it('removes known entries and keys, keeps other files, removes empty roots', async () => {
    const base = temp()
    const home = join(base, 'home')
    const root = join(base, 'custom home with spaces')
    mkdirSync(join(root, 'lists', 'vendor'), { recursive: true })
    mkdirSync(join(root, 'run'), { recursive: true })
    for (const f of ['settings.yaml', 'rules.yaml', 'searchhole.db', 'searchhole.db-wal', 'run/ui.json']) {
      writeFileSync(join(root, f), 'x')
    }
    writeFileSync(join(root, 'my-notes.txt'), 'not ours')
    const plan = planUninstall({
      roots: { config: root, data: root, run: join(root, 'run'), source: 'env' },
      home,
    })
    expect(plan.refused).toEqual([])
    expect(
      plan.remove
        .map((p) =>
          p
            .slice(root.length + 1)
            .split(sep)
            .join('/'),
        )
        .sort(),
    ).toEqual(
      ['lists/vendor', 'rules.yaml', 'run/ui.json', 'searchhole.db', 'searchhole.db-wal', 'settings.yaml'].sort(),
    )
    expect(plan.left).toEqual([])
    expect(plan.elsewhere.join('\n')).toContain('claude plugin uninstall')
    const removedKeys: EngineId[] = []
    const out = await runUninstall(plan, { removeKey: async (e) => void removedKeys.push(e) })
    expect(removedKeys).not.toContain('searxng')
    expect(removedKeys).toContain('tavily')
    expect(existsSync(join(root, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(root, 'lists'))).toBe(false)
    expect(existsSync(join(root, 'run'))).toBe(false)
    expect(existsSync(join(root, 'my-notes.txt'))).toBe(true)
    expect(out.rootsRemoved).not.toContain(root)

    rmSync(join(root, 'my-notes.txt'))
    const again = await runUninstall(
      planUninstall({ roots: { config: root, data: root, run: join(root, 'run'), source: 'env' }, home }),
      {
        removeKey: async () => {},
      },
    )
    expect(again.rootsRemoved).toContain(root)
    expect(existsSync(root)).toBe(false)
  })

  it('in a shared folder, deletes only what search-hole wrote and lists the rest', async () => {
    const base = temp()
    const root = join(base, 'shared')
    const files: Record<string, string> = {
      // Ours.
      'rules.yaml': 'x',
      'backups/searchhole-v2-20261031T221050302Z-83448.db': 'x',
      'secrets/tavily.key': 'x',
      'lists/generation': 'x',
      'lists/quenhus-dev-filter/source.txt': 'x',
      'lists/quenhus-dev-filter/source.json': '{}',
      'lists/quenhus-dev-filter/compiled-1.json': '{}',
      'lists/quenhus-dev-filter/source.json.4242.0a1b2c3d.tmp': '{}',
      'lists/local/mine/source.txt': 'x',
      'lists/local/mine/manifest.json': '{}',
      'searxng/settings.yml': '# Managed by search-hole: `searchhole searxng apply` rewrites this file\n',
      'searxng/uwsgi.ini': 'written by the container',
      // Not ours.
      'backups/photos-2019.tar': 'mine',
      'secrets/notes.txt': 'mine',
      'lists/groceries.txt': 'mine',
      'lists/recipes/soup.md': 'mine',
      'lists/local/keep/readme.md': 'mine',
    }
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(root, f, '..'), { recursive: true })
      writeFileSync(join(root, f), text)
    }
    const roots = { config: root, data: root, run: join(root, 'run'), source: 'env' as const }
    const plan = planUninstall({ roots, home: join(base, 'home') })
    const rel = (paths: string[]): string[] =>
      paths.map((p) => p.slice(root.length + 1).split(sep).join('/')).sort()
    expect(rel(plan.left)).toEqual(
      ['backups/photos-2019.tar', 'lists/groceries.txt', 'lists/local/keep', 'lists/recipes', 'secrets/notes.txt'].sort(),
    )
    await runUninstall(plan, { removeKey: async () => {} })
    const foreign = [
      'backups/photos-2019.tar',
      'secrets/notes.txt',
      'lists/groceries.txt',
      'lists/recipes/soup.md',
      'lists/local/keep/readme.md',
    ]
    for (const f of Object.keys(files)) expect([f, existsSync(join(root, f))]).toEqual([f, foreign.includes(f)])
    expect(existsSync(join(root, 'lists', 'quenhus-dev-filter'))).toBe(false)
    expect(existsSync(join(root, 'lists', 'local', 'mine'))).toBe(false)
    expect(existsSync(join(root, 'searxng'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it("leaves a searxng folder that isn't search-hole's", async () => {
    const base = temp()
    const root = join(base, 'shared')
    mkdirSync(join(root, 'searxng'), { recursive: true })
    writeFileSync(join(root, 'searxng', 'settings.yml'), 'use_default_settings: true\n')
    const plan = planUninstall({
      roots: { config: root, data: root, run: join(root, 'run'), source: 'env' },
      home: join(base, 'home'),
    })
    expect(plan.remove).toEqual([])
    expect(plan.left).toEqual([join(root, 'searxng', 'settings.yml')])
    await runUninstall(plan, { removeKey: async () => {} })
    expect(existsSync(join(root, 'searxng', 'settings.yml'))).toBe(true)
  })

  it('compares the home folder without case on macOS and Windows, and through symlinks', () => {
    const base = temp()
    const home = join(base, 'Home')
    mkdirSync(home)
    expect(unsafeRoot(join(base, 'HOME'), home, 'darwin')).toMatch(/home/)
    expect(unsafeRoot(join(base, 'home'), home, 'win32')).toMatch(/home/)
    if (process.platform !== 'win32') {
      expect(unsafeRoot(join(base, 'HOME'), home, 'linux')).toBeUndefined()
      symlinkSync(home, join(base, 'alias'))
      expect(unsafeRoot(join(base, 'alias'), home, 'linux')).toMatch(/home/)
    }
  })

  it('refuses the home folder, its ancestors and filesystem roots', () => {
    const home = join(tmpdir(), 'u')
    expect(unsafeRoot(home, home)).toMatch(/home/)
    expect(unsafeRoot(tmpdir(), home)).toMatch(/home/)
    expect(unsafeRoot('/', home)).toMatch(/filesystem root/)
    expect(unsafeRoot(join(home, '.searchhole'), home)).toBeUndefined()
    const plan = planUninstall({
      roots: { config: home, data: home, run: join(home, 'run'), source: 'env' },
      home,
    })
    expect(plan.refused.map((r) => r.root)).toContain(home)
    expect(plan.remove.every((p) => !p.startsWith(`${home}/settings`))).toBe(true)
  })

  it('a failing key store is reported, not fatal', async () => {
    const root = temp()
    writeFileSync(join(root, 'rules.yaml'), 'x')
    const plan = planUninstall({
      roots: { config: root, data: root, run: join(root, 'run'), source: 'env' },
      home: join(root, '..', 'elsewhere-home'),
    })
    const out = await runUninstall(plan, {
      removeKey: async (e) => {
        if (e === 'brave') throw new Error('keychain locked')
      },
    })
    expect(out.keysFailed).toEqual([{ engine: 'brave', error: 'keychain locked' }])
    expect(out.removed.length).toBe(1)
  })
})

describe('searchhole uninstall (CLI)', () => {
  const home = (): string => {
    const root = temp()
    for (const f of ['settings.yaml', 'rules.yaml', 'searchhole.db']) writeFileSync(join(root, f), 'x')
    return root
  }

  it('without --purge only lists; nothing is touched', async () => {
    const root = home()
    const r = await run(['uninstall'], { env: { SEARCHHOLE_HOME: root } })
    expect(r.code).toBe(0)
    expect(r.out).toContain(join(root, 'rules.yaml'))
    expect(r.out).toContain('searchhole uninstall --purge')
    expect(r.out).toContain('claude plugin uninstall')
    expect(existsSync(join(root, 'rules.yaml'))).toBe(true)
  })

  it('--purge needs a terminal or --yes; a "no" deletes nothing', async () => {
    const root = home()
    const noTty = await run(['uninstall', '--purge'], { env: { SEARCHHOLE_HOME: root } })
    expect(noTty.code).not.toBe(0)
    const declined = await run(['uninstall', '--purge'], {
      env: { SEARCHHOLE_HOME: root },
      tty: true,
      confirmAnswer: false,
    })
    expect(declined.out).toContain('Nothing deleted.')
    expect(existsSync(join(root, 'rules.yaml'))).toBe(true)
  })

  it('--purge --yes removes keys through the App, then the files', async () => {
    const root = home()
    const r = await run(['uninstall', '--purge', '--yes'], { env: { SEARCHHOLE_HOME: root } })
    expect(r.code).toBe(0)
    expect(existsSync(root)).toBe(false)
    expect(r.app.calls.filter((c) => c.method === 'keys.remove').map((c) => c.args[0])).toContain('tavily')
  })

  it('the Bash guard keeps the model from running it', () => {
    expect(bashChangesRules('searchhole uninstall --purge --yes')).toBe(true)
  })
})
