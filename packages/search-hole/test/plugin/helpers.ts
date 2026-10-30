// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach } from 'vitest'

/** The repository root (four levels above test/plugin). */
export const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
/** The plugin sources (distribution/claude-plugin). */
export const PLUGIN_DIR = join(REPO_ROOT, 'distribution', 'claude-plugin')
/** The local marketplace (distribution/marketplace). */
export const MARKETPLACE_DIR = join(REPO_ROOT, 'distribution', 'marketplace')
/** scripts/build-plugin.mjs. */
export const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-plugin.mjs')

/** The MCP server name hooks use for our plugin-bundled server (ADR-0014). */
export const HOOK_SERVER = 'plugin:search-hole:search-hole'
/** The app-only hook tool the gateway registers (ADR-0014 point 0). */
export const HOOK_TOOL = 'hook'

/** Reads a UTF-8 file. */
export function readText(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8')
}

/** Reads and parses a JSON file; the result is `unknown` and must be validated by the caller. */
export function readJson(...parts: string[]): unknown {
  return JSON.parse(readText(...parts))
}

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.()
    } catch {
      // Best effort.
    }
  }
})

/** A fresh temp directory under os.tmpdir() (with a space in its name), removed after the test. */
export function tempDir(prefix = 'searchhole plugin '): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
