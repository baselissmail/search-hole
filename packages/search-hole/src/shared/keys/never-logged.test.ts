// SPDX-License-Identifier: Apache-2.0
// ADR-0007 point 4: a key value never reaches a log line. These tests exercise log.ts
// against realistic key-bearing log calls; they live here because keys are the reason
// the redaction exists.
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createLogger,
  isSecretLogField,
  logLevelFromEnv,
  redactUrlSecrets,
  sanitizeLogValue,
} from '../log.ts'
import { forgetSecrets, registerSecret } from './known-secrets.ts'
import { resolveKey } from './resolve.ts'
import { nodeRunCommand } from './spawn.ts'

const KEY = 'Zq3w9X7c1Vb5Nm8Lk2Jh4Gf6Ds0Pa' // fixed, not a real credential

function capture(level: 'info' | 'debug' = 'info') {
  const lines: string[] = []
  const logger = createLogger({ level, destination: { write: (m: string) => void lines.push(m) } })
  return { logger, lines, text: () => lines.join('') }
}

describe('logger redaction', () => {
  beforeEach(() => {
    forgetSecrets()
  })

  it('redacts well-known secret fields at the top level and when nested', () => {
    const { logger, text } = capture()
    logger.info(
      {
        apiKey: KEY,
        api_key: KEY,
        token: KEY,
        headers: {
          Authorization: `Bearer ${KEY}`,
          'x-subscription-token': KEY,
          'X-API-Key': KEY,
          accept: 'json',
        },
        request: { headers: { authorization: KEY, cookie: `s=${KEY}` } },
        engine: 'brave',
      },
      'calling engine',
    )
    expect(text()).not.toContain(KEY)
    expect(text()).toContain('"engine":"brave"')
    expect(text()).toContain('"accept":"json"')
    expect(text()).toContain('[redacted]')
  })

  it('redacts fields named like secrets even when not on the fixed list', () => {
    const { logger, text } = capture()
    logger.info({
      env: { BRAVE_SEARCH_API_KEY: KEY, TAVILY_API_KEY_FILE: '/run/secrets/t', PATH: '/bin' },
      accessToken: KEY,
      clientSecret: KEY,
    })
    expect(text()).not.toContain(KEY)
    expect(text()).toContain('/bin')
  })

  it('redacts secret query parameters and userinfo in URLs, in fields and in messages', () => {
    const { logger, text } = capture()
    const url = `https://api.search.brave.com/res/v1/web/search?q=react&api_key=${KEY}&count=5`
    logger.info({ url }, `GET ${url}`)
    logger.info({ dsn: `postgres://svc:${KEY}@db.example.com/app` })
    expect(text()).not.toContain(KEY)
    expect(text()).toContain('q=react')
    expect(text()).toContain('count=5')
  })

  it('redacts token-shaped strings anywhere (hygiene detectors)', () => {
    const { logger, text } = capture()
    const ghp = `ghp_${'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5'}`
    logger.warn({ note: `copied ${ghp} by mistake` }, `leaked ${ghp}`)
    expect(text()).not.toContain(ghp)
  })

  it('flattens errors with redacted message and stack, and their causes', () => {
    const { logger, lines, text } = capture()
    const err = new Error(`request failed for https://x.test/?token=${KEY}`, {
      cause: new Error(`auth rejected sk-${KEY}${KEY}`),
    })
    logger.error({ err }, 'engine failed')
    logger.error(err)
    expect(text()).not.toContain(KEY)
    expect(text()).toContain('request failed')
    const [first, second] = lines.map(
      (l) => JSON.parse(l) as { err?: { type: string; cause?: { message: string } }; msg?: string },
    )
    expect(first?.err?.type).toBe('Error')
    expect(first?.err?.cause?.message).toContain('auth rejected')
    expect(second?.msg).toContain('request failed')
  })

  it('survives cycles, deep nesting, bigints and odd values', () => {
    const { logger, text } = capture()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    logger.info({
      cyclic,
      big: 10n,
      fn: () => 1,
      date: new Date(0),
      buf: new Uint8Array(4),
      url: new URL(`https://a.test/?key=${KEY}`),
    })
    expect(text()).not.toContain(KEY)
    expect(text()).toContain('[circular]')
  })

  it('keeps ordinary fields and respects the level', () => {
    const { logger, lines } = capture('info')
    logger.debug('hidden')
    logger.info({ tookMs: 12, engines: ['searxng'] }, 'search done')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      level: 30,
      tookMs: 12,
      engines: ['searxng'],
      msg: 'search done',
    })
  })

  it('redacts bindings and child logger fields', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'info',
      bindings: { host: 'claude-code', apiKey: KEY },
      destination: { write: (m: string) => void lines.push(m) },
    })
    logger.child({ engine: 'brave' }).info('hello')
    expect(lines.join('')).not.toContain(KEY)
    expect(lines.join('')).toContain('claude-code')
  })

  it('redacts a registered key of unknown format wherever it appears, but only once registered', () => {
    const { logger, text } = capture()
    logger.info({ note: `auth ${KEY} rejected`, key: KEY }, `retry with ${KEY}`)
    expect(text()).toContain(KEY) // nothing recognises this string yet
    registerSecret(KEY)
    const second = capture()
    second.logger.info(
      { note: `auth ${KEY} rejected`, key: KEY, q: encodeURIComponent(`${KEY}/x`) },
      `retry with ${KEY}`,
    )
    expect(second.text()).not.toContain(KEY)
  })

  it('never logs a resolved key', async () => {
    const { logger, text } = capture()
    const res = await resolveKey('tavily', { env: { SEARCHHOLE_TAVILY_API_KEY: KEY } })
    logger.info({ resolution: res, key: res.key }, 'resolved')
    logger.info(res, `key ${res.key} from ${res.source}`)
    expect(text()).not.toContain(KEY)
    expect(text()).toContain('host-env')
  })
})

describe('helpers', () => {
  it('reads SEARCHHOLE_LOG with a quiet default', () => {
    expect(logLevelFromEnv({})).toBe('warn')
    expect(logLevelFromEnv({ SEARCHHOLE_LOG: 'DEBUG' })).toBe('debug')
    expect(logLevelFromEnv({ SEARCHHOLE_LOG: ' silent ' })).toBe('silent')
    expect(logLevelFromEnv({ SEARCHHOLE_LOG: 'loud' })).toBe('warn')
  })

  it('classifies field names', () => {
    for (const n of [
      'apiKey',
      'BRAVE_API_KEY',
      'Authorization',
      'X-Subscription-Token',
      'cookie',
      'refresh_token',
      'password',
    ])
      expect(isSecretLogField(n), n).toBe(true)
    for (const n of ['tokens', 'maxTokens', 'engine', 'url', 'count', 'key'])
      expect(isSecretLogField(n), n).toBe(false)
  })

  it('redactUrlSecrets keeps other parameters and plain strings untouched', () => {
    expect(redactUrlSecrets('https://a.test/p?q=x&key=abc123&page=2')).toBe(
      'https://a.test/p?q=x&key=[redacted]&page=2',
    )
    expect(redactUrlSecrets('no urls here, token words only')).toBe('no urls here, token words only')
    expect(redactUrlSecrets('https://u:pw@host.test/x')).toBe('https://u:[redacted]@host.test/x')
  })

  it('sanitizeLogValue truncates very deep structures', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 20; i++) deep = { next: deep }
    expect(JSON.stringify(sanitizeLogValue(deep))).toContain('[truncated]')
  })
})

describe('stdout stays clean', () => {
  it('writes log lines to stderr and nothing to stdout', async () => {
    const logModule = fileURLToPath(new URL('../log.ts', import.meta.url))
    const script = `import { createLogger } from ${JSON.stringify(logModule)}; createLogger({ env: { SEARCHHOLE_LOG: 'info' } }).info({ apiKey: 'k-${KEY}' }, 'hello from the gateway')`
    const r = await nodeRunCommand(process.execPath, ['--input-type=module', '-e', script], {
      timeoutMs: 20_000,
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('hello from the gateway')
    expect(r.stderr).not.toContain(KEY)
  })
})
