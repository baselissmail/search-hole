#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Developer Certificate of Origin check (ADR-0016 point 4): every non-merge commit in a range
 * needs a `Signed-off-by:` trailer whose email matches the commit author's email.
 *
 *   node .github/scripts/check-dco.mjs <base>..<head>
 *
 * Bot authors (`…[bot]@users.noreply.github.com`, such as Renovate) are exempt.
 * See https://developercertificate.org and CONTRIBUTING.md.
 */
import { spawnSync } from 'node:child_process'

const range = process.argv[2]
if (!range?.includes('..')) {
  process.stderr.write('Usage: node .github/scripts/check-dco.mjs <base>..<head>\n')
  process.exit(2)
}

const FIELD = '\x1f'
const RECORD = '\x1e'
const res = spawnSync(
  'git',
  ['log', '--no-merges', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`, range],
  {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
)
if (res.status !== 0) {
  process.stderr.write(`git log ${range} failed:\n${res.stderr}`)
  process.exit(2)
}

const SIGNOFF = /^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/gim
const isBot = (email) => /\[bot\]@users\.noreply\.github\.com$/i.test(email)

const commits = res.stdout
  .split(RECORD)
  .map((r) => r.replace(/^\n/, ''))
  .filter((r) => r.trim() !== '')
  .map((r) => {
    const [sha, name, email, body = ''] = r.split(FIELD)
    return { sha, name, email, body }
  })

const bad = []
for (const c of commits) {
  if (isBot(c.email)) continue
  const emails = [...c.body.matchAll(SIGNOFF)].map((m) => m[2].toLowerCase())
  if (!emails.includes(c.email.toLowerCase())) {
    bad.push({ ...c, found: emails })
  }
}

if (bad.length === 0) {
  process.stdout.write(`DCO: ${commits.length} commit(s) in ${range} are signed off.\n`)
  process.exit(0)
}

process.stderr.write(
  `DCO: ${bad.length} of ${commits.length} commit(s) lack a matching Signed-off-by line:\n`,
)
for (const c of bad) {
  const subject = c.body.split('\n')[0]
  const why = c.found.length ? `signed off as ${c.found.join(', ')}, not the author` : 'no Signed-off-by line'
  process.stderr.write(`  ${c.sha.slice(0, 12)} ${subject}\n    author ${c.name} <${c.email}>: ${why}\n`)
}
process.stderr.write(
  '\nFix: sign off with the same email as the commit author, then force-push the branch:\n' +
    '  git commit --amend --signoff          (the last commit)\n' +
    '  git rebase --signoff <base-branch>    (every commit on the branch)\n' +
    'Signing off certifies the Developer Certificate of Origin: https://developercertificate.org\n',
)
process.exit(1)
