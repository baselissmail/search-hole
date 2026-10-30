// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Semaphore } from '../../src/app/semaphore.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import type { CommandResult } from '../../src/shared/keys/types.ts'
import { startServer, type TestServer, testPolicy } from '../fetch/helpers.ts'
import { type MockEngines, startMockEngines } from '../mock-engine/server.ts'
import { hookSession, mockSettings, setup } from './helpers.ts'

let page: TestServer
let mock: MockEngines
beforeAll(async () => {
  mock = await startMockEngines()
  page = await startServer((req, res) => {
    if (req.url === '/hop') {
      res.writeHead(302, { location: 'https://www.pinterest.com/pin/1' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><html><head><title>Compiler notes</title><meta property="article:published_time" content="2026-09-01T10:00:00Z"></head><body><article><h1>Compiler notes</h1><p>The compiler memoizes components automatically, so most manual useMemo calls can go.</p></article></body></html>',
    )
  })
})
afterAll(async () => {
  await page.close()
  await mock.close()
})

const seams = { pageFetcher: { guard: testPolicy(), robots: false as const } }

describe('fetch (ADR-0011, ADR-0012)', () => {
  it('fetches a page, records the opened source on the turn receipt', async () => {
    const h = await setup({ seams })
    const ctx = hookSession('f')
    const { receiptId } = await h.app.openTurn(ctx)
    const out = await h.app.fetch({ url: `${page.origin}/article` }, ctx)
    expect(out.kind).toBe('page')
    if (out.kind !== 'page') return
    expect(out.receiptId).toBe(receiptId)
    expect(out.sourceTitle).toBe('Compiler notes')
    expect(out.text).toContain('memoizes components')
    const [r] = await h.app.receipt(undefined, ctx)
    expect(r?.sources).toMatchObject([
      { url: `${page.origin}/article`, title: 'Compiler notes', status: 200, freshness: 'fresh' },
    ])
    expect((await h.app.closeTurn(ctx)).receiptLine).toBeUndefined()
  })

  it('refuses a blocked URL before any request, naming the rule', async () => {
    const h = await setup({ seams, rules: 'version: 1\nrules:\n  - { match: "127.0.0.1", action: block }\n' })
    const before = page.seen.length
    const out = await h.app.fetch({ url: `${page.origin}/article` }, {})
    expect(out).toMatchObject({ kind: 'refused', reason: 'rule', rule: { text: 'block 127.0.0.1' } })
    expect(page.seen.length).toBe(before)
  })

  it('refuses a redirect into a blocked site (rules on every hop)', async () => {
    const h = await setup({
      seams,
      rules: 'version: 1\nrules:\n  - { match: pinterest.com, action: block }\n',
    })
    const out = await h.app.fetch({ url: `${page.origin}/hop` }, {})
    expect(out).toMatchObject({ kind: 'refused', reason: 'rule' })
  })

  it('refuses private addresses with the default guard', async () => {
    const h = await setup()
    const out = await h.app.fetch({ url: `${page.origin}/article` }, {})
    expect(out).toMatchObject({ kind: 'refused', reason: 'ssrf' })
  })
})

describe('keys (ADR-0007)', () => {
  it('sets, reports and removes keys without exposing them', async () => {
    const h = await setup({ settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')) })
    expect((await h.app.keys.status()).find((k) => k.engine === 'tavily')).toEqual({
      engine: 'tavily',
      present: false,
      source: 'missing',
    })
    const secret = 'tvly-stored-0123456789abcdef'
    expect(await h.app.keys.set('tavily', secret)).toEqual({ backend: 'plaintext file (insecure)' })
    const status = await h.app.keys.status()
    expect(status.find((k) => k.engine === 'tavily')).toEqual({
      engine: 'tavily',
      present: true,
      source: 'file',
    })
    expect(JSON.stringify(status)).not.toContain(secret)
    expect((await h.app.engineStatus()).find((e) => e.engine === 'tavily')).toMatchObject({
      configured: true,
    })
    await h.app.keys.remove('tavily')
    expect((await h.app.keys.status()).find((k) => k.engine === 'tavily')?.present).toBe(false)
    await expect(h.app.keys.set('searxng', 'x')).rejects.toSatisfy(
      (e: unknown) => isSearchHoleError(e) && e.code === 'invalid_argument',
    )
  })
})

describe('doctor', () => {
  it('reports node, paths, store, settings, engines, docker, SearXNG and Claude Code hints', async () => {
    const calls: string[][] = []
    const docker = async (cmd: string, args: readonly string[]): Promise<CommandResult> => {
      calls.push([cmd, ...args])
      return { code: 0, stdout: '27.3.1\n', stderr: '' }
    }
    const h = await setup({
      settings: mockSettings(mock.endpoint('searxng'), mock.endpoint('tavily')),
      seams: { runCommand: docker },
    })
    const report = await h.app.doctor({ probe: true })
    const byId = new Map(report.checks.map((c) => [c.id, c]))
    expect(byId.get('node')?.status).toBe('ok')
    expect(byId.get('store')?.status).toBe('info') // nothing logged yet
    expect(byId.get('engine:searxng')).toMatchObject({ status: 'ok', title: 'searxng: healthy' })
    expect(byId.get('engine:tavily')).toMatchObject({
      status: 'info',
      fix: 'Add a free key (no card): `searchhole keys set tavily`.',
    })
    expect(byId.get('docker')).toMatchObject({ status: 'ok', title: 'Docker 27.3.1' })
    expect(byId.get('searxng')?.status).toBe('ok')
    expect(byId.get('claude-code:mode')?.title).toBe('Claude Code mode: auto (now engines)')
    expect(calls).toEqual([['docker', 'info', '--format', '{{.ServerVersion}}']])
    expect(report.paths).toEqual({ config: h.home, data: h.home, run: `${h.home}/run`, source: 'env' })
    expect(report.engines.map((e) => e.engine)).toEqual(['searxng', 'brave', 'tavily'])
  })

  it('reports invalid settings and falls back to the defaults', async () => {
    const h = await setup({ settings: 'version: 1\nui: { port: 99999 }\n' })
    const report = await h.app.doctor()
    expect(report.checks.find((c) => c.id === 'settings')?.status).toBe('fail')
    expect(report.checks.find((c) => c.id === 'docker')?.title).toBe('Docker not found')
  })
})

describe('per-engine concurrency', () => {
  it('Semaphore never runs more than its limit at once', async () => {
    const sem = new Semaphore(4)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 12 }, () =>
        sem.run(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 5))
          active--
        }),
      ),
    )
    expect(peak).toBe(4)
    expect(sem.inFlight).toBe(0)
  })

  it('a waiter whose signal aborts gives up its place', async () => {
    const sem = new Semaphore(1)
    let release: () => void = () => undefined
    const first = sem.run(() => new Promise<void>((r) => (release = r)))
    const ac = new AbortController()
    const second = sem.run(async () => 'ran', ac.signal)
    ac.abort()
    await expect(second).rejects.toBeDefined()
    release()
    await first
    expect(await sem.run(async () => 'next')).toBe('next')
  })
})
