// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of secret values this process has handled (resolved keys, keys being stored).
 * The logger redacts every registered value wherever it appears, which catches keys whose
 * format no detector knows (ADR-0007 point 4). Lives apart from log.ts so the resolver can
 * register without importing pino.
 */
const MIN_LENGTH = 8
const MAX_ENTRIES = 256
const registered = new Set<string>()

/** Remembers a secret (and its URL-encoded form) so logs never show it. Short values are ignored. */
export function registerSecret(value: string): void {
  const v = value.trim()
  if (v.length < MIN_LENGTH) return
  for (const form of new Set([v, encodeURIComponent(v)])) {
    if (registered.has(form)) continue
    if (registered.size >= MAX_ENTRIES) {
      const oldest = registered.values().next().value
      if (oldest !== undefined) registered.delete(oldest)
    }
    registered.add(form)
  }
}

/** Replaces every registered secret in `text` with `replacement`. */
export function redactKnownSecrets(text: string, replacement = '[redacted]'): string {
  let out = text
  for (const secret of registered) if (out.includes(secret)) out = out.split(secret).join(replacement)
  return out
}

/** Forgets all registered secrets (tests; a key was deleted). */
export function forgetSecrets(): void {
  registered.clear()
}
