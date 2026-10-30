// SPDX-License-Identifier: Apache-2.0
/**
 * CLI error presentation and exit codes.
 *
 * A `SearchHoleError` is printed as `error: why → fix` on stderr. It exits with 2 (the
 * user can act on it: a bad argument, a config problem, no engine) except `internal`,
 * which exits with 1 like any unexpected exception.
 */
import { isSearchHoleError } from '../shared/errors.ts'

/** Exit code for a thrown value: 2 for a user-facing error, 1 for anything internal. */
export function exitCodeFor(error: unknown): 1 | 2 {
  return isSearchHoleError(error) && error.code !== 'internal' ? 2 : 1
}

/** Removes anything that looks like a secret from an unexpected error's message. */
async function scrub(text: string): Promise<string> {
  try {
    const { redactLogString } = await import('../shared/log.ts')
    return redactLogString(text)
  } catch {
    return text
  }
}

/** The one-line stderr text for a thrown value (without the `error:` prefix). */
export async function describeError(error: unknown): Promise<string> {
  if (isSearchHoleError(error)) return error.toUserText()
  const message = error instanceof Error ? error.message : String(error)
  return `Unexpected failure: ${await scrub(message)} → Re-run with SEARCHHOLE_LOG=debug for detail, or run searchhole doctor.`
}

/** The stack of an unexpected error, redacted, for debug output; empty for user errors. */
export async function debugStack(error: unknown): Promise<string> {
  if (isSearchHoleError(error) || !(error instanceof Error) || error.stack === undefined) return ''
  return scrub(error.stack)
}
