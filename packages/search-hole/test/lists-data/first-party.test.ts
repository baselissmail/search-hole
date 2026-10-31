// SPDX-License-Identifier: Apache-2.0
// First-party lists (ADR-0016, ADR-0017 point 7): entry hygiene, evidence, and how they are bundled.
import { describe, expect, it } from 'vitest'
import { compileRuleSet, parseMatch } from '../../src/core/rules/index.ts'
import {
  AI_CONTENT_FARMS,
  BUNDLED_LIST_KINDS,
  bundledLists,
  entryMatches,
  FIRST_PARTY_LISTS,
  GITHUB_CLONES,
  OFFICIAL_DOCS_ID,
} from '../../src/lists/bundled/index.ts'

const opts = { profile: 'default', now: 0 }
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/

/** Host part of a match string (`example.com/docs` → `example.com`). */
const hostOf = (m: string): string => m.split('/')[0] ?? m
/** True when `host` is `domain` or one of its subdomains. */
const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

describe('first-party list entries', () => {
  for (const list of FIRST_PARTY_LISTS) {
    describe(list.id, () => {
      const matches = entryMatches(list)

      it('every entry is a lowercase host or host + path that parses to itself', () => {
        for (const m of matches) {
          expect(m, m).toBe(m.trim().toLowerCase())
          expect(hostOf(m), m).toMatch(HOST)
          const parsed = parseMatch(m)
          expect(parsed.ok, m).toBe(true)
          if (!parsed.ok) continue
          expect(['domain', 'host_path'], m).toContain(parsed.match.kind)
          expect(parsed.match.canonical, m).toBe(m)
        }
      })

      it('has no duplicates', () => {
        expect(new Set(matches).size).toBe(matches.length)
      })
    })
  }

  // official-docs predates this rule (e.g. docs.cloud.google.com next to cloud.google.com).
  for (const list of FIRST_PARTY_LISTS.filter((l) => l.id !== OFFICIAL_DOCS_ID)) {
    it(`${list.id}: no entry is already covered by a host entry of the same list`, () => {
      const matches = entryMatches(list)
      const hosts = matches.filter((m) => !m.includes('/'))
      const covered = matches.flatMap((m) =>
        hosts.filter((d) => d !== m && under(hostOf(m), d)).map((d) => `${m} ⊂ ${d}`),
      )
      expect(covered).toEqual([])
    })
  }

  it('no official entry overlaps a block-list entry, in either direction', () => {
    const official = FIRST_PARTY_LISTS.filter((l) => l.kind === 'official').flatMap(entryMatches)
    const blocking = FIRST_PARTY_LISTS.filter((l) => l.kind !== 'official').flatMap(entryMatches)
    const overlaps = official.flatMap((o) =>
      blocking
        .filter((b) => under(hostOf(o), hostOf(b)) || under(hostOf(b), hostOf(o)))
        .map((b) => `${o} ~ ${b}`),
    )
    expect(overlaps).toEqual([])
  })

  it('github-clones: each entry has a copied page on its own host and an original on SO/SE/GitHub', () => {
    for (const e of GITHUB_CLONES) {
      const ev = new URL(e.evidence)
      expect(under(ev.hostname, hostOf(e.match)), `${e.match}: ${e.evidence}`).toBe(true)
      const path = e.match.slice(hostOf(e.match).length)
      if (path) expect(ev.pathname.startsWith(path), `${e.match}: ${e.evidence}`).toBe(true)
      expect(e.original, e.match).toBeDefined()
      const orig = new URL(e.original ?? '')
      expect(orig.protocol).toBe('https:')
      expect(
        /(^|\.)(stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|askubuntu\.com|github\.com)$/.test(
          orig.hostname,
        ),
        `${e.match}: ${e.original}`,
      ).toBe(true)
    }
  })

  it('ai-content-farms: each entry links a documented report and says what corroborates it', () => {
    expect(AI_CONTENT_FARMS.length).toBeLessThanOrEqual(40)
    for (const e of AI_CONTENT_FARMS) {
      expect(e.evidence, e.match).toMatch(
        /^https:\/\/github\.com\/popcar2\/BadWebsiteBlocklist\/issues\/\d+$/,
      )
      expect(e.note, e.match).toBeTruthy()
    }
  })
})

describe('bundledLists()', () => {
  const lists = bundledLists()

  it('ships the four first-party lists with their kind and default mode', () => {
    expect(lists.map((l) => [l.id, l.kind, l.mode])).toEqual([
      ['official-docs', 'official', 'enforce'],
      ['official-health', 'official', 'enforce'],
      ['github-clones', 'clone', 'enforce'],
      ['ai-content-farms', 'content-farm', 'audit'],
    ])
    expect([...BUNDLED_LIST_KINDS]).toEqual(lists.map((l) => [l.id, l.kind]))
  })

  it('compiles every entry with no issues', () => {
    const set = compileRuleSet({ lists })
    expect(set.issues).toEqual([])
    expect(set.size.list).toBe(FIRST_PARTY_LISTS.reduce((n, l) => n + l.entries.length, 0))
  })

  it('official lists only annotate; block lists block; evidence rides along as the rule note', () => {
    for (const l of lists) {
      for (const r of l.rules) {
        expect(r.action).toBe(l.kind === 'official' ? 'normal' : 'block')
        if (l.kind !== 'official') expect(r.note).toMatch(/^evidence: https?:\/\//)
      }
    }
  })

  it('official-health annotates and never hides or reweights', () => {
    const set = compileRuleSet({ lists })
    const d = set.decide('https://www.nhs.uk/conditions/flu/', opts)
    expect(d.visibility).toBe('kept')
    expect(d.weight.factor).toBe(1)
    expect(set.listMemberships('https://www.nhs.uk/conditions/flu/', opts)).toEqual(['official-health'])
    expect(set.listMemberships('https://www.canada.ca/en/public-health/services/x.html', opts)).toEqual([
      'official-health',
    ])
    expect(set.listMemberships('https://www.canada.ca/en/services/taxes.html', opts)).toEqual([])
  })

  it('github-clones hides a clone, and a narrowed entry hides only its path', () => {
    const set = compileRuleSet({ lists })
    expect(set.decide('https://qastack.ru/programming/13150343/x', opts).visibility).toBe('hidden')
    expect(set.decide('https://lightrun.com/answers/some-issue', opts).visibility).toBe('hidden')
    expect(set.decide('https://lightrun.com/pricing', opts).visibility).toBe('kept')
  })

  it('ai-content-farms is audit-only: it never changes visible output, it records would-hide', () => {
    const set = compileRuleSet({ lists })
    const d = set.decide('https://www.solveyourtech.com/how-to-x/', opts)
    expect(d.visibility).toBe('kept')
    expect(d.audit?.wouldBe).toBe('hidden')
    expect(set.listMemberships('https://www.solveyourtech.com/how-to-x/', opts)).toEqual([])
  })
})
