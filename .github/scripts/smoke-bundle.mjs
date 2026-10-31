#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for the built bundle on whatever runtime runs this file (Node 22.13, 24, 26, or Bun):
 *
 *   node .github/scripts/smoke-bundle.mjs [path/to/dist/searchhole.mjs]
 *
 * Uses a temporary SEARCHHOLE_HOME whose path contains spaces (paths like "personal dev" must
 * work everywhere) and checks, without any network:
 *   1. `version` prints the package version;
 *   2. `block example.com --yes` writes rules.yaml (atomic write and file lock);
 *   3. `explain https://example.com/x --json` says hidden (rules engine);
 *   4. `log --json` returns an array (node:sqlite opens and migrates the database);
 *   5. `mcp --host claude-desktop` answers initialize and tools/list over stdio (2025-era handshake).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bundle = resolve(process.argv[2] ?? join(REPO, 'packages', 'search-hole', 'dist', 'searchhole.mjs'))
const { version } = JSON.parse(readFileSync(join(REPO, 'packages', 'search-hole', 'package.json'), 'utf8'))
const home = mkdtempSync(join(tmpdir(), 'search hole smoke '))
const env = { ...process.env, SEARCHHOLE_HOME: home, SEARCHHOLE_LOG: 'silent', NO_COLOR: '1' }
const runtime = `${process.release?.name ?? 'node'} ${process.version}${process.versions.bun ? ` (bun ${process.versions.bun})` : ''}`

let failures = 0
function check(name, ok, detail = '') {
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n     ${detail.replace(/\n/g, '\n     ')}` : ''}\n`,
  )
  if (!ok) failures++
}

function cli(args) {
  return spawnSync(process.execPath, [bundle, ...args], { env, encoding: 'utf8', timeout: 30_000 })
}

/** Speaks newline-delimited JSON-RPC to `mcp`, resolving each request by id. */
async function mcpHandshake() {
  const child = spawn(process.execPath, [bundle, 'mcp', '--host', 'claude-desktop'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  child.stdout.on('data', (d) => {
    buffer += d
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        pending.get(msg.id)?.(msg)
      } catch {
        // not JSON-RPC; ignore
      }
    }
  })
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`)
  const request = (id, method, params) =>
    new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error(`${method}: no answer in 15 s. stderr:\n${stderr}`)),
        15_000,
      )
      pending.set(id, (msg) => {
        clearTimeout(timer)
        res(msg)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  try {
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'search-hole-ci-smoke', version },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await request(2, 'tools/list', {})
    return { init, list }
  } finally {
    child.stdin.end()
    const exited = new Promise((r) => child.once('exit', r))
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 5_000))
    if ((await Promise.race([exited, timeout])) === 'timeout') child.kill()
  }
}

process.stdout.write(`smoke: ${bundle}\n       on ${runtime}, SEARCHHOLE_HOME="${home}"\n`)
try {
  const v = cli(['version'])
  check(
    `version is ${version}`,
    v.status === 0 && v.stdout.trim() === version,
    `${v.status} ${v.stdout}${v.stderr}`,
  )

  const block = cli(['block', 'example.com', '--yes'])
  check('block example.com --yes', block.status === 0, `${block.status} ${block.stdout}${block.stderr}`)

  const explain = cli(['explain', 'https://example.com/x', '--json'])
  let decision
  try {
    decision = JSON.parse(explain.stdout).decision
  } catch {
    decision = undefined
  }
  check('explain says hidden', decision === 'hidden', `${explain.status} ${explain.stdout}${explain.stderr}`)

  const log = cli(['log', '--json'])
  let isArray = false
  try {
    isArray = Array.isArray(JSON.parse(log.stdout))
  } catch {
    isArray = false
  }
  check(
    'log --json opens the database',
    log.status === 0 && isArray,
    `${log.status} ${log.stdout}${log.stderr}`,
  )

  try {
    const { init, list } = await mcpHandshake()
    const info = init.result?.serverInfo
    check(
      'mcp initialize',
      info?.name === 'search-hole' && info?.version === version,
      JSON.stringify(init).slice(0, 400),
    )
    const names = new Set((list.result?.tools ?? []).map((t) => t.name))
    const want = ['search', 'fetch', 'receipt', 'suggest_rule']
    check(
      `mcp tools/list has ${want.join(', ')}`,
      want.every((n) => names.has(n)),
      [...names].join(', '),
    )
  } catch (e) {
    check('mcp handshake', false, e instanceof Error ? e.message : String(e))
  }
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

if (failures > 0) {
  process.stderr.write(`smoke: ${failures} check(s) failed\n`)
  process.exitCode = 1
} else process.stdout.write('smoke: all checks passed\n')
