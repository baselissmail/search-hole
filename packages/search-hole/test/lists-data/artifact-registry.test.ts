// SPDX-License-Identifier: Apache-2.0
// Compiled list artifacts and the list registry (ADR-0022): pure parts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileRuleSet } from '../../src/core/rules/engine.ts'
import {
  artifactToListInput,
  contentSha256,
  decodeArtifact,
  encodeArtifact,
  LIST_COMPILER_VERSION,
  peekArtifact,
} from '../../src/lists/artifact.ts'
import { CATALOG, stripVendorHeader, VENDORED_LISTS } from '../../src/lists/catalog.ts'
import { importList, toListInput } from '../../src/lists/import/index.ts'
import {
  EXPIRES_FLOOR_MS,
  idFromUrl,
  refreshIntervalMs,
  resolveRegistry,
  retryDelayMs,
  shrinkRefused,
} from '../../src/lists/registry.ts'

const REPO = join(import.meta.dirname, '..', '..', '..', '..')
const HOUR = 3_600_000
const DAY = 24 * HOUR

const TEXT = `! Title: test
||spam.example^
||ads.example^$important
@@||good.spam.example^
||old.example^$badfilter
/-tutorial-.*\\.xyz$/
`

describe('list artifacts', () => {
  const imported = importList(TEXT, { format: 'auto', listId: 'abp-test', kind: 'block' })
  const sha = contentSha256(TEXT)
  const build = { contentSha256: sha, kind: 'block' as const, requestedFormat: 'auto' as const }
  const text = encodeArtifact(imported, { ...build, builtAt: '2026-10-31T00:00:00.000Z' })

  it('round-trips the import exactly (rules, ids, cancel set, stats)', () => {
    const d = decodeArtifact(text, { listId: 'abp-test', build })
    if (!d.ok) throw new Error(d.reason)
    const strip = (rs: typeof imported.rules) => rs.map(({ text: _t, ...r }) => r)
    expect(d.artifact.rules).toEqual(strip(imported.rules))
    expect(d.artifact.cancel).toEqual(imported.cancel)
    expect(d.artifact.stats).toEqual(imported.stats)
    expect(d.artifact.format).toBe('abp')
    expect(d.artifact.compilerVersion).toBe(LIST_COMPILER_VERSION)
    expect(peekArtifact(text)).toMatchObject({ listId: 'abp-test', contentSha256: sha })
    // The engine decides the same with the artifact as with the fresh import.
    const a = compileRuleSet({ lists: [artifactToListInput(d.artifact, 'enforce')] })
    const b = compileRuleSet({ lists: [toListInput(imported, 'enforce')] })
    for (const url of [
      'https://spam.example/',
      'https://good.spam.example/',
      'https://ads.example/x',
      'https://x.com/a-tutorial-b.xyz',
    ]) {
      expect(a.decide(url, { profile: 'p', now: 0 }).visibility, url).toBe(
        b.decide(url, { profile: 'p', now: 0 }).visibility,
      )
    }
  })

  it('reports damage, another compiler, another source or other options instead of throwing', () => {
    const nl = text.indexOf('\n')
    expect(decodeArtifact(`${text.slice(0, nl)}\n{"meta":`, { listId: 'abp-test', build })).toEqual({
      ok: false,
      reason: 'checksum',
    })
    expect(decodeArtifact('garbage', { listId: 'abp-test' })).toEqual({ ok: false, reason: 'corrupt' })
    expect(decodeArtifact('', { listId: 'abp-test' })).toEqual({ ok: false, reason: 'corrupt' })
    expect(decodeArtifact(text, { listId: 'abp-test', build, compilerVersion: '999' })).toEqual({
      ok: false,
      reason: 'compiler_version',
    })
    expect(decodeArtifact(text, { listId: 'other' })).toEqual({ ok: false, reason: 'other_list' })
    expect(
      decodeArtifact(text, { listId: 'abp-test', build: { ...build, contentSha256: 'f'.repeat(64) } }),
    ).toEqual({ ok: false, reason: 'other_content' })
    expect(decodeArtifact(text, { listId: 'abp-test', build: { ...build, kind: 'content-farm' } })).toEqual({
      ok: false,
      reason: 'other_options',
    })
    // A tampered body with a recomputed header still has to have the right shape.
    const body = JSON.stringify({ meta: {}, rules: [[1, 2]], cancel: [] })
    expect(decodeArtifact(`${text.slice(0, nl)}\n${body}`, { listId: 'abp-test' }).ok).toBe(false)
  })

  it('the shipped starter copies hash to their manifest (UTF-8 text and bytes agree)', () => {
    for (const v of VENDORED_LISTS) {
      const split = stripVendorHeader(readFileSync(join(REPO, v.path), 'utf8'))
      expect(split, v.id).not.toBeNull()
      expect(contentSha256(split?.body ?? ''), v.id).toBe(v.sha256)
    }
  })
})

describe('list registry', () => {
  it('enables the ADR-0017 starter set with its recommended modes, plus the first-party lists', () => {
    const r = resolveRegistry({ subscriptions: [], settings: {}, locals: [] })
    const modes = Object.fromEntries(r.entries.map((e) => [e.id, `${e.source}:${e.mode}`]))
    expect(modes).toEqual({
      'official-docs': 'bundled:enforce',
      'official-health': 'bundled:enforce',
      'github-clones': 'bundled:enforce',
      'ai-content-farms': 'bundled:audit',
      'quenhus-dev-filter': 'vendored:enforce',
      'arosh-stackoverflow-translation': 'vendored:enforce',
      'arosh-github-translation': 'vendored:enforce',
      'rjaus-pinterest': 'vendored:enforce',
      'laylavish-huge-ai': 'vendored:audit',
    })
    expect(r.problems).toEqual([])
    // Super-SEO is offered, never auto-enabled.
    expect(r.entries.some((e) => e.id === 'super-seo-spam-suppressor')).toBe(false)
  })

  it('applies lists.<id>.mode, subscriptions, local imports and reports clashes', () => {
    const super_ = CATALOG.find((c) => c.id === 'super-seo-spam-suppressor')
    const r = resolveRegistry({
      subscriptions: [
        {
          name: 'super-seo-spam-suppressor',
          url: super_?.url ?? '',
          format: 'ublacklist',
          kind: 'block',
          update: '1d',
          mode: 'audit',
        },
        {
          name: 'laylavish-huge-ai',
          url: CATALOG.find((c) => c.id === 'laylavish-huge-ai')?.url ?? '',
          format: 'ublacklist',
          kind: 'content-farm',
          update: '7d',
          mode: 'enforce',
        },
        {
          name: 'official-docs',
          url: 'https://x.example/l.txt',
          format: 'auto',
          kind: 'block',
          update: '7d',
          mode: 'enforce',
        },
      ],
      settings: {
        'rjaus-pinterest': { mode: 'disabled' },
        'github-clones': { mode: 'audit' },
        ghost: { mode: 'audit' },
      },
      locals: [
        {
          id: 'mine',
          kind: 'block',
          format: 'domains',
          file: 'mine.txt',
          importedAt: '2026-10-31T00:00:00Z',
          contentSha256: 'a'.repeat(64),
          bytes: 3,
        },
      ],
    })
    const by = new Map(r.entries.map((e) => [e.id, e]))
    expect(by.get('rjaus-pinterest')?.mode).toBe('disabled')
    expect(by.get('github-clones')?.mode).toBe('audit')
    expect(by.get('super-seo-spam-suppressor')).toMatchObject({
      source: 'subscribed',
      mode: 'audit',
      update: '1d',
      license: 'WTFNMFPL',
    })
    // A subscription with a starter list's name and URL keeps the shipped copy as its fallback.
    expect(by.get('laylavish-huge-ai')).toMatchObject({ source: 'vendored', mode: 'enforce' })
    expect(by.get('laylavish-huge-ai')?.vendored).toBeDefined()
    expect(by.get('mine')).toMatchObject({ source: 'local', mode: 'enforce' })
    expect(r.problems.join('\n')).toContain("subscription 'official-docs' has the name of a built-in list")
    expect(r.problems.join('\n')).toContain('lists.ghost names no list')
  })

  it('refresh arithmetic: Expires can only shorten the interval, never below 6 h; back-off doubles', () => {
    expect(refreshIntervalMs(7 * DAY)).toBe(7 * DAY)
    expect(refreshIntervalMs(7 * DAY, '1 day')).toBe(DAY)
    expect(refreshIntervalMs(7 * DAY, '30 days')).toBe(7 * DAY)
    expect(refreshIntervalMs(7 * DAY, '1h')).toBe(EXPIRES_FLOOR_MS)
    expect(refreshIntervalMs(60_000)).toBe(HOUR)
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n, DAY) / HOUR)).toEqual([1, 2, 4, 8])
    expect(retryDelayMs(10, DAY)).toBe(DAY)
  })

  it('the shrink guard refuses a copy with under half the rules in force', () => {
    expect(shrinkRefused(100, 49)).toBe(true)
    expect(shrinkRefused(100, 50)).toBe(false)
    expect(shrinkRefused(0, 0)).toBe(false)
    expect(shrinkRefused(null, 0)).toBe(false)
  })

  it('names a list from its URL', () => {
    expect(idFromUrl('https://example.com/lists/My_List.txt')).toBe('my_list')
    expect(idFromUrl('https://example.com/a/b/spam%20sites.goggle')).toBe('spam-sites')
    expect(idFromUrl('https://example.com/')).toBeNull()
  })
})
