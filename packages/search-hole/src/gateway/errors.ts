// SPDX-License-Identifier: Apache-2.0
/**
 * Tool execution errors (ADR-0012 "Behaviour"): `isError: true` results with a cause and a
 * next step ("why → fix"). JSON-RPC errors are left to the SDK for protocol faults only.
 */
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { HostProfile } from '../app/types.ts'
import { isSearchHoleError } from '../shared/errors.ts'
import type { Logger } from '../shared/log.ts'

/** Shown when something failed that has no user-facing explanation. */
export const INTERNAL_ERROR_TEXT =
  'search-hole hit an internal error → try again; if it keeps happening, ask the user to run /search-hole:doctor (details are in the gateway log)'

/**
 * What the model should do when no engine is set up (ADR-0018): use the built-in search,
 * which search-hole filters in Claude Code, instead of retrying this tool.
 */
export const NO_ENGINE_GUIDANCE =
  'Use your built-in web search for this request instead (in Claude Code, search-hole filters it with the same rules); do not retry this tool. For better results the user can run /search-hole:searxng up or add a free Tavily key.'

/**
 * The same moment in every other host: there is no filtered built-in search to fall back on,
 * and `/search-hole:…` commands don't exist there.
 */
export const NO_ENGINE_GUIDANCE_OTHER =
  "Ask the user to set up an engine: a free Tavily key (in this app's search-hole settings, or `searchhole keys set tavily` in a terminal) or a private SearXNG (`searchhole searxng up`, needs Docker). Do not retry this tool until they have. search-hole cannot filter any other web search you use meanwhile, so say so if you use one."

/** An `isError` tool result with one text block. */
export function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Maps a thrown error to a tool error: typed errors explain themselves, others are logged. */
export function toolErrorFrom(
  err: unknown,
  log: Logger,
  tool: string,
  host: HostProfile = 'claude-code',
): CallToolResult {
  if (isSearchHoleError(err)) {
    log.info({ tool, code: err.code }, 'tool error')
    if (err.code === 'no_healthy_engine') {
      return toolError(`${err.why} ${host === 'claude-code' ? NO_ENGINE_GUIDANCE : NO_ENGINE_GUIDANCE_OTHER}`)
    }
    return toolError(err.toUserText())
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return toolError('The request was cancelled → nothing was searched or opened past that point.')
  }
  log.error({ tool, err }, 'tool failed')
  return toolError(INTERNAL_ERROR_TEXT)
}
