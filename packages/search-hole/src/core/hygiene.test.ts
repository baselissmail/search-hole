// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isSearchHoleError } from '../shared/errors.ts'
import {
  checkQuery,
  describeFindings,
  detectSecrets,
  type FindingClass,
  isValidAllowPattern,
  looksLikeSecretFieldName,
  queryBlockedError,
  REDACTED,
  redact,
  scanConfigForSecrets,
} from './hygiene.ts'

/** An unsubstituted host placeholder such as `${user_config.name}`, built without a literal `${`. */
const ph = (name: string): string => ['$', '{', name, '}'].join('')

const FIXTURES = new URL('../../test/fixtures/hygiene/', import.meta.url)

interface PositiveCase {
  id: string
  class: FindingClass
  template: string
}
interface NegativeCase {
  query: string
  why: string
}

const positives = (
  JSON.parse(readFileSync(new URL('positives.json', FIXTURES), 'utf8')) as { cases: PositiveCase[] }
).cases
const negatives = (
  JSON.parse(readFileSync(new URL('negatives.json', FIXTURES), 'utf8')) as { cases: NegativeCase[] }
).cases

// ── Deterministic template expansion (no literal credentials in the repo) ──

const ALPHABETS: Record<string, string> = {
  b62: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  b64u: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  hex: '0123456789abcdef',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  num: '0123456789',
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 2166136261
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

/** Expands `{b62:36}`-style placeholders; returns the text and every generated token. */
function expand(template: string, seed: number): { text: string; generated: string[] } {
  const rand = mulberry32(seed)
  const generated: string[] = []
  const text = template.replace(/\{(\w+):(\d+)\}/g, (_m, kind: string, n: string) => {
    const alphabet = ALPHABETS[kind]
    if (alphabet === undefined) throw new Error(`unknown placeholder ${kind}`)
    let out = ''
    for (let i = 0; i < Number(n); i++) out += alphabet[Math.floor(rand() * alphabet.length)]
    generated.push(out)
    return out
  })
  return { text, generated }
}

const block = { mode: 'block' } as const
const redactMode = { mode: 'redact' } as const

describe('true positives (fixture corpus)', () => {
  it('has a case for every finding class', () => {
    const classes = new Set(positives.map((c) => c.class))
    for (const c of [
      'api_key',
      'jwt',
      'private_key',
      'connection_string',
      'secret_assignment',
      'high_entropy',
      'internal_host',
      'private_ip',
    ] satisfies FindingClass[]) {
      expect(classes.has(c), c).toBe(true)
    }
  })

  it.each(positives.map((c) => [c.id, c] as const))('blocks %s', (_id, c) => {
    const { text } = expand(c.template, hashString(c.id))
    const res = checkQuery(text, block)
    expect(res.action).toBe('block')
    expect(res.query).toBe(text)
    expect(res.findings.map((f) => f.class)).toContain(c.class)
  })

  it.each(positives.map((c) => [c.id, c] as const))(
    'redacts %s without leaking and idempotently',
    (_id, c) => {
      const { text, generated } = expand(c.template, hashString(c.id))
      const res = checkQuery(text, redactMode)
      expect(res.action).toBe('redact')
      expect(res.query).toContain(REDACTED)
      for (const token of generated) {
        if (token.length >= 16) expect(res.query).not.toContain(token)
      }
      expect(checkQuery(res.query, redactMode).action).toBe('ok')
    },
  )
})

describe('false positives (normal developer queries)', () => {
  it('has at least 30 negative cases', () => {
    expect(negatives.length).toBeGreaterThanOrEqual(30)
  })

  it.each(negatives.map((c) => [c.query.slice(0, 70), c] as const))('does not block: %s', (_label, c) => {
    const res = checkQuery(c.query, block)
    expect(res.findings.map((f) => `${f.class}:${f.detector}:${c.query.slice(f.start, f.end)}`)).toEqual([])
    expect(res.action).toBe('ok')
  })
})

describe('checkQuery', () => {
  it('returns ok with no findings in off mode, even for obvious secrets', () => {
    const { text } = expand('sk-{b62:48}', 1)
    expect(checkQuery(text, { mode: 'off' })).toEqual({ action: 'ok', query: text, findings: [] })
  })

  it('reports UTF-16 offsets that slice back to the match', () => {
    const { text, generated } = expand('😀 日本語 ghp_{b62:36} done', 7)
    const res = checkQuery(text, block)
    expect(res.findings).toHaveLength(1)
    const f = res.findings[0]
    expect(f).toBeDefined()
    expect(text.slice(f?.start, f?.end)).toBe(`ghp_${generated[0]}`)
  })

  it('never copies the matched text into findings', () => {
    const { text, generated } = expand('token ghp_{b62:36} at 10.1.2.3', 3)
    const res = checkQuery(text, block)
    const dump = JSON.stringify(res.findings)
    expect(dump).not.toContain(generated[0])
    expect(dump).not.toContain('10.1.2.3')
  })

  it('merges overlapping findings into one span led by the stronger class', () => {
    const { text } = expand('postgres://app:{b62:16}@db01.corp:5432/app', 5)
    const res = checkQuery(text, block)
    expect(res.findings).toHaveLength(1)
    expect(res.findings[0]?.class).toBe('connection_string')
  })

  it('allow patterns exempt a finding when they match its whole text', () => {
    expect(checkQuery('ssh admin@10.1.2.3', block).action).toBe('block')
    expect(checkQuery('ssh admin@10.1.2.3', { ...block, allow: ['10\\.1\\.2\\.3'] }).action).toBe('ok')
    // a partial pattern does not exempt
    expect(checkQuery('ssh admin@10.1.2.3', { ...block, allow: ['10\\.1'] }).action).toBe('block')
    // case-insensitive host allow
    expect(checkQuery('wiki.corp login', { ...block, allow: ['WIKI\\.corp'] }).action).toBe('ok')
  })

  it('skips invalid allow patterns instead of throwing', () => {
    const res = checkQuery('ssh admin@10.1.2.3', { ...block, allow: ['(', '(?=x)'] })
    expect(res.action).toBe('block')
    expect(isValidAllowPattern('(')).toBe(false)
    expect(isValidAllowPattern('wiki\\.corp')).toBe(true)
  })

  it('treats loopback as exempt unless flagLoopback is set', () => {
    for (const q of [
      'ECONNREFUSED 127.0.0.1:5432',
      'http://localhost:3000/api',
      'bind [::1]:8080 failed',
      'http://127.0.0.2/x',
    ]) {
      expect(checkQuery(q, block).action, q).toBe('ok')
      expect(checkQuery(q, { ...block, flagLoopback: true }).action, q).toBe('block')
    }
  })

  it('flags user-configured internal host suffixes', () => {
    const opts = { ...block, internalHosts: ['corp.example.com', '*.acme.test'] }
    expect(checkQuery('jira.corp.example.com 502', opts).action).toBe('block')
    expect(checkQuery('corp.example.com dns', opts).action).toBe('block')
    expect(checkQuery('git.acme.test clone', opts).action).toBe('block')
    expect(checkQuery('mycorp.example.com is public', opts).action).toBe('ok')
    expect(checkQuery('jira.corp.example.com 502', block).action).toBe('ok')
  })

  it('does not flag a bare word that happens to be an internal-looking single label', () => {
    expect(checkQuery('what is a jenkins job', block).action).toBe('ok')
    expect(checkQuery('connect to dc01:389 ldap', block).action).toBe('ok')
  })

  it('redacts several matches in one query', () => {
    const { text } = expand('use ghp_{b62:36} against http://jenkins/x and 192.168.1.5', 11)
    const res = checkQuery(text, redactMode)
    expect(res.query).toBe(`use ${REDACTED} against http://${REDACTED}/x and ${REDACTED}`)
  })
})

describe('error and description helpers', () => {
  it('names classes and never echoes the match', () => {
    const { text, generated } = expand('ghp_{b62:36} on 10.1.2.3', 2)
    const res = checkQuery(text, block)
    expect(describeFindings(res.findings)).toBe('an API key or access token and a private network address')
    const err = queryBlockedError(res.findings)
    expect(isSearchHoleError(err)).toBe(true)
    expect(err.code).toBe('query_blocked')
    const dump = `${err.message} ${err.fix ?? ''} ${JSON.stringify(err.details)}`
    expect(dump).not.toContain(generated[0])
    expect(dump).not.toContain('10.1.2.3')
    expect(dump).toContain('looks like')
  })

  it('describes a single class and the empty set', () => {
    expect(describeFindings([{ class: 'jwt', detector: 'jwt', start: 0, end: 1 }])).toBe('a JSON Web Token')
    expect(describeFindings([])).toBe('sensitive text')
  })
})

describe('redact and detectSecrets (logging helpers)', () => {
  it('redacts secrets but keeps local engine URLs when hosts is false', () => {
    const { text } = expand('GET http://127.0.0.1:8888/search?q=a key sk-{b62:48} 10.1.2.3', 4)
    const out = redact(text)
    expect(out).toContain('http://127.0.0.1:8888/search?q=a')
    expect(out).toContain('10.1.2.3')
    expect(out).not.toContain('sk-')
    expect(redact(text, { hosts: true })).not.toContain('10.1.2.3')
  })

  it('returns the input untouched when nothing matches', () => {
    expect(redact('plain text with react@18.2.0')).toBe('plain text with react@18.2.0')
  })

  it('detectSecrets ignores hostnames', () => {
    expect(detectSecrets('ssh admin@10.1.2.3 wiki.corp')).toEqual([])
    const { text } = expand('sk-{b62:48}', 9)
    expect(detectSecrets(text)).toHaveLength(1)
  })
})

describe('config scanning (ADR-0007 point 6)', () => {
  it('recognises secret-like field names', () => {
    for (const name of [
      'api_key',
      'apiKey',
      'API_KEY',
      'x-api-key',
      'token',
      'accessToken',
      'password',
      'client_secret',
      'secret',
      'privateKey',
    ]) {
      expect(looksLikeSecretFieldName(name), name).toBe(true)
    }
    for (const name of ['timeoutMs', 'keyboard', 'tokens', 'monkey', 'url', 'key', 'maxTokens', '']) {
      expect(looksLikeSecretFieldName(name), name).toBe(false)
    }
  })

  it('flags secret-named string fields and reports paths only', () => {
    const found = scanConfigForSecrets({
      engines: { brave: { api_key: 'abc', enabled: true } },
      ui: { port: 1 },
    })
    expect(found).toEqual([{ path: 'engines.brave.api_key', reason: 'secret_field_name' }])
  })

  it('flags token patterns under innocent names and key-like values next to "key"', () => {
    const gh = expand('ghp_{b62:36}', 21).text
    const rand = expand('{b62:32}', 22).text
    const found = scanConfigForSecrets({ note: gh, list: [gh], key: rand, name: 'brave' })
    expect(found).toEqual([
      { path: 'note', reason: 'token_pattern' },
      { path: 'list[0]', reason: 'token_pattern' },
      { path: 'key', reason: 'key_like_value' },
    ])
  })

  it('accepts empty values, unset placeholders, numbers and booleans', () => {
    expect(
      scanConfigForSecrets({
        api_key: '',
        token: ph('user_config.token'),
        password: '  ',
        maxTokens: 5,
        ok: true,
      }),
    ).toEqual([])
  })
})

describe('properties', () => {
  const fragments = [
    ...positives.map((c) => expand(c.template, hashString(c.id)).text),
    ...negatives.map((c) => c.query),
  ]

  it('never throws and returns sorted, non-overlapping, in-range findings', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ unit: 'binary' }), fc.constantFrom(...fragments)), { maxLength: 6 }),
        fc.constantFrom('block', 'redact', 'off'),
        (parts, mode) => {
          const q = parts.join(' ')
          const res = checkQuery(q, { mode })
          let prevEnd = 0
          for (const f of res.findings) {
            expect(f.start).toBeGreaterThanOrEqual(prevEnd)
            expect(f.end).toBeGreaterThan(f.start)
            expect(f.end).toBeLessThanOrEqual(q.length)
            prevEnd = f.end
          }
          if (mode !== 'redact') expect(res.query).toBe(q)
        },
      ),
      { seed: 20261030, numRuns: 200 },
    )
  })

  it('redaction removes embedded secrets and is idempotent', () => {
    const secretCases = positives.filter(
      (c) => !['internal_host', 'private_ip', 'high_entropy'].includes(c.class),
    )
    fc.assert(
      fc.property(
        fc.constantFrom(...secretCases),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(
          fc.constantFrom('how', 'to', 'fix', 'error', 'react@18.2.0', '@types/node', 'npm', 'docker'),
          { maxLength: 5 },
        ),
        (c, seed, words) => {
          const { text, generated } = expand(c.template, seed)
          const q = `${words.join(' ')} ${text} ${words.join(' ')}`
          const first = checkQuery(q, redactMode)
          // A random body can, rarely, lack a digit or sufficient entropy; then it is not secret-like.
          if (first.action === 'ok') return
          for (const token of generated) if (token.length >= 16) expect(first.query).not.toContain(token)
          expect(checkQuery(first.query, redactMode).action).toBe('ok')
        },
      ),
      { seed: 20261031, numRuns: 150 },
    )
  })

  it('leaves queries without findings byte-identical in every mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...negatives.map((c) => c.query)),
        fc.constantFrom('block', 'redact'),
        (q, mode) => {
          expect(checkQuery(q, { mode })).toEqual({ action: 'ok', query: q, findings: [] })
        },
      ),
      { seed: 5, numRuns: 100 },
    )
  })
})
