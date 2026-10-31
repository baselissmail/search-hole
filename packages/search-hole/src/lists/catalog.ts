// SPDX-License-Identifier: Apache-2.0
/**
 * Catalog of third-party lists search-hole can subscribe to (MASTER_PLAN §6 "Seed lists",
 * Appendix B; ADR-0016 point 5; ADR-0017 point 7), and the manifest of the starter lists
 * vendored under `lists/vendor/`.
 *
 * Every entry was checked on 2026-10-31: the subscription URL answered 200, the rule count is
 * the non-comment, non-blank, non-frontmatter lines of that file, and `license` is the SPDX id
 * of the text in the repository's LICENSE file, read from the file itself, not from GitHub's
 * `spdx_id` (two repos report `NOASSERTION` for permissive texts). `NONE` means the repository
 * has no LICENSE file; `NOASSERTION` means the licence could not be pinned to one id.
 *
 * Not included: Kagi's leaderboard (no licence, no export). Brave's public Goggles have no
 * licence, so they appear only as link entries, never bundleable.
 *
 * Pure data: no I/O here. Vendored files are read by whoever bundles them.
 */
import type { ListKind, ListMode } from '../shared/types.ts'
import type { ListFormat } from './yaml.ts'

export interface CatalogList {
  /** Stable kebab-case id; also the vendored file name (`lists/vendor/<id>.txt`). */
  id: string
  name: string
  /** HTTPS URL of the raw list file to subscribe to. */
  url: string
  homepage: string
  format: ListFormat
  kind: ListKind
  /** SPDX id read from the LICENSE file; `NONE` or `NOASSERTION` when there is none to read. */
  license: string
  /** The LICENSE file, or null when the repository has none. */
  licenseUrl: string | null
  /** The licence permits shipping a copy with search-hole (CC0, Unlicense, MIT, BSD, Apache, WTF*). */
  bundleable: boolean
  /** ADR-0017 starter set: `enforce` or `audit`; everything else is `off` (offered, not enabled). */
  recommendedMode: ListMode | 'off'
  approxRules?: number
  notes: string
}

/** The date every entry below was last checked. */
export const CATALOG_VERIFIED_AT = '2026-10-31'

/** Licences whose text permits redistributing a list copy (ADR-0016 point 5). */
export const PERMISSIVE_LICENSES: ReadonlySet<string> = new Set([
  'CC0-1.0',
  'Unlicense',
  'MIT',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'WTFPL',
  'WTFNMFPL',
])

const GH = 'https://github.com'
const RAW = 'https://raw.githubusercontent.com'

export const CATALOG: readonly CatalogList[] = [
  // ADR-0017 starter set: enforced
  {
    id: 'quenhus-dev-filter',
    name: 'uBlock-Origin-dev-filter (dev: Stack Overflow, GitHub, npm copycats)',
    url: `${RAW}/quenhus/uBlock-Origin-dev-filter/main/dist/other_format/uBlacklist/all.txt`,
    homepage: `${GH}/quenhus/uBlock-Origin-dev-filter`,
    format: 'ublacklist',
    kind: 'clone',
    license: 'Unlicense',
    licenseUrl: `${GH}/quenhus/uBlock-Origin-dev-filter/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'enforce',
    approxRules: 625,
    notes:
      'Last data push 2025-04-24. Includes whole-site entries for large platforms (csdn.net, segmentfault.com, ' +
      'qiniu.com). The README credits arosh lists (CC0-1.0), stroobants-dev/ublock-origin-shitty-copies-filter ' +
      '(MPL-2.0) and a quenhus gist as sources; the repository itself is Unlicense.',
  },
  {
    id: 'arosh-stackoverflow-translation',
    name: 'uBlacklist Stack Overflow Translation',
    url: `${RAW}/arosh/ublacklist-stackoverflow-translation/master/uBlacklist.txt`,
    homepage: `${GH}/arosh/ublacklist-stackoverflow-translation`,
    format: 'ublacklist',
    kind: 'clone',
    license: 'CC0-1.0',
    licenseUrl: `${GH}/arosh/ublacklist-stackoverflow-translation/blob/master/LICENSE`,
    bundleable: true,
    recommendedMode: 'enforce',
    approxRules: 139,
    notes:
      'Machine-translated Stack Exchange copies. Ships evidence.md (a copied page and its original per domain).',
  },
  {
    id: 'arosh-github-translation',
    name: 'uBlacklist GitHub Translation',
    url: `${RAW}/arosh/ublacklist-github-translation/master/uBlacklist.txt`,
    homepage: `${GH}/arosh/ublacklist-github-translation`,
    format: 'ublacklist',
    kind: 'clone',
    license: 'CC0-1.0',
    licenseUrl: `${GH}/arosh/ublacklist-github-translation/blob/master/LICENSE`,
    bundleable: true,
    recommendedMode: 'enforce',
    approxRules: 35,
    notes: 'Machine-translated GitHub README, issue and PR copies. Ships evidence.md.',
  },
  {
    id: 'rjaus-pinterest',
    name: 'ublacklist-pinterest (basic)',
    url: `${RAW}/rjaus/ublacklist-pinterest/main/ublacklist-pinterest.txt`,
    homepage: `${GH}/rjaus/ublacklist-pinterest`,
    format: 'ublacklist',
    kind: 'block',
    license: 'CC0-1.0',
    licenseUrl: `${GH}/rjaus/ublacklist-pinterest/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'enforce',
    approxRules: 50,
    notes:
      'All Pinterest country domains. Starts with uBlacklist YAML frontmatter. The repo also has -img, -ext and -ovk ' +
      'variants.',
  },
  // ADR-0017 starter set: audit
  {
    id: 'laylavish-huge-ai',
    name: 'uBlockOrigin & uBlacklist Huge AI Blocklist (uBlacklist format)',
    url: `${RAW}/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/list_uBlacklist.txt`,
    homepage: `${GH}/laylavish/uBlockOrigin-HUGE-AI-Blocklist`,
    format: 'ublacklist',
    kind: 'content-farm',
    license: 'CC0-1.0',
    licenseUrl: `${GH}/laylavish/uBlockOrigin-HUGE-AI-Blocklist/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'audit',
    approxRules: 1674,
    notes:
      'Mostly AI-image sites and AI-generated content. 92 regex rules, all RE2-compatible (checked 2026-10-29). ' +
      'Last push 2025-10-02. The uBO variant is list.txt; a "nuclear" variant also exists.',
  },
  // Offered, never auto-enabled
  {
    id: 'super-seo-spam-suppressor',
    name: 'Super SEO Spam Suppressor',
    url: `${RAW}/NotaInutilis/Super-SEO-Spam-Suppressor/main/ublacklist.txt`,
    homepage: `${GH}/NotaInutilis/Super-SEO-Spam-Suppressor`,
    format: 'ublacklist',
    kind: 'block',
    license: 'WTFNMFPL',
    licenseUrl: `${GH}/NotaInutilis/Super-SEO-Spam-Suppressor/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'off',
    approxRules: 417654,
    notes:
      'About 10 MB, updated daily; aggregates many lists (content farms, scrapers, copycats, AI, scams, malware). ' +
      'GitHub reports NOASSERTION; the LICENSE text is WTFNMFPL v1 (Ben McGinnes). Subscribe by URL; never ' +
      'auto-enabled (ADR-0017).',
  },
  {
    id: 'quenhus-dev-filter-global',
    name: 'uBlock-Origin-dev-filter (global: dev + Wikipedia copycats + SEO spam)',
    url: `${RAW}/quenhus/uBlock-Origin-dev-filter/main/dist/other_format/uBlacklist/global.txt`,
    homepage: `${GH}/quenhus/uBlock-Origin-dev-filter`,
    format: 'ublacklist',
    kind: 'clone',
    license: 'Unlicense',
    licenseUrl: `${GH}/quenhus/uBlock-Origin-dev-filter/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'off',
    approxRules: 710,
    notes: 'Superset of quenhus-dev-filter; enable one or the other.',
  },
  {
    id: 'popcar2-bad-website-blocklist',
    name: 'BadWebsiteBlocklist',
    url: `${RAW}/popcar2/BadWebsiteBlocklist/main/uBlacklist.txt`,
    homepage: `${GH}/popcar2/BadWebsiteBlocklist`,
    format: 'ublacklist',
    kind: 'block',
    license: 'CC0-1.0',
    licenseUrl: `${GH}/popcar2/BadWebsiteBlocklist/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'off',
    approxRules: 418,
    notes:
      'AI spam, misleading ad sites, tampered downloads; every domain has a block request in the issue tracker. ' +
      'Includes broad entries (msn.com, linux.com, digitalocean.com/community/tutorials), so it is offered, not ' +
      'enabled. Source of the ai-content-farms evidence.',
  },
  {
    id: 'alvi-se-ai-blacklist',
    name: 'ai-ublock-blacklist',
    url: `${RAW}/alvi-se/ai-ublock-blacklist/master/ublacklist.txt`,
    homepage: `${GH}/alvi-se/ai-ublock-blacklist`,
    format: 'ublacklist',
    kind: 'content-farm',
    license: 'GPL-3.0-only',
    licenseUrl: `${GH}/alvi-se/ai-ublock-blacklist/blob/master/LICENSE`,
    bundleable: false,
    recommendedMode: 'off',
    approxRules: 2764,
    notes:
      'AI-generated content sites. LICENSE is the GPL v3 text with no "or later" grant. Subscribe by URL only; ' +
      'never copied into the repo.',
  },
  {
    id: 'spamdexing-sites',
    name: 'SpamdexingSites',
    url: `${RAW}/elliotwutingfeng/SpamdexingSites/main/blocklist_UBL.txt`,
    homepage: `${GH}/elliotwutingfeng/SpamdexingSites`,
    format: 'ublacklist',
    kind: 'block',
    license: 'BSD-3-Clause',
    licenseUrl: `${GH}/elliotwutingfeng/SpamdexingSites/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'off',
    approxRules: 3686,
    notes:
      'Spamdexing (SEO-spam) domains, mostly European. Copyright (c) 2023, Wu Tingfeng. Last push 2026-01-29.',
  },
  {
    id: 'seo-garbage',
    name: 'seo-garbage',
    url: `${RAW}/insomnimus/seo-garbage/main/list.txt`,
    homepage: `${GH}/insomnimus/seo-garbage`,
    format: 'domains',
    kind: 'content-farm',
    license: 'Apache-2.0',
    licenseUrl: `${GH}/insomnimus/seo-garbage/blob/main/LICENSE`,
    bundleable: true,
    recommendedMode: 'off',
    approxRules: 261,
    notes:
      'Plain domain list of SEO-bait review and listicle sites. GitHub reports NOASSERTION; the text is Apache 2.0.',
  },
  {
    id: 'ncaq-ublacklist-rule',
    name: 'uBlacklistRule (Japanese tech spam and copy sites)',
    url: `${RAW}/ncaq/uBlacklistRule/master/uBlacklist.txt`,
    homepage: `${GH}/ncaq/uBlacklistRule`,
    format: 'ublacklist',
    kind: 'block',
    license: 'MIT',
    licenseUrl: `${GH}/ncaq/uBlacklistRule/blob/master/LICENSE`,
    bundleable: true,
    recommendedMode: 'off',
    approxRules: 7786,
    notes: 'Japanese-language focus. Copyright (c) 2021 ncaq. Updated daily.',
  },
  {
    id: 'content-farm-terminator',
    name: 'Content Farm Terminator: content farms (uBlacklist)',
    url: 'https://danny0838.github.io/content-farm-terminator/files/blocklist-ublacklist/content-farms.txt',
    homepage: 'https://danny0838.github.io/content-farm-terminator/',
    format: 'ublacklist',
    kind: 'content-farm',
    license: 'NOASSERTION',
    licenseUrl: null,
    bundleable: false,
    recommendedMode: 'off',
    approxRules: 17223,
    notes:
      'Mostly Chinese content farms. The repo is GPL-3.0 and its gh-pages branch has no LICENSE; the file header ' +
      'says MIT and the README says "mostly MIT" with aggregated sources under their own licences. One regex uses ' +
      'a lookahead RE2 rejects. Subscribe by URL only.',
  },
  {
    id: 'google-chinese-results-blocklist',
    name: 'Google-Chinese-Results-Blocklist',
    url: `${RAW}/cobaltdisco/Google-Chinese-Results-Blocklist/master/uBlacklist_subscription.txt`,
    homepage: `${GH}/cobaltdisco/Google-Chinese-Results-Blocklist`,
    format: 'ublacklist',
    kind: 'content-farm',
    license: 'NONE',
    licenseUrl: null,
    bundleable: false,
    recommendedMode: 'off',
    approxRules: 2733,
    notes:
      'Chinese-language content farms and copy sites. No LICENSE file: subscribe by URL only, never vendored.',
  },
  // Brave public Goggles: no licence, link only
  {
    id: 'brave-goggle-copycats-removal',
    name: 'Brave Goggle: Copycats removal',
    url: `${RAW}/brave/goggles-quickstart/main/goggles/copycats_removal.goggle`,
    homepage: `${GH}/brave/goggles-quickstart`,
    format: 'goggles',
    kind: 'clone',
    license: 'NONE',
    licenseUrl: null,
    bundleable: false,
    recommendedMode: 'off',
    approxRules: 189,
    notes: 'Brave goggles-quickstart has no licence: link only, never copied or vendored.',
  },
  {
    id: 'brave-goggle-no-pinterest',
    name: 'Brave Goggle: No Pinterest',
    url: `${RAW}/brave/goggles-quickstart/main/goggles/no_pinterest.goggle`,
    homepage: `${GH}/brave/goggles-quickstart`,
    format: 'goggles',
    kind: 'block',
    license: 'NONE',
    licenseUrl: null,
    bundleable: false,
    recommendedMode: 'off',
    approxRules: 22,
    notes: 'Brave goggles-quickstart has no licence: link only, never copied or vendored.',
  },
]

/** The ADR-0017 starter set: catalog entries enabled by default, with their mode. */
export function starterSet(): CatalogList[] {
  return CATALOG.filter((l) => l.recommendedMode !== 'off')
}

/** A starter list vendored under `lists/vendor/` (ADR-0016 point 5; THIRD_PARTY_NOTICES.md). */
export interface VendoredList {
  /** Catalog id. */
  id: string
  /** Repo-relative path of the vendored copy. */
  path: string
  /** SHA-256 (hex) of the upstream bytes, i.e. the file without the vendor header. */
  sha256: string
  /** Size of the upstream bytes. */
  bytes: number
  license: string
  /** The catalog URL the copy was taken from (a branch URL). */
  sourceUrl: string
  /** The same file at the upstream commit it was taken from. */
  pinnedUrl: string
  fetchedAt: string
}

export const VENDORED_LISTS: readonly VendoredList[] = [
  {
    id: 'quenhus-dev-filter',
    path: 'lists/vendor/quenhus-dev-filter.txt',
    sha256: '43dbde8c1189f37cded66f37ff860b8b54faf485dbb4422bd920789791b7b3f7',
    bytes: 14765,
    license: 'Unlicense',
    sourceUrl: `${RAW}/quenhus/uBlock-Origin-dev-filter/main/dist/other_format/uBlacklist/all.txt`,
    pinnedUrl: `${RAW}/quenhus/uBlock-Origin-dev-filter/317ca733050b46065715c0307863f741b2147873/dist/other_format/uBlacklist/all.txt`,
    fetchedAt: '2026-10-31',
  },
  {
    id: 'arosh-stackoverflow-translation',
    path: 'lists/vendor/arosh-stackoverflow-translation.txt',
    sha256: 'a63a624170089f52f06541a0c2b375cffb5531abced4ac7f9a49e37885830ee7',
    bytes: 2973,
    license: 'CC0-1.0',
    sourceUrl: `${RAW}/arosh/ublacklist-stackoverflow-translation/master/uBlacklist.txt`,
    pinnedUrl: `${RAW}/arosh/ublacklist-stackoverflow-translation/10e39fd9b7250a777043e06aa976051b995197c4/uBlacklist.txt`,
    fetchedAt: '2026-10-31',
  },
  {
    id: 'arosh-github-translation',
    path: 'lists/vendor/arosh-github-translation.txt',
    sha256: 'c65dd193cb810062d4f296efd31cacf032b054cf8a80d6c3683f8b0d0c08ef81',
    bytes: 770,
    license: 'CC0-1.0',
    sourceUrl: `${RAW}/arosh/ublacklist-github-translation/master/uBlacklist.txt`,
    pinnedUrl: `${RAW}/arosh/ublacklist-github-translation/bd0bc03be08b308f81368ecbf3919b62c9b313d5/uBlacklist.txt`,
    fetchedAt: '2026-10-31',
  },
  {
    id: 'rjaus-pinterest',
    path: 'lists/vendor/rjaus-pinterest.txt',
    sha256: '6eb10a6c5dea3276ab49c072b92d77cdab78698f0d89458f45d242228f34f557',
    bytes: 1342,
    license: 'CC0-1.0',
    sourceUrl: `${RAW}/rjaus/ublacklist-pinterest/main/ublacklist-pinterest.txt`,
    pinnedUrl: `${RAW}/rjaus/ublacklist-pinterest/a8c47411f3c4640f0ea2c344853f390912538c3f/ublacklist-pinterest.txt`,
    fetchedAt: '2026-10-31',
  },
  {
    id: 'laylavish-huge-ai',
    path: 'lists/vendor/laylavish-huge-ai.txt',
    sha256: '183d61171872d8556d68b0551a38ff76ec0a89566f08e83feea17408fa2401ce',
    bytes: 46638,
    license: 'CC0-1.0',
    sourceUrl: `${RAW}/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/list_uBlacklist.txt`,
    pinnedUrl: `${RAW}/laylavish/uBlockOrigin-HUGE-AI-Blocklist/dad86686d247fbf9845750106f6b4e7065f56703/list_uBlacklist.txt`,
    fetchedAt: '2026-10-31',
  },
]

/** Last line of the comment block prepended to each vendored file; the upstream bytes follow it. */
export const VENDOR_HEADER_END =
  '# ---- end of search-hole vendor header; upstream file follows unchanged ----'

/** Header fields written into each vendored file (`# Key: value` lines). */
export function vendorHeader(v: VendoredList): string {
  return [
    `# search-hole vendored copy of the "${v.id}" list (ADR-0016). Do not edit; re-fetch instead.`,
    `# Source: ${v.sourceUrl}`,
    `# Pinned: ${v.pinnedUrl}`,
    `# License: ${v.license}`,
    `# Fetched: ${v.fetchedAt}`,
    `# SHA-256: ${v.sha256}`,
    VENDOR_HEADER_END,
    '',
  ].join('\n')
}

/**
 * Splits a vendored file into its header fields and the upstream body (byte-identical to the
 * original, so `sha256(body)` must equal the `SHA-256` field). Returns null when the text does
 * not start with a vendor header.
 */
export function stripVendorHeader(text: string): { fields: Record<string, string>; body: string } | null {
  const end = text.indexOf(`${VENDOR_HEADER_END}\n`)
  if (end < 0 || !text.startsWith('# search-hole vendored copy')) return null
  const fields: Record<string, string> = {}
  for (const line of text.slice(0, end).split('\n')) {
    const m = /^# ([A-Za-z0-9-]+): (.*)$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) fields[m[1]] = m[2]
  }
  return { fields, body: text.slice(end + VENDOR_HEADER_END.length + 1) }
}
