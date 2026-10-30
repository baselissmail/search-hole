// SPDX-License-Identifier: Apache-2.0
/**
 * The PreToolUse guard on Bash / Edit / Write (ADR-0014 point 3, Principle 3: the model can
 * never change rules). A plain in-process string check, so the allow path costs well under a
 * millisecond.
 *
 * This is defence in depth, not a boundary. A model with shell access can obfuscate a command
 * (variables, `eval`, base64, another interpreter) and this check will not see it. The real
 * boundaries are: no model-visible tool changes rules; rule-changing slash commands are
 * user-only skills; `suggest_rule` hands the *user* an approval step; Claude Code's own
 * permission prompts still apply to Bash.
 *
 * `SEARCHHOLE_SKILL=1` in a command lets it through. Only our skills set it, but it is a
 * **soft signal**: anything that can type a command can type it too. It exists so a skill the
 * user invoked can run the CLI through Bash without being denied by its own plugin.
 */
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** CLI verbs that change rules, keys, lists, trust or settings. */
export const RULE_CHANGING_VERBS: ReadonlySet<string> = new Set([
  'block',
  'allow',
  'pin',
  'raise',
  'lower',
  'normal',
  'unrule',
  'rules',
  'trust',
  'untrust',
  'keys',
  'lists',
  'enforce',
  'unenforce',
  'mode',
  'approve',
  'reject',
])

/** `suggestions <sub>` sub-verbs that change state (listing stays allowed). */
const SUGGESTION_WRITE_VERBS: ReadonlySet<string> = new Set(['approve', 'reject'])

/** Files search-hole owns wherever they are. */
const OWNED_FILE_NAMES: ReadonlySet<string> = new Set(['.searchhole.yaml'])

/** Tools whose input names a file to write, and the field holding it. */
export const FILE_WRITE_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** The deny reason the model reads (ADR-0014 point 3: point to `suggest_rule`). */
export const GUARD_DENY_REASON =
  "search-hole: changing search rules or settings needs the user's approval. Call mcp__plugin_search-hole_search-hole__suggest_rule and tell the user its howToApprove; don't run search-hole commands or edit its files yourself."

// A `searchhole` / `search-hole` / `.../searchhole.mjs` token, then flags, then the verb.
const INVOCATION =
  /(?:^|[\s/\\'"`;|&(=])(?:searchhole|search-hole)(?:\.m?js)?['"]?\s+((?:-{1,2}[A-Za-z][\w-]*(?:=\S*)?\s+)*)([A-Za-z][\w-]*)(?:\s+([A-Za-z][\w-]*))?/g
const SKILL_MARKER = /(?:^|[\s;&|(])SEARCHHOLE_SKILL=1(?=[\s;&|)]|$)/

/** True when a Bash command invokes a rule-changing search-hole verb without the skill marker. */
export function bashChangesRules(command: string): boolean {
  if (command === '' || !/search-?hole/i.test(command)) return false
  if (SKILL_MARKER.test(command)) return false
  for (const m of command.matchAll(INVOCATION)) {
    const verb = m[2]?.toLowerCase()
    if (verb === undefined) continue
    if (RULE_CHANGING_VERBS.has(verb)) return true
    if (verb === 'suggestions' && SUGGESTION_WRITE_VERBS.has(m[3]?.toLowerCase() ?? '')) return true
  }
  return false
}

export interface ProtectedRoots {
  /** Absolute directories whose contents the model must not edit (config and data roots). */
  dirs: readonly string[]
  /** Case-insensitive comparison (macOS and Windows default file systems). */
  caseInsensitive: boolean
}

const fold = (p: string, ci: boolean): string => (ci ? p.toLowerCase() : p)

/** True when an Edit/Write target is a search-hole file: `.searchhole.yaml` or under a root. */
export function fileIsProtected(filePath: string, baseDir: string, roots: ProtectedRoots): boolean {
  if (filePath.trim() === '') return false
  const abs = normalize(isAbsolute(filePath) ? filePath : resolve(baseDir, filePath))
  const name = fold(basename(abs), roots.caseInsensitive)
  if (OWNED_FILE_NAMES.has(name)) return true
  const target = fold(abs, roots.caseInsensitive)
  return roots.dirs.some((dir) => {
    const d = fold(normalize(dir), roots.caseInsensitive).replace(/[\\/]+$/, '')
    return d !== '' && (target === d || target.startsWith(`${d}${sep}`))
  })
}

/** The `~/.searchhole` directory, always protected in addition to the resolved roots. */
export function dotDir(home: string): string {
  return join(home, '.searchhole')
}
