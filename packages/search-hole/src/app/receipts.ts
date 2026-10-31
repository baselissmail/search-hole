// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions and receipts (ADR-0005, ADR-0014 point 1).
 *
 * Grouping when a search or fetch passes no `receiptId`:
 * - hook-keyed (Claude Code): the turn's receipt, opened by UserPromptSubmit (`openTurn`) and
 *   closed by Stop (`closeTurn`); a call after a Stop and before the next prompt reopens that
 *   turn (the Stop was premature) and logs it;
 * - `_meta`- or env-keyed: the session's open receipt, until 10 minutes of inactivity;
 * - fallback key or no session: no auto-join, every call gets its own receipt.
 *
 * The gateway process is the source of truth for its sessions (hooks re-key per process), so
 * state lives in memory and is mirrored into `sessions` and `receipts` when the store is
 * writable. Receipts of other processes are rebuilt from the log.
 */
import { randomBytes } from 'node:crypto'
import { judgeFreshness } from '../core/freshness.ts'
import { classifySource } from '../core/sourcetype.ts'
import { SearchHoleError } from '../shared/errors.ts'
import {
  type Confidence,
  type DateKind,
  ENGINE_ID_LIST,
  type EngineId,
  type FoundDate,
  type Freshness,
  type HiddenReason,
  type SourceType,
  type Warning,
} from '../shared/types.ts'
import type { SessionWrite, Store, StoredDate } from '../store/index.ts'
import type { AppContext } from './context.ts'
import type { Receipt, ReceiptSearchLine, ReceiptSource, RequestCtx } from './types.ts'

/** `_meta`- and env-keyed sessions close their receipt after this much inactivity (ADR-0005). */
export const RECEIPT_IDLE_MS = 10 * 60_000
/** Another gateway opening the same hook session's turn this recently is a duplicate copy. */
export const DUPLICATE_TURN_WINDOW_MS = 10_000
const MAX_RECEIPTS = 500
const MAX_URLS = 4000
const RECEIPT_ID = /^rcpt_[A-Za-z0-9_-]{22}$/

/** A new receipt id: `rcpt_` + 22 base64url characters (128 random bits). */
export function newReceiptId(): string {
  return `rcpt_${randomBytes(16).toString('base64url')}`
}

/** True for a string shaped like a receipt id. */
export const isReceiptId = (s: string): boolean => RECEIPT_ID.test(s)

interface MemReceipt {
  id: string
  sessionKey?: string
  startedAt: number
  closedAt?: number
  searches: ReceiptSearchLine[]
  sources: ReceiptSource[]
  warnings: string[]
}

interface MemSession {
  key: string
  source: NonNullable<RequestCtx['session']>['source']
  openReceiptId?: string
  turnOpen: boolean
  lastReceiptId?: string
  /** The receipt the last Stop closed, until the next prompt opens a new turn. */
  lastStopReceiptId?: string
  /**
   * Set for this turn when another search-hole copy opened it first (ADR-0006 point 11):
   * that copy logs the hooks' work and prints the Stop line; this one stays quiet.
   */
  duplicateOf?: string
  lastActivity: number
}

const HIDDEN_REASONS: ReadonlySet<string> = new Set<HiddenReason>([
  'rule',
  'list',
  'stale',
  'date_required',
  'allowlist_mode',
])
const ENGINE_IDS: ReadonlySet<string> = new Set<string>(ENGINE_ID_LIST)
const DATE_KINDS: ReadonlySet<string> = new Set<DateKind>(['published', 'modified', 'crawled', 'existed_by'])
const CONFIDENCES: ReadonlySet<string> = new Set<Confidence>(['high', 'medium', 'low'])

/** Stored dates read back as FoundDate (unknown codes dropped). */
export function foundDates(stored: readonly StoredDate[]): FoundDate[] {
  return stored
    .filter((d) => DATE_KINDS.has(d.kind) && CONFIDENCES.has(d.confidence))
    .map((d) => ({
      value: d.value,
      kind: d.kind as DateKind,
      method: d.method,
      confidence: d.confidence as Confidence,
      tzAssumed: d.tzAssumed,
    }))
}

const TYPE_LABEL: Readonly<Record<SourceType, [string, string]>> = {
  official: ['official', 'official'],
  docs: ['docs', 'docs'],
  forum: ['forum', 'forums'],
  news: ['news', 'news'],
  blog: ['blog', 'blogs'],
  repo: ['repo', 'repos'],
  reference: ['reference', 'references'],
  content_farm: ['content farm', 'content farms'],
  unknown: ['other', 'other'],
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "6 searches · 41 results · 9 hidden · sources: 3 official, 2 blogs · ⚠ 1 stale (2022)". */
export function summaryLine(
  searches: readonly ReceiptSearchLine[],
  sources: readonly ReceiptSource[],
): string {
  const kept = searches.reduce((n, s) => n + s.kept, 0)
  const hidden = searches.reduce((n, s) => n + s.hidden, 0)
  const parts = [
    plural(searches.length, 'search', 'searches'),
    plural(kept, 'result', 'results'),
    `${hidden} hidden`,
  ]
  if (sources.length > 0) {
    const counts = new Map<SourceType, number>()
    for (const s of sources) counts.set(s.sourceType, (counts.get(s.sourceType) ?? 0) + 1)
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    parts.push(
      `sources: ${ordered.map(([t, n]) => plural(n, TYPE_LABEL[t][0], TYPE_LABEL[t][1])).join(', ')}`,
    )
  }
  const stale = sources.filter((s) => s.freshness === 'stale')
  if (stale.length > 0) {
    const years = stale
      .flatMap((s) => s.dates.map((d) => Number.parseInt(d.value.slice(0, 4), 10)))
      .filter((y) => Number.isFinite(y))
    const oldest = years.length > 0 ? ` (${Math.min(...years)})` : ''
    parts.push(`⚠ ${stale.length} stale${oldest}`)
  }
  return parts.join(' · ')
}

/** The one-line Stop receipt (ADR-0014 point 4). */
export function turnLine(
  id: string,
  c: { searches: number; builtin: number; kept: number; hidden: number; opened: number },
): string {
  const parts = [
    `search-hole · ${plural(c.searches, 'search', 'searches')}${c.builtin > 0 ? ` (${c.builtin} built-in)` : ''}`,
    plural(c.kept, 'result', 'results'),
    `${c.hidden} hidden`,
  ]
  if (c.opened > 0) parts.push(`opened ${c.opened}`)
  parts.push(`receipt ${id}`)
  return parts.join(' · ')
}

/** Process-side receipt and session state, mirrored to the store. */
export class Receipts {
  private readonly receipts = new Map<string, MemReceipt>()
  private readonly sessions = new Map<string, MemSession>()
  private readonly urls = new Map<string, string>()

  constructor(private readonly ctx: AppContext) {}

  private remember(r: MemReceipt): MemReceipt {
    this.receipts.delete(r.id)
    this.receipts.set(r.id, r)
    while (this.receipts.size > MAX_RECEIPTS) {
      const first = this.receipts.keys().next().value
      if (first === undefined) break
      this.receipts.delete(first)
    }
    return r
  }

  /** Remembers a full URL for a stored URL hash (fetch rows keep hashes only). */
  rememberUrl(hash: string, url: string): void {
    this.urls.set(hash, url)
    if (this.urls.size > MAX_URLS) {
      const first = this.urls.keys().next().value
      if (first !== undefined) this.urls.delete(first)
    }
  }

  private create(id: string, sessionKey: string | undefined, store: Store | null): MemReceipt {
    const r: MemReceipt = { id, startedAt: this.ctx.now(), searches: [], sources: [], warnings: [] }
    if (sessionKey !== undefined) r.sessionKey = sessionKey
    this.remember(r)
    this.persistReceipt(id, sessionKey, store)
    return r
  }

  private persistReceipt(id: string, sessionKey: string | undefined, store: Store | null): void {
    try {
      store?.receipts.ensure(id, sessionKey)
    } catch (e) {
      this.ctx.logger.warn({ err: e }, 'could not store the receipt')
    }
  }

  private session(sess: NonNullable<RequestCtx['session']>, store: Store | null): MemSession {
    let s = this.sessions.get(sess.key)
    if (s) {
      s.source = sess.source
      return s
    }
    s = { key: sess.key, source: sess.source, turnOpen: false, lastActivity: this.ctx.now() }
    try {
      const row = store?.sessions.get(sess.key)
      if (row) {
        s.turnOpen = row.turnOpen
        s.lastActivity = row.lastSeenAt
        if (row.openReceiptId !== null) {
          s.openReceiptId = row.openReceiptId
          s.lastReceiptId = row.openReceiptId
        }
      }
    } catch {
      // A fresh in-memory session is fine.
    }
    this.sessions.set(sess.key, s)
    return s
  }

  private sessionWrite(s: MemSession, rctx: RequestCtx): SessionWrite {
    return {
      id: s.key,
      hostProfile: this.ctx.host,
      ...(s.source === 'fallback' ? {} : { hostKey: s.key }),
      keySource: s.source,
      ...(rctx.client?.name ? { clientName: rctx.client.name } : {}),
      ...(rctx.client?.version ? { clientVersion: rctx.client.version } : {}),
      ...(rctx.protocolEra ? { protocolEra: rctx.protocolEra } : {}),
      ...(rctx.projectDir ? { projectDir: rctx.projectDir } : {}),
      gatewayId: this.ctx.gatewayId,
      ...(s.openReceiptId ? { openReceiptId: s.openReceiptId } : {}),
      turnOpen: s.turnOpen,
    }
  }

  private persistSession(s: MemSession, rctx: RequestCtx, store: Store | null): void {
    // A duplicate copy never overwrites the session row of the copy that owns the turn.
    if (!store || s.duplicateOf !== undefined) return
    try {
      store.sessions.upsert(this.sessionWrite(s, rctx))
    } catch (e) {
      this.ctx.logger.warn({ err: e }, 'could not store the session')
    }
  }

  /** True while another search-hole copy owns this hook session's turn (see `duplicateOf`). */
  isDuplicate(rctx: RequestCtx): boolean {
    const key = rctx.session?.key
    return key !== undefined && this.sessions.get(key)?.duplicateOf !== undefined
  }

  /** True when this receipt exists here or in the store. */
  private known(id: string, store: Store | null): boolean {
    if (this.receipts.has(id)) return true
    try {
      return store?.receipts.get(id) !== undefined
    } catch {
      return false
    }
  }

  /** Picks the receipt for a search or fetch (see the module comment). */
  assign(
    rctx: RequestCtx,
    requested: string | undefined,
    store: Store | null,
  ): { receiptId: string; warnings: Warning[] } {
    const warnings: Warning[] = []
    const now = this.ctx.now()
    const sess = rctx.session
    if (requested !== undefined) {
      if (isReceiptId(requested) && this.known(requested, store)) {
        if (!this.receipts.has(requested)) {
          const r: MemReceipt = { id: requested, startedAt: now, searches: [], sources: [], warnings: [] }
          if (sess) r.sessionKey = sess.key
          this.remember(r)
          this.hydrate(r, store)
        }
        this.persistReceipt(requested, sess?.key, store)
        if (sess) {
          const s = this.session(sess, store)
          s.lastReceiptId = requested
          s.lastActivity = now
          this.persistSession(s, rctx, store)
        }
        return { receiptId: requested, warnings }
      }
      warnings.push({ code: 'receipt_expired', previous: requested.slice(0, 64) })
    }
    if (!sess || sess.source === 'fallback') {
      const id = newReceiptId()
      this.create(id, sess?.key, store)
      if (sess) {
        const s = this.session(sess, store)
        s.lastReceiptId = id
        s.lastActivity = now
        this.persistSession(s, rctx, store)
      }
      return { receiptId: id, warnings }
    }
    const s = this.session(sess, store)
    let id: string | undefined
    if (sess.source === 'hook') {
      if (s.openReceiptId) id = s.openReceiptId
      else if (s.lastStopReceiptId) {
        // ADR-0014 point 1: a call between Stop and the next prompt means the Stop was premature.
        id = s.lastStopReceiptId
        this.ctx.logger.info({ receiptId: id }, 'turn reopened: a call arrived after Stop')
        const r = this.receipts.get(id)
        if (r) delete r.closedAt
        try {
          store?.receipts.reopen(id)
        } catch {
          // Memory is authoritative here.
        }
      }
      s.turnOpen = true
    } else if (s.openReceiptId && now - s.lastActivity <= RECEIPT_IDLE_MS) {
      id = s.openReceiptId
    }
    if (id === undefined) {
      id = newReceiptId()
      this.create(id, sess.key, store)
    } else {
      if (!this.receipts.has(id)) {
        const r: MemReceipt = {
          id,
          sessionKey: sess.key,
          startedAt: now,
          searches: [],
          sources: [],
          warnings: [],
        }
        this.remember(r)
        this.hydrate(r, store)
      }
      this.persistReceipt(id, sess.key, store)
    }
    s.openReceiptId = id
    s.lastReceiptId = id
    s.lastActivity = now
    this.persistSession(s, rctx, store)
    return { receiptId: id, warnings }
  }

  /** Copies what the store already knows about a receipt into memory (another process's searches). */
  private hydrate(r: MemReceipt, store: Store | null): void {
    const built = store ? this.fromStore(r.id, store, {}) : null
    if (!built) return
    r.searches = [...built.searches]
    r.sources = [...built.sources]
    r.startedAt = Date.parse(built.startedAt)
  }

  /** Adds a search line to a receipt. */
  noteSearch(receiptId: string, line: ReceiptSearchLine): void {
    const r =
      this.receipts.get(receiptId) ??
      this.remember({
        id: receiptId,
        startedAt: this.ctx.now(),
        searches: [],
        sources: [],
        warnings: [],
      })
    r.searches.push(line)
  }

  /** Adds an opened source to a receipt. */
  noteSource(receiptId: string, source: ReceiptSource): void {
    const r =
      this.receipts.get(receiptId) ??
      this.remember({
        id: receiptId,
        startedAt: this.ctx.now(),
        searches: [],
        sources: [],
        warnings: [],
      })
    r.sources.push(source)
  }

  /** UserPromptSubmit: a new turn receipt for the session (closing a turn left open). */
  openTurn(rctx: RequestCtx, store: Store | null): { receiptId: string } {
    const sess = rctx.session
    const id = newReceiptId()
    if (!sess) {
      this.create(id, undefined, store)
      return { receiptId: id }
    }
    const s = this.session(sess, store)
    if (s.turnOpen && s.openReceiptId) this.markClosed(s.openReceiptId, store)
    this.create(id, sess.key, store)
    s.openReceiptId = id
    s.lastReceiptId = id
    s.turnOpen = true
    delete s.lastStopReceiptId
    delete s.duplicateOf
    s.lastActivity = this.ctx.now()
    if (sess.source === 'hook' && store) {
      let claim: ReturnType<Store['sessions']['claimTurn']>
      try {
        claim = store.sessions.claimTurn(
          { ...this.sessionWrite(s, rctx), gatewayId: this.ctx.gatewayId, openReceiptId: id },
          DUPLICATE_TURN_WINDOW_MS,
        )
      } catch (e) {
        this.ctx.logger.warn({ err: e }, 'could not store the session')
      }
      if (claim?.kind === 'duplicate') {
        s.duplicateOf = claim.of
        this.ctx.logger.warn(
          { duplicateOf: claim.of },
          'another search-hole copy serves this session; this one stays quiet for the turn',
        )
      }
      if (claim !== undefined) return { receiptId: id }
    }
    this.persistSession(s, rctx, store)
    return { receiptId: id }
  }

  private markClosed(id: string, store: Store | null): void {
    const r = this.receipts.get(id)
    if (r) r.closedAt = this.ctx.now()
    try {
      store?.receipts.close(id)
    } catch {
      // Memory is authoritative here.
    }
  }

  /** Stop: closes the turn and returns the one-line receipt when the turn searched. */
  closeTurn(
    rctx: RequestCtx,
    store: Store | null,
    lineEnabled: boolean,
  ): { receiptLine?: string; receiptId?: string } {
    const sess = rctx.session
    if (!sess) return {}
    const s = this.session(sess, store)
    const id = s.openReceiptId
    if (id === undefined) return {}
    this.markClosed(id, store)
    delete s.openReceiptId
    s.turnOpen = false
    s.lastStopReceiptId = id
    s.lastActivity = this.ctx.now()
    this.persistSession(s, rctx, store)
    const c = this.counts(id, store)
    if (s.duplicateOf !== undefined || c.searches === 0 || !lineEnabled) return { receiptId: id }
    return { receiptId: id, receiptLine: turnLine(id, c) }
  }

  private counts(id: string, store: Store | null) {
    const r = this.receipts.get(id) ?? (store ? this.fromStore(id, store, {}) : null)
    const searches = r?.searches ?? []
    return {
      searches: searches.length,
      builtin: searches.filter((s) => s.mode === 'builtin').length,
      kept: searches.reduce((n, s) => n + s.kept, 0),
      hidden: searches.reduce((n, s) => n + s.hidden, 0),
      opened: r?.sources.length ?? 0,
    }
  }

  /** Receipts by id (unknown ids are an error), or the session's most recent one. */
  get(
    ids: readonly string[] | undefined,
    rctx: RequestCtx,
    store: Store | null,
    freshness: Freshness,
  ): Receipt[] {
    if (ids !== undefined && ids.length > 0) {
      return ids.map((id) => {
        const r = this.build(id, store, freshness)
        if (!r) {
          throw new SearchHoleError('invalid_argument', `Unknown receipt id "${id.slice(0, 40)}".`, {
            fix: 'Pass a receiptId returned by search or fetch.',
          })
        }
        return r
      })
    }
    const sess = rctx.session
    if (!sess || sess.source === 'fallback') {
      throw new SearchHoleError(
        'invalid_argument',
        "This host doesn't identify chats, so the latest receipt could belong to another conversation.",
        { fix: 'Pass receiptIds (the receiptId returned by search or fetch).' },
      )
    }
    let id = this.sessions.get(sess.key)?.lastReceiptId
    if (id === undefined) {
      try {
        id = store?.receipts.latestForSession(sess.key)?.id
      } catch {
        id = undefined
      }
    }
    if (id === undefined) return []
    const r = this.build(id, store, freshness)
    return r ? [r] : []
  }

  private build(id: string, store: Store | null, freshness: Freshness): Receipt | null {
    const mem = this.receipts.get(id)
    const warnings: string[] = []
    const status = store?.status()
    if (status && status.mode !== 'read-write') warnings.push(status.message)
    if (mem) {
      const out: Receipt = {
        receiptId: id,
        startedAt: new Date(mem.startedAt).toISOString(),
        searches: [...mem.searches],
        sources: [...mem.sources],
        warnings: [...mem.warnings, ...warnings],
        summaryLine: summaryLine(mem.searches, mem.sources),
      }
      if (mem.sessionKey !== undefined) out.sessionKey = mem.sessionKey
      if (mem.closedAt !== undefined) out.closedAt = new Date(mem.closedAt).toISOString()
      return out
    }
    if (!store) return null
    const built = this.fromStore(id, store, freshness)
    if (!built) return null
    built.warnings.push(...warnings)
    return built
  }

  /** Rebuilds a receipt from the log (searches, results, fetches). */
  private fromStore(id: string, store: Store, freshness: Freshness): Receipt | null {
    try {
      const row = store.receipts.get(id)
      if (!row) return null
      const rows = store.searchLog.byReceipt(id)
      const reasons = store.searchLog.hiddenReasons(rows.map((s) => s.id))
      const searches: ReceiptSearchLine[] = rows.map((s) => {
        const byReason: Partial<Record<HiddenReason, number>> = {}
        for (const [k, v] of Object.entries(reasons.get(s.id) ?? {})) {
          if (HIDDEN_REASONS.has(k)) byReason[k as HiddenReason] = v
        }
        return {
          query: s.queryRedacted,
          at: new Date(s.createdAt).toISOString(),
          mode: s.mode,
          engines: s.engines
            .filter((e) => e.status !== 'skipped' && ENGINE_IDS.has(e.engine))
            .map((e) => e.engine as EngineId),
          kept: s.keptCount,
          hidden: s.hiddenCount,
          hiddenByReason: byReason,
        }
      })
      const now = this.ctx.now()
      const sources: ReceiptSource[] = store.fetches
        .byReceipt(id)
        .filter((f) => f.decision === 'opened')
        .map((f) => {
          const url =
            f.finalUrl ??
            f.url ??
            this.urls.get(f.finalUrlHash ?? f.urlHash) ??
            this.urls.get(f.urlHash) ??
            (f.host ? `https://${f.host}/` : 'about:blank')
          const dates = foundDates(f.dates)
          const src: ReceiptSource = {
            url,
            dates,
            sourceType: classifySource(url, { typedLists: () => [] }),
            freshness: judgeFreshness(dates, freshness, now).status,
          }
          if (f.title !== null) src.title = f.title
          if (f.status !== null) src.status = f.status
          return src
        })
      const out: Receipt = {
        receiptId: id,
        startedAt: new Date(row.createdAt).toISOString(),
        searches,
        sources,
        warnings: [],
        summaryLine: summaryLine(searches, sources),
      }
      if (row.sessionId !== null) out.sessionKey = row.sessionId
      if (row.closedAt !== null) out.closedAt = new Date(row.closedAt).toISOString()
      return out
    } catch (e) {
      this.ctx.logger.warn({ err: e }, 'could not read the receipt from the log')
      return null
    }
  }
}
