#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Runs the Claude Code SessionStart preflight hook the way Windows runs a shell-form hook
 * (ADR-0014 "validate": Git Bash, and PowerShell when Git Bash is absent), with node on PATH and
 * with node removed from PATH:
 *
 *   node .github/scripts/check-preflight-windows.mjs [assembled-plugin-dir]
 *
 * Expected: no output when node is found; one {"systemMessage": "...node was not found..."} line
 * when it is not; exit code 0 every time. The POSIX shells are covered by
 * packages/search-hole/test/plugin/preflight.test.ts, so this script only runs on Windows.
 * It also reports, without failing, what happens under the `Restricted` execution policy that
 * Windows client editions use by default (the hook then cannot dot-source the file).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  process.stdout.write('check-preflight-windows: skipped (Windows only; POSIX shells are unit-tested)\n')
  process.exit(0)
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const plugin = resolve(process.argv[2] ?? join(REPO, 'distribution', 'marketplace', 'search-hole'))
const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'))
const hook = hooks.hooks.SessionStart.flatMap((m) => m.hooks).find((h) => h.type === 'command')
if (!hook) throw new Error('no command-type SessionStart hook in hooks.json')
// Claude Code substitutes the placeholder with the plugin's native path before running the shell.
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${CLAUDE_PLUGIN_ROOT} placeholder
const command = hook.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin)

const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
const fullPath = process.env[pathKey] ?? ''
const hasNode = (dir) => ['node.exe', 'node.cmd', 'node.bat', 'node'].some((n) => existsSync(join(dir, n)))
const noNodePath = fullPath
  .split(';')
  .filter((d) => d && !hasNode(d))
  .join(';')

const env = (path) => {
  const out = { ...process.env, CLAUDE_PLUGIN_ROOT: plugin }
  for (const k of Object.keys(out)) if (k.toLowerCase() === 'path') delete out[k]
  out.PATH = path
  return out
}

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(
  (p) => existsSync(p),
)

const MISSING = /"systemMessage":"search-hole needs Node\.js 22\.13 or newer, but node was not found/
const psArgs = ['-NoProfile', '-NonInteractive', '-Command', command]
const bashArgs = ['-c', command]
const cases = [
  { name: 'PowerShell, node on PATH', exe: powershell, args: psArgs, path: fullPath, expect: 'silent' },
  { name: 'PowerShell, node missing', exe: powershell, args: psArgs, path: noNodePath, expect: 'message' },
  ...(gitBash
    ? [
        { name: 'Git Bash, node on PATH', exe: gitBash, args: bashArgs, path: fullPath, expect: 'silent' },
        { name: 'Git Bash, node missing', exe: gitBash, args: bashArgs, path: noNodePath, expect: 'message' },
      ]
    : []),
  {
    name: 'PowerShell, Restricted policy (informational)',
    exe: powershell,
    args: ['-ExecutionPolicy', 'Restricted', ...psArgs],
    path: noNodePath,
    expect: 'info',
  },
]

process.stdout.write(`hook command: ${command}\n`)
let failures = 0
for (const c of cases) {
  const started = Date.now()
  const r = spawnSync(c.exe, c.args, {
    env: env(c.path),
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  const ms = Date.now() - started
  const out = (r.stdout ?? '').trim()
  let ok
  if (c.expect === 'silent') ok = r.status === 0 && out === ''
  else if (c.expect === 'message') {
    let parsed = false
    try {
      parsed = typeof JSON.parse(out.split(/\r?\n/).pop() ?? '').systemMessage === 'string'
    } catch {
      parsed = false
    }
    ok = r.status === 0 && MISSING.test(out) && parsed
  } else ok = true
  const tag = c.expect === 'info' ? 'info' : ok ? 'ok  ' : 'FAIL'
  process.stdout.write(`${tag} ${c.name} (exit ${r.status}, ${ms} ms)\n`)
  if (!ok || c.expect === 'info') {
    if (out) process.stdout.write(`     stdout: ${out}\n`)
    const stderr = r.stderr?.trim().split(/\r?\n/).slice(0, 4).join('\n             ')
    if (stderr) process.stdout.write(`     stderr: ${stderr}\n`)
    if (r.error) process.stdout.write(`     error: ${r.error.message}\n`)
  }
  if (!ok) failures++
}
if (!gitBash) process.stdout.write('note: Git Bash not found; only PowerShell was checked\n')
process.exitCode = failures > 0 ? 1 : 0
