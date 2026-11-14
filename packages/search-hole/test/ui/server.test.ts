// SPDX-License-Identifier: Apache-2.0
// The dashboard server (ADR-0004 point 4, ADR-0020): security wall, login flow, API, assets, stream.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { App, DashboardApi } from '../../src/app/types.ts'
import { createLogger } from '../../src/shared/log.ts'
import { CSP, createUiServer, LOGIN_CODE_TTL_MS } from '../../src/ui/server.ts'
import { hookSession, setup } from '../app/helpers.ts'

const PORT = 7341
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'login-secret-0123456789abcdefghijklmnop'

async function harness(opts: { assets?: boolean } = {}) {
  const h = await setup({ host: 'cli' })
  let t = h.clock.now()
  let assetsDir: string | null = null
  if (opts.assets === true) {
    assetsDir = mkdtempSync(join(tmpdir(), 'searchhole-ui-assets-'))
    mkdirSync(join(assetsDir, 'assets'))
    writeFileSync(join(assetsDir, 'index.html'), '<!doctype html><title>search-hole</title>')
    writeFileSync(join(assetsDir, 'assets', 'app-abc123.js'), 'console.log(1)')
  }
  const ui = createUiServer({
    app: h.app as App & { dashboard: DashboardApi },
    port: PORT,
    version: '0.1.1',
    nonce: 'nonce-0123456789abcdef',
    loginSecret: SECRET,
    assetsDir,
    now: () => t,
    logger: createLogger({ env: { SEARCHHOLE_LOG: 'silent' } }),
  })
  const call = (path: string, init: RequestInit & { host?: string } = {}) => {
    const headers = new Headers(init.headers)
    headers.set('host', init.host ?? `127.0.0.1:${PORT}`)
    return ui.fetch(new Request(`${BASE}${path}`, { ...init, headers }))
  }
  const signIn = async (): Promise<string> => {
    const res = await call('/session', { method: 'POST', body: JSON.stringify({ code: ui.mintCode() }) })
    return ((await res.json()) as { token: string }).token
  }
  const api = async (path: string, token: string, init: RequestInit = {}) =>
    call(path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  return { h, ui, call, signIn, api, advance: (ms: number) => (t += ms) }
}

describe('security wall', () => {
  it('a path with an encoded line terminator never gets past the Host check or the sign-in', async () => {
    // hono GHSA-h7mg-cq63-vhpq: its router could skip wildcard middleware for such paths, and
    // both walls here are wildcard middleware.
    const { call } = await harness()
    const routes = [
      '/api/overview',
      '/api/searches',
      '/api/searches/1',
      '/api/rules',
      '/api/rules/remove',
      '/api/rules/explain',
      '/api/suggestions',
      '/api/suggestions/1/approve',
      '/api/lists',
      '/api/lists/catalog',
      '/api/lists/update',
      '/api/lists/x/mode',
      '/api/lists/x/update',
      '/api/engines',
      '/api/engines/probe',
      '/api/settings',
      '/api/doctor',
    ]
    const terminators = ['%0A', '%0D', '%0D%0A', '%E2%80%A8', '%E2%80%A9', '%C2%85', '%0a']
    for (const route of routes) {
      for (const t of terminators) {
        const paths = [
          `${route}${t}`,
          `${route}/${t}`,
          route.replace('/api/', `/api/${t}`),
          `${route}?x=${t}`,
        ]
        for (const path of paths) {
          for (const method of ['GET', 'POST']) {
            const init = method === 'POST' ? { method, body: '{}' } : { method }
            const open = await call(path, init)
            expect([method, path, open.status]).toEqual([method, path, open.status === 404 ? 404 : 401])
            const foreign = await call(path, { ...init, host: 'evil.example:7341' })
            expect([method, path, foreign.status]).toEqual([method, path, 403])
          }
        }
      }
    }
  })

  it('refuses a foreign Host (DNS rebinding) and a cross-origin write; sends CSP, never CORS', async () => {
    const { call, signIn, api } = await harness()
    expect((await call('/health', { host: 'evil.example:7341' })).status).toBe(403)
    expect((await call('/health', { host: 'localhost:7341' })).status).toBe(200)
    const health = await call('/health')
    expect(health.headers.get('content-security-policy')).toBe(CSP)
    expect(health.headers.get('x-frame-options')).toBe('DENY')
    expect(health.headers.get('access-control-allow-origin')).toBeNull()
    const token = await signIn()
    const cross = await call('/api/rules', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ match: 'x.com', action: 'block' }),
    })
    expect(cross.status).toBe(403)
    const same = await call('/api/rules', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ match: 'x.com', action: 'block' }),
    })
    expect(same.status).toBe(200)
    expect((await api('/api/rules', token)).headers.get('cache-control')).toBe('no-store')
  })

  it('a login code works once and only within 60 s; /api needs the session token', async () => {
    const { call, ui, advance } = await harness()
    expect((await call('/api/overview')).status).toBe(401)
    expect((await call('/api/overview', { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(401)
    const code = ui.mintCode()
    const first = await call('/session', { method: 'POST', body: JSON.stringify({ code }) })
    expect(first.status).toBe(200)
    expect((await call('/session', { method: 'POST', body: JSON.stringify({ code }) })).status).toBe(401)
    const late = ui.mintCode()
    advance(LOGIN_CODE_TTL_MS + 1)
    const expired = await call('/session', { method: 'POST', body: JSON.stringify({ code: late }) })
    expect(expired.status).toBe(401)
    expect(((await expired.json()) as { error: { fix: string } }).error.fix).toContain('searchhole ui --open')
  })

  it('/api/login-code takes only the ui.json secret', async () => {
    const { call } = await harness()
    expect((await call('/api/login-code', { method: 'POST' })).status).toBe(401)
    expect(
      (await call('/api/login-code', { method: 'POST', headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401)
    const ok = await call('/api/login-code', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    const { code } = (await ok.json()) as { code: string }
    expect((await call('/session', { method: 'POST', body: JSON.stringify({ code }) })).status).toBe(200)
  })
})

describe('API', () => {
  it('log pages newest first, by keyset; detail; overview', async () => {
    const { h, signIn, api } = await harness()
    for (const q of ['one', 'two', 'three']) {
      await h.app.filterBuiltinResults(q, [{ title: `T ${q}`, url: `https://react.dev/${q}` }], hookSession())
    }
    const token = await signIn()
    const page = (await (await api('/api/searches?limit=2', token)).json()) as {
      items: Array<{ searchId: number; query: string }>
      nextBefore: number
      maxId: number
    }
    expect(page.items.map((i) => i.query)).toEqual(['three', 'two'])
    expect(page.maxId).toBe(3)
    const older = (await (await api(`/api/searches?limit=2&before=${page.nextBefore}`, token)).json()) as {
      items: Array<{ query: string }>
      nextBefore: number | null
    }
    expect(older.items.map((i) => i.query)).toEqual(['one'])
    expect(older.nextBefore).toBeNull()
    const newer = (await (await api('/api/searches?after=2', token)).json()) as {
      items: Array<{ query: string }>
    }
    expect(newer.items.map((i) => i.query)).toEqual(['three'])
    // More newer rows than `limit`: the oldest ones come first, so polling never skips a gap.
    const gap = (await (await api('/api/searches?after=0&limit=2', token)).json()) as {
      items: Array<{ query: string }>
    }
    expect(gap.items.map((i) => i.query)).toEqual(['two', 'one'])
    const detail = (await (await api('/api/searches/1', token)).json()) as {
      results: Array<{ title?: string }>
    }
    expect(detail.results[0]?.title).toBe('T one')
    expect((await api('/api/searches/999', token)).status).toBe(404)
    const overview = (await (await api('/api/overview', token)).json()) as {
      searches: number
      builtin: number
    }
    expect(overview).toMatchObject({ searches: 3, builtin: 3 })
  })

  it('rules: add, explain, remove (for Undo); a bad rule is a 400 with the fix', async () => {
    const { signIn, api } = await harness()
    const token = await signIn()
    const added = (await (
      await api('/api/rules', token, {
        method: 'POST',
        body: JSON.stringify({ match: 'pinterest.com', action: 'block' }),
      })
    ).json()) as { id: string }
    const explain = (await (
      await api('/api/rules/explain', token, {
        method: 'POST',
        body: JSON.stringify({ url: 'https://pinterest.com/x' }),
      })
    ).json()) as { decision: string }
    expect(explain.decision).toMatch(/hidden|block/i)
    const removed = (await (
      await api('/api/rules/remove', token, { method: 'POST', body: JSON.stringify({ rule: added.id }) })
    ).json()) as Array<{ match: string }>
    expect(removed.map((r) => r.match)).toEqual(['pinterest.com'])
    const bad = await api('/api/rules', token, {
      method: 'POST',
      body: JSON.stringify({ match: '', action: 'block' }),
    })
    expect(bad.status).toBe(400)
    const notJson = await api('/api/rules', token, { method: 'POST', body: '{nope' })
    expect(notJson.status).toBe(400)
    for (const body of ['null', '[]', '"x"', '3']) {
      expect([body, (await api('/api/rules', token, { method: 'POST', body })).status]).toEqual([body, 400])
      expect([body, (await api('/api/settings', token, { method: 'POST', body })).status]).toEqual([
        body,
        400,
      ])
    }
  })

  it('rules are added for every project: the dashboard has no current project', async () => {
    const { signIn, api } = await harness()
    const token = await signIn()
    for (const scope of ['project', 'session']) {
      const res = await api('/api/rules', token, {
        method: 'POST',
        body: JSON.stringify({ match: 'a.example', action: 'block', scope }),
      })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('every project')
    }
    const ok = await api('/api/rules', token, {
      method: 'POST',
      body: JSON.stringify({ match: 'a.example', action: 'block', scope: 'global' }),
    })
    expect(ok.status).toBe(200)
  })

  it('settings: a path that only exists on Object.prototype is refused', async () => {
    const { signIn, api } = await harness()
    const token = await signIn()
    for (const path of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const res = await api('/api/settings', token, {
        method: 'POST',
        body: JSON.stringify({ path, value: 'x' }),
      })
      expect([path, res.status]).toEqual([path, 400])
    }
  })

  it('settings: allowlisted paths only, validated before writing', async () => {
    const { signIn, api } = await harness()
    const token = await signIn()
    const view = (await (
      await api('/api/settings', token, {
        method: 'POST',
        body: JSON.stringify({ path: 'limits.searchesPerTurn', value: 25 }),
      })
    ).json()) as { limits: { searchesPerTurn: number } }
    expect(view.limits.searchesPerTurn).toBe(25)
    const guard = await api('/api/settings', token, {
      method: 'POST',
      body: JSON.stringify({ path: 'hooks.guard', value: false }),
    })
    expect(guard.status).toBe(400)
    const invalid = await api('/api/settings', token, {
      method: 'POST',
      body: JSON.stringify({ path: 'limits.repeatQuery', value: 1 }),
    })
    expect(invalid.status).toBe(400)
    const after = (await (await api('/api/settings', token)).json()) as { limits: { repeatQuery: number } }
    expect(after.limits.repeatQuery).toBe(3)
    const mode = (await (
      await api('/api/settings', token, {
        method: 'POST',
        body: JSON.stringify({ path: 'mode', value: 'builtin' }),
      })
    ).json()) as { mode: { configured: string } }
    expect(mode.mode.configured).toBe('builtin')
  })

  it('unknown API routes are 404 JSON', async () => {
    const { signIn, api } = await harness()
    const res = await api('/api/nope', await signIn())
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
})

describe('assets', () => {
  it('serves the build with an SPA fallback, immutable hashed assets, and no path traversal', async () => {
    const { call } = await harness({ assets: true })
    const index = await call('/rules')
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('search-hole')
    expect(index.headers.get('cache-control')).toBe('no-cache')
    const asset = await call('/assets/app-abc123.js')
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await call('/assets/missing.js')).status).toBe(404)
    for (const evil of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%E0%A4%A']) {
      const res = await call(evil)
      expect(await res.text()).not.toContain('root:')
    }
  })

  it('says how to build when the assets are missing', async () => {
    const { call } = await harness()
    const res = await call('/')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('pnpm build')
  })
})

describe('live stream', () => {
  it('primes, sends searches after the cursor with ids, and resets when the cursor is ahead', async () => {
    const { h, signIn, api } = await harness()
    await h.app.filterBuiltinResults('first', [{ title: 'A', url: 'https://a.dev/' }], hookSession())
    const token = await signIn()
    const read = async (path: string, until: string): Promise<string> => {
      const res = await api(path, token)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let text = ''
      for (let i = 0; i < 50 && reader !== undefined && !text.includes(until); i++) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      await reader?.cancel()
      return text
    }
    const fresh = await read('/api/stream?after=0', 'id: 1')
    expect(fresh.startsWith(': connected')).toBe(true)
    expect(fresh).toContain('event: search')
    expect(fresh).toContain('id: 1')
    expect(fresh).toContain('"query":"first"')
    const ahead = await read('/api/stream?after=50', 'event: reset')
    expect(ahead).toContain('event: reset')
  })
})

describe('lists API (ADR-0022)', () => {
  it('lists, catalog, mode, add without download, update and remove; bad input is a 400', async () => {
    const { signIn, api } = await harness()
    const token = await signIn()
    const lists = (await (await api('/api/lists', token)).json()) as Array<{
      id: string
      mode: string
      source: string
    }>
    expect(lists.find((l) => l.id === 'rjaus-pinterest')).toMatchObject({
      mode: 'enforce',
      source: 'vendored',
    })
    const catalog = (await (await api('/api/lists/catalog', token)).json()) as Array<{
      id: string
      starter: boolean
    }>
    expect(catalog.some((c) => c.id === 'super-seo-spam-suppressor' && !c.starter)).toBe(true)

    const mode = await api('/api/lists/laylavish-huge-ai/mode', token, {
      method: 'POST',
      body: JSON.stringify({ mode: 'enforce' }),
    })
    expect(mode.status).toBe(200)
    expect(((await mode.json()) as { mode: string }).mode).toBe('enforce')
    expect(
      (
        await api('/api/lists/laylavish-huge-ai/mode', token, {
          method: 'POST',
          body: JSON.stringify({ mode: 'off' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (await api('/api/lists/nope/mode', token, { method: 'POST', body: JSON.stringify({ mode: 'audit' }) }))
        .status,
    ).toBe(400)
    expect(
      (
        await api('/api/lists/Bad%2Fid/mode', token, {
          method: 'POST',
          body: JSON.stringify({ mode: 'audit' }),
        })
      ).status,
    ).toBe(404)

    const added = await api('/api/lists', token, {
      method: 'POST',
      body: JSON.stringify({ source: 'super-seo-spam-suppressor', mode: 'audit', fetch: false }),
    })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({ id: 'super-seo-spam-suppressor', mode: 'audit', copy: 'none' })
    expect(
      (
        await api('/api/lists', token, {
          method: 'POST',
          body: JSON.stringify({ source: 'http://x.example/l.txt' }),
        })
      ).status,
    ).toBe(400)
    expect((await api('/api/lists', token, { method: 'POST', body: JSON.stringify({}) })).status).toBe(400)

    const update = (await (
      await api('/api/lists/github-clones/update', token, { method: 'POST' })
    ).json()) as Array<{
      result: string
    }>
    expect(update).toEqual([expect.objectContaining({ id: 'github-clones', result: 'skipped' })])

    const builtin = await api('/api/lists/remove', token, {
      method: 'POST',
      body: JSON.stringify({ id: 'github-clones' }),
    })
    expect(builtin.status).toBe(400)
    expect(((await builtin.json()) as { error: { fix: string } }).error.fix).toContain('disable')
    const removed = await api('/api/lists/remove', token, {
      method: 'POST',
      body: JSON.stringify({ id: 'super-seo-spam-suppressor' }),
    })
    expect(removed.status).toBe(200)
    const after = (await (await api('/api/lists', token)).json()) as Array<{ id: string }>
    expect(after.some((l) => l.id === 'super-seo-spam-suppressor')).toBe(false)
  })
})

describe('review API and opened results (ADR-0025)', () => {
  type Review = {
    days: number
    minSearches: number
    total: number
    sites: Array<{ domain: string; searches: number; examples: Array<{ url: string; title?: string }> }>
    dismissed: Array<{ domain: string }>
  }
  const seed = async (h: Awaited<ReturnType<typeof harness>>['h']) => {
    for (const q of ['one', 'two', 'three']) {
      await h.app.filterBuiltinResults(
        q,
        [
          { title: 'Farm page', url: 'https://farm.example/page' },
          { title: 'Read page', url: 'https://read.example/page' },
        ],
        hookSession(),
      )
    }
    await h.app.recordBuiltinFetch('https://read.example/page', hookSession())
  }

  it('needs the session token, and the dismiss POST also the right Host and Origin', async () => {
    const { h, call, signIn } = await harness()
    await seed(h)
    const body = JSON.stringify({ domain: 'farm.example' })
    expect((await call('/api/review')).status).toBe(401)
    expect((await call('/api/review', { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(401)
    for (const path of ['/api/review/dismiss', '/api/review/restore']) {
      expect((await call(path, { method: 'POST', body })).status, path).toBe(401)
    }
    const token = await signIn()
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    expect((await call('/api/review', { headers: auth, host: 'evil.example:7341' })).status).toBe(403)
    for (const path of ['/api/review/dismiss', '/api/review/restore']) {
      const cross = await call(path, {
        method: 'POST',
        headers: { ...auth, origin: 'http://evil.example' },
        body,
      })
      expect(cross.status, path).toBe(403)
      const rebound = await call(path, { method: 'POST', headers: auth, body, host: 'evil.example:7341' })
      expect(rebound.status, path).toBe(403)
    }
    // Nothing above changed anything.
    const list = await call('/api/review', { headers: auth })
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(list.headers.get('access-control-allow-origin')).toBeNull()
    const before = (await list.json()) as Review
    expect(before.sites.map((s) => s.domain)).toEqual(['farm.example'])
    expect(before.dismissed).toEqual([])
    const same = await call('/api/review/dismiss', {
      method: 'POST',
      headers: { ...auth, origin: BASE },
      body,
    })
    expect(same.status).toBe(200)
  })

  it('GET lists the sites; dismiss hides one and restore brings it back', async () => {
    const { h, signIn, api } = await harness()
    await seed(h)
    const token = await signIn()
    const get = async (query = ''): Promise<Review> =>
      (await (await api(`/api/review${query}`, token)).json()) as Review
    expect(await get()).toEqual({
      days: 30,
      minSearches: 3,
      total: 1,
      sites: [
        {
          domain: 'farm.example',
          searches: 3,
          results: 3,
          lastSeen: new Date(h.clock.now()).toISOString(),
          sourceType: 'unknown',
          examples: [{ url: 'https://farm.example/page', title: 'Farm page' }],
        },
      ],
      dismissed: [],
    })
    // Query parameters: clamped, and anything that is not a whole number falls back to the default.
    expect(await get('?days=7&limit=1')).toMatchObject({ days: 7, total: 1 })
    expect((await get('?days=9999')).days).toBe(365)
    expect((await get('?days=0')).days).toBe(1)
    for (const bad of ['?days=abc', '?days=-5', '?days=1.5', '?days=', '?limit=x']) {
      expect(await get(bad), bad).toMatchObject({ days: 30, total: 1 })
    }

    const post = (path: string, body: unknown) =>
      api(path, token, { method: 'POST', body: JSON.stringify(body) })
    const dismissed = await post('/api/review/dismiss', { domain: 'farm.example' })
    expect(dismissed.status).toBe(200)
    expect(await dismissed.json()).toEqual({ domain: 'farm.example', changed: true })
    expect(await (await post('/api/review/dismiss', { domain: 'farm.example' })).json()).toEqual({
      domain: 'farm.example',
      changed: false,
    })
    const after = await get()
    expect(after.sites).toEqual([])
    expect(after.dismissed.map((d) => d.domain)).toEqual(['farm.example'])
    expect(await (await post('/api/review/restore', { domain: 'farm.example' })).json()).toEqual({
      domain: 'farm.example',
      changed: true,
    })
    expect((await get()).sites.map((s) => s.domain)).toEqual(['farm.example'])

    // A rule added from the dashboard takes the site off the list as well.
    await post('/api/rules', { match: 'farm.example', action: 'lower' })
    expect((await get()).sites).toEqual([])
  })

  it('refuses bad dismiss bodies with a 400, and an oversized one with a 413', async () => {
    const { h, signIn, api } = await harness()
    await seed(h)
    const token = await signIn()
    for (const path of ['/api/review/dismiss', '/api/review/restore']) {
      const send = (body: string) => api(path, token, { method: 'POST', body })
      for (const body of [
        '{nope',
        '',
        'null',
        '[]',
        '"farm.example"',
        '{}',
        '{"domain":42}',
        '{"domain":["farm.example"]}',
        '{"domain":""}',
        '{"domain":"   "}',
        JSON.stringify({ domain: `${'a'.repeat(250)}.example` }),
      ]) {
        const res = await send(body)
        expect(res.status, `${path} ${body.slice(0, 30)}`).toBe(400)
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request')
      }
      // A string that is not a site reaches the app, which names the fix.
      const notSite = await send(JSON.stringify({ domain: 'two words' }))
      expect(notSite.status).toBe(400)
      expect((await notSite.json()) as { error: { code: string; fix: string } }).toMatchObject({
        error: { code: 'invalid_argument', fix: expect.stringContaining('example.com') },
      })
      const huge = await send(JSON.stringify({ domain: 'farm.example', pad: 'x'.repeat(70_000) }))
      expect(huge.status).toBe(413)
    }
    expect((await api('/api/review/dismiss', token)).status).toBe(404) // GET is not a route
    const list = (await (await api('/api/review', token)).json()) as Review
    expect(list.sites.map((s) => s.domain)).toEqual(['farm.example'])
    expect(list.dismissed).toEqual([])
  })

  it('the search detail says which results were opened', async () => {
    const { h, signIn, api } = await harness()
    await seed(h)
    const detail = (await (await api('/api/searches/1', await signIn())).json()) as {
      opened: number
      results: Array<{ domain: string; opened: boolean }>
    }
    expect(detail.opened).toBe(1)
    expect(detail.results.map((r) => [r.domain, r.opened])).toEqual([
      ['farm.example', false],
      ['read.example', true],
    ])
  })
})
