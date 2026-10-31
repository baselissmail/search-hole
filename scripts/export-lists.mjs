#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Writes the CC0 text copies of the first-party lists (`lists/<id>.txt`, ADR-0016) from the TS
// modules in packages/search-hole/src/lists/bundled, which Node loads with type stripping.
//
//   node scripts/export-lists.mjs           write lists/<id>.txt
//   node scripts/export-lists.mjs --check   exit 1 if any file is missing or out of date
//   node scripts/export-lists.mjs --vendor  re-fetch the vendored starter lists from their pinned
//                                           commit URLs, verify the manifest sha256, and rewrite
//                                           lists/vendor/<id>.txt (network; run by hand only)
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LISTS_SRC = join(ROOT, 'packages/search-hole/src/lists')

const { FIRST_PARTY_LISTS } = await import(join(LISTS_SRC, 'bundled/first-party.ts'))
const { exportPath, renderListText } = await import(join(LISTS_SRC, 'bundled/render-text.ts'))
const { VENDORED_LISTS, vendorHeader } = await import(join(LISTS_SRC, 'catalog.ts'))

const args = new Set(process.argv.slice(2))

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

async function vendor() {
  for (const v of VENDORED_LISTS) {
    const res = await fetch(v.pinnedUrl)
    if (!res.ok) throw new Error(`${v.id}: HTTP ${res.status} for ${v.pinnedUrl}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== v.sha256) throw new Error(`${v.id}: sha256 ${sha} does not match the manifest ${v.sha256}`)
    const out = join(ROOT, v.path)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, Buffer.concat([Buffer.from(vendorHeader(v), 'utf8'), bytes]))
    console.log(`vendored ${v.path} (${bytes.length} bytes, sha256 ${sha})`)
  }
}

if (args.has('--vendor')) {
  await vendor()
} else {
  const stale = []
  for (const list of FIRST_PARTY_LISTS) {
    const path = join(ROOT, exportPath(list.id))
    const text = renderListText(list)
    if (readOrNull(path) === text) continue
    if (args.has('--check')) {
      stale.push(exportPath(list.id))
    } else {
      writeFileSync(path, text)
      console.log(`wrote ${exportPath(list.id)} (${list.entries.length} entries)`)
    }
  }
  if (stale.length > 0) {
    console.error(`out of date: ${stale.join(', ')}; run node scripts/export-lists.mjs`)
    process.exit(1)
  }
}
