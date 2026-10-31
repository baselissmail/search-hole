// SPDX-License-Identifier: Apache-2.0
/**
 * The `hook` tool: answers search-hole's own Claude Code `mcp_tool` hooks (ADR-0014,
 * ADR-0018). Claude Code parses the tool's text like a command hook's stdout, so every answer
 * is one JSON object; `{}` means "no opinion". Every failure answers `{}` (fail open): a hook
 * must never break the user's session.
 *
 * Event table:
 * - SessionStart(startup|resume|clear|compact), UserPromptSubmit: turn bracketing and re-key
 *   (session.ts), `app.openTurn`.
 * - PreToolUse WebSearch: query hygiene; `engines` mode steers to our `search` (deny), with a
 *   deny-loop breaker; otherwise builtin behaviour injects the user's domain blocks.
 * - PostToolUse WebSearch: rules applied to the results (`app.filterBuiltinResults`), the
 *   result list rebuilt in the recorded shape.
 * - PreToolUse WebFetch: blocked sites denied. PostToolUse WebFetch: recorded for the receipt.
 * - PreToolUse Bash / Edit / Write / MultiEdit / NotebookEdit: the rule-change guard.
 * - Stop: closes the turn; a `systemMessage` only (never `additionalContext` or `decision`,
 *   which would make Claude keep working).
 *
 * Builtin-behaviour finding (Claude Code 2.1.312, recorded 2026-10-30): the hooks docs
 * describe `updatedInput` only with `permissionDecision` "allow" (auto-approve) or "ask", and
 * say nothing about omitting it. The 2.1.312 binary applies `updatedInput` from a PreToolUse
 * hook that returns no `permissionDecision` as a plain input rewrite and keeps the normal
 * permission flow. We therefore omit `permissionDecision` and never auto-allow WebSearch on
 * the user's behalf; the plugin end-to-end check must confirm `blocked_domains` arrives.
 */
import { homedir } from 'node:os'
import type { App, RequestCtx } from '../app/types.ts'
import { describeFindings, type Finding, type FindingClass } from '../core/hygiene.ts'
import type { Logger } from '../shared/log.ts'
import {
  collectResults,
  parseJsonValue,
  parseWebSearchInput,
  parseWebSearchResponse,
  planBuiltinInput,
  rebuildWebSearchResponse,
} from './builtin.ts'
import {
  bashChangesRules,
  FILE_WRITE_TOOLS,
  fileIsProtected,
  GUARD_DENY_REASON,
  type ProtectedRoots,
} from './guard.ts'
import { oneLine } from './render.ts'
import type { HookInput } from './schemas.ts'
import type { GatewaySessions } from './session.ts'

/** Our tools as Claude Code names them for a plugin server (ADR-0014). */
export const PLUGIN_TOOL_PREFIX = 'mcp__plugin_search-hole_search-hole__'

/** ADR-0014 point 2: the steering reason shown to Claude when WebSearch is denied. */
export const STEER_REASON = `search-hole is active: use ${PLUGIN_TOOL_PREFIX}search (and ${PLUGIN_TOOL_PREFIX}fetch for pages) instead of WebSearch; site: operators work. It applies the user's source rules.`

/** Context added when the deny-loop breaker lets WebSearch through. */
export const LOOP_BREAK_NOTE = `search-hole: built-in WebSearch allowed because ${PLUGIN_TOOL_PREFIX}search was not used, or failed, after the last denial; results are still filtered by the user's rules.`

/** Context added when a WebSearch response has a shape we can't read (fail open, but say so). */
export const UNREADABLE_NOTE =
  "search-hole could not read this WebSearch result format, so the user's source rules were not applied to these results."

/** Longest Stop `systemMessage` we send (Claude Code caps hook strings at 10,000 characters). */
const MAX_SYSTEM_MESSAGE_CHARS = 1_000

/** A hook answer: Claude Code reads it like command-hook stdout. */
export type HookOutput = Record<string, unknown>

/** What the hook handler needs from the gateway. */
export interface HookDeps {
  sessions: GatewaySessions
  getApp(): Promise<App>
  log: Logger
  /** Config and data roots plus `~/.searchhole` (computed once, lazily). */
  protectedRoots(): ProtectedRoots
  /** Resolves relative file paths when the request has no project directory. */
  cwd: string
}

const FILE_TOOLS = new Set(Object.keys(FILE_WRITE_TOOLS))
/** Built-in tools whose use after a Stop reopens the turn (ADR-0014 point 1). */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch'])

const KNOWN_CLASSES: ReadonlySet<string> = new Set<FindingClass>([
  'api_key',
  'jwt',
  'private_key',
  'connection_string',
  'secret_assignment',
  'high_entropy',
  'internal_host',
  'private_ip',
])

/** "an API key or access token and a private network address" from hygiene class codes. */
export function describeClasses(classes: readonly string[]): string {
  const findings: Finding[] = classes
    .filter((c): c is FindingClass => KNOWN_CLASSES.has(c))
    .map((c) => ({ class: c, detector: c, start: 0, end: 0 }))
  return describeFindings(findings)
}

const deny = (reason: string): HookOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
})

/** A usable string value; "" and a `${...}` placeholder the host did not substitute are not. */
const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' && !/^\$\{[^}]*\}$/.test(v.trim()) ? v : undefined

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The tool input object: the JSON string `toolInput`, else the lean single fields. */
function toolInputOf(input: HookInput): Record<string, unknown> {
  const parsed = parseJsonValue(input.toolInput)
  if (isRecord(parsed)) return parsed
  const out: Record<string, unknown> = {}
  if (nonEmpty(input.query) !== undefined) out.query = input.query
  if (nonEmpty(input.command) !== undefined) out.command = input.command
  if (nonEmpty(input.filePath) !== undefined) out.file_path = input.filePath
  if (nonEmpty(input.url) !== undefined) out.url = input.url
  return out
}

const withSession = (ctx: RequestCtx, key: string): RequestCtx => ({
  ...ctx,
  session: { key, source: 'hook' },
})

/** Answers one hook call. Never throws: any failure is logged and answered with `{}`. */
export async function handleHook(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  try {
    return await dispatch(input, ctx, deps)
  } catch (err) {
    deps.log.warn(
      { err, event: input.event, toolName: input.toolName },
      'hook failed; answering {} (fail open)',
    )
    return {}
  }
}

async function dispatch(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  switch (input.event) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      return beginTurn(input.event, input, ctx, deps)
    case 'PreToolUse':
    case 'PostToolUse': {
      // The hook's own session id, not the process key: after /clear the two can differ.
      const key = nonEmpty(input.sessionId)
      deps.sessions.noteActivity(key)
      if (SEARCH_TOOLS.has(input.toolName ?? '') && deps.sessions.reopenAfterSuspectStop()) {
        deps.log.info(
          { toolName: input.toolName },
          'built-in search or fetch after Stop: the turn was reopened',
        )
      }
      const hookCtx = key === undefined ? ctx : withSession(ctx, key)
      return input.event === 'PreToolUse'
        ? preToolUse(input, hookCtx, deps)
        : postToolUse(input, hookCtx, deps)
    }
    case 'Stop':
      return stop(input, ctx, deps)
    default:
      return {}
  }
}

async function beginTurn(
  event: 'SessionStart' | 'UserPromptSubmit',
  input: HookInput,
  ctx: RequestCtx,
  deps: HookDeps,
): Promise<HookOutput> {
  const decision = deps.sessions.beginTurn(event, input.sessionId ?? '', nonEmpty(input.source))
  if (decision.kind !== 'open') {
    if (decision.kind === 'refused') deps.log.warn({ event, reason: decision.reason }, 'turn not opened')
    return {}
  }
  const app = await deps.getApp()
  if (decision.replaced !== undefined) {
    // The previous turn ended without a Stop (an interrupt): close it without a line.
    await app.closeTurn(withSession(ctx, decision.replaced.key)).catch((err: unknown) => {
      deps.log.warn({ err }, 'closing an abandoned turn failed')
    })
  }
  if (decision.rekeyed) {
    deps.log.info({ event, source: input.source, previousKey: decision.previousKey }, 'hook session re-keyed')
  }
  const source = input.source
  if (
    event === 'SessionStart' &&
    decision.previousKey !== undefined &&
    (source === 'resume' || source === 'compact' || source === 'clear')
  ) {
    // ADR-0005: resume and compact carry the session's rules over; clear drops them.
    await app
      .rekeySession?.(decision.previousKey, withSession(ctx, decision.key), source)
      .catch((err: unknown) => {
        deps.log.warn({ err }, 'moving session rules to the new session failed')
      })
  }
  await app.openTurn(withSession(ctx, decision.key))
  return {}
}

async function preToolUse(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const tool = input.toolName ?? ''
  if (tool === 'WebSearch') return preWebSearch(input, ctx, deps)
  if (tool === 'WebFetch') return preWebFetch(input, ctx, deps)
  if (tool === 'Bash') return guardBash(input, ctx, deps)
  if (FILE_TOOLS.has(tool)) return guardFile(tool, input, ctx, deps)
  return {}
}

async function postToolUse(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const tool = input.toolName ?? ''
  if (tool === 'WebSearch') return postWebSearch(input, ctx, deps)
  if (tool === 'WebFetch') {
    const url = nonEmpty(toolInputOf(input).url)
    if (url === undefined) return {}
    const app = await deps.getApp()
    await app.recordBuiltinFetch(url, ctx)
  }
  return {}
}

async function preWebSearch(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const toolInput = parseWebSearchInput(toolInputOf(input))
  if (toolInput === null) {
    deps.log.warn('PreToolUse WebSearch: unrecognised tool_input; not filtered')
    return {}
  }
  const query = toolInput.query?.trim() ?? ''
  if (query === '') return {}
  const app = await deps.getApp()
  const hygiene = app.checkQuery(query)
  if (hygiene.action === 'block') {
    return deny(
      `search-hole blocked this search: the query looks like it contains ${describeClasses(hygiene.classes)}, so it was not sent → remove that part and search again.`,
    )
  }
  const effectiveQuery = hygiene.action === 'redact' ? hygiene.query : (toolInput.query ?? query)
  const sessionId = nonEmpty(input.sessionId) ?? ctx.session?.key ?? ''
  const agentType = input.agentType ?? ''
  const notes: string[] = []
  const mode = await app.searchMode()
  if (mode.effective === 'engines') {
    if (!deps.sessions.denyLoopBroken(sessionId, agentType)) {
      deps.sessions.recordDeny(sessionId, agentType)
      return deny(STEER_REASON)
    }
    deps.log.info({ agentType }, 'deny-loop breaker: filtered built-in WebSearch allowed')
    notes.push(LOOP_BREAK_NOTE)
  }
  if (hygiene.action === 'redact') {
    notes.push(`search-hole removed ${describeClasses(hygiene.classes)} from the query before searching.`)
  }
  const blocked = await app.builtinBlockedDomains(ctx, effectiveQuery)
  const plan = planBuiltinInput(toolInput, blocked, effectiveQuery)
  if (plan.kind === 'all_allowed_blocked') {
    return deny(
      "search-hole: every domain in allowed_domains is blocked by the user's rules → search other sites, or ask the user.",
    )
  }
  const out: Record<string, unknown> = { hookEventName: 'PreToolUse' }
  if (plan.kind === 'rewrite') out.updatedInput = plan.input
  if (notes.length > 0) out.additionalContext = notes.join(' ')
  return plan.kind === 'rewrite' || notes.length > 0 ? { hookSpecificOutput: out } : {}
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** One line for the model: what search-hole did to a built-in WebSearch. */
export function builtinNote(
  excludedSites: number,
  hidden: number,
  pinned: number,
  receiptId: string,
): string {
  const parts = [
    excludedSites > 0 ? `excluded ${plural(excludedSites, 'blocked site')} before the search` : '',
    hidden > 0 ? `hid ${plural(hidden, 'result')}` : '',
    pinned > 0 ? `pinned ${plural(pinned, 'result')}` : '',
  ].filter(Boolean)
  const did = parts.length > 0 ? parts.join(', ') : 'checked every result (none matched a rule)'
  return `search-hole applied the user's source rules to this search: ${did} · receipt ${receiptId}`
}

async function postWebSearch(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const resp = parseWebSearchResponse(input.toolResponse)
  if (resp === null) {
    deps.log.warn('PostToolUse WebSearch: unrecognised tool_response shape; results not filtered (fail open)')
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: UNREADABLE_NOTE } }
  }
  const toolInput = parseWebSearchInput(toolInputOf(input))
  const query = toolInput?.query ?? resp.query ?? ''
  const app = await deps.getApp()
  const filter = await app.filterBuiltinResults(query, collectResults(resp), ctx)
  const rebuilt = rebuildWebSearchResponse(resp, filter)
  const out: Record<string, unknown> = { hookEventName: 'PostToolUse' }
  if (rebuilt !== null) out.updatedToolOutput = rebuilt
  // Always say what happened, so the model never concludes the user's rules were skipped (E2E 2026-10-30).
  out.additionalContext = builtinNote(
    toolInput?.blocked_domains?.length ?? 0,
    filter.hidden.length,
    filter.pinned,
    filter.receiptId,
  )
  return { hookSpecificOutput: out }
}

async function preWebFetch(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const url = nonEmpty(toolInputOf(input).url)
  if (url === undefined) return {}
  const app = await deps.getApp()
  const verdict = await app.checkUrl(url, ctx)
  if (verdict.allowed) return {}
  return deny(`search-hole: ${oneLine(verdict.message, 500)}`)
}

async function guardEnabled(deps: HookDeps): Promise<boolean> {
  try {
    const settings = await (await deps.getApp()).settings.get()
    const hooks = settings.hooks
    return !(isRecord(hooks) && hooks.guard === false)
  } catch {
    return true
  }
}

async function guardBash(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const command = nonEmpty(toolInputOf(input).command)
  if (command === undefined) return {}
  const roots = deps.protectedRoots()
  const files = { roots, baseDir: ctx.projectDir ?? deps.cwd, home: roots.home ?? homedir() }
  if (!bashChangesRules(command, files)) return {}
  if (!(await guardEnabled(deps))) return {}
  deps.log.warn({ agentType: input.agentType }, 'guard: denied a Bash call to a rule-changing command')
  return deny(GUARD_DENY_REASON)
}

async function guardFile(
  tool: string,
  input: HookInput,
  ctx: RequestCtx,
  deps: HookDeps,
): Promise<HookOutput> {
  const field = FILE_WRITE_TOOLS[tool] ?? 'file_path'
  const fields = toolInputOf(input)
  const filePath = nonEmpty(fields[field]) ?? nonEmpty(fields.file_path)
  if (filePath === undefined) return {}
  const base = ctx.projectDir ?? deps.cwd
  if (!fileIsProtected(filePath, base, deps.protectedRoots())) return {}
  if (!(await guardEnabled(deps))) return {}
  deps.log.warn({ tool, agentType: input.agentType }, 'guard: denied an edit to a search-hole file')
  return deny(GUARD_DENY_REASON)
}

async function stop(input: HookInput, ctx: RequestCtx, deps: HookDeps): Promise<HookOutput> {
  const decision = deps.sessions.endTurn(input.sessionId ?? '')
  if (decision.kind !== 'close') return {}
  const app = await deps.getApp()
  const closed = await app.closeTurn(withSession(ctx, decision.turn.key))
  const line = closed.receiptLine === undefined ? '' : oneLine(closed.receiptLine, MAX_SYSTEM_MESSAGE_CHARS)
  return line === '' ? {} : { systemMessage: line }
}
