#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Packs the Claude Desktop extension (ADR-0021 point 10, ADR-0002):
 *   distribution/claude-desktop/{manifest.json, icon.png} + dist/ (no source maps) + LICENSE
 *   → validated with @anthropic-ai/mcpb → distribution/out/search-hole-<version>.mcpb
 * Run after the package build (`pnpm -C packages/search-hole build`); it does not build.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packExtension, validateManifest } from '@anthropic-ai/mcpb'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pkgDir, '..', '..')
const source = join(repo, 'distribution', 'claude-desktop')
const outDir = join(repo, 'distribution', 'out')
const stage = join(outDir, 'mcpb-stage')
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

for (const required of ['dist/searchhole.mjs', 'dist/panel/receipt.html', 'dist/ui/index.html']) {
  if (!existsSync(join(pkgDir, required))) {
    console.error(
      `build-mcpb: ${required} is missing. Run the build first: node scripts/build-plugin.mjs (or pnpm -r build).`,
    )
    process.exit(1)
  }
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
manifest.version = version
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(join(source, 'icon.png'), join(stage, 'icon.png'))
cpSync(join(repo, 'LICENSE'), join(stage, 'LICENSE'))
cpSync(join(pkgDir, 'dist'), join(stage, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') })

if (!validateManifest(join(stage, 'manifest.json'))) {
  console.error('build-mcpb: the manifest did not validate (see above).')
  process.exit(1)
}
const output = join(outDir, `search-hole-${version}.mcpb`)
rmSync(output, { force: true })
if (!(await packExtension({ extensionPath: stage, outputPath: output, silent: true }))) {
  console.error('build-mcpb: mcpb pack failed.')
  process.exit(1)
}
rmSync(stage, { recursive: true, force: true })
console.log(`build-mcpb: ${output}`)
console.log('Install: open Claude Desktop → Settings → Extensions → Install Extension…, and pick this file.')
