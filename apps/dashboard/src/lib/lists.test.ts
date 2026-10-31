// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import type { ListStatus, ListUpdateResult } from './contract.ts'
import {
  canRemove,
  canUpdate,
  catalogAddMode,
  catalogUndo,
  checkListName,
  checkListUrl,
  contributionSummary,
  contributionText,
  hostOf,
  intervalText,
  licenseText,
  listErrorAdvice,
  resubscribeInput,
  summaryText,
  tallyText,
  tallyUpdates,
  updateOutcome,
} from './lists.ts'
import { parseListsSearch } from './listsSearch.ts'

function list(over: Partial<ListStatus> = {}): ListStatus {
  return {
    id: 'my-list',
    name: 'My list',
    source: 'subscribed',
    url: 'https://example.net/my-list.txt',
    format: 'ublacklist',
    kind: 'block',
    mode: 'enforce',
    defaultMode: 'enforce',
    ruleCount: 10,
    skipped: 0,
    skipReasons: {},
    copy: 'downloaded',
    lastUpdate: null,
    lastCheck: null,
    nextUpdate: null,
    lastError: null,
    warnings: [],
    contribution: { hidden7d: 0, wouldHide7d: 0 },
    ...over,
  }
}

function withoutUrl(l: ListStatus): ListStatus {
  const { url: _url, ...rest } = l
  return rest
}

const result = (r: Partial<ListUpdateResult>): ListUpdateResult => ({
  id: 'my-list',
  result: 'updated',
  ruleCount: 10,
  previousRuleCount: null,
  message: '',
  ...r,
})

describe('contributionText', () => {
  it('says what an enforced list hid and what an audit list would hide', () => {
    expect(contributionText(list({ contribution: { hidden7d: 312, wouldHide7d: 0 } }))).toBe(
      'Hid 312 results this week',
    )
    expect(contributionText(list({ contribution: { hidden7d: 1, wouldHide7d: 0 } }))).toBe(
      'Hid 1 result this week',
    )
    expect(contributionText(list({ mode: 'audit', contribution: { hidden7d: 0, wouldHide7d: 41 } }))).toBe(
      'Would hide 41 results this week',
    )
    expect(contributionText(list({ contribution: { hidden7d: 5, wouldHide7d: 2 } }))).toBe(
      'Hid 5 results this week; would hide 2 more',
    )
  })

  it('explains a list that hid nothing', () => {
    expect(contributionText(list())).toBe('Hid nothing this week')
    expect(contributionText(list({ mode: 'audit' }))).toBe('Would hide nothing this week')
    expect(contributionText(list({ mode: 'disabled' }))).toBe('Off: not applied')
    expect(contributionText(list({ kind: 'official' }))).toBe('Marks official sources; hides nothing')
    expect(contributionText(list({ kind: 'allow' }))).toBe('Keeps sites; hides nothing')
  })
})

describe('contributionSummary', () => {
  it('adds up the week and ranks the lists that hid the most', () => {
    const s = contributionSummary([
      list({ id: 'a', name: 'A', contribution: { hidden7d: 3, wouldHide7d: 0 } }),
      list({ id: 'b', name: 'B', contribution: { hidden7d: 312, wouldHide7d: 0 } }),
      list({ id: 'c', name: 'C', mode: 'audit', contribution: { hidden7d: 0, wouldHide7d: 41 } }),
      list({ id: 'd', name: 'D', contribution: { hidden7d: 9, wouldHide7d: 0 } }),
      list({ id: 'e', name: 'E', contribution: { hidden7d: 1, wouldHide7d: 0 } }),
    ])
    expect(s.hidden).toBe(325)
    expect(s.wouldHide).toBe(41)
    expect(s.top.map((t) => t.id)).toEqual(['b', 'd', 'a'])
    expect(summaryText(s)).toBe('Lists hid 325 results this week; audit lists would have hidden 41 more.')
  })

  it('has a sentence for a quiet week', () => {
    expect(summaryText(contributionSummary([list()]))).toBe('No list hid anything this week.')
    expect(
      summaryText(
        contributionSummary([list({ mode: 'audit', contribution: { hidden7d: 0, wouldHide7d: 2 } })]),
      ),
    ).toBe('Lists hid nothing this week; audit lists would have hidden 2 more.')
  })
})

describe('undo payloads', () => {
  it('recreates a removed subscription from its status', () => {
    const removed = list({
      id: 'seo',
      url: 'https://raw.githubusercontent.com/x/y/main/list.txt',
      format: 'auto',
      kind: 'content-farm',
      mode: 'audit',
      update: '1d',
      sha256: 'ab'.repeat(32),
    })
    expect(resubscribeInput(removed)).toEqual({
      source: 'https://raw.githubusercontent.com/x/y/main/list.txt',
      name: 'seo',
      format: 'auto',
      kind: 'content-farm',
      mode: 'audit',
      update: '1d',
      sha256: 'ab'.repeat(32),
    })
  })

  it('leaves out what was not set, and has nothing for lists without an address', () => {
    expect(resubscribeInput(list())).toEqual({
      source: 'https://example.net/my-list.txt',
      name: 'my-list',
      format: 'ublacklist',
      kind: 'block',
      mode: 'enforce',
    })
    expect(resubscribeInput(withoutUrl(list({ source: 'local' })))).toBeNull()
    expect(resubscribeInput(withoutUrl(list({ source: 'bundled' })))).toBeNull()
  })

  it('adds a catalog list in its recommended mode, else Audit, and knows how to undo it', () => {
    expect(catalogAddMode({ recommendedMode: 'enforce' })).toBe('enforce')
    expect(catalogAddMode({ recommendedMode: 'audit' })).toBe('audit')
    expect(catalogAddMode({ recommendedMode: 'off' })).toBe('audit')
    expect(catalogUndo({})).toEqual({ remove: true })
    expect(catalogUndo({ mode: 'disabled' })).toEqual({ mode: 'disabled' })
  })

  it('removes only subscriptions and imports, and refreshes only lists with an address', () => {
    expect(canRemove({ source: 'subscribed' })).toBe(true)
    expect(canRemove({ source: 'local' })).toBe(true)
    expect(canRemove({ source: 'vendored' })).toBe(false)
    expect(canRemove({ source: 'bundled' })).toBe(false)
    expect(canUpdate({ source: 'vendored', url: 'https://x.example/l.txt' })).toBe(true)
    expect(canUpdate({ source: 'subscribed', url: 'https://x.example/l.txt' })).toBe(true)
    expect(canUpdate({ source: 'local' })).toBe(false)
    expect(canUpdate({ source: 'bundled' })).toBe(false)
  })
})

describe('update results', () => {
  it('counts outcomes and words the summary without zero counts', () => {
    const t = tallyUpdates([
      result({ result: 'updated' }),
      result({ result: 'updated' }),
      result({ result: 'unchanged' }),
      result({ result: 'failed' }),
    ])
    expect(t).toEqual({ updated: 2, unchanged: 1, failed: 1, skipped: 0 })
    expect(tallyText(t)).toBe('2 updated · 1 unchanged · 1 failed')
    expect(tallyText(tallyUpdates([]))).toBe('No list to update')
  })

  it('words one refresh', () => {
    expect(updateOutcome(result({ ruleCount: 640, previousRuleCount: 625 }), 'L')).toEqual({
      tone: 'success',
      title: 'Updated L',
      description: '625 → 640 rules.',
    })
    expect(updateOutcome(result({ result: 'unchanged', ruleCount: 1 }), 'L').description).toBe(
      'No change; 1 rule in force.',
    )
    const failed = updateOutcome(
      result({
        result: 'failed',
        message: 'x',
        error: { code: 'timeout', message: 'Timed out after 60 s.' },
      }),
      'L',
    )
    expect(failed.tone).toBe('error')
    expect(failed.description).toBe('Timed out after 60 s. The copy in force is kept.')
    expect(
      updateOutcome(result({ result: 'failed', message: 'getaddrinfo ENOTFOUND x.example' }), 'L')
        .description,
    ).toBe('getaddrinfo ENOTFOUND x.example. The copy in force is kept.')
    expect(
      updateOutcome(result({ result: 'skipped', message: 'built in: it updates with search-hole' }), 'L'),
    ).toEqual({
      tone: 'info',
      title: 'L was not updated',
      description: 'Built in: it updates with search-hole.',
    })
  })
})

describe('listErrorAdvice', () => {
  it('offers "Update anyway" only for the shrink guard, and a retry for transient failures', () => {
    expect(listErrorAdvice('shrink_guard')).toMatchObject({
      word: 'Held back',
      tone: 'warn',
      action: 'force',
    })
    expect(listErrorAdvice('network').action).toBe('retry')
    expect(listErrorAdvice('timeout').action).toBe('retry')
    expect(listErrorAdvice('sha256_mismatch').action).toBeUndefined()
    expect(listErrorAdvice('blocked_address')).toMatchObject({ word: 'Blocked address', tone: 'danger' })
    expect(listErrorAdvice('some_new_code')).toMatchObject({ word: 'Update failed', action: 'retry' })
  })
})

describe('add form checks', () => {
  it('accepts an https URL and refuses the rest with a fix', () => {
    expect(checkListUrl('https://example.org/list.txt')).toBeNull()
    expect(checkListUrl('  ')?.message).toBe("Enter the list's address.")
    expect(checkListUrl('example.org/list.txt')?.fix).toBe('Start it with https://')
    expect(checkListUrl('http://example.org/list.txt')?.message).toBe('Lists are fetched over HTTPS only.')
    expect(checkListUrl('javascript:alert(1)')?.message).toBe('Lists are fetched over HTTPS only.')
    expect(checkListUrl('https://user:pw@example.org/l.txt')?.message).toMatch(/user name or password/)
  })

  it('accepts an empty or valid name', () => {
    expect(checkListName('')).toBeNull()
    expect(checkListName('my-list.v2')).toBeNull()
    expect(checkListName('My List')).not.toBeNull()
    expect(checkListName('-x')).not.toBeNull()
    expect(checkListName('a'.repeat(65))).not.toBeNull()
  })
})

describe('small words', () => {
  it('reads intervals, hosts, licences and the URL state', () => {
    expect(intervalText('7d')).toBe('every 7 days')
    expect(intervalText('1d')).toBe('every day')
    expect(intervalText('12h')).toBe('every 12 hours')
    expect(intervalText('2w')).toBe('every 2 weeks')
    expect(intervalText('soon')).toBe('soon')
    expect(hostOf('https://raw.githubusercontent.com/a/b.txt')).toBe('raw.githubusercontent.com')
    expect(hostOf('not a url')).toBeNull()
    expect(licenseText('NONE')).toBe('No licence')
    expect(licenseText('NOASSERTION')).toBe('Licence unclear')
    expect(licenseText('CC0-1.0')).toBe('CC0-1.0')
    expect(parseListsSearch({ catalog: '1' })).toEqual({ catalog: true })
    expect(parseListsSearch({ catalog: true })).toEqual({ catalog: true })
    expect(parseListsSearch({ catalog: 'yes please' })).toEqual({})
    expect(parseListsSearch({})).toEqual({})
  })
})
