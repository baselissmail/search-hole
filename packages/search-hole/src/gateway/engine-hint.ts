// SPDX-License-Identifier: Apache-2.0
/**
 * A cheap guess at "has the user set up a search engine?", made once when the gateway starts
 * so the server instructions can say which search to use (ADR-0012 amendment 2026-11-14).
 *
 * It reads the environment and a few file names, nothing else: no App, no database, no
 * keychain, no network, and it creates nothing (ADR-0013 point 3). It can be wrong both ways,
 * and both are harmless in Claude Code, the only profile that uses it:
 * - an engine it missed (a key kept only in the OS keychain): the WebSearch hook redirects the
 *   first web search to `search`, as it does in every session with a healthy engine;
 * - an engine that is set up but down: `search` answers "no healthy engine" and names the
 *   built-in search, as before.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CONVENTIONAL_KEY_ENV, hostKeyEnvName } from '../shared/keys/resolve.ts'
import { envValue } from '../shared/keys/unset.ts'
import { pathFor, resolveRoots, rootLayout } from '../shared/paths.ts'
import { ENGINE_ID_LIST } from '../shared/types.ts'

type Env = Readonly<Record<string, string | undefined>>

export interface EngineHintInput {
  env: Env
  home: string
  platform: NodeJS.Platform
  exists?: (path: string) => boolean
  read?: (path: string) => string
}

/** A settings file that configures an engine or forces engines mode. */
const SETTINGS_SIGNS = /^\s*(?:engines|searxng)\s*:|^\s*mode\s*:\s*["']?engines\b/m

/** True when an engine looks set up: a key in the environment or the key file, or a SearXNG config. */
export function engineLikelySetUp(o: EngineHintInput): boolean {
  const exists = o.exists ?? existsSync
  const read = o.read ?? ((path: string) => readFileSync(path, 'utf8'))
  if (envValue(o.env, 'SEARCHHOLE_MODE')?.toLowerCase() === 'engines') return true
  for (const engine of ENGINE_ID_LIST) {
    for (const name of [hostKeyEnvName(engine), ...CONVENTIONAL_KEY_ENV[engine]]) {
      if (envValue(o.env, name) !== undefined || envValue(o.env, `${name}_FILE`) !== undefined) return true
    }
  }
  // The platform's own path rules, as the roots are built with them.
  const { join } = pathFor(o.platform)
  try {
    const layout = rootLayout(
      resolveRoots({ env: o.env, platform: o.platform, homedir: o.home, exists }),
      o.platform,
    )
    if (exists(join(layout.searxng, 'settings.yml'))) return true
    for (const engine of ENGINE_ID_LIST) {
      if (exists(join(layout.secrets, `${engine}.key`)) || exists(join(layout.secrets, `${engine}.dpapi`)))
        return true
    }
    return exists(layout.settings) && SETTINGS_SIGNS.test(read(layout.settings))
  } catch {
    // No home folder, or an unreadable settings file: keep the wording that expects an engine.
    return true
  }
}
