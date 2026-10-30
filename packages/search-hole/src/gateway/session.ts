// SPDX-License-Identifier: Apache-2.0
/**
 * Per-process session state (ADR-0005 session chain, ADR-0014 point 1 turn bracketing,
 * ADR-0014 point 2 deny-loop breaker). Pure state with an injected clock: the hook handler
 * decides, the App records.
 *
 * Turn bracketing, as implemented:
 * - `UserPromptSubmit` and `SessionStart(startup|resume|clear|compact)` may open a turn and
 *   re-key the hook session, but a *different* key is accepted only while no turn is open.
 * - Claude Code does not run Stop after a user interrupt, so a turn can stay open forever.
 *   A turn with no activity (hooks, `search`, `fetch`) for `STALE_TURN_MS` counts as
 *   abandoned and may be replaced. This is defence in depth only: the `hook` tool is hidden
 *   from the model in Claude Code (spikes §1), so forged calls are a future-host concern.
 * - `UserPromptSubmit` with the current key while a turn is open replaces that turn (the
 *   previous one ended without a Stop). `SessionStart` mid-turn (auto-compaction) is a no-op.
 * - `Stop` closes the turn only when its session id is the turn's key.
 */
import { sessionKeyFromMeta } from './host-keys.ts'

/** A turn idle this long may be replaced by a different session's prompt (see file header). */
export const STALE_TURN_MS = 10_000
/** Fallback sessions start afresh after this idle gap (ADR-0005 source 4). */
export const FALLBACK_IDLE_MS = 30 * 60_000
/** `SessionStart` sources that may re-key (ADR-0014 point 1). */
export const REKEY_SOURCES: ReadonlySet<string> = new Set(['startup', 'resume', 'clear', 'compact'])
/** Bound on remembered WebSearch denials (one per session and agent type). */
const MAX_DENY_RECORDS = 256

type Env = Readonly<Record<string, string | undefined>>

export interface OpenTurn {
  key: string
  openedAt: number
  lastActivityAt: number
}

/** What a turn-opening hook event should do. */
export type BeginTurnDecision =
  | { kind: 'open'; key: string; rekeyed: boolean; previousKey?: string; replaced?: OpenTurn }
  | { kind: 'noop'; reason: 'turn_open' | 'source' }
  | { kind: 'refused'; reason: 'no_session' | 'turn_active' }

/** What a Stop hook event should do. */
export type EndTurnDecision = { kind: 'close'; turn: OpenTurn } | { kind: 'none' } | { kind: 'mismatch' }

export interface GatewaySessionsOptions {
  host: string
  pid: number
  env: Env
  now: () => number
}

/** Session resolution and turn state for one gateway process. */
export class GatewaySessions {
  /** The hook-reported key (ADR-0005 source 1), once a hook has reported one. */
  hookKey: string | undefined
  turn: OpenTurn | undefined
  lastStopAt: number | undefined
  /** `search` tool calls served by this process (deny-loop breaker). */
  searchCalls = 0

  private readonly host: string
  private readonly pid: number
  private readonly env: Env
  private readonly now: () => number
  private fallback: { key: string; lastSeen: number } | undefined
  private readonly denies = new Map<string, number>()

  constructor(opts: GatewaySessionsOptions) {
    this.host = opts.host
    this.pid = opts.pid
    this.env = opts.env
    this.now = opts.now
  }

  /** ADR-0005 chain: hook key, host `_meta` key, spawn env, then the approximate fallback label. */
  resolve(meta: Readonly<Record<string, unknown>>): {
    key: string
    source: 'hook' | 'meta' | 'env' | 'fallback'
  } {
    if (this.hookKey !== undefined) return { key: this.hookKey, source: 'hook' }
    const fromMeta = sessionKeyFromMeta(meta)
    if (fromMeta !== undefined) return { key: fromMeta, source: 'meta' }
    const fromEnv = this.env.CLAUDE_CODE_SESSION_ID?.trim()
    if (fromEnv !== undefined && fromEnv !== '') return { key: fromEnv, source: 'env' }
    return { key: this.fallbackKey(), source: 'fallback' }
  }

  private fallbackKey(): string {
    const now = this.now()
    if (this.fallback === undefined || now - this.fallback.lastSeen > FALLBACK_IDLE_MS) {
      this.fallback = { key: `fallback:${this.host}:${this.pid}:${now.toString(36)}`, lastSeen: now }
    } else {
      this.fallback.lastSeen = now
    }
    return this.fallback.key
  }

  /** Marks the open turn as active (hooks, `search`, `fetch`). */
  noteActivity(): void {
    if (this.turn !== undefined) this.turn.lastActivityAt = this.now()
  }

  /** `UserPromptSubmit` / `SessionStart`: may open a turn and re-key (see file header). */
  beginTurn(
    event: 'UserPromptSubmit' | 'SessionStart',
    sessionId: string,
    source?: string,
  ): BeginTurnDecision {
    if (sessionId.trim() === '') return { kind: 'refused', reason: 'no_session' }
    if (event === 'SessionStart' && (source === undefined || !REKEY_SOURCES.has(source))) {
      return { kind: 'noop', reason: 'source' }
    }
    const now = this.now()
    const open = this.turn
    let replaced: OpenTurn | undefined
    if (open !== undefined) {
      const stale = now - open.lastActivityAt >= STALE_TURN_MS
      if (open.key === sessionId) {
        if (event === 'SessionStart') return { kind: 'noop', reason: 'turn_open' }
        replaced = open
      } else if (stale) {
        replaced = open
      } else {
        return { kind: 'refused', reason: 'turn_active' }
      }
    }
    const previousKey = this.hookKey
    const rekeyed = previousKey !== sessionId
    this.hookKey = sessionId
    this.turn = { key: sessionId, openedAt: now, lastActivityAt: now }
    return {
      kind: 'open',
      key: sessionId,
      rekeyed,
      ...(previousKey !== undefined && rekeyed ? { previousKey } : {}),
      ...(replaced !== undefined ? { replaced } : {}),
    }
  }

  /** `Stop`: closes the open turn when the session id matches its key. */
  endTurn(sessionId: string): EndTurnDecision {
    const open = this.turn
    if (open === undefined) return { kind: 'none' }
    if (open.key !== sessionId) return { kind: 'mismatch' }
    this.turn = undefined
    this.lastStopAt = this.now()
    return { kind: 'close', turn: open }
  }

  /**
   * A `search`/`fetch` after a Stop and before the next prompt marks that Stop as suspect
   * (ADR-0014 point 1): the turn is reopened. Returns true when it was.
   */
  reopenAfterSuspectStop(): boolean {
    if (this.hookKey === undefined || this.turn !== undefined || this.lastStopAt === undefined) return false
    const now = this.now()
    this.turn = { key: this.hookKey, openedAt: now, lastActivityAt: now }
    return true
  }

  /** Counts a `search` tool call (it resets the deny-loop breaker). */
  noteSearchCall(): void {
    this.searchCalls++
  }

  /** Remembers that WebSearch was denied for this session and agent type. */
  recordDeny(sessionId: string, agentType: string): void {
    const key = denyKey(sessionId, agentType)
    this.denies.delete(key)
    this.denies.set(key, this.searchCalls)
    while (this.denies.size > MAX_DENY_RECORDS) {
      const oldest = this.denies.keys().next().value
      if (oldest === undefined) break
      this.denies.delete(oldest)
    }
  }

  /** True when the last WebSearch here was denied and no `search` call has happened since. */
  denyLoopBroken(sessionId: string, agentType: string): boolean {
    const at = this.denies.get(denyKey(sessionId, agentType))
    return at !== undefined && at === this.searchCalls
  }
}

const denyKey = (sessionId: string, agentType: string): string => `${sessionId}\u0000${agentType}`
