// SPDX-License-Identifier: Apache-2.0
/**
 * The review actions end to end against the dev mock's review routes: the real API client, the
 * real toasts (captured) and their Undo buttons, the query cache, no network.
 */
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockServer } from '../dev/mock.ts'
import { api } from './api.ts'
import type { ReviewList } from './contract.ts'
import { keys } from './queries.ts'
import { actOnSite, keepSiteWithUndo, restoreSite, withoutSite } from './reviewActions.ts'
import { startSession } from './session.ts'

interface Shown {
  type: string
  title: string
  opts: {
    description?: string
    duration?: number
    action?: { label: string; onClick: (event: unknown) => void }
  }
}

const shown: Shown[] = []

vi.mock('sonner', () => {
  const record =
    (type: string) =>
    (title: string, opts: Shown['opts'] = {}) => {
      shown.push({ type, title, opts })
      return shown.length
    }
  return {
    toast: Object.assign(record('default'), {
      success: record('success'),
      error: record('error'),
      dismiss: vi.fn(),
    }),
  }
})

const last = () => shown[shown.length - 1] as Shown
const undo = async (t: Shown) => {
  t.opts.action?.onClick({})
  await vi.waitFor(() => expect(shown[shown.length - 1]).not.toBe(t))
}
const listed = async (): Promise<string[]> => (await api.review()).sites.map((s) => s.domain)
const kept = async (): Promise<string[]> => (await api.review()).dismissed.map((s) => s.domain)

let qc: QueryClient
let requests: Array<{ method: string; path: string; body: unknown }>

function serve(config: { emptyReview?: boolean } = {}): void {
  const server = new MockServer({ size: 0, brokenStream: false, instant: true, ...config })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:7341')
    requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return server.handle(url, null, init)
  })
}

beforeEach(() => {
  shown.length = 0
  requests = []
  serve()
  startSession('mock-session-token', '0.0.0-test')
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  qc.clear()
})

describe('the review list from the server', () => {
  it('is fetched with a bearer token and lists the sites, most-seen first', async () => {
    const list = await api.review()
    expect(requests).toEqual([{ method: 'GET', path: '/api/review', body: undefined }])
    expect(list).toMatchObject({ days: 30, minSearches: 3, total: 4 })
    expect(list.sites.map((s) => [s.domain, s.searches])).toEqual([
      ['geeksforgeeks.org', 9],
      ['w3schools.com', 7],
      ['brave-only.example', 5],
      ['evil.example', 3],
    ])
    expect(list.sites.find((s) => s.domain === 'brave-only.example')?.examples).toEqual([])
    expect(list.dismissed.map((d) => d.domain)).toEqual(['stackoverflow.com'])
    await api.review(undefined, 7)
    expect(requests.at(-1)?.path).toBe('/api/review?days=7')
  })

  it('is empty under ?mock=empty', async () => {
    vi.unstubAllGlobals()
    serve({ emptyReview: true })
    expect(await api.review()).toMatchObject({ total: 0, sites: [] })
  })
})

describe('Keep', () => {
  it('dismisses the site, offers Undo for 8 seconds, and Undo lists it again', async () => {
    expect(await keepSiteWithUndo(qc, 'w3schools.com')).toBe(true)
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      path: '/api/review/dismiss',
      body: { domain: 'w3schools.com' },
    })
    expect(last()).toMatchObject({
      type: 'success',
      title: 'Kept w3schools.com',
      opts: { duration: 8000, action: { label: 'Undo' } },
    })
    expect(await listed()).not.toContain('w3schools.com')
    expect(await kept()).toContain('w3schools.com')

    await undo(last())
    expect(last()).toMatchObject({ type: 'success', title: 'w3schools.com can be listed for review again' })
    expect(await listed()).toContain('w3schools.com')
    expect(await kept()).toEqual(['stackoverflow.com'])
  })

  it('"Review again" restores a site kept earlier', async () => {
    expect(await restoreSite(qc, 'stackoverflow.com')).toBe(true)
    expect(requests.at(-1)).toMatchObject({
      path: '/api/review/restore',
      body: { domain: 'stackoverflow.com' },
    })
    expect(await kept()).toEqual([])
  })

  it('a failed call says so and reports false, without an Undo', async () => {
    expect(await keepSiteWithUndo(qc, '   ')).toBe(false)
    expect(last()).toMatchObject({ type: 'error', title: "Couldn't keep    " })
    expect(last().opts.action).toBeUndefined()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')))
    expect(await restoreSite(qc, 'stackoverflow.com')).toBe(false)
    expect(last()).toMatchObject({ type: 'error', title: "Couldn't restore stackoverflow.com" })
    expect(last().opts.description).toContain("search-hole isn't answering")
  })
})

describe('acting on a listed site', () => {
  const cached = (): ReviewList | undefined => qc.getQueryData<ReviewList>(keys.review)

  it('Block adds a global block rule through the rule path; Undo removes it and the site returns', async () => {
    qc.setQueryData(keys.review, await api.review())
    expect(await actOnSite(qc, 'block', 'geeksforgeeks.org')).toBe(true)
    expect(requests.find((r) => r.path === '/api/rules' && r.method === 'POST')?.body).toEqual({
      match: 'geeksforgeeks.org',
      action: 'block',
    })
    expect(last()).toMatchObject({
      type: 'success',
      title: 'Blocked geeksforgeeks.org',
      opts: { description: 'Global rule', duration: 8000, action: { label: 'Undo' } },
    })
    // The row is gone from the cache at once, and the server agrees.
    expect(cached()?.sites.map((s) => s.domain)).not.toContain('geeksforgeeks.org')
    expect(cached()?.total).toBe(3)
    expect(await listed()).not.toContain('geeksforgeeks.org')
    expect((await api.rules()).some((r) => r.match === 'geeksforgeeks.org' && r.action === 'block')).toBe(
      true,
    )

    await undo(last())
    expect(last().title).toBe('Undone: Blocked geeksforgeeks.org')
    expect((await api.rules()).some((r) => r.match === 'geeksforgeeks.org')).toBe(false)
    expect(await listed()).toContain('geeksforgeeks.org')
  })

  it('Lower adds a lower rule, and Keep dismisses', async () => {
    qc.setQueryData(keys.review, await api.review())
    expect(await actOnSite(qc, 'lower', 'w3schools.com')).toBe(true)
    expect(last().title).toBe('Lowered w3schools.com')
    expect((await api.rules()).find((r) => r.match === 'w3schools.com')).toMatchObject({
      action: 'lower',
      scope: 'global',
    })
    expect(await actOnSite(qc, 'keep', 'evil.example')).toBe(true)
    expect(last().title).toBe('Kept evil.example')
    expect(cached()?.sites.map((s) => s.domain)).toEqual(['geeksforgeeks.org', 'brave-only.example'])
    expect(await listed()).toEqual(['geeksforgeeks.org', 'brave-only.example'])
  })

  it('a refused rule leaves the list as it was', async () => {
    const before = await api.review()
    qc.setQueryData(keys.review, before)
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')))
    expect(await actOnSite(qc, 'block', 'geeksforgeeks.org')).toBe(false)
    expect(last()).toMatchObject({ type: 'error', title: "Couldn't block geeksforgeeks.org" })
    expect(cached()).toEqual(before)
  })
})

describe('withoutSite', () => {
  const list: ReviewList = {
    days: 30,
    minSearches: 3,
    total: 5,
    sites: [
      { domain: 'a.example', searches: 4, results: 4, lastSeen: '', sourceType: 'unknown', examples: [] },
      { domain: 'b.example', searches: 3, results: 3, lastSeen: '', sourceType: 'unknown', examples: [] },
    ],
    dismissed: [],
  }

  it('drops the site and one from the total, and returns the same object when it is not listed', () => {
    expect(withoutSite(list, 'a.example')).toMatchObject({ total: 4, sites: [{ domain: 'b.example' }] })
    expect(withoutSite(list, 'zzz.example')).toBe(list)
    expect(withoutSite({ ...list, total: 2 }, 'a.example').total).toBe(1)
  })
})
