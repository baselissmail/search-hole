// SPDX-License-Identifier: Apache-2.0
// `searchhole uninstall --purge` (ADR-0006 point 13): only known entries, never unsafe roots.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planUninstall, runUninstall, unsafeRoot } from '../../src/cli/uninstall.ts'
import type { EngineId } from '../../src/shared/types.ts'

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
    expect(plan.remove.map((p) => p.slice(root.length + 1)).sort()).toEqual(
      [
        'lists',
        'rules.yaml',
        'run',
        'run/ui.json',
        'searchhole.db',
        'searchhole.db-wal',
        'settings.yaml',
      ].sort(),
    )
    expect(plan.elsewhere.join('\n')).toContain('claude plugin uninstall')
    const removedKeys: EngineId[] = []
    const out = await runUninstall(plan, { removeKey: async (e) => void removedKeys.push(e) })
    expect(removedKeys).not.toContain('searxng')
    expect(removedKeys).toContain('tavily')
    expect(existsSync(join(root, 'settings.yaml'))).toBe(false)
    expect(existsSync(join(root, 'lists'))).toBe(false)
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
