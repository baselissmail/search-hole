// SPDX-License-Identifier: Apache-2.0
import { SearchHoleError } from '../errors.ts'
import { registerSecret } from './known-secrets.ts'

const hasControlChar = (s: string): boolean =>
  [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
const hasWhitespace = (s: string): boolean => [...s].some((ch) => ch.trim() === '')

/** True for a value that may be used as a key: non-empty and free of control characters. */
export function isUsableKey(key: string): boolean {
  return key.length > 0 && !hasControlChar(key)
}

/**
 * Trims a key and checks it can be stored. Throws `invalid_argument` without echoing the
 * key. `strictQuoting` is for `security -i`, which parses its input line: whitespace, `"`
 * and `\` are rejected (ADR-0007 point 2).
 */
export function normalizeKeyForStorage(key: string, opts: { strictQuoting?: boolean } = {}): string {
  const trimmed = key.trim()
  if (trimmed === '')
    throw new SearchHoleError('invalid_argument', 'The key is empty.', { fix: 'Paste the API key.' })
  if (hasControlChar(trimmed)) {
    throw new SearchHoleError(
      'invalid_argument',
      'The key contains control characters (a stray newline or tab?).',
      {
        fix: 'Copy the key again without surrounding text.',
      },
    )
  }
  if (
    opts.strictQuoting === true &&
    (hasWhitespace(trimmed) || trimmed.includes('"') || trimmed.includes('\\'))
  ) {
    throw new SearchHoleError(
      'invalid_argument',
      'The key contains a space, a double quote or a backslash, which the macOS Keychain helper cannot store safely.',
      {
        fix: 'Check the key was copied whole, or provide it through an environment variable or a *_FILE variable.',
      },
    )
  }
  registerSecret(trimmed)
  return trimmed
}

/** Replaces every occurrence of `secret` in `text` (for error output that might echo it). */
export function scrub(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('[redacted]')
}

/** A store failure with a non-secret reason. */
export function unavailable(label: string, reason: string, fix?: string): SearchHoleError {
  return new SearchHoleError('store_unavailable', `${label}: ${reason}`, fix === undefined ? {} : { fix })
}
