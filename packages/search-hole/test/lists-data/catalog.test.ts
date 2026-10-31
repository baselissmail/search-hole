// SPDX-License-Identifier: Apache-2.0
// The third-party list catalog and the vendored starter lists (ADR-0016 point 5, ADR-0017 point 7).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  CATALOG_VERIFIED_AT,
  PERMISSIVE_LICENSES,
  starterSet,
  stripVendorHeader,
  VENDORED_LISTS,
  vendorHeader,
} from '../../src/lists/catalog.ts'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const FORMATS = ['auto', 'ublacklist', 'abp', 'adguard', 'hosts', 'domains', 'goggles', 'searchhole']
const KINDS = ['block', 'allow', 'official', 'content-farm', 'clone']
const MODES = ['enforce', 'audit', 'disabled', 'off']
const COPYLEFT = /^(A?GPL|LGPL|EUPL|MPL|CC-BY-SA)/
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

describe('catalog', () => {
  it('has unique kebab-case ids', () => {
    const ids = CATALOG.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  it('every entry has https URLs, a known format, kind and mode, and notes', () => {
    for (const l of CATALOG) {
      expect(new URL(l.url).protocol, l.id).toBe('https:')
      expect(new URL(l.homepage).protocol, l.id).toBe('https:')
      if (l.licenseUrl !== null) expect(new URL(l.licenseUrl).protocol, l.id).toBe('https:')
      expect(FORMATS, l.id).toContain(l.format)
      expect(KINDS, l.id).toContain(l.kind)
      expect(MODES, l.id).toContain(l.recommendedMode)
      expect(l.license, l.id).toMatch(/^[A-Za-z0-9.+-]+$/)
      expect(l.notes.length, l.id).toBeGreaterThan(0)
      if (l.approxRules !== undefined) expect(Number.isInteger(l.approxRules) && l.approxRules > 0).toBe(true)
    }
  })

  it('bundleable implies a permissive licence; copyleft and unlicensed lists are never bundleable', () => {
    for (const l of CATALOG) {
      if (l.bundleable) expect(PERMISSIVE_LICENSES.has(l.license), l.id).toBe(true)
      if (COPYLEFT.test(l.license) || l.license === 'NONE' || l.license === 'NOASSERTION') {
        expect(l.bundleable, l.id).toBe(false)
        expect(l.recommendedMode, l.id).toBe('off')
      }
      // A licence URL exists exactly when there is a LICENSE file to point at.
      expect(l.licenseUrl === null, l.id).toBe(l.license === 'NONE' || l.license === 'NOASSERTION')
    }
  })

  it('the starter set is exactly ADR-0017 point 7', () => {
    expect(starterSet().map((l) => [l.id, l.recommendedMode])).toEqual([
      ['quenhus-dev-filter', 'enforce'],
      ['arosh-stackoverflow-translation', 'enforce'],
      ['arosh-github-translation', 'enforce'],
      ['rjaus-pinterest', 'enforce'],
      ['laylavish-huge-ai', 'audit'],
    ])
    for (const l of starterSet()) expect(['CC0-1.0', 'Unlicense'], l.id).toContain(l.license)
    expect(CATALOG.find((l) => l.id === 'super-seo-spam-suppressor')?.recommendedMode).toBe('off')
  })

  it('Brave Goggles are link-only and Kagi is absent', () => {
    for (const l of CATALOG.filter((x) => x.format === 'goggles')) {
      expect(l.bundleable, l.id).toBe(false)
      expect(l.recommendedMode, l.id).toBe('off')
    }
    expect(CATALOG.some((l) => /kagi/i.test(`${l.id} ${l.url} ${l.homepage}`))).toBe(false)
  })

  it('records when it was verified', () => {
    expect(CATALOG_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('vendored starter lists', () => {
  it('vendors exactly the bundleable starter lists', () => {
    const starters = starterSet().filter((l) => l.bundleable)
    expect(VENDORED_LISTS.map((v) => v.id)).toEqual(starters.map((l) => l.id))
  })

  for (const v of VENDORED_LISTS) {
    it(`${v.id}: file exists, header matches the manifest, body hashes to its sha256`, () => {
      const entry = CATALOG.find((l) => l.id === v.id)
      expect(entry?.bundleable).toBe(true)
      expect(v.license).toBe(entry?.license)
      expect(v.sourceUrl).toBe(entry?.url)
      expect(v.path).toBe(`lists/vendor/${v.id}.txt`)
      const file = join(ROOT, v.path)
      expect(existsSync(file)).toBe(true)
      const raw = readFileSync(file)
      const text = raw.toString('utf8')
      expect(text.startsWith(vendorHeader(v))).toBe(true)
      const split = stripVendorHeader(text)
      expect(split).not.toBeNull()
      expect(split?.fields).toMatchObject({
        Source: v.sourceUrl,
        Pinned: v.pinnedUrl,
        License: v.license,
        Fetched: v.fetchedAt,
        'SHA-256': v.sha256,
      })
      const body = raw.subarray(Buffer.byteLength(vendorHeader(v), 'utf8'))
      expect(body.length).toBe(v.bytes)
      expect(sha256(body)).toBe(v.sha256)
      expect(split?.body).toBe(body.toString('utf8'))
    })
  }

  it('THIRD_PARTY_NOTICES.md records every vendored list with its licence', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    for (const v of VENDORED_LISTS) {
      expect(notices, v.id).toContain(v.path)
      expect(notices, v.id).toContain(v.sha256)
    }
  })

  it('stripVendorHeader rejects text without a header', () => {
    expect(stripVendorHeader('*://*.example.com/*\n')).toBeNull()
  })
})
