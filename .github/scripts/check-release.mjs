#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Release preflight (docs/release.md): the tag, every version string and the changelog agree.
 *
 *   node .github/scripts/check-release.mjs <tag> [--notes <file>]
 *
 * Checks, for tag vX.Y.Z[-pre]:
 *   - the version in packages/search-hole/package.json, apps/dashboard/package.json,
 *     apps/receipt-app/package.json, packages/search-hole/src/cli/version.ts,
 *     distribution/claude-plugin/.claude-plugin/plugin.json and distribution/claude-desktop/manifest.json;
 *   - packages/search-hole/package.json `repository.url` names this GitHub repository, which npm
 *     requires before it accepts a provenance statement;
 *   - CHANGELOG.md has a `## [X.Y.Z] - YYYY-MM-DD` section, written to --notes when given.
 * In GitHub Actions it also writes version, prerelease and npm_tag to $GITHUB_OUTPUT.
 * Run it locally before tagging: node .github/scripts/check-release.mjs v0.3.0
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXPECTED_REPO = (process.env.GITHUB_REPOSITORY ?? 'baselissmail/search-hole').toLowerCase()

const args = process.argv.slice(2)
const tag = args[0]
const notesIdx = args.indexOf('--notes')
const notesOut = notesIdx >= 0 ? args[notesIdx + 1] : undefined
if (!tag || tag.startsWith('--') || (notesIdx >= 0 && !notesOut)) {
  process.stderr.write('Usage: node .github/scripts/check-release.mjs <tag> [--notes <file>]\n')
  process.exit(2)
}

const problems = []
const m = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/.exec(tag)
if (!m) {
  process.stderr.write(`release: tag "${tag}" is not vMAJOR.MINOR.PATCH (optionally -prerelease)\n`)
  process.exit(1)
}
const version = `${m[1]}${m[2] ?? ''}`
const prerelease = m[2] !== undefined

const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
const json = (rel) => JSON.parse(read(rel))

const sources = [
  ['packages/search-hole/package.json', () => json('packages/search-hole/package.json').version],
  ['apps/dashboard/package.json', () => json('apps/dashboard/package.json').version],
  ['apps/receipt-app/package.json', () => json('apps/receipt-app/package.json').version],
  [
    'packages/search-hole/src/cli/version.ts',
    () => /export const VERSION = '([^']+)'/.exec(read('packages/search-hole/src/cli/version.ts'))?.[1],
  ],
  [
    'distribution/claude-plugin/.claude-plugin/plugin.json',
    () => json('distribution/claude-plugin/.claude-plugin/plugin.json').version,
  ],
  [
    'distribution/claude-desktop/manifest.json',
    () => json('distribution/claude-desktop/manifest.json').version,
  ],
]
for (const [file, get] of sources) {
  let found
  try {
    found = get()
  } catch (e) {
    found = `unreadable (${e instanceof Error ? e.message : e})`
  }
  if (found !== version) problems.push(`${file}: version is ${found ?? 'missing'}, the tag says ${version}`)
}

const pkg = json('packages/search-hole/package.json')
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
const repoMatch = repoUrl
  ?.toLowerCase()
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
  .match(/github\.com[/:]([^/]+\/[^/]+)$/)
if (!repoMatch || repoMatch[1] !== EXPECTED_REPO) {
  problems.push(
    `packages/search-hole/package.json: repository.url is ${repoUrl ?? 'missing'}; npm provenance needs ` +
      `{"type": "git", "url": "git+https://github.com/${EXPECTED_REPO}.git", "directory": "packages/search-hole"}`,
  )
}

let notes = ''
let changelog = ''
try {
  changelog = read('CHANGELOG.md')
} catch {
  problems.push('CHANGELOG.md is missing')
}
const heading = new RegExp(
  `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`,
  'm',
)
const h = heading.exec(changelog)
if (!h)
  problems.push(
    `CHANGELOG.md: no "## [${version}] - YYYY-MM-DD" section (move the Unreleased notes under it)`,
  )
else {
  const rest = changelog.slice(h.index + h[0].length)
  const next = rest.search(/^## \[|^\[[^\]]+\]:\s/m)
  notes = (next >= 0 ? rest.slice(0, next) : rest).trim()
  if (notes === '') problems.push(`CHANGELOG.md: the ${version} section is empty`)
}

if (problems.length > 0) {
  process.stderr.write(`release: ${tag} is not ready:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`)
  process.exit(1)
}

if (notesOut) writeFileSync(notesOut, `${notes}\n`)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nprerelease=${prerelease}\nnpm_tag=${prerelease ? 'next' : 'latest'}\n`,
  )
}
process.stdout.write(`release: ${tag} matches every version string and has changelog notes.\n`)
