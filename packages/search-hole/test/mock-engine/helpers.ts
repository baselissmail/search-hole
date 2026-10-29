// SPDX-License-Identifier: Apache-2.0
/** Test helpers shared by the engine, health and fan-out tests. */

import { readFileSync } from 'node:fs'
import type { AdapterCtx, EnginePlan, HttpResponse } from '../../src/shared/types.ts'

/** A fixed clock for deterministic tests: 2026-10-30 12:00:00 UTC. */
export const NOW = Date.parse('2026-10-30T12:00:00Z')

/** Reads a file under test/fixtures/. */
export function readFixture(rel: string): string {
  return readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), 'utf8')
}

/** An engine plan with sensible defaults. */
export function makePlan(overrides: Partial<EnginePlan> = {}): EnginePlan {
  return {
    query: 'react compiler',
    count: 20,
    depth: 'standard',
    language: 'en',
    safesearch: 1,
    includeDomains: [],
    excludeDomains: [],
    pushdownBlockHosts: [],
    ...overrides,
  }
}

/** An adapter context with a fake key. */
export function makeCtx(overrides: Partial<AdapterCtx> = {}): AdapterCtx {
  return { endpoint: null, apiKey: 'test-key-0123456789', timeoutMs: 5000, ...overrides }
}

/** A canned HTTP response. */
export function response(status: number, text: string, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, text, durationMs: 12 }
}
