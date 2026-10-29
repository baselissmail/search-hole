// SPDX-License-Identifier: Apache-2.0
/**
 * Public surface of the rules engine (ADR-0008). Import from here.
 */
export {
  type CancelEntry,
  type CompiledRuleSet,
  type CompileIssue,
  type CompileIssueCode,
  compileRuleSet,
  DEFAULT_PREFER_FACTOR,
  type DecideOptions,
  type ListInput,
  type RuleMatchInfo,
  type RuleSetInput,
  weightFactor,
} from './engine.ts'
export { assignRuleIds, isWeighted, type RuleIdentity, ruleIdBase, ruleText } from './ids.ts'
export {
  classifyMatch,
  type MatchParseResult,
  type ParsedMatch,
  parseMatch,
  pathHasPrefix,
  specificity,
  testMatch,
} from './match.ts'
export {
  hostMatchesDomain,
  isIpHost,
  type NormalizedUrl,
  normalizeHost,
  normalizePath,
  normalizeUrl,
} from './normalize.ts'
export {
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_SEPARATORS,
  MAX_PATTERN_WILDCARDS,
  urlPatternToRegex,
} from './pattern.ts'
export {
  DEFAULT_PROFILE,
  hasKeyword,
  matchProfile,
  orderProfiles,
  type ProfileDefaults,
  type ProfileMatch,
  type ProfileSources,
  resolveProfiles,
} from './profile.ts'
export { compileRegex, findNonLinearSyntax, MAX_REGEX_LENGTH } from './regex.ts'
export { isExpired, parseDuration, ttlToUntil, untilToMs } from './time.ts'
