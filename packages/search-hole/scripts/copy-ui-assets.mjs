#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copies the built UI apps and the starter lists into dist/ after tsdown (which cleans dist/):
//   apps/dashboard/dist          → dist/ui     (served by `searchhole ui`, ADR-0020)
//   apps/receipt-app/dist/receipt.html → dist/panel/receipt.html (the MCP App, ADR-0021)
//   lists/vendor/*.txt            → dist/lists/ (the shipped starter lists, ADR-0017 point 7, ADR-0022)
// A missing UI build warns instead of failing, so the CLI and gateway still build alone. Missing
// starter lists fail the build: without them the default lists would be empty offline.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apps = join(pkg, '..', '..', 'apps')

const dashboard = join(apps, 'dashboard', 'dist')
if (existsSync(join(dashboard, 'index.html'))) {
  rmSync(join(pkg, 'dist', 'ui'), { recursive: true, force: true })
  cpSync(dashboard, join(pkg, 'dist', 'ui'), { recursive: true })
  console.log('copy-ui-assets: dashboard → dist/ui')
} else {
  console.warn(
    'copy-ui-assets: apps/dashboard is not built; `searchhole ui` will say so (pnpm -C apps/dashboard build).',
  )
}

const panel = join(apps, 'receipt-app', 'dist', 'receipt.html')
if (existsSync(panel)) {
  mkdirSync(join(pkg, 'dist', 'panel'), { recursive: true })
  cpSync(panel, join(pkg, 'dist', 'panel', 'receipt.html'))
  console.log('copy-ui-assets: receipt panel → dist/panel/receipt.html')
} else {
  console.warn(
    'copy-ui-assets: apps/receipt-app is not built; hosts get a "not built" panel (pnpm -C apps/receipt-app build).',
  )
}

const vendor = join(pkg, '..', '..', 'lists', 'vendor')
const lists = existsSync(vendor) ? readdirSync(vendor).filter((f) => f.endsWith('.txt')) : []
if (lists.length === 0) {
  console.error('copy-ui-assets: lists/vendor/ has no starter lists; the bundle would ship without them.')
  process.exit(1)
}
rmSync(join(pkg, 'dist', 'lists'), { recursive: true, force: true })
mkdirSync(join(pkg, 'dist', 'lists'), { recursive: true })
for (const f of lists) cpSync(join(vendor, f), join(pkg, 'dist', 'lists', f))
console.log(`copy-ui-assets: ${lists.length} starter lists → dist/lists`)

// The bundle inlines MIT/ISC/BSD code and ships CC0/Unlicense starter lists: their notices travel
// with every artifact built from dist/ (npm package, Claude plugin, .mcpb).
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(join(pkg, '..', '..', f), join(pkg, 'dist', f))
console.log('copy-ui-assets: LICENSE and THIRD_PARTY_NOTICES.md → dist/')
