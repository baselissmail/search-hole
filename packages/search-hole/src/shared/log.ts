// SPDX-License-Identifier: Apache-2.0
/**
 * Logging (ADR-0007 point 4, ADR-0015 point 4). pino writes JSON lines to **stderr**
 * (fd 2): stdout belongs to the MCP stdio protocol and must never carry a log line.
 *
 * Nothing secret reaches the output. Two layers apply:
 * 1. pino `redact` paths for the well-known fields (`apiKey`, `authorization`,
 *    `x-subscription-token`, `x-api-key`, `token`, ...), at the top level and up to two
 *    levels deep;
 * 2. a sanitiser on every log call that redacts any field *named like* a secret
 *    (`BRAVE_API_KEY`, `accessToken`, ...), URL query parameters named like secrets,
 *    credentials in URL userinfo, anything the query-hygiene detectors recognise
 *    (`sk-...`, `ghp_...`, JWTs, PEM blocks, ...), and every key value this process has
 *    resolved or stored (`keys/known-secrets.ts`), whatever its format. Errors are
 *    flattened with their message and stack redacted.
 *
 * Level comes from `SEARCHHOLE_LOG` (trace, debug, info, warn, error, fatal, silent);
 * the default is `warn`.
 */

import pino from 'pino'
import { RE2JS } from 're2js'
import { looksLikeSecretFieldName, REDACTED, redact } from '../core/hygiene.ts'
import { redactKnownSecrets } from './keys/known-secrets.ts'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'
export type Logger = pino.Logger

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']
export const DEFAULT_LOG_LEVEL: LogLevel = 'warn'

/** Reads `SEARCHHOLE_LOG`; unknown or empty values give the default. */
export function logLevelFromEnv(env: Readonly<Record<string, string | undefined>>): LogLevel {
  const raw = env.SEARCHHOLE_LOG?.trim().toLowerCase()
  return LEVELS.find((l) => l === raw) ?? DEFAULT_LOG_LEVEL
}

const SECRET_FIELD_NAMES = [
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'accessToken',
  'access_token',
  'secret',
  'password',
  'authorization',
  'Authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-subscription-token',
  'X-Subscription-Token',
  'x-api-key',
  'X-API-Key',
] as const

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** pino `redact.paths`: each well-known name at depth 0, 1 and 2. */
export const REDACT_PATHS: readonly string[] = SECRET_FIELD_NAMES.flatMap((name) => {
  const leaf = IDENTIFIER.test(name) ? `.${name}` : `["${name}"]`
  const top = IDENTIFIER.test(name) ? name : `["${name}"]`
  return [top, `*${leaf}`, `*.*${leaf}`]
})

const ALWAYS_SECRET_FIELDS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])

/** True when a log field name must have its value redacted. */
export function isSecretLogField(name: string): boolean {
  return ALWAYS_SECRET_FIELDS.has(name.toLowerCase()) || looksLikeSecretFieldName(name)
}

const QUERY_SECRET = RE2JS.compile(
  String.raw`([?&;])((?:api[_\-]?key|apikey|key|token|access[_\-]?token|auth[_\-]?token|auth|authorization|secret|client[_\-]?secret|password|passwd|pwd|sig|signature|subscription[_\-]?key|x[_\-]api[_\-]key))=([^&#\s"'<>]+)`,
  RE2JS.CASE_INSENSITIVE,
)
const USERINFO_PASSWORD = RE2JS.compile(String.raw`(://[^\s/:@]*:)[^\s/@]+@`)

/** Redacts secret-named URL query parameters and `user:password@` userinfo in a string. */
export function redactUrlSecrets(s: string): string {
  const withQuery = QUERY_SECRET.matcher(s).replaceAll(`$1$2=${REDACTED}`)
  return USERINFO_PASSWORD.matcher(withQuery).replaceAll(`$1${REDACTED}@`)
}

/**
 * Redacts one string for logging: secrets this process has handled, then URL secrets,
 * then the hygiene secret detectors.
 */
export function redactLogString(s: string): string {
  return redact(redactUrlSecrets(redactKnownSecrets(s)))
}

const MAX_DEPTH = 6
const MAX_ITEMS = 200

/**
 * Returns a copy of `value` that is safe to write to a log: secret-named fields replaced,
 * strings redacted, errors flattened, cycles and deep nesting cut off.
 */
export function sanitizeLogValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactLogString(value)
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean')
    return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return undefined
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[truncated]'
  seen.add(value)
  if (value instanceof Error) {
    const out: Record<string, unknown> = { type: value.name, message: redactLogString(value.message) }
    if (value.stack !== undefined) out.stack = redactLogString(value.stack)
    if ('code' in value && typeof value.code === 'string') out.code = value.code
    if (value.cause !== undefined) out.cause = sanitizeLogValue(value.cause, depth + 1, seen)
    return out
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof URL) return redactLogString(value.href)
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitizeLogValue(v, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value).slice(0, MAX_ITEMS)) {
    out[k] =
      isSecretLogField(k) && v !== undefined && v !== null && v !== ''
        ? REDACTED
        : sanitizeLogValue(v, depth + 1, seen)
  }
  return out
}

export interface LoggerOptions {
  env?: Readonly<Record<string, string | undefined>>
  /** Defaults to fd 2 (stderr). Tests pass a capturing stream. */
  destination?: pino.DestinationStream
  /** Extra fields on every line, e.g. `{ host: 'claude-code' }`. */
  bindings?: Record<string, unknown>
  level?: LogLevel
}

/**
 * Creates the process logger: JSON lines on stderr, level from `SEARCHHOLE_LOG`, with
 * secrets redacted as described in the file header. Never writes to stdout.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const destination = opts.destination ?? pino.destination({ fd: 2, sync: true })
  return pino(
    {
      level: opts.level ?? logLevelFromEnv(opts.env ?? {}),
      base: {
        pid: process.pid,
        ...(opts.bindings === undefined ? {} : (sanitizeLogValue(opts.bindings) as object)),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACT_PATHS], censor: REDACTED },
      // Errors are already flattened and redacted by `sanitizeLogValue`.
      serializers: { err: (e: unknown) => e },
      hooks: {
        logMethod(args, method) {
          const [first, ...rest] = args
          // `logger.error(err)` becomes `{ err }` with the message as the log message.
          const clean =
            first instanceof Error
              ? [
                  { err: sanitizeLogValue(first) },
                  redactLogString(first.message),
                  ...rest.map((a) => sanitizeLogValue(a)),
                ]
              : args.map((a) => sanitizeLogValue(a))
          // pino's overloads are not expressible for a mapped tuple; the shape is unchanged.
          method.apply(this, clean as Parameters<typeof method>)
        },
      },
    },
    destination,
  )
}
