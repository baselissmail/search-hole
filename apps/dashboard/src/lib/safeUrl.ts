// SPDX-License-Identifier: Apache-2.0
/**
 * Result URLs come from the web and are untrusted (§12.4). Only an absolute http(s) URL becomes
 * a link; `javascript:`, `data:` and everything else stay plain text.
 */

/** The normalised href for a safe link, or null when the value must render as text only. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.href
}

/** Attributes for every outbound link: a new tab, no opener, no referrer, no endorsement. */
export const EXTERNAL_LINK = {
  target: '_blank',
  rel: 'noopener noreferrer nofollow',
} as const
