// SPDX-License-Identifier: Apache-2.0
/**
 * `format: auto`: guesses a list's format from its first lines. Every rule-like
 * line votes for the formats whose syntax it uses; a header such as
 * `[Adblock Plus 2.0]` or uBlacklist front matter settles it. Ties go to the
 * more specific syntax (Goggles, uBlacklist, AdGuard, ABP, hosts, domains).
 * Text with no recognisable line is read as a domains list.
 */
import { isHostsLine } from './hosts.ts'
import type { ImportFormat } from './types.ts'

const SCAN_LINES = 2000
const SCAN_RULES = 500

const GOGGLES_OPTION = /\$(?:[^$]*,)?\s*(?:site=|boost\b|downrank\b|discard\b)/i
const GOGGLES_HEADER = /^!\s*(?:name|public|author|avatar|transferred_to)\s*:/i
const MATCH_PATTERN = /^@?\d*\s*(?:(?:\*|https?):\/\/\S|<all_urls>)/i
const ABP_RULE =
  /^(?:@@)?\|\|?|#@?[$%?]{0,2}#|\$@?\$|\$~?(?:important|badfilter|third-party|3p|1p|document|script|image|domain=|all)\b/i
const ADGUARD_ONLY = /\$(?:[^$]*,)?\s*(?:dnstype|client|ctag|dnsrewrite|denyallow)\b/i
const DOMAIN = /^(?:\*\.|\.)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)+\.?$/i
const SEARCHHOLE = /^version:\s*1\s*(?:#.*)?$/m

const ORDER: readonly ImportFormat[] = ['goggles', 'ublacklist', 'adguard', 'abp', 'hosts', 'domains']

export function detectFormat(text: string): ImportFormat {
  const head = text.slice(0, 256 * 1024).replace(/^\uFEFF/, '')
  if (SEARCHHOLE.test(head) && /^rules:\s*$/m.test(head)) return 'searchhole'
  const score: Record<ImportFormat, number> = {
    goggles: 0,
    ublacklist: 0,
    adguard: 0,
    abp: 0,
    hosts: 0,
    domains: 0,
    searchhole: 0,
  }
  let lines = 0
  let rules = 0
  let at = 0
  while (at < head.length && lines < SCAN_LINES && rules < SCAN_RULES) {
    let end = head.indexOf('\n', at)
    if (end === -1) end = head.length
    const t = head.slice(at, end).trim()
    at = end + 1
    lines++
    if (t === '') continue
    if (lines === 1 && t === '---') score.ublacklist += 1000
    if (/^\[adguard/i.test(t)) score.adguard += 1000
    else if (/^\[(?:adblock|ublock|abp)/i.test(t)) score.abp += 1000
    if (t.startsWith('!')) {
      if (GOGGLES_HEADER.test(t)) score.goggles += 1
      else score.abp += 0.1
      continue
    }
    if (t.startsWith('#') && !/^#@?[$%?]{0,2}#/.test(t)) continue
    rules++
    if (GOGGLES_OPTION.test(t)) score.goggles += 3
    if (MATCH_PATTERN.test(t)) score.ublacklist += 3
    if (ABP_RULE.test(t)) score.abp += 3
    if (ADGUARD_ONLY.test(t)) score.adguard += 3
    if (isHostsLine(t.replace(/#.*$/, '').trim())) score.hosts += 3
    if (DOMAIN.test(t.replace(/\s+#.*$/, ''))) score.domains += 2
    if (/^@?\d*\s*\/.+\/[a-z]*$/.test(t)) {
      score.ublacklist += 1
      score.abp += 1
    }
  }
  // AdGuard syntax is ABP plus DNS modifiers: one vote for either counts for the pair.
  if (score.adguard > 0 && score.abp > 0) {
    score.adguard += score.abp
    score.abp = 0
  }
  let best: ImportFormat = 'domains'
  let top = 0
  for (const f of ORDER) {
    if (score[f] > top) {
      top = score[f]
      best = f
    }
  }
  return best
}
