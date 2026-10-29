// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers shared by the engine adapters: text hygiene for untrusted titles and snippets,
 * URL and hostname validation, secret redaction and tolerant JSON parsing. Pure.
 */

import type { AdapterCtx } from '../shared/types.ts'

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function codePointToString(cp: number): string {
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ''
  return String.fromCodePoint(cp)
}

/** Cuts to `max` characters without splitting a surrogate pair, adding an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  let end = Math.max(0, max - 1)
  const last = s.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${s.slice(0, end)}…`
}

/**
 * Normalises untrusted engine text: decodes the common HTML entities once, collapses
 * whitespace, and removes control and bidi-override characters. Markup is left as text
 * (consumers render it as text only). Non-strings give ''.
 */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== 'string') return ''
  const decoded = input.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g,
    (m, dec, hex, name) => {
      if (dec !== undefined) return codePointToString(Number(dec))
      if (hex !== undefined) return codePointToString(Number.parseInt(hex, 16))
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? m
    },
  )
  const collapsed = decoded.replace(/\s+/g, ' ')
  const stripped = collapsed.replace(/\p{Cc}/gu, '').replace(/[­​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
  return truncate(stripped.trim(), max)
}

/** Returns the trimmed URL when it is a plain http(s) URL with a host, else null. */
export function cleanUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s === '' || s.length > 2048 || /[\s\p{Cc}]/u.test(s)) return null
  try {
    const u = new URL(s)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.hostname === '') return null
    return s
  } catch {
    return null
  }
}

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Lower-cases, validates and de-duplicates hostnames, keeping first-seen order, up to `cap`.
 * Anything that is not a plain dotted hostname is dropped (it could carry syntax, such as
 * a newline or comma, into an inline goggle or a JSON body).
 */
export function normalizeHosts(hosts: readonly string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of hosts) {
    if (out.length >= cap) break
    const h = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
    if (!HOST_RE.test(h) || seen.has(h)) continue
    seen.add(h)
    out.push(h)
  }
  return out
}

/**
 * Removes secrets from text that may reach logs, errors or receipts: the exact keys in
 * play, `Bearer`/`Token` values, and long opaque tokens. Then cleans and truncates.
 */
export function redactDetail(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
  max = 200,
): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }
  out = out
    .replace(/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
  return cleanText(out, max)
}

/**
 * Removes the user's query from text that came from the server (some error pages echo the
 * request), so raw queries never reach run details, logs or receipts. Short queries are left.
 */
export function scrubQuery(text: string, query: string): string {
  const q = query.trim()
  return q.length >= 4 ? text.split(q).join('[query]') : text
}

/** The secrets an adapter must never echo: its API key. */
export function secretsOf(ctx: AdapterCtx): Array<string | null> {
  return [ctx.apiKey]
}

export type JsonResult = { ok: true; value: unknown } | { ok: false }

/** JSON.parse that never throws. */
export function parseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** A short, cleaned prefix of a response body for classification and error detail. */
export function bodySnippet(text: string, max = 400): string {
  return cleanText(text.slice(0, max * 3), max)
}

/** The primary language subtag (`en-US` → `en`), or null for `all` and malformed tags. */
export function primaryLanguage(tag: string): string | null {
  const t = tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return /^[a-z]{2,3}$/.test(t) ? t : null
}

/** True when the API key is usable as a header value (no whitespace or control characters). */
export function isHeaderSafeKey(key: string): boolean {
  return key.length >= 8 && key.length <= 512 && !/[\s\p{Cc}]/u.test(key)
}
