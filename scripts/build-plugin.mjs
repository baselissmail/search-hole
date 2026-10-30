#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Assembles the search-hole Claude Code plugin for local installs and testing (ADR-0002 point 5,
 * "for local development ... a relative-path marketplace points at a local build").
 *
 *   node scripts/build-plugin.mjs [--skip-build] [--dist <dir>] [--out <dir>]
 *
 * 1. Builds the package (`mise exec -- pnpm -C packages/search-hole build`), unless --skip-build.
 * 2. Copies distribution/claude-plugin/, the built dist/ (every file) and LICENSE into
 *    distribution/marketplace/search-hole/, the plugin directory that the local marketplace
 *    `search-hole-local` points at (git-ignored).
 * 3. Prints the install steps.
 *
 * Importable without side effects: the exported functions are what the tests exercise.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'search-hole')
const PLUGIN_SOURCE = join(REPO_ROOT, 'distribution', 'claude-plugin')
const DEFAULT_OUT = join(REPO_ROOT, 'distribution', 'marketplace', 'search-hole')
const MARKETPLACE_NAME = 'search-hole-local'
const PLUGIN_NAME = 'search-hole'

/** Files that must exist in the assembled plugin, relative to its root. */
export const REQUIRED_FILES = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'hooks/preflight.ps1',
  'dist/searchhole.mjs',
  'LICENSE',
]

/**
 * Parses the command line. Unknown flags and missing values throw.
 * @param {string[]} argv
 * @returns {{ skipBuild: boolean, dist: string, out: string, help: boolean }}
 */
export function parseArgs(argv) {
  const opts = { skipBuild: false, dist: join(PACKAGE_DIR, 'dist'), out: DEFAULT_OUT, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-build') opts.skipBuild = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--dist' || arg === '--out') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a directory`)
      opts[arg === '--dist' ? 'dist' : 'out'] = resolve(value)
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return opts
}

/** Runs the package build through mise, falling back to a bare pnpm when mise is not installed. */
function runBuild() {
  const attempts = [
    ['mise', ['exec', '--', 'pnpm', '-C', PACKAGE_DIR, 'build']],
    ['pnpm', ['-C', PACKAGE_DIR, 'build']],
  ]
  for (const [cmd, args] of attempts) {
    const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT })
    if (res.error && res.error.code === 'ENOENT') continue
    if (res.error) throw res.error
    if (res.status !== 0) throw new Error(`The package build failed (${cmd} exited ${res.status}).`)
    return
  }
  throw new Error(
    'Neither mise nor pnpm is on PATH. Install mise (https://mise.jdx.dev), or run the build yourself and pass --skip-build.',
  )
}

/** True when `dir` exists and has at least one entry. */
async function isNonEmptyDir(dir) {
  try {
    return (await readdir(dir)).length > 0
  } catch {
    return false
  }
}

/**
 * Copies the plugin sources, the built dist/ and LICENSE into `out`, replacing a previous assembly.
 * Refuses to delete a non-empty directory that does not look like an earlier assembly.
 * @param {{ pluginSource?: string, dist: string, out: string, license?: string }} opts
 * @returns {Promise<{ out: string, files: string[] }>}
 */
export async function assemblePlugin(opts) {
  const pluginSource = opts.pluginSource ?? PLUGIN_SOURCE
  const license = opts.license ?? join(REPO_ROOT, 'LICENSE')
  const { dist, out } = opts

  if (!existsSync(join(pluginSource, '.claude-plugin', 'plugin.json'))) {
    throw new Error(`Plugin sources not found at ${pluginSource}`)
  }
  if (!existsSync(join(dist, 'searchhole.mjs'))) {
    throw new Error(
      `${join(dist, 'searchhole.mjs')} does not exist. Build the package first (it needs src/cli/main.ts), or pass --dist.`,
    )
  }
  if (!existsSync(license)) throw new Error(`LICENSE not found at ${license}`)

  if ((await isNonEmptyDir(out)) && !existsSync(join(out, '.claude-plugin', 'plugin.json'))) {
    throw new Error(`Refusing to replace ${out}: it is not empty and does not look like an assembled plugin.`)
  }
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const skipJunk = (src) => basename(src) !== '.DS_Store'
  await cp(pluginSource, out, { recursive: true, filter: skipJunk })
  await cp(dist, join(out, 'dist'), { recursive: true, filter: skipJunk })
  await cp(license, join(out, 'LICENSE'))
  // The sh/PowerShell polyglot is dot-sourced, but keep it runnable as a file too.
  await chmod(join(out, 'hooks', 'preflight.ps1'), 0o755)

  const missing = REQUIRED_FILES.filter((rel) => !existsSync(join(out, rel)))
  if (missing.length > 0) throw new Error(`The assembled plugin is missing: ${missing.join(', ')}`)
  return { out, files: REQUIRED_FILES }
}

/** Reads a JSON file's `version`, or undefined when it cannot be read. */
function readVersion(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** A note when the plugin manifest and the package disagree about the version, else undefined. */
export function versionNote(pluginDir, packageDir = PACKAGE_DIR) {
  const plugin = readVersion(join(pluginDir, '.claude-plugin', 'plugin.json'))
  const pkg = readVersion(join(packageDir, 'package.json'))
  if (plugin === undefined || pkg === undefined || plugin === pkg) return undefined
  return `Note: plugin.json says ${plugin} but packages/search-hole/package.json says ${pkg}.`
}

/**
 * The install instructions for an assembled plugin directory.
 * The marketplace steps appear only when the plugin sits next to a marketplace.json.
 */
export function installSteps(out) {
  const marketplaceDir = dirname(out)
  const hasMarketplace = existsSync(join(marketplaceDir, '.claude-plugin', 'marketplace.json'))
  const lines = [
    '',
    `Plugin assembled at: ${out}`,
    '',
    'Needs Claude Code 2.1.296 or newer and Node.js 22.13+ on PATH.',
    '',
    'Quick try (one session, nothing installed):',
    `  claude --plugin-dir "${out}"`,
  ]
  if (hasMarketplace) {
    lines.push(
      '',
      'Install from the local marketplace (from a terminal):',
      `  claude plugin marketplace add "${marketplaceDir}"`,
      `  claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
      '',
      'Or inside Claude Code:',
      `  /plugin marketplace add "${marketplaceDir}"`,
      `  /plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    )
  }
  lines.push(
    '',
    'Then restart Claude Code (or run /reload-plugins) and run /search-hole:doctor.',
    'After a rebuild, run this script again and restart Claude Code.',
    '',
    'Uninstall:',
    `  claude plugin uninstall ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    `  claude plugin marketplace remove ${MARKETPLACE_NAME}`,
    '',
  )
  return lines.join('\n')
}

const USAGE = `Usage: node scripts/build-plugin.mjs [--skip-build] [--dist <dir>] [--out <dir>]

  --skip-build   do not build the package; use the existing dist/
  --dist <dir>   built bundle to copy (default: packages/search-hole/dist)
  --out <dir>    where to assemble the plugin (default: distribution/marketplace/search-hole)
`

/** CLI entry point. Returns the process exit code. */
export async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    if (!opts.skipBuild) runBuild()
    if (!existsSync(opts.dist) || !statSync(opts.dist).isDirectory()) {
      throw new Error(`${opts.dist} is not a directory. Build the package first, or pass --dist.`)
    }
    const { out } = await assemblePlugin(opts)
    const note = versionNote(out)
    if (note) process.stderr.write(`${note}\n`)
    process.stdout.write(installSteps(out))
    return 0
  } catch (err) {
    process.stderr.write(`build-plugin: ${err.message}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
