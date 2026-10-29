// SPDX-License-Identifier: Apache-2.0
/**
 * App versions are semver strings in `meta` (`min_writer_version`, ...). `PRAGMA user_version`
 * is a 32-bit integer, so the mirror of `min_writer_version` uses this encoding:
 *
 *     user_version = major * 1_000_000 + minor * 1_000 + patch      (minor, patch <= 999; major <= 2146)
 *
 * The encoding is monotonic: comparing encodings equals comparing versions. Prerelease and
 * build suffixes (`0.4.0-beta.1`) are ignored, so a prerelease equals its release.
 */

export interface Semver {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const SEMVER_RE = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+].*)?$/

/** Parses `X.Y.Z` (optional leading `v`, optional suffix). Returns undefined when malformed. */
export function parseSemver(version: string): Semver | undefined {
  const m = SEMVER_RE.exec(version.trim())
  if (!m) return undefined
  const [, a, b, c] = m
  if (a === undefined || b === undefined || c === undefined) return undefined
  return { major: Number(a), minor: Number(b), patch: Number(c) }
}

const ZERO: Semver = { major: 0, minor: 0, patch: 0 }

/** Negative, zero or positive like `Array.sort`. Malformed versions compare as 0.0.0. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a) ?? ZERO
  const y = parseSemver(b) ?? ZERO
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch
}

/** The larger of two version strings (the first on ties). */
export function maxSemver(a: string, b: string): string {
  return compareSemver(a, b) >= 0 ? a : b
}

/** Encodes a version for `PRAGMA user_version`. Throws RangeError for malformed or out-of-range input. */
export function encodeUserVersion(version: string): number {
  const v = parseSemver(version)
  if (!v) throw new RangeError(`not a semver version: ${version}`)
  if (v.major > 2146 || v.minor > 999 || v.patch > 999)
    throw new RangeError(`version out of range: ${version}`)
  return v.major * 1_000_000 + v.minor * 1_000 + v.patch
}
