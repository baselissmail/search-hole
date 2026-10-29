// SPDX-License-Identifier: Apache-2.0
/**
 * The safe page fetcher behind the `fetch` tool (ADR-0011, ADR-0012, §12.4).
 *
 * Per hop (the requested URL and every redirect target, at most 5 redirects):
 * URL shape check (scheme, credentials, port, literal IPs) → the injected rule
 * check `isBlocked` (so a redirector cannot launder a blocked site) →
 * robots.txt → a request through the guarded agent, whose DNS lookup refuses
 * any non-public address. After the final response: a 5 MB decoded-body cap
 * (streamed; the download is aborted at the cap and the prefix is kept), a 15 s
 * total deadline, readable-text extraction, the rule check on
 * `<link rel=canonical>`, typed page dates and a token-budgeted chunk with a
 * continuation cursor. The output is untrusted web content.
 */
import { type Dispatcher, request } from 'undici'
import { extractPageDates } from '../core/dates/extract.ts'
import type { FoundDate, HiddenReason, RuleRef } from '../shared/types.ts'
import { errorCodeOf, raceAbort } from './abort.ts'
import {
  decodeText,
  discardBody,
  headerString,
  parseContentType,
  readBody,
  UnsupportedEncodingError,
} from './body.ts'
import { contentHash, decodeCursor, encodeCursor } from './cursor.ts'
import { type FetchFailureReason, fetchFailure } from './errors.ts'
import { checkUrlShape, createGuardedAgent, findGuardError, GuardError, type GuardPolicy } from './guard.ts'
import { scanPageMeta } from './pageMeta.ts'
import { type ExtractionMethod, extractReadable } from './readable.ts'
import {
  createRobotsChecker,
  ROBOTS_MAX_BYTES,
  type RobotsChecker,
  type RobotsFetchResult,
} from './robots.ts'
import { stripInvisible } from './sanitize.ts'
import { takeChunk } from './tokens.ts'
import { USER_AGENT } from './version.ts'

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_MAX_TOKENS = 8_000
const MIN_TOKENS = 100
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_TITLE_CHARS = 300

/** Why a URL is blocked by the user's rules (the rules engine's hidden decision). */
export interface BlockVerdict {
  reason: Extract<HiddenReason, 'rule' | 'list' | 'allowlist_mode'>
  rule?: RuleRef
}

/** Rule check run on every hop and on the canonical link; falsy means allowed. */
export type IsBlocked = (
  url: string,
) => BlockVerdict | null | undefined | false | Promise<BlockVerdict | null | undefined | false>

export interface PageFetcherConfig {
  /** SSRF policy. Production code passes nothing (or only `resolve` for tests). */
  guard?: GuardPolicy
  userAgent?: string
  acceptLanguage?: string
  maxBodyBytes?: number
  /** Total deadline for the whole fetch, robots included. */
  timeoutMs?: number
  maxRedirects?: number
  connectionsPerOrigin?: 1 | 2
  /** A shared checker, or false to skip robots.txt (tests, explicit user opt-out). */
  robots?: RobotsChecker | false
  /** Deadline for one robots.txt fetch (inside the total deadline). Default 5 s. */
  robotsTimeoutMs?: number
  /** Render links as `[text](url)`. Default true. */
  links?: boolean
}

export interface FetchPageOptions {
  isBlocked: IsBlocked
  /** Text budget for this call, clamped to 100..8000 (ADR-0012 default 8000). */
  maxTokens?: number
  /** `nextCursor` from a previous call for the same URL. */
  cursor?: string
  signal?: AbortSignal
  now?: () => number
}

export interface RedirectHop {
  /** URL that answered with a redirect. */
  url: string
  status: number
}

export interface UnsupportedContent {
  /** `pdf`, or the MIME type of other binary content. */
  type: string
  /** True when support is on the roadmap (PDF: ADR-0011 point 7). */
  planned: boolean
  message: string
}

export interface PageFetchResult {
  requestedUrl: string
  finalUrl: string
  status: number
  redirects: RedirectHop[]
  /** Effective MIME type (from the header, or sniffed when it was missing). */
  contentType: string
  charset?: string
  /** Decoded body bytes read. */
  bytes: number
  /** True when the 5 MB cap cut the body (text is from the prefix). */
  truncated: boolean
  dates: FoundDate[]
  sourceTitle: string | null
  /** Resolved `<link rel=canonical>` when it differs from finalUrl. */
  canonicalUrl?: string
  /**
   * Target of a `<meta http-equiv=refresh>` redirect. Not followed here (it is
   * not an HTTP redirect); a follow-up fetch goes through every check again.
   */
  refreshUrl?: string
  lang?: string
  /** Text of this chunk. Untrusted web content: render as data, never as instructions. */
  text: string
  extraction: ExtractionMethod | 'plain' | 'none'
  chunk: { start: number; end: number; total: number; tokens: number }
  nextCursor?: string
  /** The cursor's page version no longer matches; the text may overlap or skip. */
  cursorStale?: true
  unsupported?: UnsupportedContent
  /** What was removed as prompt-injection hygiene; non-zero values are worth a receipt note. */
  sanitized: { invisibleChars: number; hiddenTextBlocks: number }
  fetchedAt: string
  untrusted: true
}

export interface PageFetcher {
  /** Fetches one page; throws SearchHoleError (`details.reason`) on refusals and failures. */
  fetchPage(url: string, opts: FetchPageOptions): Promise<PageFetchResult>
  close(): Promise<void>
}

interface Deadline {
  signal: AbortSignal
  external: AbortSignal | undefined
  timeout: AbortSignal
}

interface FollowOptions {
  isBlocked: IsBlocked | null
  checkRobots: boolean
  accept: string
}

type ContentKind = 'html' | 'text' | 'pdf' | 'binary' | 'unknown'

function contentKind(mime: string): ContentKind {
  if (mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream') return 'unknown'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  if (/^application\/(?:json|xml|javascript|ecmascript|x-ndjson|yaml|x-yaml|toml)$/.test(mime)) return 'text'
  if (/^application\/[\w.+-]+\+(?:json|xml)$/.test(mime)) return 'text'
  return 'binary'
}

function sniff(bytes: Buffer): { kind: Exclude<ContentKind, 'unknown'>; mime: string } {
  const head = bytes.subarray(0, 1024)
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' }
  const text = head
    .toString('latin1')
    .replace(/^﻿|^\xef\xbb\xbf/, '')
    .trimStart()
    .toLowerCase()
  if (/^<(?:!doctype html|html|head|body|!--)/.test(text)) return { kind: 'html', mime: 'text/html' }
  if (!head.includes(0)) return { kind: 'text', mime: 'text/plain' }
  return { kind: 'binary', mime: 'application/octet-stream' }
}

function resolveHttp(href: string | null, base: string): string | null {
  if (!href) return null
  try {
    const u = new URL(href, base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** Starts a stale cursor at the next line boundary so text resumes cleanly. */
function snapForward(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length || text[offset - 1] === '\n') return Math.min(offset, text.length)
  const nl = text.indexOf('\n', offset)
  return nl >= 0 && nl - offset < 2000 ? nl + 1 : offset
}

function cleanTitle(raw: string | null): string | null {
  if (!raw) return null
  const t = stripInvisible(raw).text.replace(/\s+/g, ' ').trim()
  return t === '' ? null : t.slice(0, MAX_TITLE_CHARS)
}

function guardFailure(err: GuardError, url: string, hop: number): Error {
  const reason: FetchFailureReason = err.reason
  return fetchFailure(
    err.message,
    {
      reason,
      url,
      hop,
      ...(err.address === undefined ? {} : { address: err.address }),
      ...(err.range === undefined ? {} : { range: err.range }),
    },
    err,
  )
}

function networkFailure(err: unknown, url: URL, hop: number, deadline: Deadline): Error {
  const guard = findGuardError(err)
  if (guard) return guardFailure(guard, url.href, hop)
  if (deadline.external?.aborted)
    return fetchFailure('The fetch was cancelled', { reason: 'cancelled', url: url.href, hop })
  if (deadline.timeout.aborted) {
    return fetchFailure(`${url.host} did not answer within the time limit`, {
      reason: 'timeout',
      url: url.href,
      hop,
    })
  }
  if (err instanceof UnsupportedEncodingError) {
    return fetchFailure(err.message, { reason: 'decode', url: url.href, hop }, err)
  }
  const code = errorCodeOf(err)
  const host = url.host
  let why: string
  let reason: FetchFailureReason = 'network'
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
    case 'EAI_FAIL':
      why = `Could not resolve ${url.hostname}`
      break
    case 'ECONNREFUSED':
      why = `${host} refused the connection`
      break
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
    case 'EPIPE':
      why = `${host} closed the connection`
      break
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'ETIMEDOUT':
      why = `${host} did not answer within the time limit`
      reason = 'timeout'
      break
    default:
      why =
        code && /CERT|TLS|SSL/i.test(code)
          ? `TLS error talking to ${host} (${code})`
          : `Network error talking to ${host}${code ? ` (${code})` : ''}`
  }
  return fetchFailure(why, { reason, url: url.href, hop }, err)
}

function makeDeadline(timeoutMs: number, external: AbortSignal | undefined): Deadline {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = external ? AbortSignal.any([external, timeout]) : timeout
  return { signal, external, timeout }
}

function ruleWhy(verdict: BlockVerdict, url: string, viaCanonical: boolean): string {
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    // keep the raw URL
  }
  const what = viaCanonical ? `the page's canonical URL (${host})` : host
  if (verdict.rule) return `${what} is blocked by the rule "${verdict.rule.text}" (${verdict.rule.tier})`
  if (verdict.reason === 'allowlist_mode') return `${what} is not on the profile's allowlist`
  return `${what} is blocked by a ${verdict.reason}`
}

/** Builds a page fetcher with its own guarded connection pool and robots cache. */
export function createPageFetcher(config: PageFetcherConfig = {}): PageFetcher {
  const policy = config.guard
  const agent = createGuardedAgent({
    ...(policy === undefined ? {} : { policy }),
    connectionsPerOrigin: config.connectionsPerOrigin ?? 2,
  })
  const ua = config.userAgent ?? USER_AGENT
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const robotsTimeout = config.robotsTimeoutMs ?? 5_000
  const links = config.links ?? true

  const shape = (url: string, hop: number): URL => {
    try {
      return checkUrlShape(url, policy)
    } catch (err) {
      if (err instanceof GuardError) throw guardFailure(err, url, hop)
      throw err
    }
  }

  const send = (url: URL, accept: string, deadline: Deadline): Promise<Dispatcher.ResponseData> => {
    const headers: Record<string, string> = {
      'user-agent': ua,
      accept,
      'accept-encoding': 'gzip, br',
    }
    if (config.acceptLanguage) headers['accept-language'] = config.acceptLanguage
    const p = request(url, { method: 'GET', headers, dispatcher: agent, signal: deadline.signal })
    return raceAbort(p, deadline.signal, (late) => discardBody(late.body))
  }

  const follow = async (
    start: string,
    opts: FollowOptions,
    deadline: Deadline,
  ): Promise<{ res: Dispatcher.ResponseData; url: URL; redirects: RedirectHop[] }> => {
    const redirects: RedirectHop[] = []
    let url = shape(start, 0)
    for (let hop = 0; ; hop++) {
      if (opts.isBlocked) {
        const verdict = await opts.isBlocked(url.href)
        if (verdict) {
          throw fetchFailure(ruleWhy(verdict, url.href, false), {
            reason: 'rule',
            url: url.href,
            hop,
            ...(verdict.rule ? { rule: verdict.rule } : {}),
          })
        }
      }
      if (opts.checkRobots && robots) {
        const verdict = await robots.check(url.href, deadline.signal)
        if (!verdict.allowed) {
          if (deadline.external?.aborted || deadline.timeout.aborted)
            throw networkFailure(null, url, hop, deadline)
          throw fetchFailure(`${url.host}: ${verdict.detail}`, {
            reason: verdict.reason === 'disallowed' ? 'robots' : 'robots_unavailable',
            url: url.href,
            hop,
          })
        }
      }
      let res: Dispatcher.ResponseData
      try {
        res = await send(url, opts.accept, deadline)
      } catch (err) {
        throw networkFailure(err, url, hop, deadline)
      }
      const location = headerString(res.headers.location)
      if (!REDIRECT_STATUSES.has(res.statusCode) || !location) return { res, url, redirects }
      discardBody(res.body)
      if (redirects.length >= maxRedirects) {
        throw fetchFailure(`More than ${maxRedirects} redirects`, {
          reason: 'too_many_redirects',
          url: url.href,
          hop,
          status: res.statusCode,
        })
      }
      let next: string
      try {
        next = new URL(location, url.href).href
      } catch {
        throw fetchFailure(`${url.host} sent an invalid redirect`, {
          reason: 'network',
          url: url.href,
          hop,
          status: res.statusCode,
        })
      }
      redirects.push({ url: url.href, status: res.statusCode })
      url = shape(next, hop + 1)
    }
  }

  const fetchRobotsTxt = async (
    robotsUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<RobotsFetchResult> => {
    const own = AbortSignal.timeout(robotsTimeout)
    const deadline: Deadline = {
      signal: signal ? AbortSignal.any([signal, own]) : own,
      external: signal,
      timeout: own,
    }
    try {
      const { res } = await follow(
        robotsUrl,
        { isBlocked: null, checkRobots: false, accept: 'text/plain' },
        deadline,
      )
      if (res.statusCode < 200 || res.statusCode >= 300) {
        discardBody(res.body)
        return { status: res.statusCode, text: '' }
      }
      const body = await readBody(res.body, headerString(res.headers['content-encoding']), ROBOTS_MAX_BYTES)
      return { status: res.statusCode, text: body.bytes.toString('utf8') }
    } catch (err) {
      const reason = (err as { details?: { reason?: string } }).details?.reason
      if (reason === 'too_many_redirects') return { status: 310, text: '' }
      const message = err instanceof Error ? err.message : 'robots.txt fetch failed'
      // Our own cancellation or overall deadline says nothing about the site: do not cache it.
      return signal?.aborted ? { networkError: message, transient: true } : { networkError: message }
    }
  }

  const robots: RobotsChecker | null =
    config.robots === false ? null : (config.robots ?? createRobotsChecker({ fetchRobots: fetchRobotsTxt }))

  const fetchPage = async (requestedUrl: string, opts: FetchPageOptions): Promise<PageFetchResult> => {
    const now = opts.now ?? Date.now
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor)
    if (opts.cursor !== undefined && cursor === null) {
      throw fetchFailure('The cursor is not valid', { reason: 'invalid_cursor', url: requestedUrl })
    }
    const deadline = makeDeadline(timeoutMs, opts.signal)
    const accept = 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,application/pdf;q=0.5,*/*;q=0.3'
    const { res, url, redirects } = await follow(
      requestedUrl,
      { isBlocked: opts.isBlocked, checkRobots: true, accept },
      deadline,
    )
    const finalUrl = url.href
    const fetchedAtMs = now()
    const status = res.statusCode
    const ct = parseContentType(headerString(res.headers['content-type']))
    let kind = contentKind(ct.mime)
    let mime = ct.mime
    const base = {
      requestedUrl,
      finalUrl,
      status,
      redirects,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      untrusted: true as const,
    }

    const unsupportedResult = (type: string, bytes: number): PageFetchResult => {
      const planned = type === 'pdf'
      return {
        ...base,
        contentType: mime,
        bytes,
        truncated: false,
        dates: [],
        sourceTitle: null,
        text: '',
        extraction: 'none',
        chunk: { start: 0, end: 0, total: 0, tokens: 0 },
        unsupported: {
          type,
          planned,
          message: planned ? 'unsupported_type: pdf (planned)' : `unsupported_type: ${type}`,
        },
        sanitized: { invisibleChars: 0, hiddenTextBlocks: 0 },
      }
    }

    if (kind === 'pdf' || kind === 'binary') {
      discardBody(res.body)
      return unsupportedResult(kind === 'pdf' ? 'pdf' : mime, 0)
    }

    let body: Awaited<ReturnType<typeof readBody>>
    try {
      body = await readBody(res.body, headerString(res.headers['content-encoding']), maxBody)
    } catch (err) {
      throw networkFailure(err, url, redirects.length, deadline)
    }
    if (kind === 'unknown') {
      const sniffed = sniff(body.bytes)
      kind = sniffed.kind
      mime = sniffed.mime
      if (kind === 'pdf' || kind === 'binary')
        return unsupportedResult(kind === 'pdf' ? 'pdf' : mime, body.bytes.length)
    }

    const ok = status >= 200 && status < 300
    const lastModified = headerString(res.headers['last-modified'])
    const dateCtx = {
      url: finalUrl,
      fetchedAt: fetchedAtMs,
      ...(lastModified === undefined ? {} : { httpLastModified: lastModified }),
    }
    let fullText: string
    let charset: string
    let dates: FoundDate[] = []
    let title: string | null = null
    let extraction: PageFetchResult['extraction']
    let canonicalUrl: string | undefined
    let refreshUrl: string | undefined
    let lang: string | undefined
    let hiddenTextBlocks = 0

    if (kind === 'html') {
      const decoded = decodeText(body.bytes, ct.charset, true)
      charset = decoded.charset
      const html = decoded.text
      const meta = scanPageMeta(html)
      const canonical = resolveHttp(meta.canonicalHref, finalUrl)
      if (canonical && canonical !== finalUrl) {
        const verdict = await opts.isBlocked(canonical)
        if (verdict) {
          throw fetchFailure(ruleWhy(verdict, canonical, true), {
            reason: 'canonical_rule',
            url: canonical,
            hop: redirects.length,
            ...(verdict.rule ? { rule: verdict.rule } : {}),
          })
        }
        canonicalUrl = canonical
      }
      if (ok) dates = extractPageDates(html, dateCtx)
      const baseHref = resolveHttp(meta.baseHref, finalUrl) ?? finalUrl
      const readable = await extractReadable(html, { baseUrl: baseHref, links })
      fullText = readable.text
      extraction = readable.method
      hiddenTextBlocks = readable.hiddenTextBlocks
      title = cleanTitle(readable.title) ?? cleanTitle(meta.ogTitle) ?? cleanTitle(meta.title)
      if (meta.lang) lang = meta.lang
      const refresh = resolveHttp(meta.refreshHref, finalUrl)
      if (refresh && refresh !== finalUrl) refreshUrl = refresh
    } else {
      const decoded = decodeText(body.bytes, ct.charset, false)
      charset = decoded.charset
      fullText = decoded.text
      extraction = 'plain'
      if (ok) dates = extractPageDates('', dateCtx)
    }

    const clean = stripInvisible(fullText)
    const text = clean.text
    const hash = contentHash(text)
    let start = 0
    let stale = false
    if (cursor) {
      if (cursor.contentHash === hash) start = Math.min(cursor.offset, text.length)
      else {
        stale = true
        start = snapForward(text, Math.min(cursor.offset, text.length))
      }
    }
    const maxTokens = Math.min(DEFAULT_MAX_TOKENS, Math.max(MIN_TOKENS, opts.maxTokens ?? DEFAULT_MAX_TOKENS))
    const chunk = takeChunk(text, start, maxTokens)
    return {
      ...base,
      contentType: mime,
      charset,
      bytes: body.bytes.length,
      truncated: body.truncated,
      dates,
      sourceTitle: title,
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      ...(refreshUrl === undefined ? {} : { refreshUrl }),
      ...(lang === undefined ? {} : { lang }),
      text: text.slice(chunk.start, chunk.end),
      extraction,
      chunk: { start: chunk.start, end: chunk.end, total: text.length, tokens: chunk.tokens },
      ...(chunk.end < text.length
        ? { nextCursor: encodeCursor({ offset: chunk.end, contentHash: hash }) }
        : {}),
      ...(stale ? { cursorStale: true as const } : {}),
      sanitized: { invisibleChars: clean.removed, hiddenTextBlocks },
    }
  }

  return {
    fetchPage,
    async close() {
      await agent.close()
    },
  }
}

let shared: PageFetcher | null = null

/**
 * Fetches a page with the process-wide default fetcher (default limits,
 * robots on, no test overrides). Use createPageFetcher for custom limits.
 */
export function fetchPage(url: string, opts: FetchPageOptions): Promise<PageFetchResult> {
  shared ??= createPageFetcher()
  return shared.fetchPage(url, opts)
}

/** Closes the default fetcher's connection pool (CLI exit, tests). */
export async function closeDefaultPageFetcher(): Promise<void> {
  const f = shared
  shared = null
  await f?.close()
}
