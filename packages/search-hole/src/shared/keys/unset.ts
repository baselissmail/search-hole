// SPDX-License-Identifier: Apache-2.0

/** Matches an unsubstituted MCPB/plugin placeholder such as `${user_config.brave_api_key}` (ADR-0007). */
const PLACEHOLDER = /^\$\{[^}]+\}$/

/**
 * True when an environment value counts as unset: missing, empty or whitespace-only, or an
 * unset host placeholder. Desktop passes an optional `user_config` field the user left blank
 * as the literal `${user_config.<name>}` (ADR-0007), so every env read goes through this.
 */
export function isUnsetValue(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true
  const trimmed = value.trim()
  return trimmed === '' || PLACEHOLDER.test(trimmed)
}

/** The trimmed value, or undefined when it counts as unset. */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const raw = env[name]
  return isUnsetValue(raw) ? undefined : raw?.trim()
}
