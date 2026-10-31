#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * CycloneDX SBOM for what the npm package `search-hole` ships (ADR-0002: one bundle, no runtime
 * node_modules). Run after the builds:
 *
 *   node scripts/sbom.mjs [--out <file>]
 *
 * The package declares no runtime dependencies, because tsdown inlines them. A plain lockfile SBOM
 * would list the dev toolchain (vitest, typescript, tsdown...) and miss what is actually inside
 * dist/. So this script:
 *   1. asks pnpm (`pnpm sbom`, CycloneDX 1.6) for the components, licences and tarball hashes of
 *      packages/search-hole (all dependencies) and of the two UI apps (production dependencies);
 *   2. keeps, for the CLI and gateway bundle, exactly the packages named in dist/*.mjs.map sources
 *      (tsdown writes the pnpm store path of every inlined module);
 *   3. keeps, for dist/ui (dashboard) and dist/panel (receipt panel), each app's production
 *      dependency closure. Vite builds them without source maps, so this may list a package that
 *      tree-shaking dropped; it never misses one.
 * Each component carries a `search-hole:bundled-in` property naming the bundle it ships in.
 *
 * Default output: distribution/out/search-hole-<version>.cdx.json. SOURCE_DATE_EPOCH, when set,
 * fixes the timestamp. Needs pnpm on PATH (or npm_execpath, as `pnpm sbom` scripts set it).
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = join(REPO, 'packages', 'search-hole')
const SPEC = '1.6'

const BUNDLES = {
  cli: 'dist/searchhole.mjs and chunks (CLI, MCP gateway, dashboard server)',
  dashboard: 'dist/ui (dashboard, from apps/dashboard)',
  panel: 'dist/panel/receipt.html (receipt panel, from apps/receipt-app)',
}

/** `@scope/name` or `name` for a CycloneDX component. */
const fullName = (c) => (c.group ? `${c.group}/${c.name}` : c.name)
const key = (name, version) => `${name}@${version}`

/** Runs `pnpm sbom` for one workspace package and returns the parsed BOM. */
function pnpmSbom(filter, prodOnly) {
  const pnpm =
    process.env.npm_execpath && existsSync(process.env.npm_execpath) ? process.env.npm_execpath : 'pnpm'
  const args = [
    'sbom',
    '--sbom-format',
    'cyclonedx',
    '--sbom-spec-version',
    SPEC,
    '--sbom-type',
    'application',
    ...(prodOnly ? ['--prod'] : []),
    '--filter',
    filter,
  ]
  // npm_execpath may be a JS entry (npm-installed pnpm); run it with this Node then.
  const [cmd, cmdArgs] =
    pnpm.endsWith('.js') || pnpm.endsWith('.cjs') ? [process.execPath, [pnpm, ...args]] : [pnpm, args]
  const res = spawnSync(cmd, cmdArgs, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // A pnpm.cmd shim on Windows needs a shell; the arguments contain no spaces or metacharacters.
    shell: process.platform === 'win32' && !/\.exe$/i.test(cmd) && cmd !== process.execPath,
  })
  if (res.error) throw new Error(`could not run pnpm sbom (${res.error.message}). Is pnpm on PATH?`)
  if (res.status !== 0) throw new Error(`pnpm sbom --filter ${filter} failed:\n${res.stderr}`)
  return JSON.parse(res.stdout)
}

/**
 * Package name@version pairs inlined into the tsdown bundle, read from its source maps.
 * A source like `../../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core.js` is resolved
 * against the map's folder, and the package's own package.json gives the name and version.
 * @returns {Map<string, { name: string, version: string, license?: string, dir: string }>}
 */
export function bundledFromSourceMaps(distDir) {
  const maps = readdirSync(distDir).filter((n) => n.endsWith('.mjs.map'))
  if (maps.length === 0) {
    throw new Error(
      `no source maps in ${distDir}; the SBOM needs them (tsdown sourcemap: true). Build first.`,
    )
  }
  const found = new Map()
  const seenDirs = new Set()
  for (const file of maps) {
    const { sources = [] } = JSON.parse(readFileSync(join(distDir, file), 'utf8'))
    for (const source of sources) {
      const marker = source.lastIndexOf('node_modules/')
      if (marker < 0) continue
      const rest = source.slice(marker + 'node_modules/'.length).split('/')
      const nameParts = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1)
      const dir = resolve(distDir, source.slice(0, marker), 'node_modules', ...nameParts)
      if (seenDirs.has(dir)) continue
      seenDirs.add(dir)
      const manifest = join(dir, 'package.json')
      if (!existsSync(manifest))
        throw new Error(`source map names ${relative(REPO, dir)}, which is not installed`)
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const license = typeof pkg.license === 'string' ? pkg.license : undefined
      found.set(key(pkg.name, pkg.version), { name: pkg.name, version: pkg.version, license, dir })
    }
  }
  return found
}

/** A copy of a pnpm component without pnpm's dev/prod flags, tagged with the bundle it ships in. */
function shipped(component, bundles) {
  const { properties = [], ...rest } = component
  const kept = properties.filter((p) => !p.name.startsWith('cdx:npm:package:development'))
  return {
    ...rest,
    properties: [...kept, ...bundles.map((b) => ({ name: 'search-hole:bundled-in', value: BUNDLES[b] }))],
  }
}

/** A minimal component for a bundled package that pnpm's SBOM did not list. */
function minimalComponent({ name, version, license }) {
  const scoped = name.startsWith('@')
  const purl = `pkg:npm/${scoped ? `%40${name.slice(1)}` : name}@${version}`
  return {
    type: 'library',
    ...(scoped ? { group: name.split('/')[0], name: name.split('/')[1] } : { name }),
    version,
    purl,
    'bom-ref': purl,
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
  }
}

/** Builds the SBOM object. Exported for tests and dry runs. */
export function buildSbom({ pkgBom, dashBom, panelBom, bundled, version, timestamp }) {
  const components = new Map()
  const tag = (ref, component, bundle) => {
    const prev = components.get(ref)
    components.set(ref, { component, bundles: prev ? [...new Set([...prev.bundles, bundle])] : [bundle] })
  }

  const byKey = new Map(pkgBom.components.map((c) => [key(fullName(c), c.version), c]))
  const unlisted = []
  for (const [k, info] of bundled) {
    const c = byKey.get(k)
    if (c) tag(c['bom-ref'], c, 'cli')
    else {
      const m = minimalComponent(info)
      unlisted.push(k)
      tag(m['bom-ref'], m, 'cli')
    }
  }
  for (const [bom, bundle] of [
    [dashBom, 'dashboard'],
    [panelBom, 'panel'],
  ]) {
    for (const c of bom.components) {
      if (fullName(c).startsWith('@search-hole/')) continue
      tag(c['bom-ref'], c, bundle)
    }
  }

  const rootRef = `pkg:npm/search-hole@${version}`
  const kept = new Set(components.keys())
  const deps = new Map()
  for (const bom of [pkgBom, dashBom, panelBom]) {
    for (const d of bom.dependencies ?? []) {
      if (!kept.has(d.ref)) continue
      const set = deps.get(d.ref) ?? new Set()
      for (const on of d.dependsOn ?? []) if (kept.has(on)) set.add(on)
      deps.set(d.ref, set)
    }
  }
  // The root depends on what each bundle pulls in directly.
  const direct = new Set()
  const pkgRoot = pkgBom.dependencies?.find((d) => d.ref === pkgBom.metadata?.component?.['bom-ref'])
  for (const on of pkgRoot?.dependsOn ?? []) if (kept.has(on)) direct.add(on)
  for (const bom of [dashBom, panelBom]) {
    const root = bom.dependencies?.find((d) => d.ref === bom.metadata?.component?.['bom-ref'])
    for (const on of root?.dependsOn ?? []) if (kept.has(on)) direct.add(on)
  }
  // Bundled packages pnpm did not place in the graph still hang off the root.
  for (const ref of kept) {
    const isDep = [...deps.values()].some((s) => s.has(ref))
    if (!isDep) direct.add(ref)
  }

  const pnpmTool = pkgBom.metadata?.tools?.components?.find((t) => t.name === 'pnpm')
  const sortedRefs = [...components.keys()].sort()
  return {
    bom: {
      $schema: `http://cyclonedx.org/schema/bom-${SPEC}.schema.json`,
      bomFormat: 'CycloneDX',
      specVersion: SPEC,
      serialNumber: `urn:uuid:${randomUUID()}`,
      version: 1,
      metadata: {
        timestamp,
        lifecycles: [{ phase: 'build' }],
        tools: {
          components: [
            ...(pnpmTool ? [pnpmTool] : []),
            { type: 'application', name: 'search-hole scripts/sbom.mjs', version },
          ],
        },
        component: {
          type: 'application',
          name: 'search-hole',
          version,
          purl: rootRef,
          'bom-ref': rootRef,
          description: pkgBom.metadata?.component?.description,
          licenses: [{ license: { id: 'Apache-2.0' } }],
          externalReferences: [
            { type: 'vcs', url: 'https://github.com/baselissmail/search-hole' },
            { type: 'distribution', url: `https://www.npmjs.com/package/search-hole/v/${version}` },
          ],
        },
        properties: [
          {
            name: 'search-hole:scope',
            value:
              'Components inlined into the published npm package; the package has no runtime dependencies to install.',
          },
        ],
      },
      components: sortedRefs.map((ref) => {
        const { component, bundles } = components.get(ref)
        return shipped(component, bundles)
      }),
      dependencies: [
        { ref: rootRef, dependsOn: [...direct].sort() },
        ...sortedRefs.map((ref) => ({ ref, dependsOn: [...(deps.get(ref) ?? [])].sort() })),
      ],
    },
    unlisted,
  }
}

function parseArgs(argv) {
  const opts = { out: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const v = argv[++i]
      if (!v) throw new Error('--out needs a file')
      opts.out = resolve(v)
    } else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  return opts
}

export function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`${e.message}\nUsage: node scripts/sbom.mjs [--out <file>]\n`)
    return 2
  }
  if (opts.help) {
    process.stdout.write('Usage: node scripts/sbom.mjs [--out <file>]\n')
    return 0
  }
  try {
    const { version } = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
    const bundled = bundledFromSourceMaps(join(PKG_DIR, 'dist'))
    for (const required of ['dist/ui/index.html', 'dist/panel/receipt.html']) {
      if (!existsSync(join(PKG_DIR, required)))
        throw new Error(`${required} is missing; build the UI apps first`)
    }
    const epoch = Number(process.env.SOURCE_DATE_EPOCH)
    const timestamp = (
      Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date()
    ).toISOString()
    const { bom, unlisted } = buildSbom({
      pkgBom: pnpmSbom('search-hole', false),
      dashBom: pnpmSbom('@search-hole/dashboard', true),
      panelBom: pnpmSbom('@search-hole/receipt-app', true),
      bundled,
      version,
      timestamp,
    })
    const out = opts.out ?? join(REPO, 'distribution', 'out', `search-hole-${version}.cdx.json`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`)

    const count = (b) => bom.components.filter((c) => c.properties.some((p) => p.value === BUNDLES[b])).length
    const noLicence = bom.components.filter((c) => !c.licenses?.length).map(fullName)
    const shown = out.startsWith(REPO + sep) ? relative(REPO, out).split(sep).join('/') : out
    process.stdout.write(
      `sbom: ${shown}\n` +
        `  ${bom.components.length} components: ${count('cli')} in the CLI bundle, ${count('dashboard')} in the dashboard, ${count('panel')} in the receipt panel\n`,
    )
    if (unlisted.length > 0)
      process.stderr.write(`sbom: not in pnpm's SBOM, added from package.json: ${unlisted.join(', ')}\n`)
    if (noLicence.length > 0) process.stderr.write(`sbom: no licence declared: ${noLicence.join(', ')}\n`)
    return 0
  } catch (e) {
    process.stderr.write(`sbom: ${e.message}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
