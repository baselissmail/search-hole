// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_SCRIPT, MARKETPLACE_DIR, PLUGIN_DIR, REPO_ROOT, readText, tempDir } from './helpers.ts'

/** Runs scripts/build-plugin.mjs with the current Node. */
function build(args: string[]) {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

/** A stand-in for packages/search-hole/dist with a nested chunk, a source map and OS junk. */
function fakeDist(): string {
  const dist = join(tempDir('searchhole fake dist '), 'dist')
  mkdirSync(join(dist, 'chunks'), { recursive: true })
  writeFileSync(join(dist, 'searchhole.mjs'), '// fake bundle\n')
  writeFileSync(join(dist, 'searchhole.mjs.map'), '{}')
  writeFileSync(join(dist, 'chunks', 'dashboard-abc123.mjs'), 'export {}\n')
  writeFileSync(join(dist, '.DS_Store'), 'junk')
  return dist
}

/** A temp marketplace directory with the real marketplace.json, ready to receive `search-hole/`. */
function marketplaceDir(): string {
  const mp = tempDir('searchhole marketplace ')
  mkdirSync(join(mp, '.claude-plugin'))
  writeFileSync(
    join(mp, '.claude-plugin', 'marketplace.json'),
    readText(MARKETPLACE_DIR, '.claude-plugin', 'marketplace.json'),
  )
  return mp
}

/** Every file under `dir`, relative, sorted. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    )
    .sort()
}

describe('scripts/build-plugin.mjs', () => {
  it('assembles plugin sources, every dist file and LICENSE', () => {
    const mp = marketplaceDir()
    const out = join(mp, 'search-hole')
    const res = build(['--skip-build', '--dist', fakeDist(), '--out', out])
    expect(res.status, res.stderr).toBe(0)

    const files = listFiles(out)
    expect(files).toEqual(
      expect.arrayContaining([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'LICENSE',
        'dist/chunks/dashboard-abc123.mjs',
        'dist/searchhole.mjs',
        'dist/searchhole.mjs.map',
        'hooks/hooks.json',
        'hooks/preflight-windows.ps1',
        'hooks/preflight.ps1',
        'skills/block/SKILL.md',
        'skills/research/SKILL.md',
      ]),
    )
    expect(files.some((f) => f.endsWith('.DS_Store'))).toBe(false)
    // Every source file is carried over unchanged.
    for (const file of listFiles(PLUGIN_DIR)) {
      if (file.endsWith('.DS_Store')) continue
      expect(readText(out, file), file).toBe(readText(PLUGIN_DIR, file))
    }
    expect(readText(out, 'LICENSE')).toBe(readText(REPO_ROOT, 'LICENSE'))
    expect(readText(out, 'dist', 'searchhole.mjs')).toBe('// fake bundle\n')
  })

  // Windows has no executable bit.
  it.skipIf(process.platform === 'win32')('keeps the preflight executable', () => {
    const out = join(marketplaceDir(), 'search-hole')
    expect(build(['--skip-build', '--dist', fakeDist(), '--out', out]).status).toBe(0)
    expect(statSync(join(out, 'hooks', 'preflight.ps1')).mode & 0o111).not.toBe(0)
  })

  it('prints the install steps, with the marketplace commands when marketplace.json sits next to it', () => {
    const mp = marketplaceDir()
    const res = build(['--skip-build', '--dist', fakeDist(), '--out', join(mp, 'search-hole')])
    expect(res.stdout).toContain(`claude plugin marketplace add "${mp}"`)
    expect(res.stdout).toContain(`/plugin marketplace add "${mp}"`)
    expect(res.stdout).toContain('claude plugin install search-hole@search-hole-local')
    expect(res.stdout).toContain(`claude --plugin-dir "${join(mp, 'search-hole')}"`)
    expect(res.stdout).toContain('/search-hole:doctor')
  })

  it('prints only the --plugin-dir try-out when there is no marketplace next to the output', () => {
    const out = join(tempDir('searchhole lone '), 'plugin')
    const res = build(['--skip-build', '--dist', fakeDist(), '--out', out])
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('--plugin-dir')
    expect(res.stdout).not.toContain('marketplace add')
  })

  it('replaces an earlier assembly instead of merging into it', () => {
    const out = join(marketplaceDir(), 'search-hole')
    const dist = fakeDist()
    expect(build(['--skip-build', '--dist', dist, '--out', out]).status).toBe(0)
    writeFileSync(join(out, 'stale.txt'), 'old')
    writeFileSync(join(out, 'dist', 'old-chunk.mjs'), 'old')
    const second = build(['--skip-build', '--dist', dist, '--out', out])
    expect(second.status, second.stderr).toBe(0)
    expect(existsSync(join(out, 'stale.txt'))).toBe(false)
    expect(existsSync(join(out, 'dist', 'old-chunk.mjs'))).toBe(false)
    expect(existsSync(join(out, 'dist', 'searchhole.mjs'))).toBe(true)
  })

  it('refuses to delete a non-empty directory that is not an earlier assembly', () => {
    const out = tempDir('searchhole precious ')
    writeFileSync(join(out, 'important.txt'), 'keep me')
    const res = build(['--skip-build', '--dist', fakeDist(), '--out', out])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('Refusing to replace')
    expect(readText(out, 'important.txt')).toBe('keep me')
  })

  it('fails with a clear message when dist/searchhole.mjs is missing', () => {
    const emptyDist = tempDir('searchhole empty dist ')
    const res = build(['--skip-build', '--dist', emptyDist, '--out', join(tempDir(), 'out')])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('searchhole.mjs')
    expect(res.stderr).toContain('Build the package first')
  })

  it('fails when the dist directory itself is missing', () => {
    const res = build(['--skip-build', '--dist', join(tempDir(), 'nope'), '--out', join(tempDir(), 'out')])
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('is not a directory')
  })

  it('rejects unknown options and missing values with exit code 2, and --help prints usage', () => {
    expect(build(['--bogus']).status).toBe(2)
    expect(build(['--dist']).status).toBe(2)
    const help = build(['--help'])
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--skip-build')
  })

  it('writes the install steps to stdout and diagnostics to stderr', () => {
    const res = build(['--skip-build', '--dist', fakeDist(), '--out', join(marketplaceDir(), 'search-hole')])
    expect(res.stdout).toContain('Plugin assembled at')
    expect(res.stderr).not.toContain('Plugin assembled')
  })
})

describe('the committed layout', () => {
  it('keeps the assembled output out of git and the marketplace outside the plugin', () => {
    expect(readText(MARKETPLACE_DIR, '.gitignore')).toContain('search-hole/')
    expect(existsSync(join(PLUGIN_DIR, 'dist'))).toBe(false)
  })
})

// Opt-in: set CLAUDE_BIN to a Claude Code binary (2.1.296 or newer) to run its validator on an assembled plugin.
describe.skipIf(!process.env.CLAUDE_BIN)('claude plugin validate --strict (opt-in, CLAUDE_BIN)', () => {
  it('passes for the assembled plugin and for the marketplace', () => {
    const mp = marketplaceDir()
    const out = join(mp, 'search-hole')
    expect(build(['--skip-build', '--dist', fakeDist(), '--out', out]).status).toBe(0)
    for (const target of [out, mp]) {
      const res = spawnSync(process.env.CLAUDE_BIN ?? 'claude', ['plugin', 'validate', target, '--strict'], {
        encoding: 'utf8',
      })
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0)
    }
  })
})
