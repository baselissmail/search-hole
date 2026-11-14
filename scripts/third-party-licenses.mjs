#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Licence notices for the npm libraries inlined into what search-hole ships (ADR-0016
 * amendment 2026-11-14). The package has no runtime node_modules: tsdown and Vite copy every
 * library into dist/, and MIT, BSD, ISC and Apache-2.0 all ask that copies keep the copyright
 * and licence text. Run after the builds (the package's `build` script does):
 *
 *   node scripts/third-party-licenses.mjs [--out <file>]
 *
 * It writes dist/THIRD_PARTY_LICENSES.txt, which travels with every artifact (npm tarball,
 * plugin zip, .mcpb), since each of them ships dist/ whole. The set of libraries is the SBOM's
 * (scripts/sbom.mjs): the packages named in the CLI bundle's source maps, plus each UI app's
 * production dependency closure. For each one it copies the LICENSE / NOTICE / COPYING files
 * from the installed package.
 *
 * A UI app that isn't built is left out with a warning, like copy-ui-assets.mjs does, so the
 * CLI still builds alone. A listed library that isn't installed is an error: a release must
 * not ship without its notices. The output has no timestamp, so the same inputs give the
 * same bytes.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundledFromSourceMaps, pnpmSbom } from './sbom.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(REPO, 'packages', 'search-hole')
const STORE = join(REPO, 'node_modules', '.pnpm')

/** Files a package uses for its licence terms and notices. */
const LICENCE_FILE = /^(?:licen[cs]e|copying|notice|unlicense)(?:[.-].*)?$/i
const RULE = '-'.repeat(80)

const fullName = (c) => (c.group ? `${c.group}/${c.name}` : c.name)

/** The licence a CycloneDX component declares, as text. */
function declaredLicence(component) {
  const first = component.licenses?.[0]
  return first?.license?.id ?? first?.license?.name ?? first?.expression
}

/** `name@version` → installed folder, for every package in pnpm's store. Built once, on the first miss. */
let storeIndex

/**
 * Reads the name and version of every package under `.pnpm/<entry>/node_modules/`. The folder
 * names can't be trusted for this: pnpm shortens long ones to a hash (always on Windows).
 */
export function indexStore(entries) {
  const index = new Map()
  const note = (dir) => {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
        index.set(`${pkg.name}@${pkg.version}`, dir)
      }
    } catch {
      // Not a package folder.
    }
  }
  const list = (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  for (const entry of entries) {
    const modules = join(STORE, entry, 'node_modules')
    for (const name of list(modules)) {
      if (name.startsWith('.')) continue
      if (!name.startsWith('@')) note(join(modules, name))
      else for (const scoped of list(join(modules, name))) note(join(modules, name, scoped))
    }
  }
  return index
}

/** The installed folder of `name@version` in pnpm's store, or undefined. */
function installedDir(name, version, entries) {
  const prefix = `${name.replace('/', '+')}@`
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const dir = join(STORE, entry, 'node_modules', ...name.split('/'))
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === version) return dir
    } catch {
      // Another package whose name starts the same way.
    }
  }
  storeIndex ??= indexStore(entries)
  return storeIndex.get(`${name}@${version}`)
}

/**
 * Every library in the shipped bundles: name, version, declared licence, installed folder and
 * the bundles it is in.
 * @returns {{ libraries: Array<{ name: string, version: string, licence?: string, dir?: string, bundles: string[] }>, skipped: string[] }}
 */
export function collect(distDir = join(PKG_DIR, 'dist')) {
  const found = new Map()
  const add = (name, version, licence, dir, bundle) => {
    const id = `${name}@${version}`
    const lib = found.get(id) ?? { name, version, licence, dir, bundles: [] }
    lib.licence ??= licence
    lib.dir ??= dir
    if (!lib.bundles.includes(bundle)) lib.bundles.push(bundle)
    found.set(id, lib)
  }
  for (const lib of bundledFromSourceMaps(distDir).values()) {
    add(lib.name, lib.version, lib.license, lib.dir, 'the CLI, MCP gateway and dashboard server')
  }
  const entries = existsSync(STORE) ? readdirSync(STORE) : []
  const skipped = []
  const apps = [
    ['@search-hole/dashboard', 'ui/index.html', 'the dashboard'],
    ['@search-hole/receipt-app', 'panel/receipt.html', 'the receipt panel'],
  ]
  for (const [filter, built, bundle] of apps) {
    if (!existsSync(join(distDir, built))) {
      skipped.push(bundle)
      continue
    }
    for (const c of pnpmSbom(filter, true).components ?? []) {
      const name = fullName(c)
      if (name.startsWith('@search-hole/')) continue
      add(name, c.version, declaredLicence(c), installedDir(name, c.version, entries), bundle)
    }
  }
  const libraries = [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  )
  return { libraries, skipped }
}

/** The licence and notice files of one installed package, as `[file name, text]` pairs. */
function licenceFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()])
    .filter(([, text]) => text !== '')
}

/** The whole notices file. Throws when a listed library is not installed. */
export function render({ libraries, skipped }) {
  const missing = libraries.filter((l) => l.dir === undefined || !existsSync(l.dir))
  if (missing.length > 0) {
    throw new Error(
      `not installed, so their licences can't be copied: ${missing.map((l) => `${l.name}@${l.version}`).join(', ')}`,
    )
  }
  const out = [
    'Third-party software in search-hole',
    '===================================',
    '',
    "search-hole's own code is under the Apache License 2.0 (see LICENSE). The files in this",
    'folder also contain the npm libraries listed below, copied in when search-hole is built.',
    'Each entry gives the licence the library declares and the licence and notice files from',
    'its package, unchanged. Block lists and adapted code are in THIRD_PARTY_NOTICES.md.',
    '',
    `${libraries.length} libraries.`,
    ...(skipped.length > 0 ? ['', `Not built, so not listed: ${skipped.join(', ')}.`] : []),
    '',
  ]
  for (const lib of libraries) {
    out.push(RULE, `${lib.name} ${lib.version}`, `Licence: ${lib.licence ?? 'not declared'}`)
    out.push(
      `In: ${lib.bundles.join('; ')}`,
      `From: https://www.npmjs.com/package/${lib.name}/v/${lib.version}`,
      '',
    )
    const files = licenceFiles(lib.dir)
    if (files.length === 0) {
      out.push(
        `This package ships no licence file. Its package.json declares "${lib.licence ?? 'no licence'}".`,
        '',
      )
    }
    for (const [file, text] of files) {
      if (files.length > 1) out.push(`[${file}]`, '')
      out.push(text, '')
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

export function main(argv) {
  const at = argv.indexOf('--out')
  const out =
    at >= 0 && argv[at + 1] ? resolve(argv[at + 1]) : join(PKG_DIR, 'dist', 'THIRD_PARTY_LICENSES.txt')
  try {
    const collected = collect()
    writeFileSync(out, render(collected))
    for (const bundle of collected.skipped) {
      process.stderr.write(`third-party-licenses: ${bundle} is not built; its libraries are not listed\n`)
    }
    process.stdout.write(`third-party-licenses: ${collected.libraries.length} libraries → ${out}\n`)
    return 0
  } catch (e) {
    process.stderr.write(`third-party-licenses: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
