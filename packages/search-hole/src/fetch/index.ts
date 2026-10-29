// SPDX-License-Identifier: Apache-2.0
/** Public surface of the fetch layer: safe page fetcher, robots, engine transport. */
export { type FetchFailureDetails, type FetchFailureReason, fetchFailureReason } from './errors.ts'
export {
  type BlockVerdict,
  closeDefaultPageFetcher,
  createPageFetcher,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  type FetchPageOptions,
  fetchPage,
  type IsBlocked,
  type PageFetcher,
  type PageFetcherConfig,
  type PageFetchResult,
  type RedirectHop,
  type UnsupportedContent,
} from './fetchPage.ts'
export {
  checkUrlShape,
  createGuardedAgent,
  GuardError,
  type GuardPolicy,
  type ResolveAll,
} from './guard.ts'
export { type AddressVerdict, classifyAddress } from './ip.ts'
export {
  createRobotsChecker,
  type RobotsChecker,
  type RobotsFetch,
  type RobotsFetchResult,
  type RobotsOptions,
  type RobotsVerdict,
} from './robots.ts'
export { estimateTokens, takeChunk } from './tokens.ts'
export {
  createEngineTransport,
  type EngineOriginPolicy,
  type EngineTransport,
  type EngineTransportOptions,
  isTransportFailure,
  type TransportErrorCode,
  type TransportFailure,
  type TransportResult,
  type TransportTrace,
} from './transport.ts'
export { USER_AGENT, userAgent, VERSION } from './version.ts'
