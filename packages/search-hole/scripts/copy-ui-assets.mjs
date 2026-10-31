#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copies the built UI apps into dist/ after tsdown (which cleans dist/):
//   apps/dashboard/dist          → dist/ui     (served by `searchhole ui`, ADR-0020)
//   apps/receipt-app/dist/receipt.html → dist/panel/receipt.html (the MCP App, ADR-0021)
// A missing build warns instead of failing, so the CLI and gateway still build alone.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
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
