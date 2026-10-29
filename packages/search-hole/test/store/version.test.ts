// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareSemver, encodeUserVersion, maxSemver, parseSemver } from '../../src/store/version.ts'

describe('semver helpers', () => {
  it('parses plain, v-prefixed and suffixed versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseSemver('v0.4.0')).toEqual({ major: 0, minor: 4, patch: 0 })
    expect(parseSemver('0.4.0-beta.1+build5')).toEqual({ major: 0, minor: 4, patch: 0 })
    expect(parseSemver('not-a-version')).toBeUndefined()
    expect(parseSemver('1.2')).toBeUndefined()
  })

  it('orders versions numerically, not lexically', () => {
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareSemver('0.4.0', '0.4.0')).toBe(0)
    expect(compareSemver('0.4.0-beta.1', '0.4.0')).toBe(0)
    expect(maxSemver('0.4.0', '0.10.0')).toBe('0.10.0')
  })

  it('documents the encoding', () => {
    expect(encodeUserVersion('0.0.0')).toBe(0)
    expect(encodeUserVersion('0.3.0')).toBe(3000)
    expect(encodeUserVersion('1.2.3')).toBe(1_002_003)
    expect(encodeUserVersion('2146.999.999')).toBeLessThan(2 ** 31)
  })

  it('rejects malformed or out-of-range versions', () => {
    expect(() => encodeUserVersion('nope')).toThrow(RangeError)
    expect(() => encodeUserVersion('0.1000.0')).toThrow(RangeError)
    expect(() => encodeUserVersion('2147.0.0')).toThrow(RangeError)
  })

  it('property: encoding is monotonic with version order', () => {
    const version = fc.record({
      major: fc.integer({ min: 0, max: 2146 }),
      minor: fc.integer({ min: 0, max: 999 }),
      patch: fc.integer({ min: 0, max: 999 }),
    })
    const text = (v: { major: number; minor: number; patch: number }): string =>
      `${v.major}.${v.minor}.${v.patch}`
    fc.assert(
      fc.property(version, version, (a, b) => {
        expect(Math.sign(encodeUserVersion(text(a)) - encodeUserVersion(text(b)))).toBe(
          Math.sign(compareSemver(text(a), text(b))),
        )
      }),
    )
  })
})
