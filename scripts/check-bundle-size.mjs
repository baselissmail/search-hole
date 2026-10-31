#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle-size budgets (MASTER_PLAN §12.3, ADR-0020, ADR-0021). Run after the builds:
 *
 *   node scripts/check-bundle-size.mjs [--allow-missing]
 *
 * Budgets, gzipped (zlib default level), 1 kB = 1,000 bytes as Vite reports it:
 *   - dashboard initial JS: the scripts and modulepreloads that apps/dashboard/dist/index.html loads  ≤ 250 kB
 *   - receipt panel: apps/receipt-app/dist/receipt.html, one self-contained file                     ≤ 80 kB
 *   - CLI startup: what every CLI and gateway start loads — the entry (dist/searchhole.mjs), the
 *     chunks it imports (statically, or dynamically from main()), and their static imports       ≤ 115 kB
 *     (0.3.0: the entry became a stub that loads the CLI from main(); the measure follows it)
 *   - CLI bundle: every .mjs in packages/search-hole/dist (no source maps, ui/ or panel/)             ≤ 1,330 kB
 * The CLI limits are about 15% over the v0.2.0 build (22.9 kB and 1,153 kB). They catch an accidental
 * new dependency or a chunk that stopped being lazy. Raise them in the same change that says why.
 *
 * Also printed, without a limit: dashboard CSS, the npm package's dist/ (source maps included)
 * and the newest .mcpb in distribution/out/.
 *
 * Exit codes: 0 within budget, 1 over budget, 2 a build output is missing (unless --allow-missing).
 * Writes a Markdown table to $GITHUB_STEP_SUMMARY when that is set (GitHub Actions).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KB = 1000

/** Budgets in bytes, gzipped. */
export const BUDGETS = {
  dashboardInitialJs: 250 * KB,
  receiptPanel: 80 * KB,
  cliStartup: 115 * KB,
  cliBundle: 1330 * KB,
}

const gz = (buf) => gzipSync(buf).length

const STATIC_IMPORT =
  /(?:^|[;\n])\s*(?:import|export)\s[^;]*?from\s*["'](\.\/[^"']+\.mjs)["']|(?:^|[;\n])\s*import\s*["'](\.\/[^"']+\.mjs)["']/g
const DYNAMIC_IMPORT = /import\(\s*["'](\.\/[^"']+\.mjs)["']\s*\)/g

/**
 * The files a plain start loads: the entry, every chunk it imports (its dynamic imports run in
 * main() on every start), and their static imports, transitively.
 */
export function startupFiles(entry) {
  const dir = dirname(entry)
  const seen = new Set([entry])
  const queue = []
  const add = (spec) => {
    const file = join(dir, spec)
    if (!seen.has(file) && existsSync(file)) {
      seen.add(file)
      queue.push(file)
    }
  }
  const entryText = readFileSync(entry, 'utf8')
  for (const m of entryText.matchAll(STATIC_IMPORT)) add(m[1] ?? m[2])
  for (const m of entryText.matchAll(DYNAMIC_IMPORT)) add(m[1])
  while (queue.length > 0) {
    const file = queue.shift()
    for (const m of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) add(m[1] ?? m[2])
  }
  return [...seen]
}

/** Raw and gzipped byte counts for a list of files. */
function measure(files) {
  let raw = 0
  let gzip = 0
  for (const f of files) {
    const buf = readFileSync(f)
    raw += buf.length
    gzip += gz(buf)
  }
  return { raw, gzip }
}

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * The JS files an HTML page loads before anything else: module scripts and modulepreload links
 * with a local `src`/`href`. Dynamic imports are not initial and are not counted.
 * @param {string} html
 * @returns {string[]} paths as written in the page, without a leading slash
 */
export function initialScripts(html) {
  const found = new Set()
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) found.add(m[1])
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\brel=["']modulepreload["']/i.test(tag)) continue
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)
    if (href) found.add(href[1])
  }
  return [...found].filter((p) => !/^[a-z]+:\/\//i.test(p)).map((p) => p.replace(/^\.?\//, ''))
}

/**
 * Measures the current build outputs under `repo`.
 * @returns {{ rows: Array<{ name: string, raw: number, gzip: number, limit?: number, missing?: string, zipped?: boolean }> }}
 */
export function collect(repo = REPO) {
  const rows = []
  const missing = (name, path, limit) => rows.push({ name, raw: 0, gzip: 0, limit, missing: path })

  const dash = join(repo, 'apps', 'dashboard', 'dist')
  const indexHtml = join(dash, 'index.html')
  if (existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, 'utf8')
    const scripts = initialScripts(html).map((p) => join(dash, p))
    const absent = scripts.filter((p) => !existsSync(p))
    if (scripts.length === 0 || absent.length > 0) {
      missing(
        'dashboard initial JS',
        absent[0] ?? `${indexHtml} (no module script)`,
        BUDGETS.dashboardInitialJs,
      )
    } else {
      rows.push({ name: 'dashboard initial JS', ...measure(scripts), limit: BUDGETS.dashboardInitialJs })
    }
    const css = walk(join(dash, 'assets')).filter((p) => p.endsWith('.css'))
    if (css.length > 0) rows.push({ name: 'dashboard CSS (info)', ...measure(css) })
  } else missing('dashboard initial JS', indexHtml, BUDGETS.dashboardInitialJs)

  const panel = join(repo, 'apps', 'receipt-app', 'dist', 'receipt.html')
  if (existsSync(panel))
    rows.push({ name: 'receipt panel', ...measure([panel]), limit: BUDGETS.receiptPanel })
  else missing('receipt panel', panel, BUDGETS.receiptPanel)

  const dist = join(repo, 'packages', 'search-hole', 'dist')
  const entry = join(dist, 'searchhole.mjs')
  if (existsSync(entry)) {
    const startup = startupFiles(entry)
    rows.push({
      name: `CLI startup (${startup.length} files)`,
      ...measure(startup),
      limit: BUDGETS.cliStartup,
    })
    const chunks = readdirSync(dist)
      .filter((n) => n.endsWith('.mjs'))
      .map((n) => join(dist, n))
    rows.push({
      name: `CLI bundle (${chunks.length} .mjs files)`,
      ...measure(chunks),
      limit: BUDGETS.cliBundle,
    })
    rows.push({ name: 'npm dist/ incl. maps (info)', ...measure(walk(dist)) })
  } else {
    missing('CLI startup', entry, BUDGETS.cliStartup)
    missing('CLI bundle', dist, BUDGETS.cliBundle)
  }

  const out = join(repo, 'distribution', 'out')
  if (existsSync(out)) {
    const mcpb = readdirSync(out)
      .filter((n) => n.endsWith('.mcpb'))
      .map((n) => join(out, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    if (mcpb) {
      const raw = statSync(mcpb).size
      rows.push({ name: `${relative(out, mcpb)} (info, a zip)`, raw, gzip: raw, zipped: true })
    }
  }
  return { rows }
}

const fmt = (bytes) => `${(bytes / KB).toFixed(1)} kB`

/** One status word per row. */
export function status(row) {
  if (row.missing) return 'MISSING'
  if (row.limit === undefined) return ''
  const pct = Math.round((row.gzip / row.limit) * 100)
  return row.gzip > row.limit ? `OVER (${pct}%)` : `ok (${pct}%)`
}

/** A plain-text table for the terminal. */
export function table(rows) {
  const header = ['Budget', 'Raw', 'Gzipped', 'Limit (gz)', 'Status']
  const body = rows.map((r) => [
    r.name,
    r.missing ? '-' : fmt(r.raw),
    r.missing || r.zipped ? '-' : fmt(r.gzip),
    r.limit === undefined ? '-' : fmt(r.limit),
    status(r),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)))
  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n')
}

function markdown(rows) {
  const lines = [
    '### Bundle sizes',
    '',
    '| Budget | Raw | Gzipped | Limit (gz) | Status |',
    '|---|--:|--:|--:|---|',
  ]
  for (const r of rows) {
    lines.push(
      `| ${r.name} | ${r.missing ? '-' : fmt(r.raw)} | ${r.missing || r.zipped ? '-' : fmt(r.gzip)} | ${
        r.limit === undefined ? '-' : fmt(r.limit)
      } | ${status(r)} |`,
    )
  }
  return `${lines.join('\n')}\n`
}

/** CLI entry point. Returns the exit code. */
export function main(argv, repo = REPO) {
  const unknown = argv.filter((a) => a !== '--allow-missing')
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown option: ${unknown[0]}\nUsage: node scripts/check-bundle-size.mjs [--allow-missing]\n`,
    )
    return 2
  }
  const allowMissing = argv.includes('--allow-missing')
  const { rows } = collect(repo)
  process.stdout.write(`${table(rows)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(rows))

  const over = rows.filter((r) => !r.missing && r.limit !== undefined && r.gzip > r.limit)
  const absent = rows.filter((r) => r.missing)
  for (const r of over) {
    process.stderr.write(
      `check-bundle-size: ${r.name} is ${fmt(r.gzip)} gzipped, over its ${fmt(r.limit)} budget.\n`,
    )
  }
  if (over.length > 0) return 1
  if (absent.length > 0 && !allowMissing) {
    for (const r of absent)
      process.stderr.write(`check-bundle-size: not built: ${relative(repo, r.missing)}\n`)
    process.stderr.write('Build first: node scripts/build-plugin.mjs (or pnpm -r build).\n')
    return 2
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
