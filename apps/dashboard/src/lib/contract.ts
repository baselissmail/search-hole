// SPDX-License-Identifier: Apache-2.0
/**
 * The one place that reaches into the server package for the HTTP contract (ADR-0020 point 3).
 * `contract.ts` holds types plus the route constants, so only `ROUTES` ends up in the bundle.
 */
import type { LogDetail } from '../../../../packages/search-hole/src/ui/contract.ts'

export type { DoctorCheck } from '../../../../packages/search-hole/src/app/types.ts'
export type {
  EngineId,
  ErrorClass,
  HealthState,
  HiddenReason,
  InactiveReason,
  RuleAction,
  SourceType,
  Tier,
} from '../../../../packages/search-hole/src/shared/types.ts'
export type {
  AddListInput,
  AddRuleInput,
  ApiError,
  DoctorReport,
  EngineStatus,
  ExplainRequest,
  ExplainResponse,
  ListCatalogEntry,
  ListError,
  ListErrorCode,
  ListFormat,
  ListKind,
  ListMode,
  ListModeRequest,
  ListSource,
  ListStatus,
  ListUpdateRequest,
  ListUpdateResult,
  LogDetail,
  LogEntry,
  Overview,
  RemoveListRequest,
  RemoveRuleRequest,
  ReviewList,
  ReviewSite,
  ReviewSiteRequest,
  ReviewSiteResponse,
  RuleListing,
  SearchMode,
  SearchPage,
  SessionRequest,
  SessionResponse,
  SettingsPatch,
  SettingsView,
  StreamEvent,
  SuggestionItem,
  SuggestRuleInput,
} from '../../../../packages/search-hole/src/ui/contract.ts'
export { ROUTES } from '../../../../packages/search-hole/src/ui/contract.ts'

/** One result row of a search's detail. */
export type LogResult = LogDetail['results'][number]
