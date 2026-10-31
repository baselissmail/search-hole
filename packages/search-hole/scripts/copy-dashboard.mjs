#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copies the built dashboard (apps/dashboard/dist) into dist/ui, where `searchhole ui` serves it
// from (ADR-0020). Run after tsdown, which cleans dist/. Missing build: warn, don't fail, so the
// CLI and gateway still build alone.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(pkg, '..', '..', 'apps', 'dashboard', 'dist')
const to = join(pkg, 'dist', 'ui')

if (!existsSync(join(from, 'index.html'))) {
  console.warn(
    'copy-dashboard: apps/dashboard/dist is not built; `searchhole ui` will say so. Run `pnpm -C apps/dashboard build` first.',
  )
} else {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  console.log(`copy-dashboard: ${from} → ${to}`)
}
