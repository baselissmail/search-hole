// SPDX-License-Identifier: Apache-2.0
/** Text helpers for dense data: middle truncation keeps both ends of URLs and domains. */

const ELLIPSIS = '…'

/**
 * Shorten `text` to at most `max` code points by replacing its middle with an ellipsis. Works on
 * code points, so emoji and other astral characters are never split.
 */
export function middleTruncate(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max <= 1) return max === 1 ? ELLIPSIS : ''
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return chars.slice(0, head).join('') + ELLIPSIS + (tail > 0 ? chars.slice(-tail).join('') : '')
}

/** A URL as shown in tables: `https://` is implied; any other scheme stays visible. */
export function displayUrl(url: string): string {
  return url.startsWith('https://') ? url.slice('https://'.length) : url
}
