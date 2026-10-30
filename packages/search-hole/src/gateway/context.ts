// SPDX-License-Identifier: Apache-2.0
/**
 * The one request-context helper (ADR-0013 point 4): hides the protocol-era difference from
 * tool code, then resolves the App's `RequestCtx` (ADR-0005 session and project directory).
 *
 * - Modern (2026-07-28) requests carry the client's identity in the per-request envelope,
 *   which the SDK lifts to `ctx.mcpReq.envelope`.
 * - Legacy (2025) connections report it once at `initialize`; the SDK keeps it on the
 *   low-level `Server` (`getClientVersion()` and friends).
 * - Vendor keys (`claudecode/toolUseId`, `openai/session`, ...) stay in `ctx.mcpReq._meta`
 *   in both eras.
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import type { RequestCtx } from '../app/types.ts'
import { projectDirFromMeta, toolUseIdFromMeta } from './host-keys.ts'
import type { GatewaySessions } from './session.ts'

type Env = Readonly<Record<string, string | undefined>>

/** What one MCP request tells us about its caller, whatever the era. */
export interface McpRequestInfo {
  era: 'modern' | 'legacy'
  protocolVersion?: string
  clientInfo?: { name: string; version?: string }
  capabilities?: Readonly<Record<string, unknown>>
  /** Request `_meta` without the reserved envelope keys (vendor keys live here). */
  vendorMeta: Readonly<Record<string, unknown>>
  toolUseId?: string
  progressToken?: string | number
  signal?: AbortSignal
}

/** The parts of the SDK handler context the helper reads (structural, so tests can fake it). */
export interface HandlerContextLike {
  mcpReq: { _meta?: unknown; envelope?: unknown; signal?: AbortSignal }
}

/** Where a legacy connection's `initialize` data lives (the SDK's low-level `Server`). */
export interface LegacyClientSource {
  getClientVersion(): { name: string; version: string } | undefined
  getClientCapabilities(): unknown
  getNegotiatedProtocolVersion(): string | undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function implementation(v: unknown): { name: string; version?: string } | undefined {
  if (!isRecord(v) || typeof v.name !== 'string' || v.name === '') return undefined
  return typeof v.version === 'string' ? { name: v.name, version: v.version } : { name: v.name }
}

/**
 * Era-agnostic request context (ADR-0013 point 4). `era` is the era the serving instance was
 * built for; a request carrying an envelope is modern whatever the caller says.
 */
export function requestContext(
  ctx: HandlerContextLike,
  era: 'modern' | 'legacy',
  legacy?: LegacyClientSource,
): McpRequestInfo {
  const envelope = isRecord(ctx.mcpReq.envelope) ? ctx.mcpReq.envelope : undefined
  const meta = isRecord(ctx.mcpReq._meta) ? ctx.mcpReq._meta : {}
  const effectiveEra = envelope === undefined ? era : 'modern'
  const out: McpRequestInfo = { era: effectiveEra, vendorMeta: meta }
  if (envelope !== undefined) {
    const version = envelope[PROTOCOL_VERSION_META_KEY]
    if (typeof version === 'string') out.protocolVersion = version
    const client = implementation(envelope[CLIENT_INFO_META_KEY])
    if (client !== undefined) out.clientInfo = client
    const caps = envelope[CLIENT_CAPABILITIES_META_KEY]
    if (isRecord(caps)) out.capabilities = caps
  } else if (legacy !== undefined) {
    const version = legacy.getNegotiatedProtocolVersion()
    if (version !== undefined) out.protocolVersion = version
    const client = implementation(legacy.getClientVersion())
    if (client !== undefined) out.clientInfo = client
    const caps = legacy.getClientCapabilities()
    if (isRecord(caps)) out.capabilities = caps
  }
  const toolUseId = toolUseIdFromMeta(meta)
  if (toolUseId !== undefined) out.toolUseId = toolUseId
  const token = meta.progressToken
  if (typeof token === 'string' || typeof token === 'number') out.progressToken = token
  if (ctx.mcpReq.signal !== undefined) out.signal = ctx.mcpReq.signal
  return out
}

/** Inputs for the project-directory chain that come from the process, not the request. */
export interface ProcessContext {
  env: Env
  cwd: string
  /** Defaults to the OS home directory. */
  home?: string
}

/**
 * Project directory, first available (ADR-0005): `CLAUDE_PROJECT_DIR`, Codex sandbox cwd,
 * Goose working dir, then the process cwd unless it is the home directory or `/`.
 */
export function resolveProjectDir(
  info: Pick<McpRequestInfo, 'vendorMeta'>,
  proc: ProcessContext,
): string | undefined {
  const fromEnv = proc.env.CLAUDE_PROJECT_DIR?.trim()
  if (fromEnv !== undefined && fromEnv !== '' && isAbsolute(fromEnv)) return fromEnv
  const fromMeta = projectDirFromMeta(info.vendorMeta)
  if (fromMeta !== undefined && isAbsolute(fromMeta)) return fromMeta
  const cwd = resolve(proc.cwd)
  const home = resolve(proc.home ?? homedir())
  if (cwd === home || cwd === resolve('/')) return undefined
  return cwd
}

/** Builds the App's per-request context from the MCP request and the gateway's session state. */
export function buildRequestCtx(
  info: McpRequestInfo,
  sessions: GatewaySessions,
  proc: ProcessContext,
): RequestCtx {
  const ctx: RequestCtx = { session: sessions.resolve(info.vendorMeta), protocolEra: info.era }
  const projectDir = resolveProjectDir(info, proc)
  if (projectDir !== undefined) ctx.projectDir = projectDir
  if (info.clientInfo !== undefined) ctx.client = info.clientInfo
  if (info.toolUseId !== undefined) ctx.toolUseId = info.toolUseId
  if (info.signal !== undefined) ctx.signal = info.signal
  return ctx
}
