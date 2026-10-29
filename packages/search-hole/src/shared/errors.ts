// SPDX-License-Identifier: Apache-2.0
/**
 * Typed errors with codes and user-facing explanations (§12.2). Explanations are
 * data, in the spirit of smart-doctor's ranked causes: `why` says what happened,
 * `fix` says what the user can do next.
 */

export type ErrorCode =
  | 'config_invalid'
  | 'rules_invalid'
  | 'secret_in_config'
  | 'no_healthy_engine'
  | 'engine_failed'
  | 'query_blocked'
  | 'fetch_blocked'
  | 'fetch_failed'
  | 'store_unavailable'
  | 'schema_newer'
  | 'invalid_argument'
  | 'config_locked'
  | 'internal'

export class SearchHoleError extends Error {
  readonly code: ErrorCode
  readonly why: string
  readonly fix: string | undefined
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: ErrorCode,
    why: string,
    opts: { fix?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(why, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'SearchHoleError'
    this.code = code
    this.why = why
    this.fix = opts.fix
    this.details = opts.details
  }

  /** One line suitable for a tool error or a CLI message. */
  toUserText(): string {
    return this.fix ? `${this.why} → ${this.fix}` : this.why
  }
}

export const isSearchHoleError = (e: unknown): e is SearchHoleError => e instanceof SearchHoleError
