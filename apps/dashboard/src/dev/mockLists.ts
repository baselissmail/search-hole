// SPDX-License-Identifier: Apache-2.0
/**
 * Dev-only: the lists routes of the fixture server (see mock.ts). Every state the Lists page has
 * to show is here: built-in, starter (shipped and downloaded copies), subscribed, imported; each
 * mode; skipped lines; a shrink-guard refusal with "Update anyway"; a network failure on a list
 * never downloaded; and hostile text where the network supplies it.
 */
import {
  type AddListInput,
  type ListCatalogEntry,
  type ListMode,
  type ListStatus,
  type ListUpdateResult,
  ROUTES,
} from '../lib/contract.ts'

const HOUR = 3_600_000
const DAY = 86_400_000
const RAW = 'https://raw.githubusercontent.com'
const GH = 'https://github.com'
const LIST_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MODES: readonly ListMode[] = ['enforce', 'audit', 'disabled']

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const fail = (status: number, code: string, message: string, fix?: string) =>
  json({ error: fix ? { code, message, fix } : { code, message } }, status)

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

/** A calendar date (`2026-10-31`), as the server reports a shipped copy's vendoring day. */
function day(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * DAY)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type CatalogSeed = Omit<ListCatalogEntry, 'enabled' | 'mode'>

const CATALOG: readonly CatalogSeed[] = [
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
      'Copycat sites of Stack Overflow, GitHub and npm. Includes whole-site entries for large platforms.',
    starter: true,
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
    notes: 'Machine-translated Stack Exchange copies. Ships evidence.md.',
    starter: true,
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
    starter: true,
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
    notes: 'All Pinterest country domains.',
    starter: true,
  },
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
    notes: 'Mostly AI-image sites and AI-generated content. 92 regex rules, all RE2-compatible.',
    starter: true,
  },
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
      'About 10 MB, updated daily; aggregates many lists (content farms, scrapers, copycats, AI, scams).',
    starter: false,
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
      'AI spam, misleading ad sites, tampered downloads. Includes broad entries, so it is offered, not enabled.',
    starter: false,
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
    notes: 'AI-generated content farms. GPL: subscribe-only, never shipped.',
    starter: false,
  },
  {
    id: 'brave-goggle-no-pinterest',
    name: '<img src=x onerror=alert(1)> No Pinterest (Goggle)',
    url: `${RAW}/brave/goggles-quickstart/main/goggles/no_pinterest.goggle`,
    homepage: 'javascript:alert(1)',
    format: 'goggles',
    kind: 'block',
    license: 'NONE',
    licenseUrl: null,
    bundleable: false,
    recommendedMode: 'off',
    approxRules: 22,
    notes: '"><script>alert(document.domain)</script> A hostile catalog entry: its text must render as text.',
    starter: false,
  },
]

const catalogById = new Map(CATALOG.map((c) => [c.id, c]))

function list(
  over: Partial<ListStatus> & Pick<ListStatus, 'id' | 'name' | 'source' | 'kind' | 'mode'>,
): ListStatus {
  return {
    format: 'ublacklist',
    defaultMode: over.mode,
    ruleCount: 0,
    skipped: 0,
    skipReasons: {},
    copy: 'downloaded',
    lastUpdate: null,
    lastCheck: null,
    nextUpdate: null,
    lastError: null,
    warnings: [],
    contribution: { hidden7d: 0, wouldHide7d: 0 },
    ...over,
  }
}

function starter(id: string, over: Partial<ListStatus> & Pick<ListStatus, 'mode'>): ListStatus {
  const c = catalogById.get(id) as CatalogSeed
  const defaultMode: ListMode = c.recommendedMode === 'off' ? 'disabled' : c.recommendedMode
  return list({
    id,
    name: c.name,
    source: 'vendored',
    kind: c.kind,
    format: c.format,
    defaultMode,
    url: c.url,
    homepage: c.homepage,
    license: c.license,
    description: c.notes,
    update: '7d',
    ruleCount: c.approxRules ?? 0,
    ...over,
  })
}

function builtin(
  id: string,
  kind: ListStatus['kind'],
  mode: ListMode,
  ruleCount: number,
  description: string,
  hidden7d = 0,
  wouldHide7d = 0,
): ListStatus {
  return list({
    id,
    name: `search-hole ${id}`,
    source: 'bundled',
    kind,
    mode,
    format: 'searchhole',
    license: 'CC0-1.0',
    description,
    ruleCount,
    copy: 'built-in',
    contribution: { hidden7d, wouldHide7d },
  })
}

function fixtures(): ListStatus[] {
  return [
    builtin(
      'official-docs',
      'official',
      'enforce',
      96,
      'Official documentation sites, one ecosystem per block. Annotation only: never hides anything.',
    ),
    builtin(
      'official-health',
      'official',
      'enforce',
      111,
      'Official health authorities, medicines regulators and clinical reference sites. Annotation only.',
    ),
    builtin(
      'github-clones',
      'clone',
      'enforce',
      172,
      'Sites that republish Stack Exchange or GitHub content wholesale, each with evidence.',
      41,
    ),
    builtin(
      'ai-content-farms',
      'content-farm',
      'audit',
      21,
      'Sites that mass-publish machine-generated articles, each with a documented report.',
      0,
      6,
    ),
    starter('quenhus-dev-filter', {
      mode: 'enforce',
      copy: 'shipped',
      lastUpdate: day(-1),
      nextUpdate: at(6 * DAY),
      contribution: { hidden7d: 23, wouldHide7d: 0 },
    }),
    starter('arosh-stackoverflow-translation', {
      mode: 'enforce',
      lastUpdate: at(-2 * DAY),
      lastCheck: at(-3 * HOUR),
      nextUpdate: at(5 * DAY),
      detectedFormat: 'ublacklist',
      contribution: { hidden7d: 9, wouldHide7d: 0 },
    }),
    starter('arosh-github-translation', {
      mode: 'disabled',
      copy: 'shipped',
      lastUpdate: day(-1),
      nextUpdate: at(6 * DAY),
    }),
    starter('rjaus-pinterest', {
      mode: 'enforce',
      lastUpdate: at(-26 * HOUR),
      lastCheck: at(-26 * HOUR),
      nextUpdate: at(6 * DAY - 2 * HOUR),
      contribution: { hidden7d: 312, wouldHide7d: 0 },
    }),
    starter('laylavish-huge-ai', {
      mode: 'audit',
      ruleCount: 1659,
      skipped: 15,
      skipReasons: { 'regex with a lookahead (not RE2)': 12, 'cosmetic filter': 3 },
      copy: 'shipped',
      lastUpdate: day(-1),
      nextUpdate: at(-20 * 60_000),
      contribution: { hidden7d: 0, wouldHide7d: 41 },
    }),
    list({
      id: 'super-seo-spam-suppressor',
      name: 'Super SEO Spam Suppressor',
      source: 'subscribed',
      kind: 'block',
      mode: 'audit',
      defaultMode: 'enforce',
      url: catalogById.get('super-seo-spam-suppressor')?.url as string,
      homepage: `${GH}/NotaInutilis/Super-SEO-Spam-Suppressor`,
      license: 'WTFNMFPL',
      description: catalogById.get('super-seo-spam-suppressor')?.notes as string,
      update: '1d',
      ruleCount: 417_654,
      skipped: 212,
      skipReasons: { 'unsupported option $removeparam': 200, 'not a URL pattern': 12 },
      lastUpdate: at(-8 * DAY),
      lastCheck: at(-40 * 60_000),
      nextUpdate: at(20 * 60_000),
      lastError: {
        code: 'shrink_guard',
        message:
          'The new copy has 1,204 rules, under half of the 417,654 in force, so it was refused (a guard against broken or hijacked lists).',
        at: at(-40 * 60_000),
      },
      contribution: { hidden7d: 0, wouldHide7d: 88 },
    }),
    list({
      id: 'block.txt',
      name: 'block.txt',
      source: 'subscribed',
      kind: 'block',
      mode: 'enforce',
      format: 'auto',
      url: 'https://lists.example.org/%3Cimg%20src=x%20onerror=alert(1)%3E/block.txt',
      homepage: 'javascript:alert(1)',
      description: '<script>alert(1)</script> A header from the network: text only.',
      update: '12h',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      copy: 'none',
      lastCheck: at(-5 * 60_000),
      nextUpdate: at(55 * 60_000),
      lastError: {
        code: 'network',
        message: 'getaddrinfo ENOTFOUND lists.example.org',
        at: at(-5 * 60_000),
      },
    }),
    list({
      id: 'team-blocklist',
      name: 'team-blocklist',
      source: 'local',
      kind: 'block',
      mode: 'enforce',
      format: 'domains',
      description: 'Imported from team-blocklist.txt',
      ruleCount: 2140,
      skipped: 3,
      skipReasons: { 'cosmetic filter': 2, 'not a single domain name': 1 },
      copy: 'imported',
      lastUpdate: at(-3 * DAY),
      warnings: ['2 rules were read as domain rules (approximate).'],
      contribution: { hidden7d: 4, wouldHide7d: 0 },
    }),
  ]
}

function idFromUrl(url: string): string | null {
  const file = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  const id = file
    .toLowerCase()
    .replace(/\.(txt|list|goggle)$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
  return id === '' ? null : id
}

export class MockLists {
  readonly #delay: (ms: number) => Promise<void>
  #lists: ListStatus[] = fixtures()
  #updates = 0

  constructor(instant: boolean) {
    this.#delay = (ms) => (instant ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))
  }

  /** The response for a lists route, or null when `path` is not one. */
  handle(method: string, path: string, body: unknown): Promise<Response> | null {
    if (path === ROUTES.lists && method === 'GET') return Promise.resolve(json(this.#lists))
    if (path === ROUTES.listCatalog && method === 'GET') return Promise.resolve(json(this.#catalog()))
    if (method !== 'POST') return null
    if (path === ROUTES.lists) return this.#add((body ?? {}) as AddListInput)
    if (path === ROUTES.updateLists) return this.#updateAll()
    if (path === ROUTES.removeList) return Promise.resolve(this.#remove((body as { id?: string })?.id ?? ''))
    const m = /^\/api\/lists\/([^/]+)\/(mode|update)$/.exec(path)
    if (!m) return null
    const id = decodeURIComponent(m[1] ?? '')
    if (m[2] === 'mode') return Promise.resolve(this.#setMode(id, (body as { mode?: ListMode })?.mode))
    return this.#updateOne(id, (body as { force?: boolean })?.force === true)
  }

  #catalog(): ListCatalogEntry[] {
    return CATALOG.map((c) => {
      const mine = this.#lists.find((l) => l.id === c.id)
      const entry: ListCatalogEntry = { ...c, enabled: mine !== undefined && mine.mode !== 'disabled' }
      if (mine) entry.mode = mine.mode
      return entry
    })
  }

  #find(id: string): ListStatus | undefined {
    return this.#lists.find((l) => l.id === id)
  }

  async #download(l: ListStatus): Promise<void> {
    await this.#delay(1400)
    const now = Date.now()
    l.lastCheck = new Date(now).toISOString()
    const host = l.url ? new URL(l.url).host : ''
    if (/unreachable|\.invalid$|example\.org$/.test(host)) {
      l.lastError = { code: 'network', message: `getaddrinfo ENOTFOUND ${host}`, at: l.lastCheck }
      l.nextUpdate = new Date(now + HOUR).toISOString()
      return
    }
    l.ruleCount = catalogById.get(l.id)?.approxRules ?? 1000 + ((host.length * 97) % 4000)
    l.copy = 'downloaded'
    l.lastUpdate = l.lastCheck
    l.nextUpdate = new Date(now + 7 * DAY).toISOString()
    l.lastError = null
  }

  async #add(input: AddListInput): Promise<Response> {
    const source = typeof input.source === 'string' ? input.source.trim() : ''
    if (source === '') return fail(400, 'bad_request', 'Give a catalog id or an https:// URL as "source".')
    const mode = input.mode
    if (mode !== undefined && !MODES.includes(mode)) {
      return fail(
        400,
        'invalid_argument',
        `Unknown mode "${String(mode)}".`,
        'Use enforce, audit or disabled.',
      )
    }
    const cat = catalogById.get(source)
    const here = cat ? this.#find(cat.id) : undefined
    if (cat && here && input.name === undefined) {
      here.mode =
        mode ??
        (here.mode !== 'disabled'
          ? here.mode
          : here.defaultMode !== 'disabled'
            ? here.defaultMode
            : 'enforce')
      if (input.fetch !== false && here.url && here.mode !== 'disabled') await this.#download(here)
      return json(here)
    }
    let url: string
    let id: string | null
    if (cat) {
      url = cat.url
      id = input.name ?? cat.id
    } else {
      let parsed: URL
      try {
        parsed = new URL(source)
      } catch {
        return fail(
          400,
          'invalid_argument',
          'That is neither a catalog list nor a URL.',
          'See `searchhole lists catalog`, or give an https:// URL.',
        )
      }
      if (parsed.protocol !== 'https:') {
        return fail(
          400,
          'invalid_argument',
          'Lists are fetched over HTTPS only.',
          'Use the https:// address of the list.',
        )
      }
      url = parsed.href
      id = input.name ?? idFromUrl(url)
    }
    if (id === null) {
      return fail(
        400,
        'invalid_argument',
        'Could not name this list from its URL.',
        'Give it a name with --name <id>.',
      )
    }
    if (!LIST_ID.test(id)) {
      return fail(400, 'invalid_argument', 'A list name is 1–64 lower-case letters, digits, ".", "_" or "-".')
    }
    if (this.#find(id)) {
      return fail(
        400,
        'invalid_argument',
        `A list named "${id}" already exists.`,
        'Pick another --name, or change its mode with `searchhole lists enforce|audit|disable`.',
      )
    }
    const l = list({
      id,
      name: cat?.name ?? id,
      source: 'subscribed',
      kind: input.kind ?? cat?.kind ?? 'block',
      mode: mode ?? 'enforce',
      defaultMode: 'enforce',
      format: input.format ?? cat?.format ?? 'auto',
      url,
      update: input.update ?? '7d',
      copy: 'none',
    })
    if (cat) {
      l.homepage = cat.homepage
      l.license = cat.license
      l.description = cat.notes
    }
    if (input.sha256) l.sha256 = input.sha256.toLowerCase()
    this.#lists.push(l)
    if (input.fetch !== false && l.mode !== 'disabled') await this.#download(l)
    return json(l)
  }

  #setMode(id: string, mode: ListMode | undefined): Response {
    const l = this.#find(id)
    if (!l) return fail(404, 'not_found', 'No such list.')
    if (mode === undefined || !MODES.includes(mode)) {
      return fail(400, 'bad_request', '"mode" must be enforce, audit or disabled.')
    }
    l.mode = mode
    return json(l)
  }

  #remove(id: string): Response {
    const l = this.#find(id)
    if (!l)
      return fail(
        400,
        'invalid_argument',
        `There is no list "${id}".`,
        'See your lists with `searchhole lists`.',
      )
    if (l.source === 'bundled' || l.source === 'vendored') {
      return fail(
        400,
        'invalid_argument',
        `${id} comes with search-hole and cannot be removed.`,
        `Turn it off with \`searchhole lists disable ${id}\`.`,
      )
    }
    this.#lists = this.#lists.filter((x) => x !== l)
    return json(l)
  }

  async #refresh(l: ListStatus, force: boolean): Promise<ListUpdateResult> {
    if (!l.url) {
      return {
        id: l.id,
        result: 'skipped',
        ruleCount: l.ruleCount,
        previousRuleCount: null,
        message:
          l.source === 'local'
            ? 'imported: run `searchhole lists import` again to change it'
            : 'built in: it updates with search-hole',
      }
    }
    await this.#delay(900)
    const previous = l.copy === 'none' ? null : l.ruleCount
    const now = new Date().toISOString()
    l.lastCheck = now
    if (l.lastError?.code === 'shrink_guard') {
      if (!force) {
        l.lastError = { ...l.lastError, at: now }
        return {
          id: l.id,
          result: 'failed',
          ruleCount: l.ruleCount,
          previousRuleCount: previous,
          message: l.lastError.message,
          error: { code: 'shrink_guard', message: l.lastError.message },
        }
      }
      l.ruleCount = 1204
      l.skipped = 0
      l.skipReasons = {}
      l.lastError = null
      l.lastUpdate = now
      l.nextUpdate = at(DAY)
      return { id: l.id, result: 'updated', ruleCount: 1204, previousRuleCount: previous, message: '' }
    }
    const host = new URL(l.url).host
    if (/unreachable|\.invalid$|example\.org$/.test(host)) {
      const message = `getaddrinfo ENOTFOUND ${host}`
      l.lastError = { code: 'network', message, at: now }
      l.nextUpdate = at(HOUR)
      return {
        id: l.id,
        result: 'failed',
        ruleCount: l.ruleCount,
        previousRuleCount: previous,
        message,
        error: { code: 'network', message },
      }
    }
    l.lastError = null
    l.nextUpdate = at(7 * DAY)
    if (++this.#updates % 3 === 0 || l.copy === 'shipped' || l.copy === 'none') {
      l.ruleCount += 7
      l.copy = 'downloaded'
      l.lastUpdate = now
      return { id: l.id, result: 'updated', ruleCount: l.ruleCount, previousRuleCount: previous, message: '' }
    }
    return {
      id: l.id,
      result: 'unchanged',
      ruleCount: l.ruleCount,
      previousRuleCount: previous,
      message: 'same content',
    }
  }

  async #updateOne(id: string, force: boolean): Promise<Response> {
    const l = this.#find(id)
    if (!l) return fail(404, 'not_found', 'No such list.')
    return json([await this.#refresh(l, force)])
  }

  async #updateAll(): Promise<Response> {
    const results: ListUpdateResult[] = []
    for (const l of this.#lists) {
      if (l.url && l.mode !== 'disabled') results.push(await this.#refresh(l, false))
    }
    return json(results)
  }
}
