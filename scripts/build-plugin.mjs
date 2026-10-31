#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Assembles the search-hole Claude Code plugin for local installs and testing (ADR-0002 point 5,
 * "for local development ... a relative-path marketplace points at a local build"), and on request
 * the Codex and Cursor plugins (P7).
 *
 *   node scripts/build-plugin.mjs [--skip-build] [--target claude|codex|cursor|all] [--dist <dir>] [--out <dir>]
 *
 * 1. Builds the dashboard and then the package (`mise exec -- pnpm -C <dir> build`), unless --skip-build.
 * 2. Copies the plugin sources, the built dist/ (every file) and LICENSE into the output (git-ignored):
 *    - claude (default): distribution/claude-plugin/ → distribution/marketplace/search-hole/, the plugin
 *      directory that the local marketplace `search-hole-local` points at;
 *    - codex: distribution/codex/ → distribution/out/codex-marketplace/search-hole/, plus a local Codex
 *      marketplace file next to it (.agents/plugins/marketplace.json);
 *    - cursor: distribution/cursor-plugin/ → distribution/out/cursor/search-hole/.
 *    Codex and Cursor also get the plugin icon as assets/logo.png.
 * 3. Prints the install steps.
 *
 * Importable without side effects: the exported functions are what the tests exercise.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'search-hole')
const PLUGIN_SOURCE = join(REPO_ROOT, 'distribution', 'claude-plugin')
const DEFAULT_OUT = join(REPO_ROOT, 'distribution', 'marketplace', 'search-hole')
const OUT_ROOT = join(REPO_ROOT, 'distribution', 'out')
/** The plugin icon, reused as the Codex and Cursor logo. */
export const ICON = join(PLUGIN_SOURCE, '.claude-plugin', 'icon.png')
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
 * What each target copies and checks. `manifest` marks an earlier assembly (an output directory
 * without it is never deleted); `logo` is where the icon goes, when the target has one.
 */
export const TARGETS = {
  claude: {
    source: PLUGIN_SOURCE,
    manifest: '.claude-plugin/plugin.json',
    out: DEFAULT_OUT,
    required: REQUIRED_FILES,
  },
  codex: {
    source: join(REPO_ROOT, 'distribution', 'codex'),
    manifest: 'plugin.json',
    out: join(OUT_ROOT, 'codex-marketplace', PLUGIN_NAME),
    logo: 'assets/logo.png',
    required: [
      'plugin.json',
      'mcp.json',
      'skills/research/SKILL.md',
      'assets/logo.png',
      'dist/searchhole.mjs',
      'LICENSE',
    ],
  },
  cursor: {
    source: join(REPO_ROOT, 'distribution', 'cursor-plugin'),
    manifest: '.cursor-plugin/plugin.json',
    out: join(OUT_ROOT, 'cursor', PLUGIN_NAME),
    logo: 'assets/logo.png',
    required: [
      '.cursor-plugin/plugin.json',
      'mcp.json',
      'skills/research/SKILL.md',
      'assets/logo.png',
      'dist/searchhole.mjs',
      'LICENSE',
    ],
  },
}
const TARGET_NAMES = [...Object.keys(TARGETS), 'all']

/**
 * Parses the command line. Unknown flags and missing values throw.
 * `out` defaults to the target's own output; `--out` with `--target all` is refused.
 * @param {string[]} argv
 * @returns {{ skipBuild: boolean, dist: string, out: string, help: boolean, target: string }}
 */
export function parseArgs(argv) {
  const opts = {
    skipBuild: false,
    dist: join(PACKAGE_DIR, 'dist'),
    out: undefined,
    help: false,
    target: 'claude',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-build') opts.skipBuild = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--dist' || arg === '--out') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a directory`)
      opts[arg === '--dist' ? 'dist' : 'out'] = resolve(value)
    } else if (arg === '--target') {
      const value = argv[++i]
      if (!TARGET_NAMES.includes(value)) throw new Error(`--target needs one of: ${TARGET_NAMES.join(', ')}`)
      opts.target = value
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (opts.target === 'all' && opts.out !== undefined)
    throw new Error('--out cannot be used with --target all')
  if (opts.out === undefined && opts.target !== 'all') opts.out = TARGETS[opts.target].out
  return opts
}

/** Runs `pnpm -C <dir> build` through mise, falling back to a bare pnpm when mise is not installed. */
function pnpmBuild(dir, what) {
  const attempts = [
    ['mise', ['exec', '--', 'pnpm', '-C', dir, 'build']],
    ['pnpm', ['-C', dir, 'build']],
  ]
  // Windows ships pnpm and mise as .cmd shims, which Node runs only through a shell (since the
  // 2024 batch-file fix), so quote each argument for cmd.exe there (paths may contain spaces).
  const win = process.platform === 'win32'
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
  for (const [cmd, args] of attempts) {
    const res = win
      ? spawnSync([cmd, ...args].map(quote).join(' '), { stdio: 'inherit', cwd: REPO_ROOT, shell: true })
      : spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT })
    // Not installed: ENOENT, or cmd.exe's 9009 ("is not recognized") through the Windows shell.
    if ((res.error && res.error.code === 'ENOENT') || (win && res.status === 9009)) continue
    if (res.error) throw res.error
    if (res.status !== 0) throw new Error(`The ${what} build failed (${cmd} exited ${res.status}).`)
    return
  }
  throw new Error(
    'Neither mise nor pnpm is on PATH. Install mise (https://mise.jdx.dev), or run the build yourself and pass --skip-build.',
  )
}

/** Builds the UI apps (when present), then the package, which copies them into dist/ (ADR-0020, ADR-0021). */
function runBuild() {
  for (const app of ['dashboard', 'receipt-app']) {
    const dir = join(REPO_ROOT, 'apps', app)
    if (existsSync(join(dir, 'package.json'))) pnpmBuild(dir, app)
  }
  pnpmBuild(PACKAGE_DIR, 'package')
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
 * @param {{ target?: 'claude' | 'codex' | 'cursor', pluginSource?: string, dist: string, out: string, license?: string, icon?: string }} opts
 * @returns {Promise<{ out: string, files: string[] }>}
 */
export async function assemblePlugin(opts) {
  const target = TARGETS[opts.target ?? 'claude']
  if (target === undefined) throw new Error(`Unknown target: ${opts.target}`)
  const pluginSource = opts.pluginSource ?? target.source
  const license = opts.license ?? join(REPO_ROOT, 'LICENSE')
  const icon = opts.icon ?? ICON
  const { dist, out } = opts

  if (!existsSync(join(pluginSource, target.manifest))) {
    throw new Error(`Plugin sources not found at ${pluginSource}`)
  }
  if (!existsSync(join(dist, 'searchhole.mjs'))) {
    throw new Error(
      `${join(dist, 'searchhole.mjs')} does not exist. Build the package first (it needs src/cli/main.ts), or pass --dist.`,
    )
  }
  if (!existsSync(license)) throw new Error(`LICENSE not found at ${license}`)
  if (target.logo !== undefined && !existsSync(icon)) throw new Error(`The plugin icon is missing at ${icon}`)

  if ((await isNonEmptyDir(out)) && !existsSync(join(out, target.manifest))) {
    throw new Error(`Refusing to replace ${out}: it is not empty and does not look like an assembled plugin.`)
  }
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const skipJunk = (src) => basename(src) !== '.DS_Store'
  await cp(pluginSource, out, { recursive: true, filter: skipJunk })
  await cp(dist, join(out, 'dist'), { recursive: true, filter: skipJunk })
  await cp(license, join(out, 'LICENSE'))
  if (target.logo !== undefined) {
    await mkdir(dirname(join(out, target.logo)), { recursive: true })
    await cp(icon, join(out, target.logo))
  }
  // The sh/PowerShell polyglot is dot-sourced, but keep it runnable as a file too.
  if (opts.target === undefined || opts.target === 'claude')
    await chmod(join(out, 'hooks', 'preflight.ps1'), 0o755)

  const missing = target.required.filter((rel) => !existsSync(join(out, rel)))
  if (missing.length > 0) throw new Error(`The assembled plugin is missing: ${missing.join(', ')}`)
  return { out, files: target.required }
}

/**
 * The local Codex marketplace for a plugin assembled at `<root>/<plugin dir>`: Codex reads
 * `<root>/.agents/plugins/marketplace.json` after `codex plugin marketplace add <root>`.
 */
export function codexMarketplace(pluginDirName = PLUGIN_NAME) {
  return {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'search-hole (local build)' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: 'local', path: `./${pluginDirName}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  }
}

/** Writes the local Codex marketplace file next to an assembled Codex plugin. */
export async function writeCodexMarketplace(out) {
  const file = join(dirname(out), '.agents', 'plugins', 'marketplace.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(codexMarketplace(basename(out)), null, 2)}\n`)
  return file
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
export function versionNote(pluginDir, packageDir = PACKAGE_DIR, manifest = '.claude-plugin/plugin.json') {
  const plugin = readVersion(join(pluginDir, manifest))
  const pkg = readVersion(join(packageDir, 'package.json'))
  if (plugin === undefined || pkg === undefined || plugin === pkg) return undefined
  return `Note: ${manifest} says ${plugin} but packages/search-hole/package.json says ${pkg}.`
}

/** Install steps for an assembled Codex plugin (docs/clients/codex.md). */
export function codexInstallSteps(out) {
  const root = dirname(out)
  const hasMarketplace = existsSync(join(root, '.agents', 'plugins', 'marketplace.json'))
  const lines = [
    '',
    `Codex plugin assembled at: ${out}`,
    '',
    'Needs Codex with plugins and Node.js 22.19+ on PATH.',
  ]
  if (hasMarketplace) {
    lines.push(
      '',
      'Add the local marketplace (from a terminal):',
      `  codex plugin marketplace add "${root}"`,
      `Then in Codex run /plugins, install ${PLUGIN_NAME} from ${MARKETPLACE_NAME}, and start a new session.`,
      '',
      'Uninstall: remove it in /plugins, then',
      `  codex plugin marketplace remove ${MARKETPLACE_NAME}`,
    )
  } else {
    lines.push('', 'Add it to a Codex marketplace (.agents/plugins/marketplace.json) to install it.')
  }
  lines.push('', 'The plugin has no hooks, so it can be listed in the plugin directory.', '')
  return lines.join('\n')
}

/** Install steps for an assembled Cursor plugin (docs/clients/cursor.md). */
export function cursorInstallSteps(out) {
  return [
    '',
    `Cursor plugin assembled at: ${out}`,
    '',
    'Needs Cursor with plugins and Node.js 22.19+ on PATH.',
    '',
    "Install it as a local plugin: copy the folder into Cursor's local plugins folder.",
    `  macOS, Linux:  mkdir -p ~/.cursor/plugins/local && cp -R "${out}" ~/.cursor/plugins/local/`,
    `  Windows:       Copy-Item -Recurse "${out}" "$env:USERPROFILE\\.cursor\\plugins\\local\\"`,
    'Then run "Developer: Reload Window" in Cursor and check Customize: search-hole and its MCP server.',
    'Copy again after a rebuild (a symlink to this folder is not loaded).',
    '',
    'Uninstall: delete ~/.cursor/plugins/local/search-hole and reload Cursor.',
    '',
  ].join('\n')
}

/**
 * The install instructions for an assembled plugin directory.
 * The marketplace steps appear only when the plugin sits next to a marketplace.json.
 */
export function installSteps(out, target = 'claude') {
  if (target === 'codex') return codexInstallSteps(out)
  if (target === 'cursor') return cursorInstallSteps(out)
  const marketplaceDir = dirname(out)
  const hasMarketplace = existsSync(join(marketplaceDir, '.claude-plugin', 'marketplace.json'))
  const lines = [
    '',
    `Plugin assembled at: ${out}`,
    '',
    'Needs Claude Code 2.1.296 or newer and Node.js 22.19+ on PATH.',
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

const USAGE = `Usage: node scripts/build-plugin.mjs [--skip-build] [--target <name>] [--dist <dir>] [--out <dir>]

  --skip-build     do not build the package; use the existing dist/
  --target <name>  claude (default), codex, cursor, or all
  --dist <dir>     built bundle to copy (default: packages/search-hole/dist)
  --out <dir>      where to assemble the plugin (default: distribution/marketplace/search-hole for
                   claude, distribution/out/codex-marketplace/search-hole for codex,
                   distribution/out/cursor/search-hole for cursor; not with --target all)
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
    const targets = opts.target === 'all' ? Object.keys(TARGETS) : [opts.target]
    for (const target of targets) {
      const out = opts.target === 'all' ? TARGETS[target].out : opts.out
      await assemblePlugin({ target, dist: opts.dist, out })
      // The local Codex marketplace sits next to the default output only, never in a folder
      // the caller chose.
      if (target === 'codex' && out === TARGETS.codex.out) await writeCodexMarketplace(out)
      const note = versionNote(out, PACKAGE_DIR, TARGETS[target].manifest)
      if (note) process.stderr.write(`${note}\n`)
      process.stdout.write(installSteps(out, target))
    }
    return 0
  } catch (err) {
    process.stderr.write(`build-plugin: ${err.message}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
