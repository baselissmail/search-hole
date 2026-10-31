// SPDX-License-Identifier: Apache-2.0
/**
 * The apps `searchhole setup` knows, as a tiny module: argument parsing loads it on every CLI
 * start, while the setup engine itself (setup.ts) loads only when `setup` runs.
 */
export const SETUP_CLIENT_IDS = [
  'vscode',
  'cursor',
  'windsurf',
  'zed',
  'goose',
  'codex',
  'claude-desktop',
  'generic',
] as const

export type SetupClient = (typeof SETUP_CLIENT_IDS)[number]

export function isSetupClient(value: string): value is SetupClient {
  return (SETUP_CLIENT_IDS as readonly string[]).includes(value)
}
