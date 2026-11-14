// SPDX-License-Identifier: Apache-2.0
/**
 * Lists published in search-hole's own YAML rule format (`version: 1`,
 * `rules: [...]`), read with the user-file loader and turned into list rules.
 * Each rule keeps its action (an `official` list only annotates); `pin` is
 * skipped because lists never pin; `important: true` becomes list-important.
 * `profile` and `until` do not apply to list rules and are dropped with a
 * warning. A file that does not load is one counted skip, never an exception.
 */
import { SearchHoleError } from '../../shared/errors.ts'
import { loadRulesYaml } from '../yaml.ts'
import type { ListBuilder } from './builder.ts'

export function parseSearchhole(text: string, lines: number, b: ListBuilder): void {
  let loaded: ReturnType<typeof loadRulesYaml>
  try {
    loaded = loadRulesYaml(text, { scope: 'global', file: b.listId })
  } catch (e) {
    const issue =
      e instanceof SearchHoleError
        ? (e.details?.issues as Array<{ line?: number }> | undefined)?.[0]
        : undefined
    const message = e instanceof Error ? e.message : String(e)
    b.ignoreLines(Math.max(0, lines - 1))
    b.skip(issue?.line ?? 1, '', 'invalid search-hole rules file', message)
    return
  }
  let dropped = 0
  let i = 0
  for (const r of loaded.rules) {
    i++
    if (r.profiles?.length || r.until !== undefined) {
      // A list rule applies to every profile and never expires, so importing this one would widen it.
      dropped++
      b.skip(i, r.match, 'limited to a profile or an end date (list rules have neither)')
      continue
    }
    if (r.action === 'pin') {
      b.skip(i, r.match, 'pin in a list (lists never pin)')
      continue
    }
    b.add(i, r.match, r.match, { type: 'explicit', action: r.action, weight: r.weight }, r.important)
  }
  b.ignoreLines(Math.max(0, lines - b.stats.entries))
  if (dropped > 0)
    b.warn(`${dropped} rule(s) set profile or until, which list rules do not use; they were skipped`)
  if (loaded.profiles.length > 0 || loaded.subscriptions.length > 0) {
    b.warn('profiles and subscriptions in a list file are ignored')
  }
}
