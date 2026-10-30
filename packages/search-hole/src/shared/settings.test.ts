// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkQuery } from '../core/hygiene.ts'
import { isSearchHoleError, type SearchHoleError } from './errors.ts'
import {
  DEFAULT_SETTINGS,
  describeSettingsWarning,
  ENGINE_IDS,
  loadSettings,
  readSettingsFile,
  retentionDaysFor,
  SETTINGS_ENV_BINDINGS,
  setSettingsFileValue,
  setSettingsValue,
  settingsJsonSchema,
  unsetSettingsValue,
  updateSettingsFile,
} from './settings.ts'

/** An unsubstituted host placeholder such as `${user_config.name}`, built without a literal `${`. */
const ph = (name: string): string => ['$', '{', name, '}'].join('')

/** Runs `fn` and returns the SearchHoleError it throws (fails the test otherwise). */
function thrown(fn: () => unknown): SearchHoleError {
  try {
    fn()
  } catch (e) {
    if (isSearchHoleError(e)) return e
    throw e
  }
  throw new Error('expected a SearchHoleError')
}

// The yaml example from ADR-0015 point 2, verbatim.
const ADR_EXAMPLE = `version: 1
engines:
  searxng:    { enabled: true, url: "http://127.0.0.1:8888", timeoutMs: 6000, weight: 1.0, pushdown: off }
  brave:      { enabled: true, plan: free-credit, caps: { day: 300, month: 900 }, pushdown: blocks, storageRights: false }
  tavily:     { enabled: true, caps: { day: 300, month: 900 } }   # no-Docker default (ADR-0017)
fallback: [searxng, tavily, brave, exa]
profiles_default: default
retention: { days: 90 }                                # per-table defaults below
ui: { port: 7341, idleMinutes: 30 }
hooks: { mode: steer, guard: true, receiptLine: true } # ADR-0014
queryHygiene: { mode: block, allow: [] }               # point 4
privacy: { wayback: false, sitemap: false }            # ADR-0011 opt-ins
searxng: { managed: true, port: 8888 }                 # point 5
`

describe('defaults', () => {
  const { settings, locked, warnings, unknownKeys, fromFile } = loadSettings()

  it('match ADR-0015 and ADR-0017', () => {
    expect(settings.version).toBe(1)
    expect(settings.fallback).toEqual(['searxng', 'tavily', 'brave', 'exa'])
    expect(settings.profiles_default).toBe('default')
    expect(settings.retention).toMatchObject({
      days: 90,
      dailyStatsDays: 400,
      suggestionsResolvedDays: 30,
      gatewayDays: 7,
      backups: 3,
    })
    expect(settings.ui).toEqual({ port: 7341, idleMinutes: 30 })
    expect(settings.hooks).toEqual({ mode: 'steer', guard: true, receiptLine: true })
    expect(settings.queryHygiene).toMatchObject({ mode: 'block', allow: [], flagLoopback: false })
    expect(settings.privacy).toEqual({ wayback: false, sitemap: false })
    expect(settings.searxng).toMatchObject({ managed: true, port: 8888, offer: 'pending' })
  })

  it('give SearXNG a local URL with pushdown off, and billed engines block pushdown with caps', () => {
    expect(settings.engines.searxng).toMatchObject({
      url: 'http://127.0.0.1:8888',
      pushdown: 'off',
      timeoutMs: 6000,
      weight: 1,
    })
    expect(settings.engines.searxng.caps).toEqual({ day: null, month: null })
    expect(settings.engines.tavily.caps).toEqual({ day: 300, month: 900 })
    expect(settings.engines.brave).toMatchObject({
      pushdown: 'blocks',
      plan: 'free-credit',
      storageRights: false,
    })
    expect(settings.engines.brave.caps).toEqual({ day: 300, month: 900 })
    expect(settings.engines.exa.caps).toEqual({ day: 300, month: 2000 })
    expect(Object.keys(settings.engines).sort()).toEqual([...ENGINE_IDS].sort())
  })

  it('feed straight into the query hygiene check', () => {
    expect(checkQuery('ssh admin@10.1.2.3', DEFAULT_SETTINGS.queryHygiene).action).toBe('block')
    const lenient = loadSettings(
      'queryHygiene: { mode: redact, allow: ["10\\\\.1\\\\.2\\\\.3"], flagLoopback: true }\n',
    ).settings
    expect(checkQuery('ssh admin@10.1.2.3', lenient.queryHygiene).action).toBe('ok')
    expect(checkQuery('curl localhost:3000', lenient.queryHygiene).action).toBe('ok')
    expect(checkQuery('curl http://localhost:3000', lenient.queryHygiene).action).toBe('redact')
  })

  it('report nothing locked, no warnings, and no file', () => {
    expect(locked).toEqual([])
    expect(warnings).toEqual([])
    expect(unknownKeys).toEqual([])
    expect(fromFile).toBe(false)
  })

  it('are frozen and equal to loading empty text', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SETTINGS.engines.brave.caps)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SETTINGS.fallback)).toBe(true)
    expect(loadSettings('').settings).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings('# only a comment\n').settings).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings('').fromFile).toBe(true)
  })
})

describe('loadSettings', () => {
  it('loads the ADR-0015 example unchanged, keeping `pushdown: off` as the string "off"', () => {
    const loaded = loadSettings(ADR_EXAMPLE)
    expect(loaded.settings).toEqual(DEFAULT_SETTINGS)
    expect(loaded.warnings).toEqual([])
    expect(loaded.settings.engines.searxng.pushdown).toBe('off')
  })

  it('deep-merges partial files over the defaults', () => {
    const { settings } = loadSettings('engines:\n  brave:\n    caps: { day: 100 }\nhooks: { mode: strict }\n')
    expect(settings.engines.brave.caps).toEqual({ day: 100, month: 900 })
    expect(settings.engines.brave.pushdown).toBe('blocks')
    expect(settings.hooks).toEqual({ mode: 'strict', guard: true, receiptLine: true })
  })

  it('treats an explicit null cap as "no cap" and empty sections as defaults', () => {
    const { settings } = loadSettings('engines:\n  tavily:\n    caps: { month: null }\nui:\n')
    expect(settings.engines.tavily.caps).toEqual({ day: 300, month: null })
    expect(settings.ui.port).toBe(7341)
  })

  it('warns about unknown keys at any depth, and still loads', () => {
    const loaded = loadSettings(
      'future: 1\nengines:\n  brave: { newField: x, enabled: false }\nui: { skin: dark }\n',
    )
    expect(loaded.settings.engines.brave.enabled).toBe(false)
    expect(loaded.unknownKeys.sort()).toEqual(['engines.brave.newField', 'future', 'ui.skin'])
    expect(loaded.warnings.map((w) => w.kind)).toEqual(['unknown_key', 'unknown_key', 'unknown_key'])
    expect(describeSettingsWarning(loaded.warnings[0] ?? { kind: 'unknown_key', path: '?' })).toContain(
      'unknown key',
    )
  })

  it('warns when the file is from a newer version', () => {
    const loaded = loadSettings('version: 2\n')
    expect(loaded.warnings).toEqual([{ kind: 'version_newer', found: 2, supported: 1 }])
  })

  describe('rejects', () => {
    it('invalid YAML, naming the line but not quoting the source', () => {
      const err = thrown(() => loadSettings('ui:\n  port: [\n'))
      expect(err.code).toBe('config_invalid')
      expect(err.why).toMatch(/line \d+/)
      expect(err.why).not.toContain('port')
    })

    it('a non-mapping document', () => {
      expect(thrown(() => loadSettings('- a\n- b\n')).code).toBe('config_invalid')
      expect(thrown(() => loadSettings('just text\n')).code).toBe('config_invalid')
    })

    it.each([
      ['ui: { port: 70000 }', 'ui.port'],
      ['ui: { port: "7341" }', 'ui.port'],
      ['hooks: { mode: loud }', 'hooks.mode'],
      ['retention: { days: 0 }', 'retention.days'],
      ['fallback: [searxng, searxng]', 'fallback'],
      ['fallback: [bing]', 'fallback'],
      ['engines: { brave: { caps: { day: -5 } } }', 'engines.brave.caps.day'],
      ['engines: { brave: { url: "ftp://x" } }', 'engines.brave.url'],
      ['engines: { brave: { url: "https://u:p@host.example" } }', 'engines.brave.url'],
      ['engines: { brave: { pushdown: all } }', 'engines.brave.pushdown'],
      ['queryHygiene: { allow: ["("] }', 'queryHygiene.allow'],
      ['queryHygiene: { internalHosts: ["a/b"] }', 'queryHygiene.internalHosts'],
    ])('%s', (yaml, path) => {
      const err = thrown(() => loadSettings(`${yaml}\n`))
      expect(err.code).toBe('config_invalid')
      expect(err.why).toContain(path)
    })
  })

  describe('refuses secrets in the file', () => {
    it('a secret-named field, without echoing the value', () => {
      const err = thrown(() => loadSettings('engines:\n  brave:\n    api_key: hunter2hunter2\n'))
      expect(err.code).toBe('secret_in_config')
      expect(err.why).toContain('engines.brave.api_key')
      expect(JSON.stringify({ why: err.why, fix: err.fix, details: err.details })).not.toContain('hunter2')
      expect(err.fix).toContain('keys set')
    })

    it('a token pattern under an innocent name', () => {
      const token = `ghp_${'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5'}`
      const err = thrown(() => loadSettings(`engines:\n  brave:\n    plan: ${token}\n`))
      expect(err.code).toBe('secret_in_config')
      expect(JSON.stringify(err.details)).not.toContain(token)
    })

    it('but accepts unset placeholders and empty values', () => {
      const loaded = loadSettings(
        `engines:\n  brave:\n    api_key: ""\n    token: "${ph('user_config.token')}"\n`,
      )
      expect(loaded.unknownKeys.sort()).toEqual(['engines.brave.api_key', 'engines.brave.token'])
    })
  })
})

describe('environment overrides', () => {
  it('override the file, lock their fields, and leave the rest alone', () => {
    const loaded = loadSettings('hooks: { mode: off }\nui: { port: 7000 }\n', {
      env: {
        SEARCHHOLE_HOOK_MODE: 'strict',
        SEARCHHOLE_SEARXNG_URL: 'http://127.0.0.1:9999',
        SEARCHHOLE_UI_PORT: '7400',
      },
    })
    expect(loaded.settings.hooks.mode).toBe('strict')
    expect(loaded.settings.engines.searxng.url).toBe('http://127.0.0.1:9999')
    expect(loaded.settings.ui.port).toBe(7400)
    expect(loaded.settings.ui.idleMinutes).toBe(30)
    expect(loaded.locked.sort()).toEqual(['engines.searxng.url', 'hooks.mode', 'ui.port'])
  })

  it('apply with no settings file at all', () => {
    const loaded = loadSettings(undefined, { env: { SEARCHHOLE_HOOK_MODE: 'OFF' } })
    expect(loaded.settings.hooks.mode).toBe('off')
    expect(loaded.locked).toEqual(['hooks.mode'])
  })

  it('treat empty, whitespace and unsubstituted placeholders as unset', () => {
    const loaded = loadSettings('hooks: { mode: strict }\n', {
      env: {
        SEARCHHOLE_HOOK_MODE: ph('user_config.hook_mode'),
        SEARCHHOLE_UI_PORT: '   ',
        SEARCHHOLE_RETENTION_DAYS: '',
      },
    })
    expect(loaded.settings.hooks.mode).toBe('strict')
    expect(loaded.locked).toEqual([])
    expect(loaded.warnings).toEqual([])
  })

  it('ignore invalid values with a warning and do not lock the field', () => {
    const loaded = loadSettings(undefined, {
      env: {
        SEARCHHOLE_HOOK_MODE: 'banana',
        SEARCHHOLE_UI_PORT: '99999',
        SEARCHHOLE_SEARXNG_URL: 'javascript:alert(1)',
      },
    })
    expect(loaded.settings.hooks.mode).toBe('steer')
    expect(loaded.locked).toEqual([])
    expect(loaded.warnings.map((w) => (w.kind === 'env_invalid' ? w.env : '')).sort()).toEqual([
      'SEARCHHOLE_HOOK_MODE',
      'SEARCHHOLE_SEARXNG_URL',
      'SEARCHHOLE_UI_PORT',
    ])
  })

  it('parse booleans, caps, weights, lists', () => {
    const loaded = loadSettings(undefined, {
      env: {
        SEARCHHOLE_HOOK_GUARD: 'no',
        SEARCHHOLE_BRAVE_CAP_DAY: '50',
        SEARCHHOLE_BRAVE_CAP_MONTH: 'none',
        SEARCHHOLE_TAVILY_WEIGHT: '1.5',
        SEARCHHOLE_EXA_ENABLED: 'false',
        SEARCHHOLE_FALLBACK: 'tavily, brave',
        SEARCHHOLE_QUERY_HYGIENE_MODE: 'redact',
        SEARCHHOLE_PRIVACY_WAYBACK: '1',
      },
    })
    const s = loaded.settings
    expect(s.hooks.guard).toBe(false)
    expect(s.engines.brave.caps).toEqual({ day: 50, month: null })
    expect(s.engines.tavily.weight).toBe(1.5)
    expect(s.engines.exa.enabled).toBe(false)
    expect(s.fallback).toEqual(['tavily', 'brave'])
    expect(s.queryHygiene.mode).toBe('redact')
    expect(s.privacy.wayback).toBe(true)
  })

  it('has unique variable names whose paths all exist in the defaults', () => {
    const names = SETTINGS_ENV_BINDINGS.map((b) => b.env)
    expect(new Set(names).size).toBe(names.length)
    for (const b of SETTINGS_ENV_BINDINGS) {
      expect(b.env).toMatch(/^SEARCHHOLE_[A-Z_]+$/)
      expect(b.env).not.toMatch(/_API_KEY(_FILE)?$/)
      let node: unknown = DEFAULT_SETTINGS
      for (const key of b.path.split('.')) {
        expect(node, b.path).toBeTypeOf('object')
        expect(Object.keys(node as object), b.path).toContain(key)
        node = (node as Record<string, unknown>)[key]
      }
    }
    for (const name of ['SEARCHHOLE_HOOK_MODE', 'SEARCHHOLE_SEARXNG_URL', 'SEARCHHOLE_UI_PORT'])
      expect(names).toContain(name)
  })
})

describe('retentionDaysFor', () => {
  it('uses the table override, else retention.days, and caps payloads at days', () => {
    const { settings } = loadSettings(
      'retention: { days: 30, tables: { searches: 365, resultPayloads: 90 } }\n',
    )
    expect(retentionDaysFor(settings.retention, 'receipts')).toBe(30)
    expect(retentionDaysFor(settings.retention, 'searches')).toBe(365)
    expect(retentionDaysFor(settings.retention, 'resultPayloads')).toBe(30)
  })
})

describe('settingsJsonSchema', () => {
  it('describes every section with defaults and forbids unknown keys', () => {
    const schema = settingsJsonSchema() as {
      title: string
      properties: Record<string, { default?: unknown; properties?: Record<string, { default?: unknown }> }>
      additionalProperties: boolean
    }
    expect(schema.title).toContain('settings.yaml')
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'version',
        'engines',
        'fallback',
        'retention',
        'ui',
        'hooks',
        'queryHygiene',
        'privacy',
        'searxng',
      ]),
    )
    expect(schema.properties.ui?.properties?.port?.default).toBe(7341)
    expect(schema.additionalProperties).toBe(false)
  })
})

describe('setSettingsValue / unsetSettingsValue', () => {
  const original = `# my notes
version: 1
engines:
  brave: { enabled: true, plan: free-credit }   # billed
future_key: keep-me # added by a newer build
hooks:
  mode: steer # steering is the default
`

  it('changes one value and keeps comments, flow style and unknown keys', () => {
    const next = setSettingsValue(original, ['hooks', 'mode'], 'strict')
    expect(next).toContain('# my notes')
    expect(next).toContain('# billed')
    expect(next).toContain('future_key: keep-me # added by a newer build')
    expect(next).toContain('mode: strict # steering is the default')
    const loaded = loadSettings(next)
    expect(loaded.settings.hooks.mode).toBe('strict')
    expect(loaded.unknownKeys).toEqual(['future_key'])
  })

  it('creates nested keys inside flow mappings and missing sections', () => {
    const next = setSettingsValue(original, ['engines', 'brave', 'caps', 'day'], 120)
    expect(loadSettings(next).settings.engines.brave.caps).toEqual({ day: 120, month: 900 })
    expect(next).toContain('# billed')
    expect(loadSettings(setSettingsValue(original, ['ui', 'port'], 7500)).settings.ui.port).toBe(7500)
  })

  it('starts a new file with a header and the version', () => {
    const next = setSettingsValue(undefined, ['ui', 'port'], 7600)
    expect(next).toMatch(/^# search-hole settings/)
    expect(next).toContain('version: 1')
    expect(loadSettings(next).settings.ui.port).toBe(7600)
  })

  it('rejects invalid values and secrets before producing any text', () => {
    expect(thrown(() => setSettingsValue(original, ['ui', 'port'], 99999)).code).toBe('config_invalid')
    expect(thrown(() => setSettingsValue(original, ['hooks', 'mode'], 'loud')).code).toBe('config_invalid')
    expect(
      thrown(() => setSettingsValue(original, ['engines', 'brave', 'api_key'], 'abc123def456ghi')).code,
    ).toBe('secret_in_config')
    expect(thrown(() => setSettingsValue(original, [], 1)).code).toBe('config_invalid')
  })

  it('refuses to write through a scalar, and to edit broken YAML', () => {
    expect(thrown(() => setSettingsValue('ui: 5\n', ['ui', 'port'], 7000)).code).toBe('config_invalid')
    expect(thrown(() => setSettingsValue('ui: [\n', ['ui', 'port'], 7000)).code).toBe('config_invalid')
  })

  it('unsets a key so the default applies again, keeping the rest', () => {
    const next = unsetSettingsValue(original, ['hooks', 'mode'])
    expect(loadSettings(next).settings.hooks.mode).toBe('steer')
    expect(next).toContain('future_key: keep-me')
    expect(unsetSettingsValue(undefined, ['ui', 'port'])).toContain('version: 1')
  })

  it('round-trips random valid values and never drops unknown keys (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65535 }),
        fc.constantFrom('steer', 'strict', 'off'),
        fc.integer({ min: 1, max: 3650 }),
        fc.stringMatching(/^[a-z][a-z0-9_]{2,12}$/),
        (port, mode, days, extra) => {
          fc.pre(
            ![
              'version',
              'engines',
              'fallback',
              'retention',
              'ui',
              'hooks',
              'privacy',
              'searxng',
              'queryHygiene',
              'profiles_default',
            ].includes(extra),
          )
          let text: string | undefined = `${extra}: 1\n`
          text = setSettingsValue(text, ['ui', 'port'], port)
          text = setSettingsValue(text, ['hooks', 'mode'], mode)
          text = setSettingsValue(text, ['retention', 'days'], days)
          const loaded = loadSettings(text)
          expect(loaded.settings.ui.port).toBe(port)
          expect(loaded.settings.hooks.mode).toBe(mode)
          expect(loaded.settings.retention.days).toBe(days)
          expect(loaded.unknownKeys).toEqual([extra])
        },
      ),
      { seed: 7, numRuns: 60 },
    )
  })
})

describe('settings file on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'searchhole-settings-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('readSettingsFile returns defaults for a missing file and loads an existing one', () => {
    const file = join(dir, 'settings.yaml')
    expect(readSettingsFile(file).settings).toEqual(DEFAULT_SETTINGS)
    expect(readSettingsFile(file).fromFile).toBe(false)
    writeFileSync(file, 'ui: { port: 7123 }\n')
    expect(readSettingsFile(file).settings.ui.port).toBe(7123)
  })

  it('updateSettingsFile creates the file 0600 inside a new private folder, with no leftovers', async () => {
    const file = join(dir, 'config', 'settings.yaml')
    await setSettingsFileValue(file, ['hooks', 'mode'], 'off')
    expect(readSettingsFile(file).settings.hooks.mode).toBe('off')
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, 'config')).mode & 0o777).toBe(0o700)
    }
  })

  it('serialises concurrent writers so no update is lost', async () => {
    const file = join(dir, 'settings.yaml')
    await Promise.all([
      setSettingsFileValue(file, ['ui', 'port'], 7001),
      setSettingsFileValue(file, ['hooks', 'mode'], 'strict'),
      setSettingsFileValue(file, ['retention', 'days'], 45),
      setSettingsFileValue(file, ['searxng', 'offer'], 'declined'),
    ])
    const { settings } = readSettingsFile(file)
    expect(settings.ui.port).toBe(7001)
    expect(settings.hooks.mode).toBe('strict')
    expect(settings.retention.days).toBe(45)
    expect(settings.searxng.offer).toBe('declined')
  })

  it('does not rewrite the file when the edit changes nothing, and keeps it intact on invalid edits', async () => {
    const file = join(dir, 'settings.yaml')
    writeFileSync(file, '# keep\nui: { port: 7123 }\n')
    const before = statSync(file).mtimeMs
    await updateSettingsFile(file, (t) => t ?? '')
    expect(statSync(file).mtimeMs).toBe(before)
    await expect(setSettingsFileValue(file, ['ui', 'port'], 0)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('# keep\nui: { port: 7123 }\n')
  })
})
