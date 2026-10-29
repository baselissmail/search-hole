// SPDX-License-Identifier: Apache-2.0
/**
 * Profile selection and resolution (ADR-0008 "Profiles").
 */
import type { RE2JS } from 're2js'
import { SearchHoleError } from '../../shared/errors.ts'
import type { Profile } from '../../shared/types.ts'
import { compileRegex } from './regex.ts'

/** Profile fields a `defaults:` block may set. */
export type ProfileDefaults = Omit<Profile, 'name' | 'match'>

/** Profiles from both rule files, each in file order. */
export interface ProfileSources {
  project?: readonly Profile[]
  global?: readonly Profile[]
}

/** Which profile a search runs under, and why. */
export interface ProfileMatch {
  name: string
  via: 'explicit' | 'keyword' | 'regex' | 'default'
  /** Absent when `via` is `default` or the explicit name is the default name. */
  profile?: Profile
  /** The keyword or regex that matched. */
  matched?: string
}

/** Name used when no profile matches. */
export const DEFAULT_PROFILE = 'default'

const WORD = /[\p{L}\p{N}_]/u
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch)

/** Case-insensitive whole-word test: `api` matches "REST API docs", not "rapid". Multi-word keywords work. */
export function hasKeyword(query: string, keyword: string): boolean {
  const q = query.toLowerCase()
  const k = keyword.toLowerCase().trim()
  if (k === '') return false
  let from = 0
  while (from <= q.length - k.length) {
    const i = q.indexOf(k, from)
    if (i === -1) return false
    const before = i === 0 ? undefined : q[i - 1]
    const after = q[i + k.length]
    // Only require a boundary where the keyword itself starts or ends with a word character.
    const okBefore = !isWordChar(k[0]) || !isWordChar(before)
    const okAfter = !isWordChar(k[k.length - 1]) || !isWordChar(after)
    if (okBefore && okAfter) return true
    from = i + 1
  }
  return false
}

const regexCache = new Map<string, RE2JS | null>()
function cachedRegex(source: string): RE2JS | null {
  let re = regexCache.get(source)
  if (re === undefined) {
    const r = compileRegex(source)
    re = r.ok ? r.re : null
    if (regexCache.size > 512) regexCache.clear()
    regexCache.set(source, re)
  }
  return re
}

/** Orders profiles for matching: project first, then global profiles not replaced by a project one. */
export function orderProfiles(sources: ProfileSources | readonly Profile[]): Profile[] {
  if (Array.isArray(sources)) return [...(sources as readonly Profile[])]
  const s = sources as ProfileSources
  const project = s.project ?? []
  const names = new Set(project.map((p) => p.name))
  return [...project, ...(s.global ?? []).filter((p) => !names.has(p.name))]
}

/**
 * Picks the profile for a query. An explicit argument wins (unknown names are an
 * `invalid_argument` error, except the default name). Otherwise project profiles
 * come first, then global, each in file order; the first whose keyword
 * (case-insensitive, whole word) or re2js regex matches wins. An array is taken
 * as already ordered.
 */
export function matchProfile(
  query: string,
  profiles: ProfileSources | readonly Profile[],
  explicit?: string,
  defaultName: string = DEFAULT_PROFILE,
): ProfileMatch {
  const ordered = orderProfiles(profiles)
  if (explicit !== undefined) {
    const p = ordered.find((x) => x.name === explicit)
    if (p) return { name: p.name, via: 'explicit', profile: p }
    if (explicit === defaultName) return { name: defaultName, via: 'explicit' }
    const known = ordered.map((x) => x.name)
    throw new SearchHoleError('invalid_argument', `Unknown profile "${explicit}".`, {
      fix:
        known.length > 0 ? `Use one of: ${known.join(', ')}.` : 'No profiles are defined; omit the argument.',
      details: { profile: explicit, known },
    })
  }
  for (const p of ordered) {
    for (const k of p.match?.keywords ?? []) {
      if (hasKeyword(query, k)) return { name: p.name, via: 'keyword', profile: p, matched: k }
    }
    for (const r of p.match?.regex ?? []) {
      if (cachedRegex(r)?.test(query)) return { name: p.name, via: 'regex', profile: p, matched: r }
    }
  }
  return { name: defaultName, via: 'default' }
}

const FIELDS = ['engines', 'depth', 'freshness', 'prefer', 'defaultAction'] as const

/**
 * Effective profiles: a project profile replaces the global one of the same
 * name, and every field a profile omits falls through to project `defaults`,
 * then global `defaults` (shallow, per top-level field). Order as in
 * {@link orderProfiles}. Also returns the effective defaults.
 */
export function resolveProfiles(input: {
  project?: readonly Profile[]
  global?: readonly Profile[]
  projectDefaults?: ProfileDefaults
  globalDefaults?: ProfileDefaults
}): { profiles: Profile[]; defaults: ProfileDefaults } {
  const defaults: ProfileDefaults = {}
  for (const src of [input.globalDefaults, input.projectDefaults]) {
    if (!src) continue
    for (const f of FIELDS) if (src[f] !== undefined) Object.assign(defaults, { [f]: src[f] })
  }
  const profiles = orderProfiles({ project: input.project ?? [], global: input.global ?? [] }).map((p) => {
    const out: Profile = { ...p }
    for (const f of FIELDS) {
      if (out[f] === undefined && defaults[f] !== undefined) Object.assign(out, { [f]: defaults[f] })
    }
    return out
  })
  return { profiles, defaults }
}
