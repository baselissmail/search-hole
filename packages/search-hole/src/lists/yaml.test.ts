// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileRuleSet } from '../core/rules/engine.ts'
import { isSearchHoleError, type SearchHoleError } from '../shared/errors.ts'
import {
  detectSecretValue,
  isSecretFieldName,
  type LoadRulesOptions,
  loadRulesYaml,
  type RulesIssue,
} from './yaml.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/rules/${name}`, import.meta.url), 'utf8')
const GLOBAL: LoadRulesOptions = { scope: 'global', file: 'rules.yaml' }
const PROJECT: LoadRulesOptions = { scope: 'project', file: '.searchhole.yaml' }

function loadError(text: string, opts: LoadRulesOptions = GLOBAL): SearchHoleError {
  try {
    loadRulesYaml(text, opts)
  } catch (e) {
    if (isSearchHoleError(e)) return e
    throw e
  }
  throw new Error('expected the load to fail')
}
const issuesOf = (e: SearchHoleError) => (e.details?.issues ?? []) as RulesIssue[]

describe('loadRulesYaml: global fixture', () => {
  const r = loadRulesYaml(fixture('global.rules.yaml'), GLOBAL)

  it('loads rules in file order with stable ids and inferred kinds', () => {
    expect(r.rules.map((x) => [x.matchKind, x.action, x.order])).toEqual([
      ['domain', 'block', 0],
      ['domain', 'lower', 1],
      ['exact_host', 'allow', 2],
      ['host_path', 'raise', 3],
      ['url_pattern', 'block', 4],
      ['regex', 'block', 5],
      ['domain', 'pin', 6],
      ['domain', 'block', 7],
      ['domain', 'block', 8],
      ['domain', 'block', 9],
    ])
    for (const rule of r.rules) expect(rule.id).toMatch(/^r_[0-9a-f]{10}(-\d+)?$/)
    expect(r.rules[9]?.id).toBe(`${r.rules[0]?.id}-2`)
    expect(r.rules[1]).toMatchObject({
      match: '*.medium.com',
      weight: 3,
      scope: 'global',
      source: 'rules.yaml:19',
    })
    expect(r.rules[6]?.profiles).toEqual(['coding'])
    expect(r.rules[7]).toMatchObject({ important: true, note: 'never' })
    expect(r.rules[8]?.until).toBe('2026-12-31')
  })

  it('warns about the exact duplicate with its line', () => {
    expect(r.warnings).toEqual([
      { code: 'duplicate_rule', message: 'exact duplicate of rules[0]', path: 'rules[9]', line: 27, col: 5 },
    ])
  })

  it('keeps profile order from the file, including integer-like names', () => {
    expect(r.profiles.map((p) => p.name)).toEqual(['coding', 'prices-news', '2024'])
    expect(r.profiles[0]).toEqual({
      name: 'coding',
      match: { keywords: ['docs', 'api', 'error', 'npm', 'pip', 'typescript', 'react'] },
      prefer: { lists: ['official-docs'] },
      freshness: { maxAgeDays: 730, requireDate: false },
    })
    expect(r.profiles[1]?.match).toEqual({ regex: ['(?i)\\bprices?\\b'] })
    expect(r.profiles[2]).toEqual({ name: '2024', defaultAction: 'block' })
    expect(r.defaults).toEqual({ engines: ['searxng', 'brave'], depth: 'standard' })
  })

  it('fills subscription defaults', () => {
    expect(r.subscriptions).toEqual([
      {
        name: 'seo-spam',
        url: 'https://lists.example/seo-spam.txt',
        format: 'ublacklist',
        kind: 'block',
        update: '7d',
        mode: 'enforce',
      },
      {
        name: 'official-docs',
        url: 'https://lists.example/official-docs.txt',
        format: 'domains',
        kind: 'official',
        update: '7d',
        mode: 'audit',
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
    ])
  })

  it('compiles cleanly into the engine', () => {
    const set = compileRuleSet({ rules: r.rules, profiles: r.profiles })
    expect(set.issues).toEqual([])
    const now = Date.parse('2026-10-30T00:00:00Z')
    expect(set.decide('https://www.pinterest.com/x', { profile: 'default', now }).visibility).toBe('hidden')
    expect(set.decide('https://example.com/', { profile: '2024', now }).visibility).toBe('kept')
    expect(set.decide('https://other.example/', { profile: '2024', now }).hiddenReason).toBe('allowlist_mode')
  })

  it('gives the same ids for the same file every time', () => {
    const again = loadRulesYaml(fixture('global.rules.yaml'), GLOBAL)
    expect(again.rules.map((x) => x.id)).toEqual(r.rules.map((x) => x.id))
  })
})

describe('loadRulesYaml: project fixture', () => {
  const r = loadRulesYaml(fixture('project.searchhole.yaml'), PROJECT)

  it('makes an unknown action a counted no-op and warns about unknown fields', () => {
    expect(r.rules.map((x) => x.match)).toEqual(['stackoverflow.com', 'w3schools.com', 'example.com'])
    expect(r.rules.map((x) => x.order)).toEqual([0, 1, 3])
    expect(r.noopRules).toBe(1)
    expect(r.warnings).toEqual([
      {
        code: 'unknown_action',
        message: "unknown action 'quarantine': rule ignored (needs a newer search-hole)",
        path: 'rules[2].action',
        line: 10,
        col: 35,
      },
      {
        code: 'unknown_field',
        message: "unknown rule field 'colour' is ignored",
        path: 'rules[3].colour',
        line: 11,
        col: 42,
      },
    ])
    expect(r.rules.every((x) => x.scope === 'project')).toBe(true)
    expect(r.rules[1]?.profiles).toEqual(['coding', 'docs'])
    expect(r.subscriptions).toEqual([])
  })

  it('gives project and global copies of the same rule different ids', () => {
    const text = 'version: 1\nrules:\n  - { match: x.com, action: block }\n'
    expect(loadRulesYaml(text, PROJECT).rules[0]?.id).not.toBe(loadRulesYaml(text, GLOBAL).rules[0]?.id)
  })
})

describe('loadRulesYaml: errors carry file and line', () => {
  it('reports every bad rule, sorted by line', () => {
    const e = loadError(fixture('invalid.rules.yaml'), { scope: 'global', file: 'invalid.rules.yaml' })
    expect(e.code).toBe('rules_invalid')
    const issues = issuesOf(e)
    expect(issues.map((i) => [i.line, i.path])).toEqual([
      [4, 'rules[1].match'],
      [5, 'rules[2].weight'],
      [6, 'rules[3].match'],
      [8, 'rules[4].match'],
      [11, 'profiles.bad.match.regex[0]'],
    ])
    expect(issues[0]?.message).toContain('lookahead')
    expect(issues[2]?.message).toContain("more than 2 '*'")
    expect(issues[4]?.message).toContain('backreferences')
    expect(e.why).toMatch(/^invalid\.rules\.yaml:4:\d+: .*lookahead.* \(and 4 more\)$/)
    expect(e.details?.file).toBe('invalid.rules.yaml')
  })

  it('reports YAML syntax errors with a line', () => {
    const e = loadError('version: 1\nrules:\n  - { match: x.com, action: block\n')
    expect(e.code).toBe('rules_invalid')
    expect(issuesOf(e)[0]?.line).toBeGreaterThanOrEqual(3)
    expect(e.why).toMatch(/^rules\.yaml:\d+:\d+: YAML: /)
  })

  it('rejects duplicate keys', () => {
    const e = loadError('version: 1\nrules: []\nrules: []\n')
    expect(issuesOf(e)[0]?.line).toBe(3)
  })

  it.each([
    ['version: 2\n', 1, 'needs a newer search-hole'],
    ['rules: []\n', 1, 'version: 1 is required'],
    ['- a\n- b\n', 1, 'must be a mapping'],
    ['version: 1\nrules:\n  - pinterest.com\n', 3, 'each rule must be a mapping'],
    ['version: 1\nrules:\n  - { match: x.com, action: block, ttl: 7d }\n', 3, 'ttl needs a start time'],
    ['version: 1\nrules:\n  - { match: x.com, action: block, until: soon }\n', 3, 'until must be a date'],
    ['version: 1\nrules:\n  - { match: "x .com", action: block }\n', 3, 'not a valid host name'],
    ['version: 1\nrules:\n  - { match: x.com, action: 7 }\n', 3, 'action is required and must be a string'],
    ['version: 1\nengines:\n  brave: { enabled: true }\n', 2, 'belongs in settings.yaml'],
    ['version: 1\nprofiles:\n  p:\n    url: http://evil.example\n', 4, 'settings.yaml'],
    ['version: 1\nprofiles:\n  p: { engines: [google] }\n', 3, 'Invalid option'],
    ['version: 1\nprofiles:\n  "bad name": {}\n', 3, 'profile name'],
    ['version: 1\nsubscriptions:\n  - { name: a, url: "http://lists.example/a" }\n', 3, 'https://'],
    ['version: 1\nsubscriptions:\n  - { name: a, url: "https://x/a", update: often }\n', 3, 'duration'],
    [
      'version: 1\nsubscriptions:\n  - { name: a, url: "https://x/a" }\n  - { name: a, url: "https://x/b" }\n',
      4,
      'duplicate subscription',
    ],
    [
      'version: 1\nrules:\n  - { match: a.com, action: block, id: x }\n  - { match: b.com, action: block, id: x }\n',
      4,
      'used twice',
    ],
  ])('%j → line %i: %s', (text, line, message) => {
    const e = loadError(text)
    expect(e.code).toBe('rules_invalid')
    expect(issuesOf(e)[0]).toMatchObject({ line })
    expect(issuesOf(e)[0]?.message).toContain(message)
  })

  it('accepts an empty file as an empty rule set', () => {
    expect(loadRulesYaml('', GLOBAL)).toMatchObject({
      rules: [],
      profiles: [],
      subscriptions: [],
      noopRules: 0,
    })
    expect(loadRulesYaml('# nothing yet\n', PROJECT).rules).toEqual([])
  })

  it('warns about unknown fields nested in profiles and defaults', () => {
    const r = loadRulesYaml(
      'version: 1\nprofiles:\n  p:\n    match: { keywords: [a], fuzzy: true }\n    freshness: { maxAgeDays: 3, grace: 1 }\ndefaults:\n  depth: deep\n  colour: red\n',
      GLOBAL,
    )
    expect(r.warnings.map((w) => [w.path, w.line])).toEqual([
      ['profiles.p.match.fuzzy', 4],
      ['profiles.p.freshness.grace', 5],
      ['defaults.colour', 8],
    ])
    expect(r.profiles[0]).toEqual({ name: 'p', match: { keywords: ['a'] }, freshness: { maxAgeDays: 3 } })
  })

  it('warns about an ignored weight and unknown top-level fields', () => {
    const r = loadRulesYaml(
      'version: 1\nextra: 1\nrules:\n  - { match: x.com, action: block, weight: 4 }\n',
      GLOBAL,
    )
    expect(r.warnings.map((w) => [w.code, w.line])).toEqual([
      ['unknown_field', 2],
      ['ignored_weight', 4],
    ])
    expect(r.rules[0]?.weight).toBe(1)
  })
})

describe('loadRulesYaml: project files are restricted (ADR-0008, ADR-0015)', () => {
  it('rejects important: true with its line', () => {
    const e = loadError(
      'version: 1\nrules:\n  - { match: x.com, action: allow }\n  - { match: y.com, action: block, important: true }\n',
      PROJECT,
    )
    expect(issuesOf(e)).toEqual([
      expect.objectContaining({
        path: 'rules[1].important',
        line: 4,
        message: expect.stringContaining('not allowed in project files'),
      }),
    ])
    expect(e.why).toMatch(/^\.searchhole\.yaml:4:/)
  })

  it('allows important: false', () => {
    expect(
      loadRulesYaml('version: 1\nrules:\n  - { match: x.com, action: block, important: false }\n', PROJECT)
        .rules,
    ).toHaveLength(1)
  })

  it('rejects subscriptions and settings keys', () => {
    expect(issuesOf(loadError('version: 1\nsubscriptions: []\n', PROJECT))[0]).toMatchObject({
      line: 2,
      path: 'subscriptions',
    })
    expect(issuesOf(loadError('version: 1\nqueryHygiene: { mode: off }\n', PROJECT))[0]?.message).toContain(
      'settings.yaml',
    )
    expect(issuesOf(loadError('version: 1\nsearxng: { port: 1 }\n', PROJECT))[0]?.message).toContain(
      'settings.yaml',
    )
  })
})

describe('refusing secrets (ADR-0007 point 6)', () => {
  const secrets: [string, number, string][] = [
    ['version: 1\nprofiles:\n  p:\n    api_key: abc123\n', 4, "a field named 'api_key'"],
    ['version: 1\nbraveApiKey: x\n', 2, "a field named 'braveApiKey'"],
    ['version: 1\ntoken: x\n', 2, "a field named 'token'"],
    ['version: 1\npassword: hunter2\n', 2, "a field named 'password'"],
    [
      'version: 1\nrules:\n  - { match: x.com, action: block, note: "sk-proj-AbCdEf1234567890XyZ12345" }\n',
      3,
      'sk-',
    ],
    [
      'version: 1\nrules:\n  - match: x.com\n    action: block\n    note: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
      5,
      'GitHub token',
    ],
    ['version: 1\nrules:\n  - { match: x.com, action: block, note: "AKIAIOSFODNN7EXAMPLE" }\n', 3, 'AWS'],
    [
      'version: 1\nrules:\n  - { match: x.com, action: block, note: "tvly-dev-abcdefghijklmnop1234" }\n',
      3,
      'Tavily',
    ],
    [
      'version: 1\nrules:\n  - { match: x.com, action: block, note: "BSAabcdefGHIJKLmnop1234567890" }\n',
      3,
      'Brave',
    ],
    [
      'version: 1\nrules:\n  - { match: x.com, action: block, note: "dGhpcyBpcyBhIHNlY3JldCB2YWx1ZTEyMzQ1Njc4OQ==" }\n',
      3,
      'opaque',
    ],
    [
      'version: 1\nrules:\n  - { match: x.com, action: block, note: "0123456789abcdef0123456789abcdef01234567" }\n',
      3,
      'opaque',
    ],
    [
      'version: 1\nsubscriptions:\n  - { name: a, url: "https://lists.example/a.txt?token=abcdef123456" }\n',
      3,
      'key in a URL',
    ],
    [
      'version: 1\nsubscriptions:\n  - { name: a, url: "https://user:pa55word@lists.example/a.txt" }\n',
      3,
      'password',
    ],
    ['version: 1\nprofiles:\n  p:\n    brave: { key: "abcdefghijklmnopqrstuvwx" }\n', 4, 'a key'],
  ]
  it.each(secrets)('%j → secret_in_config at line %i (%s)', (text, line, kind) => {
    const e = loadError(text)
    expect(e.code).toBe('secret_in_config')
    const findings = e.details?.findings as { line: number; kind: string }[]
    expect(findings[0]?.line).toBe(line)
    expect(findings[0]?.kind).toContain(kind)
    expect(e.fix).toContain('searchhole keys set')
  })

  it('never echoes the secret', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const e = loadError(`version: 1\nrules:\n  - { match: x.com, action: block, note: "${secret}" }\n`)
    expect(JSON.stringify({ why: e.why, fix: e.fix, details: e.details, msg: e.message })).not.toContain(
      secret,
    )
  })

  it('refuses secrets in a project file too, before any other check', () => {
    expect(loadError('version: 9\nsecret: s3cr3t\n', PROJECT).code).toBe('secret_in_config')
  })

  it('does not flag ordinary rule content', () => {
    const ok = [
      'sk-learn-tutorials.example',
      'skiing-tips.com',
      'https://lists.example/official-docs.txt',
      '/^https?:\\/\\/[a-z0-9-]+\\.xyz\\//',
      'github.com/orgname/repo/commit/0123abc',
      'never show these',
      'BSA-guide.example',
    ]
    for (const v of ok) expect(detectSecretValue(v, 'match')).toBeNull()
    expect(
      detectSecretValue('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'sha256'),
    ).toBeNull()
    for (const f of ['match', 'keywords', 'maxAgeDays', 'requireDate', 'sha256', 'tokens', 'monkey']) {
      expect(isSecretFieldName(f)).toBe(false)
    }
    for (const f of [
      'api_key',
      'apiKey',
      'x-api-key',
      'auth_token',
      'client_secret',
      'PASSWORD',
      'credentials',
    ]) {
      expect(isSecretFieldName(f)).toBe(true)
    }
  })

  it('does not treat profile names as field names', () => {
    expect(
      loadRulesYaml('version: 1\nprofiles:\n  secret: {}\n  token: {}\n', GLOBAL).profiles.map((p) => p.name),
    ).toEqual(['secret', 'token'])
  })
})
