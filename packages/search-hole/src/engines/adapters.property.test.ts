// SPDX-License-Identifier: Apache-2.0
/** Properties every adapter must satisfy (ADR-0009: pure, never throws, errors are data). */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { makeCtx, makePlan, NOW, readFixture, response } from '../../test/mock-engine/helpers.ts'
import type { AdapterCtx, EngineAdapter } from '../shared/types.ts'
import { createP1Adapters } from './index.ts'

const adapters = createP1Adapters({ now: () => NOW })
const ctxFor = (a: EngineAdapter): AdapterCtx =>
  makeCtx({
    endpoint: a.id === 'searxng' ? 'http://127.0.0.1:8080' : null,
    apiKey: a.id === 'searxng' ? null : 'secret-key-0123456789',
  })

const planArb = fc.record({
  query: fc.string({ maxLength: 600 }),
  count: fc.integer({ min: -5, max: 500 }),
  language: fc.string({ maxLength: 12 }),
  safesearch: fc.constantFrom(0 as const, 1 as const, 2 as const),
  pushdownBlockHosts: fc.array(fc.string({ maxLength: 40 }), { maxLength: 30 }),
  includeDomains: fc.array(fc.string({ maxLength: 40 }), { maxLength: 30 }),
  excludeDomains: fc.array(fc.string({ maxLength: 40 }), { maxLength: 30 }),
})

describe.each(Object.values(adapters))('adapter $id', (adapter) => {
  const ctx = ctxFor(adapter)

  it('builds a request without throwing for any plan, with an absolute URL and no key in it', () => {
    fc.assert(
      fc.property(planArb, (p) => {
        const req = adapter.buildRequest(makePlan(p), ctx)
        expect(() => new URL(req.url)).not.toThrow()
        expect(req.url).not.toContain('secret-key')
        expect(['GET', 'POST']).toContain(req.method)
      }),
    )
  })

  it('is pure: the same plan gives the same request', () => {
    fc.assert(
      fc.property(planArb, (p) => {
        expect(adapter.buildRequest(makePlan(p), ctx)).toEqual(adapter.buildRequest(makePlan(p), ctx))
      }),
    )
  })

  it('never throws on arbitrary responses and returns well-formed outcomes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 599 }), fc.string({ maxLength: 2000 }), (status, text) => {
        const out = adapter.parseResponse(response(status, text), makePlan(), ctx)
        expect(['ok', 'empty', 'error']).toContain(out.kind)
        if (out.kind === 'error') expect(out.detail.length).toBeLessThanOrEqual(200)
      }),
    )
  })

  it('never throws on arbitrary JSON bodies and never leaks the key', () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 599 }), fc.jsonValue(), (status, json) => {
        const out = adapter.parseResponse(response(status, JSON.stringify(json)), makePlan(), ctx)
        expect(JSON.stringify(out)).not.toContain('secret-key')
        if (out.kind === 'ok') {
          expect(out.results.length).toBeGreaterThan(0)
          for (const r of out.results) expect(r.url).toMatch(/^https?:\/\//)
        }
      }),
    )
  })

  it('ranks results 1..n in order and respects plan.count', () => {
    const fixture =
      adapter.id === 'searxng'
        ? 'searxng/react-compiler.json'
        : adapter.id === 'brave'
          ? 'brave/web-ok.json'
          : 'tavily/search-ok.json'
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (count) => {
        const out = adapter.parseResponse(response(200, readFixture(fixture)), makePlan({ count }), ctx)
        if (out.kind !== 'ok') throw new Error('expected ok')
        expect(out.results.length).toBeLessThanOrEqual(count)
        expect(out.results.map((r) => r.rank)).toEqual(out.results.map((_, i) => i + 1))
      }),
    )
  })
})
