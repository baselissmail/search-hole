// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal colour. Colour is on only when the stream is a TTY, `NO_COLOR` is unset or
 * empty (https://no-color.org) and `TERM` is not `dumb`. Piped output is always plain.
 */

type Env = Readonly<Record<string, string | undefined>>

/** True when output to this stream may carry ANSI colour codes. */
export function colorEnabled(env: Env, isTTY: boolean): boolean {
  if (!isTTY) return false
  const noColor = env.NO_COLOR
  if (noColor !== undefined && noColor !== '') return false
  return env.TERM !== 'dumb'
}

/** Wraps text in styles; every function is the identity when colour is off. */
export interface Style {
  readonly enabled: boolean
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  cyan(text: string): string
}

const wrap =
  (enabled: boolean, open: number, close: number) =>
  (text: string): string =>
    enabled && text !== '' ? `\u001b[${open}m${text}\u001b[${close}m` : text

/** Builds the style helpers; pass `colorEnabled(...)` for `enabled`. */
export function createStyle(enabled: boolean): Style {
  return {
    enabled,
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
  }
}

/** A style that never emits escape codes. */
export const PLAIN: Style = createStyle(false)
