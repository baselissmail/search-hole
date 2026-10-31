// SPDX-License-Identifier: Apache-2.0
/** Words for the contract's codes. Codes are stable (ADR-0006 point 12); unknown ones show as-is. */
import type {
  EngineId,
  ErrorClass,
  HiddenReason,
  InactiveReason,
  RuleAction,
  SearchMode,
  SourceType,
  Tier,
} from './contract.ts'

const ENGINE_NAMES: Record<EngineId, string> = {
  searxng: 'SearXNG',
  brave: 'Brave',
  tavily: 'Tavily',
  exa: 'Exa',
  mojeek: 'Mojeek',
  kagi: 'Kagi',
  marginalia: 'Marginalia',
}

export function engineName(id: string): string {
  return ENGINE_NAMES[id as EngineId] ?? id
}

const HIDDEN_REASONS: Record<HiddenReason, string> = {
  rule: 'Your rule',
  list: 'A list',
  stale: 'Too old',
  date_required: 'No date found',
  allowlist_mode: 'Not on the allowlist',
}

export function hiddenReasonLabel(reason: string): string {
  return HIDDEN_REASONS[reason as HiddenReason] ?? reason
}

const SOURCE_TYPES: Record<SourceType, string> = {
  official: 'Official',
  docs: 'Docs',
  forum: 'Forum',
  news: 'News',
  blog: 'Blog',
  repo: 'Repo',
  reference: 'Reference',
  content_farm: 'Content farm',
  unknown: 'Unknown',
}

export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPES[type as SourceType] ?? type
}

const TIERS: Record<Tier, string> = {
  T0s: 'important, session',
  T0g: 'important, global',
  T1: 'session',
  T2: 'project',
  T3: 'global',
  T4: 'list',
}

export function tierLabel(tier: string): string {
  return TIERS[tier as Tier] ?? tier
}

const INACTIVE: Record<InactiveReason, string> = {
  missing_key: 'No API key',
  no_endpoint: 'No endpoint set',
  disabled: 'Turned off',
  spend_cap: 'Spend cap reached',
  suspended: 'Suspended',
  json_disabled: 'JSON output is off',
  unhealthy: 'Unhealthy',
}

export function inactiveLabel(reason: string): string {
  return INACTIVE[reason as InactiveReason] ?? reason
}

const ERRORS: Record<ErrorClass, string> = {
  offline: 'Offline',
  unreachable: 'Unreachable',
  timeout: 'Timed out',
  rate_limited: 'Rate limited',
  quota: 'Quota used up',
  auth: 'Key rejected',
  forbidden: 'Forbidden',
  json_disabled: 'JSON output is off',
  captcha: 'Asked for a CAPTCHA',
  server: 'Server error',
  malformed: 'Unreadable response',
  bad_request: 'Bad request',
  cancelled: 'Cancelled',
}

export function errorLabel(code: string): string {
  return ERRORS[code as ErrorClass] ?? code
}

export const RULE_ACTION_LABELS: Record<RuleAction, string> = {
  block: 'Block',
  allow: 'Allow',
  pin: 'Pin',
  raise: 'Raise',
  lower: 'Lower',
  normal: 'Normal',
}

export function ruleActionLabel(action: string): string {
  return RULE_ACTION_LABELS[action as RuleAction] ?? action
}

export const MODE_LABELS: Record<SearchMode, string> = {
  auto: 'Auto',
  builtin: 'Built-in',
  engines: 'Engines',
}

export function searchModeLabel(mode: string): string {
  if (mode === 'builtin') return 'Built-in'
  return MODE_LABELS[mode as SearchMode] ?? mode
}
