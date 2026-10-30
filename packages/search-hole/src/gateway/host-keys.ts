// SPDX-License-Identifier: Apache-2.0
/**
 * Vendor `_meta` keys the gateway reads per request (ADR-0005). Adding a host is one row.
 * Values are self-reported by the host: they are grouping keys, never trust decisions.
 */

/** Conversation keys hosts put in request `_meta`, in precedence order. */
export const SESSION_META_KEYS: readonly { key: string; host: string }[] = [
  { key: 'openai/session', host: 'chatgpt' },
  { key: 'vscode.conversationId', host: 'vscode' },
  { key: 'agent-session-id', host: 'goose' },
]

/** Claude Code's transcript `tool_use` id on every `tools/call` (spikes §1). */
export const TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'

/** Codex sandbox state; `sandboxCwd` is the project directory (ADR-0005). */
export const CODEX_SANDBOX_META_KEY = 'codex/sandbox-state'

/** Goose working directory (ADR-0005). */
export const GOOSE_WORKING_DIR_META_KEY = 'agent-working-dir'

/** Longest vendor value we accept as a key; longer values are ignored as malformed. */
export const MAX_META_KEY_LENGTH = 512

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const usableString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' && v.length <= MAX_META_KEY_LENGTH ? v : undefined

/** The first host conversation key present in `_meta`, if any. */
export function sessionKeyFromMeta(meta: Readonly<Record<string, unknown>>): string | undefined {
  for (const row of SESSION_META_KEYS) {
    const v = usableString(meta[row.key])
    if (v !== undefined) return v
  }
  return undefined
}

/** Claude Code's `claudecode/toolUseId`, if present. */
export function toolUseIdFromMeta(meta: Readonly<Record<string, unknown>>): string | undefined {
  return usableString(meta[TOOL_USE_ID_META_KEY])
}

/** Project directory a host reports in `_meta` (Codex sandbox cwd, then Goose working dir). */
export function projectDirFromMeta(meta: Readonly<Record<string, unknown>>): string | undefined {
  const codex = meta[CODEX_SANDBOX_META_KEY]
  if (isRecord(codex)) {
    const cwd = usableString(codex.sandboxCwd)
    if (cwd !== undefined) return cwd
  }
  return usableString(meta[GOOSE_WORKING_DIR_META_KEY])
}
