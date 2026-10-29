// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { createRobotsChecker, type RobotsFetchResult } from '../../src/fetch/robots.ts'

function setup(answer: () => RobotsFetchResult | Promise<RobotsFetchResult>) {
  let t = Date.UTC(2026, 9, 30)
  const calls: string[] = []
  const checker = createRobotsChecker({
    now: () => t,
    fetchRobots: async (url) => {
      calls.push(url)
      return answer()
    },
  })
  return {
    checker,
    calls,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const RULES = [
  'User-agent: *',
  'Disallow: /all-bots',
  '',
  'User-agent: search-hole',
  'Disallow: /private',
  'Allow: /private/ok',
  '',
  'User-agent: OtherBot',
  'Disallow: /',
].join('\n')

describe('robots checker', () => {
  it('applies our group, longest match wins, and the URL must match the origin', async () => {
    const { checker } = setup(() => ({ status: 200, text: RULES }))
    expect(await checker.check('https://a.example/private/x')).toMatchObject({
      allowed: false,
      reason: 'disallowed',
    })
    expect(await checker.check('https://a.example/private/ok/1')).toEqual({ allowed: true, basis: 'rules' })
    // Our specific group replaces `*`, so /all-bots is allowed for us.
    expect(await checker.check('https://a.example/all-bots')).toEqual({ allowed: true, basis: 'rules' })
    expect(await checker.check('https://a.example/')).toEqual({ allowed: true, basis: 'rules' })
  })

  it('falls back to the * group when there is no search-hole group', async () => {
    const { checker } = setup(() => ({ status: 200, text: 'User-agent: *\nDisallow: /' }))
    expect(await checker.check('https://b.example/anything')).toMatchObject({ allowed: false })
  })

  it('caches per origin for 24 h, then refetches', async () => {
    const { checker, calls, advance } = setup(() => ({ status: 200, text: RULES }))
    await checker.check('https://a.example/1')
    await checker.check('https://a.example/2')
    await checker.check('http://a.example/3')
    expect(calls).toEqual(['https://a.example/robots.txt', 'http://a.example/robots.txt'])
    advance(24 * 3_600_000 - 1)
    await checker.check('https://a.example/4')
    expect(calls).toHaveLength(2)
    advance(2)
    await checker.check('https://a.example/5')
    expect(calls).toHaveLength(3)
  })

  it('shares one in-flight fetch between concurrent checks', async () => {
    const { checker, calls } = setup(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { status: 200, text: '' }
    })
    await Promise.all([checker.check('https://c.example/1'), checker.check('https://c.example/2')])
    expect(calls).toHaveLength(1)
  })

  it.each([400, 401, 403, 404, 410, 310])('HTTP %i → allow all', async (status) => {
    const { checker } = setup(() => ({ status, text: 'User-agent: *\nDisallow: /' }))
    expect(await checker.check('https://d.example/x')).toEqual({ allowed: true, basis: 'no_robots' })
  })

  it.each([429, 500, 503])('HTTP %i → temporary disallow, re-checked after 5 minutes', async (status) => {
    let current: RobotsFetchResult = { status, text: '' }
    const { checker, calls, advance } = setup(() => current)
    expect(await checker.check('https://e.example/x')).toMatchObject({
      allowed: false,
      reason: 'unavailable',
    })
    advance(4 * 60_000)
    await checker.check('https://e.example/y')
    expect(calls).toHaveLength(1)
    current = { status: 200, text: '' }
    advance(61_000)
    expect(await checker.check('https://e.example/z')).toEqual({ allowed: true, basis: 'rules' })
    expect(calls).toHaveLength(2)
  })

  it('network errors disallow temporarily; transient (our own cancellation) ones are not cached', async () => {
    let current: RobotsFetchResult = { networkError: 'connection refused' }
    const { checker, calls } = setup(() => current)
    expect(await checker.check('https://f.example/x')).toMatchObject({
      allowed: false,
      reason: 'unavailable',
    })
    await checker.check('https://f.example/x')
    expect(calls).toHaveLength(1)

    current = { networkError: 'cancelled', transient: true }
    expect(await checker.check('https://g.example/x')).toMatchObject({ allowed: false })
    current = { status: 404, text: '' }
    expect(await checker.check('https://g.example/x')).toEqual({ allowed: true, basis: 'no_robots' })
    expect(calls).toHaveLength(3)
  })

  it('treats a throwing fetcher like a network error', async () => {
    const { checker } = setup(() => {
      throw new Error('boom')
    })
    expect(await checker.check('https://h.example/')).toMatchObject({ allowed: false, reason: 'unavailable' })
  })

  it('evicts the oldest origins beyond maxEntries', async () => {
    const calls: string[] = []
    const checker = createRobotsChecker({
      maxEntries: 2,
      fetchRobots: async (u) => {
        calls.push(u)
        return { status: 404, text: '' }
      },
    })
    for (const host of ['a', 'b', 'c', 'a']) await checker.check(`https://${host}.example/`)
    expect(calls.map((u) => new URL(u).hostname)).toEqual([
      'a.example',
      'b.example',
      'c.example',
      'a.example',
    ])
  })
})
