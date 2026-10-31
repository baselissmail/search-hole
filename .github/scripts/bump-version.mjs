#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Sets the release version everywhere it is written (docs/release.md, step 2):
 *
 *   node .github/scripts/bump-version.mjs <X.Y.Z[-pre]> [--date YYYY-MM-DD]
 *
 * Rewrites only the top-level "version" value (no reformatting) in
 *   packages/search-hole/package.json, apps/dashboard/package.json, apps/receipt-app/package.json,
 *   distribution/claude-plugin/.claude-plugin/plugin.json, distribution/claude-desktop/manifest.json,
 *   distribution/codex/plugin.json, distribution/cursor-plugin/.cursor-plugin/plugin.json
 * and the VERSION constant in packages/search-hole/src/cli/version.ts, then turns
 * `## [Unreleased]` in CHANGELOG.md into a dated `## [X.Y.Z]` section under a fresh, empty
 * Unreleased heading. Check the result with: node .github/scripts/check-release.mjs vX.Y.Z
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const version = args[0]
const dateIdx = args.indexOf('--date')
const date = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().slice(0, 10)
if (
  !version ||
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ||
  !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')
) {
  process.stderr.write('Usage: node .github/scripts/bump-version.mjs <X.Y.Z[-pre]> [--date YYYY-MM-DD]\n')
  process.exit(2)
}

/** Planned writes; nothing is written until every file has been prepared. */
const planned = []
const edit = (rel, fn) => {
  const file = join(REPO, rel)
  const before = readFileSync(file, 'utf8')
  const after = fn(before)
  if (after === before)
    throw new Error(`${rel}: nothing to change (already ${version}, or the pattern moved)`)
  planned.push({ rel, file, after })
}

const JSON_FILES = [
  'packages/search-hole/package.json',
  'apps/dashboard/package.json',
  'apps/receipt-app/package.json',
  'distribution/claude-plugin/.claude-plugin/plugin.json',
  'distribution/claude-desktop/manifest.json',
  'distribution/codex/plugin.json',
  'distribution/cursor-plugin/.cursor-plugin/plugin.json',
]

try {
  process.stdout.write(`Setting ${version}:\n`)
  for (const rel of JSON_FILES) {
    // The first two-space-indented "version" key is the top-level one in each of these files.
    edit(rel, (t) => t.replace(/^( {2}"version": )"[^"]*"/m, `$1"${version}"`))
  }
  edit('packages/search-hole/src/cli/version.ts', (t) =>
    t.replace(/export const VERSION = '[^']*'/, `export const VERSION = '${version}'`),
  )
  edit('CHANGELOG.md', (t) => {
    if (!/^## \[Unreleased\][ \t]*$/m.test(t))
      throw new Error('CHANGELOG.md has no "## [Unreleased]" heading')
    const section = t.split(/^## \[Unreleased\][ \t]*$/m)[1]?.split(/^## \[/m)[0] ?? ''
    if (section.trim() === '')
      throw new Error('CHANGELOG.md: the Unreleased section is empty; write the notes first')
    return t.replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`)
  })
  for (const { rel, file, after } of planned) {
    writeFileSync(file, after)
    process.stdout.write(`  ${rel}\n`)
  }
  process.stdout.write(`Next: review the diff, then run node .github/scripts/check-release.mjs v${version}\n`)
} catch (e) {
  process.stderr.write(`bump-version: ${e instanceof Error ? e.message : e}\n`)
  process.exit(1)
}
