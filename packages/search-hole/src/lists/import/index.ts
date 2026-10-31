// SPDX-License-Identifier: Apache-2.0
/**
 * List importers (ADR-0008 "Lists", "Import mapping"; MASTER_PLAN P6): turn the
 * text of a subscribed or bundled list into list-tier rules and a `$badfilter`
 * cancel set, ready for `compileRuleSet({ lists })`.
 *
 * Permissive by design: content never makes an importer throw. Lines it cannot
 * express become counted, reported skips (`skipReasons`, a `skipped` sample),
 * and the per-list caps (2,000,000 rules, 64 MiB, 20,000 regex) are enforced
 * with a warning. Every rule produced compiles: matches are validated with the
 * engine's own parser.
 *
 * ```ts
 * const imported = importList(text, { format: 'auto', listId: 'pinterest', kind: 'block' })
 * const rules = compileRuleSet({ rules: userRules, lists: [toListInput(imported, 'enforce')] })
 * ```
 */
import type { ListInput } from '../../core/rules/engine.ts'
import type { ListMode } from '../../shared/types.ts'
import { parseAbp } from './abp.ts'
import { ListBuilder } from './builder.ts'
import { detectFormat } from './detect.ts'
import { parseGoggles } from './goggles.ts'
import { parseDomains, parseHosts } from './hosts.ts'
import { parseSearchhole } from './searchhole.ts'
import { type EachLine, forEachLine, utf8Length } from './text.ts'
import {
  type ImportFormat,
  type ImportOptions,
  type ImportResult,
  LIST_CAPS,
  type ListCaps,
} from './types.ts'
import { parseUblacklist } from './ublacklist.ts'

export { detectFormat } from './detect.ts'
export { expiresToMs } from './text.ts'
export {
  type ImportFormat,
  type ImportOptions,
  type ImportResult,
  type ImportStats,
  LIST_CAPS,
  type ListCaps,
  type ListHeader,
  SKIPPED_SAMPLE,
  type SkippedEntry,
} from './types.ts'

const LINE_PARSERS: Record<Exclude<ImportFormat, 'searchhole'>, (b: ListBuilder, each: EachLine) => void> = {
  ublacklist: parseUblacklist,
  abp: parseAbp,
  adguard: parseAbp,
  hosts: parseHosts,
  domains: parseDomains,
  goggles: parseGoggles,
}

const MiB = 1024 * 1024

/** Imports one list. Never throws on list content. */
export function importList(text: string, opts: ImportOptions): ImportResult {
  const caps: ListCaps = {
    rules: Math.min(opts.caps?.rules ?? LIST_CAPS.rules, LIST_CAPS.rules),
    bytes: Math.min(opts.caps?.bytes ?? LIST_CAPS.bytes, LIST_CAPS.bytes),
    regex: Math.min(opts.caps?.regex ?? LIST_CAPS.regex, LIST_CAPS.regex),
  }
  const format: ImportFormat = opts.format === 'auto' ? detectFormat(text) : opts.format
  const b = new ListBuilder({
    listId: opts.listId,
    kind: opts.kind,
    format,
    caps,
    mergeByMatch: format === 'goggles',
  })
  b.stats.bytes = utf8Length(text)
  const each: EachLine = (fn) => {
    const r = forEachLine(text, caps.bytes, fn)
    b.stats.lines = r.lines
    if (r.truncated) {
      b.truncated = true
      b.warn(
        `list is ${(b.stats.bytes / MiB).toFixed(1)} MiB, over the ${(caps.bytes / MiB).toFixed(0)} MiB cap; ` +
          `only the first ${r.lines.toLocaleString('en-US')} lines were read`,
      )
    }
  }
  if (format === 'searchhole') {
    let lines = 0
    each(() => {
      lines++
    })
    if (b.truncated) {
      b.ignoreLines(Math.max(0, lines - 1))
      b.skip(lines, '', 'list over the byte cap (YAML lists are read whole)')
    } else parseSearchhole(text, lines, b)
  } else LINE_PARSERS[format](b, each)
  return b.finish()
}

/** The engine's view of an imported list. */
export function toListInput(imported: ImportResult, mode: ListMode = 'enforce'): ListInput {
  return { id: imported.listId, kind: imported.kind, mode, rules: imported.rules, cancel: imported.cancel }
}
