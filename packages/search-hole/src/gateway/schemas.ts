// SPDX-License-Identifier: Apache-2.0
/**
 * Tool input and output schemas (ADR-0012 "Schemas"). Every `outputSchema` root is an object,
 * so the SDK's legacy `{result: ...}` wrapping is a no-op and both eras see the same shape.
 * Input field descriptions are short: they count against the 1,500-token budget.
 */
import { z } from 'zod'
import { ENGINE_ID_LIST } from '../shared/types.ts'

const depth = z.enum(['quick', 'standard', 'deep'])
const receiptId = z.string().min(1).max(64)
const dateKind = z.enum(['published', 'modified', 'crawled', 'existed_by'])
const confidence = z.enum(['high', 'medium', 'low'])

/** `search` arguments. Depth and limit defaults come from the profile (ADR-0012). */
export const searchInput = z.object({
  query: z.string().min(1).max(400).describe('Search terms; site:example.com and -site:example.com work'),
  depth: depth.optional().describe('quick: one fact; standard (default); deep: research'),
  profile: z.string().min(1).max(64).optional().describe("One of the user's profiles (default: by keywords)"),
  engines: z.array(z.enum(ENGINE_ID_LIST)).min(1).max(ENGINE_ID_LIST.length).optional(),
  freshness: z
    .object({ maxAgeDays: z.number().int().min(1).max(36_500) })
    .optional()
    .describe("Only newer results; can only tighten the user's setting"),
  limit: z.number().int().min(1).max(20).optional(),
  receiptId: receiptId.optional().describe('From an earlier search, to group related work'),
})

const foundDate = z.object({
  value: z.string(),
  kind: dateKind,
  method: z.string(),
  confidence,
  tzAssumed: z.boolean(),
})

const count = z.number().int().optional()
const hiddenByReason = z.object({
  rule: count,
  list: count,
  stale: count,
  date_required: count,
  allowlist_mode: count,
})

/** `search` structured output (ADR-0012). */
export const searchOutput = z.object({
  receiptId: z.string(),
  query: z.string(),
  profile: z.string(),
  depth,
  results: z.array(
    z.object({
      n: z.number().int(),
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      date: z.string().optional(),
      dateKind: dateKind.optional(),
      dateConfidence: confidence.optional(),
      sourceType: z.string(),
      engines: z.array(z.string()),
      flags: z.array(z.string()),
    }),
  ),
  hidden: z.object({
    count: z.number().int(),
    byReason: hiddenByReason,
    topDomains: z.array(z.string()),
  }),
  engines: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['ok', 'empty', 'error', 'skipped']),
      latencyMs: z.number().optional(),
      reason: z.string().optional(),
      attribution: z.string().optional(),
    }),
  ),
  upstreamRules: z.number().int().optional(),
  alteredQuery: z.string().optional(),
  warnings: z.array(z.string()),
})

/** `fetch` arguments (ADR-0012). */
export const fetchInput = z.object({
  url: z.url().max(2048),
  cursor: z.string().min(1).max(1024).optional().describe('nextCursor from the previous fetch of this URL'),
  maxTokens: z.number().int().min(500).max(8_000).optional().describe('Text budget (default 8000)'),
  receiptId: receiptId.optional(),
})

/** `fetch` structured output (ADR-0012). */
export const fetchOutput = z.object({
  receiptId: z.string(),
  requestedUrl: z.string(),
  finalUrl: z.string(),
  status: z.number().int(),
  redirects: z.array(z.object({ url: z.string(), status: z.number().int() })),
  contentType: z.string(),
  title: z.string().optional(),
  canonicalUrl: z.string().optional(),
  lang: z.string().optional(),
  bytes: z.number().int(),
  truncated: z.boolean(),
  dates: z.array(foundDate),
  text: z.string(),
  chunk: z.object({
    start: z.number().int(),
    end: z.number().int(),
    total: z.number().int(),
    tokens: z.number().int(),
  }),
  nextCursor: z.string().optional(),
  cursorStale: z.boolean().optional(),
  unsupported: z.object({ type: z.string(), planned: z.boolean(), message: z.string() }).optional(),
})

/** `receipt` arguments (ADR-0012). */
/** `apply_rule` (app-only, ADR-0021 point 7): one action the receipt panel was given a token for. */
export const applyRuleInput = z.object({
  kind: z.enum(['block', 'approve']),
  value: z.string().min(1).max(253),
  token: z.string().min(16).max(200),
})
export type ApplyRuleInput = z.output<typeof applyRuleInput>

export const receiptInput = z.object({
  receiptIds: z.array(receiptId).min(1).max(20).optional().describe("Default: this session's latest"),
  format: z.enum(['summary', 'full']).optional(),
})

const receiptSchema = z.object({
  receiptId: z.string(),
  sessionKey: z.string().optional(),
  startedAt: z.string(),
  closedAt: z.string().optional(),
  searches: z.array(
    z.object({
      query: z.string(),
      at: z.string(),
      mode: z.enum(['engines', 'builtin']),
      engines: z.array(z.string()),
      kept: z.number().int(),
      hidden: z.number().int(),
      hiddenByReason,
    }),
  ),
  sources: z.array(
    z.object({
      url: z.string(),
      title: z.string().optional(),
      status: z.number().int().optional(),
      dates: z.array(foundDate),
      sourceType: z.string(),
      freshness: z.enum(['fresh', 'stale', 'unknown']),
    }),
  ),
  warnings: z.array(z.string()),
  summaryLine: z.string(),
})

/** `receipt` structured output: the receipts asked for (ADR-0012). */
export const receiptOutput = z.object({ receipts: z.array(receiptSchema) })

/** `suggest_rule` arguments (ADR-0012; project scope is not model-suggestable). */
export const suggestRuleInput = z.object({
  match: z
    .string()
    .min(1)
    .max(500)
    .describe('example.com, example.com/path, a URL pattern with *, or /regex/'),
  action: z.enum(['block', 'allow', 'pin', 'raise', 'lower', 'normal']),
  weight: z.number().int().min(1).max(10).optional().describe('raise/lower strength'),
  scope: z.enum(['global', 'session']).optional(),
  profile: z.string().min(1).max(64).optional(),
  reason: z.string().min(1).max(280),
  evidenceUrl: z.url().max(2048).optional(),
})

/** `suggest_rule` structured output (ADR-0012). */
export const suggestRuleOutput = z.object({
  suggestionId: z.number().int(),
  status: z.enum(['queued', 'duplicate', 'rejected']),
  howToApprove: z.string(),
  message: z.string().optional(),
})

/**
 * `hook` arguments (ADR-0014 + ADR-0018). Every value comes from a hooks.json `${...}`
 * substitution, so everything is a string ("" when the path was missing) and JSON-valued
 * fields (`toolInput` = `${tool_input}`, `toolResponse` = `${tool_response}`) arrive as JSON
 * strings. When `toolInput` is absent, the lean single fields are used instead (`command` =
 * `${tool_input.command}`, `filePath` = `${tool_input.file_path}` or `.notebook_path`, `url`,
 * `query`): the Bash/Edit/Write guard needs nothing else, so hooks.json need not ship a whole
 * `Write` body through MCP. Unknown keys are accepted, so a hooks.json with extra keys never
 * turns into a hook error.
 */
export const hookInput = z.looseObject({
  event: z.string().max(64),
  sessionId: z.string().max(256).optional(),
  source: z.string().max(64).optional(),
  agentType: z.string().max(256).optional(),
  toolName: z.string().max(256).optional(),
  // JSON strings today; an object is accepted too, so a host change can't switch filtering off.
  toolInput: z.unknown().optional(),
  toolResponse: z.unknown().optional(),
  command: z.string().optional(),
  filePath: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
})

export type SearchInput = z.output<typeof searchInput>
export type SearchStructured = z.output<typeof searchOutput>
export type FetchInput = z.output<typeof fetchInput>
export type FetchStructured = z.output<typeof fetchOutput>
export type ReceiptInput = z.output<typeof receiptInput>
export type ReceiptStructured = z.output<typeof receiptOutput>
export type SuggestRuleInputArgs = z.output<typeof suggestRuleInput>
export type SuggestRuleStructured = z.output<typeof suggestRuleOutput>
export type HookInput = z.output<typeof hookInput>
