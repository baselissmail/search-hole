#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * SPDX header check (ADR-0016 point 1): every tracked code file carries
 * `SPDX-License-Identifier:` in its first lines (after a shebang or a polyglot preamble).
 *
 *   node .github/scripts/check-spdx.mjs
 *
 * Covers .ts .tsx .mts .cts .js .jsx .mjs .cjs .ps1 .sh outside test fixtures and research/.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CODE = /\.(?:[cm]?[jt]s|[jt]sx|ps1|sh)$/
const SKIP = [/(^|\/)test\/fixtures\//, /^research\//, /(^|\/)node_modules\//, /(^|\/)dist\//]
const HEAD_LINES = 6

const res = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (res.status !== 0) {
  process.stderr.write(`git ls-files failed:\n${res.stderr}`)
  process.exit(2)
}

const files = res.stdout.split('\0').filter((f) => f && CODE.test(f) && !SKIP.some((re) => re.test(f)))
const missing = files.filter((f) => {
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    return false // deleted in the working tree
  }
  return !text
    .split('\n')
    .slice(0, HEAD_LINES)
    .some((l) => l.includes('SPDX-License-Identifier:'))
})

if (missing.length > 0) {
  process.stderr.write(`SPDX: ${missing.length} file(s) without an SPDX-License-Identifier header:\n`)
  for (const f of missing) process.stderr.write(`  ${f}\n`)
  process.stderr.write(
    "Add '// SPDX-License-Identifier: Apache-2.0' (or '# …' for scripts) as the first line.\n",
  )
  process.exit(1)
}
process.stdout.write(`SPDX: ${files.length} code files have a licence header.\n`)
