// SPDX-License-Identifier: Apache-2.0
/**
 * The receipt panel (ADR-0021, ADR-0012): the `ui://` resource that hosts render as an MCP App,
 * the data the panel receives in the receipt result's `_meta`, and the one-time action tokens
 * that make `apply_rule` safe to expose to the panel.
 *
 * Tokens: `apply_rule` is app-only, but visibility is enforced by the host, not by us. Every
 * token is minted into a receipt result's `_meta` (which hosts give the View, not the model),
 * binds one action to one value, expires after 10 minutes, and works once.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/server'
import type { HostProfile } from '../app/types.ts'
import type { RuleAction } from '../shared/types.ts'
import type { ReceiptStructured } from './schemas.ts'

/** The MCP Apps HTML profile (`@modelcontextprotocol/ext-apps` RESOURCE_MIME_TYPE). */
export const PANEL_MIME = 'text/html;profile=mcp-app'
/** The extension id a client declares when it renders MCP Apps. */
export const UI_EXTENSION = 'io.modelcontextprotocol/ui'
/** Where the panel data rides in the receipt result (hosts pass `_meta` to the View, not the model). */
export const PANEL_META_KEY = 'search-hole/panel'
/** Versioned, so the one-day public cache hint never serves an old panel (ADR-0021 point 3). */
export const panelUri = (version: string): string => `ui://search-hole/v${version}/receipt.html`

/** Host profiles that hide app-only tools or render a panel that uses them (ADR-0012). */
export const APPLY_RULE_HOSTS: ReadonlySet<HostProfile> = new Set<HostProfile>([
  'claude-desktop',
  'vscode',
  'cursor',
  'claude-code',
])

/** What the panel receives in `_meta["search-hole/panel"]` (ADR-0021 point 5). Tokens only where `apply_rule` exists. */
export interface PanelData {
  receipts: ReceiptStructured['receipts']
  /** Registrable sites of the opened sources, each with a one-time block token. */
  blockable: Array<{ site: string; token?: string }>
  /** Pending suggestions, each with a one-time approve token. */
  suggestions: Array<{
    id: number
    match: string
    action: RuleAction
    weight?: number
    reason: string
    token?: string
  }>
  /** The running dashboard's bare URL. */
  dashboardUrl?: string
  /** The host profile, for the fallback command wording. */
  host: HostProfile
}

export const ACTION_TOKEN_TTL_MS = 10 * 60_000
const MAX_USED = 2048

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** True when the client declared that it renders `text/html;profile=mcp-app` resources. */
export function clientRendersApps(capabilities: Readonly<Record<string, unknown>> | undefined): boolean {
  const ext = capabilities?.extensions
  if (!isRecord(ext)) return false
  const ui = ext[UI_EXTENSION]
  if (!isRecord(ui)) return false
  return Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(PANEL_MIME)
}

export type ActionKind = 'block' | 'approve'
export type TokenCheck = 'ok' | 'invalid' | 'expired' | 'used'

/** One-time, short-lived action tokens: `<expiry>.<HMAC(kind, value, expiry)>`. */
export class ActionTokens {
  private readonly secret = randomBytes(32)
  private readonly used = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private sign(kind: ActionKind, value: string, exp: number): string {
    return createHmac('sha256', this.secret).update(`${kind}\n${value}\n${exp}`).digest('base64url')
  }

  mint(kind: ActionKind, value: string): string {
    const exp = this.now() + ACTION_TOKEN_TTL_MS
    return `${exp}.${this.sign(kind, value, exp)}`
  }

  /** Checks a token and, when it is good, marks it used. */
  consume(kind: ActionKind, value: string, token: string): TokenCheck {
    const dot = token.indexOf('.')
    const exp = Number(token.slice(0, dot))
    if (dot <= 0 || !Number.isSafeInteger(exp)) return 'invalid'
    const given = Buffer.from(token.slice(dot + 1))
    const want = Buffer.from(this.sign(kind, value, exp))
    if (given.length !== want.length || !timingSafeEqual(given, want)) return 'invalid'
    const now = this.now()
    if (exp < now || exp > now + ACTION_TOKEN_TTL_MS) return 'expired'
    for (const [t, until] of this.used) if (until < now) this.used.delete(t)
    if (this.used.has(token)) return 'used'
    if (this.used.size >= MAX_USED) {
      const oldest = this.used.keys().next().value
      if (oldest !== undefined) this.used.delete(oldest)
    }
    this.used.set(token, exp)
    return 'ok'
  }
}

/** Shown when the panel isn't built (a source checkout before `pnpm build`). */
const NOT_BUILT = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head>
<body style="font:14px system-ui;margin:12px">search-hole: the receipt panel is not built in this install. Run <code>pnpm build</code>, or ask for the receipt as text.</body></html>`

let cachedHtml: string | undefined

/** The built panel next to the bundle (`dist/panel`), or in the repo when running from source. */
export function panelHtml(): string {
  if (cachedHtml !== undefined) return cachedHtml
  const here = dirname(fileURLToPath(import.meta.url))
  for (const file of [
    join(here, 'panel', 'receipt.html'),
    join(here, '..', '..', '..', '..', 'apps', 'receipt-app', 'dist', 'receipt.html'),
  ]) {
    if (existsSync(file)) {
      cachedHtml = readFileSync(file, 'utf8')
      return cachedHtml
    }
  }
  return NOT_BUILT
}

/** Registers the `ui://` receipt resource on one server instance. */
export function registerPanelResource(
  server: McpServer,
  version: string,
  html: () => string = panelHtml,
): void {
  const uri = panelUri(version)
  server.registerResource(
    'receipt-panel',
    uri,
    {
      title: 'search-hole receipt',
      description: 'The receipt card: what was searched, hidden and opened.',
      mimeType: PANEL_MIME,
      cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
    },
    async () => ({
      contents: [{ uri, mimeType: PANEL_MIME, text: html(), _meta: { ui: { prefersBorder: true } } }],
    }),
  )
}
