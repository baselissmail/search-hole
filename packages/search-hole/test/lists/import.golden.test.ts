// SPDX-License-Identifier: Apache-2.0
/**
 * Golden import tests (ADR-0008 "Import mapping", MASTER_PLAN P6). Each list in
 * fixtures/manifest.json is imported and compared with its checked-in snapshot
 * (`<id>.expected.json`; `UPDATE_GOLDEN=1` rewrites them for review). The
 * scenarios are hand-written expected decisions over the compiled lists.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileRuleSet, type ListInput } from '../../src/core/rules/engine.ts'
import { ruleText } from '../../src/core/rules/ids.ts'
import { classifyMatch } from '../../src/core/rules/match.ts'
import { detectFormat, type ImportResult, importList, toListInput } from '../../src/lists/import/index.ts'
import type { ListFormat } from '../../src/lists/yaml.ts'
import type { ListKind, Profile, Rule, RuleAction } from '../../src/shared/types.ts'

const dir = new URL('./fixtures/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, dir), 'utf8')

interface ListSpec {
  id: string
  file: string
  format: ListFormat
  kind: ListKind
  detect?: string
}
interface Case {
  url: string
  visibility: 'kept' | 'hidden'
  weight?: number
  prefer?: number
  note?: string
}
interface Scenario {
  name: string
  lists: string[]
  user?: Array<{ match: string; action: RuleAction; weight?: number }>
  profiles?: Profile[]
  profile?: string
  cases: Case[]
}
const manifest = JSON.parse(read('manifest.json')) as { lists: ListSpec[]; scenarios: Scenario[] }

/** The reviewable view of an import: one line per rule, cancel entry and skip. */
function golden(r: ImportResult) {
  return {
    format: r.format,
    header: r.header,
    stats: r.stats,
    allowlistMode: r.allowlistMode ?? false,
    warnings: r.warnings,
    rules: r.rules.map((x) => `${x.id}: ${ruleText(x)}${x.text === undefined ? '' : `   <- ${x.text}`}`),
    cancel: r.cancel.map((c) => `${c.action}${c.listImportant ? ' $important' : ''} ${c.match}`),
    skipReasons: r.skipReasons,
    skipped: r.skipped.map((s) => `${s.line}: ${s.reason}${s.detail === undefined ? '' : ` (${s.detail})`}`),
  }
}

const imported = new Map<string, ImportResult>()
for (const spec of manifest.lists) {
  imported.set(
    spec.id,
    importList(read(spec.file), { format: spec.format, listId: spec.id, kind: spec.kind }),
  )
}

describe('golden imports (test/lists/fixtures)', () => {
  for (const spec of manifest.lists) {
    it(`${spec.id} (${spec.file}, kind ${spec.kind})`, () => {
      const r = imported.get(spec.id) as ImportResult
      const view = golden(r)
      const file = new URL(`${spec.id}.expected.json`, dir)
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, `${JSON.stringify(view, null, 2)}\n`)
      expect(view).toEqual(JSON.parse(readFileSync(file, 'utf8')))
      if (spec.detect !== undefined) expect(detectFormat(read(spec.file))).toBe(spec.detect)
      const compiled = compileRuleSet({ lists: [toListInput(r)] })
      expect(compiled.issues).toEqual([])
      expect(compiled.size.list).toBe(r.rules.length)
    })
  }
})

describe('golden decisions (hand-written in manifest.json)', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z')
  for (const sc of manifest.scenarios) {
    describe(sc.name, () => {
      const lists: ListInput[] = sc.lists.map((id) => toListInput(imported.get(id) as ImportResult))
      const user: Rule[] = (sc.user ?? []).map((u, i) => ({
        id: `u${i}`,
        scope: 'global',
        match: u.match,
        matchKind: classifyMatch(u.match),
        action: u.action,
        weight: u.weight ?? 1,
        important: false,
        order: i,
      }))
      const rules = compileRuleSet({ rules: user, lists, profiles: sc.profiles ?? [] })
      it('compiles cleanly', () => expect(rules.issues).toEqual([]))
      for (const c of sc.cases) {
        it(`${c.url} → ${c.visibility}${c.weight === undefined ? '' : ` ×${c.weight}`}${c.note ? ` (${c.note})` : ''}`, () => {
          const d = rules.decide(c.url, { profile: sc.profile ?? 'default', now: NOW })
          expect(d.visibility).toBe(c.visibility)
          if (c.weight !== undefined) expect(d.weight.factor).toBeCloseTo(c.weight, 3)
          if (c.prefer !== undefined) expect(d.preferFactor).toBeCloseTo(c.prefer, 3)
        })
      }
    })
  }
})
