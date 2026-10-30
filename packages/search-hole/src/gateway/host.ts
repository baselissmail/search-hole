// SPDX-License-Identifier: Apache-2.0
/**
 * Host profile refinement at spawn (ADR-0012 "Host profiles"). `searchhole mcp --host <profile>`
 * sets the default; the environment refines it exactly once, so the tool list stays constant
 * for the life of the process.
 *
 * - `CLAUDECODE=1` means Claude Code launched us, unless Cursor markers are present: Cursor
 *   loads Claude marketplace plugins too. Claude Code (2.1.154+) also hands its MCP servers
 *   `CLAUDE_CODE_SESSION_ID`, which Cursor does not, so that variable wins over Cursor markers
 *   inherited from a Cursor terminal. The exact Cursor markers are a P2 host-matrix item.
 * - Nothing else is refined in v0.1 (the Desktop Code tab marker is a P2 spike).
 */
import type { HostProfile } from '../app/types.ts'

type Env = Readonly<Record<string, string | undefined>>

/** Env variables that mark a process spawned by Cursor (prefix match on `CURSOR_`). */
export const CURSOR_ENV_PREFIX = 'CURSOR_'

const set = (env: Env, name: string): boolean => {
  const v = env[name]
  return v !== undefined && v.trim() !== ''
}

/** True when any `CURSOR_*` variable is set to a non-empty value. */
export function hasCursorMarkers(env: Env): boolean {
  return Object.keys(env).some((k) => k.startsWith(CURSOR_ENV_PREFIX) && set(env, k))
}

export interface RefinedHost {
  host: HostProfile
  /** Why the profile changed, for the startup log line; absent when it did not. */
  reason?: 'claudecode_env' | 'cursor_markers'
}

/** Refines the `--host` default from the spawn environment (ADR-0012). Pure. */
export function refineHostProfile(requested: HostProfile, env: Env): RefinedHost {
  if (env.CLAUDECODE?.trim() !== '1') return { host: requested }
  const claudeSession = set(env, 'CLAUDE_CODE_SESSION_ID')
  if (!claudeSession && hasCursorMarkers(env)) {
    return requested === 'cursor' ? { host: requested } : { host: 'cursor', reason: 'cursor_markers' }
  }
  return requested === 'claude-code' ? { host: requested } : { host: 'claude-code', reason: 'claudecode_env' }
}
