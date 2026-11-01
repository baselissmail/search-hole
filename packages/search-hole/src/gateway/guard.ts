// SPDX-License-Identifier: Apache-2.0
/**
 * The PreToolUse guard on Bash / Edit / Write (ADR-0014 point 3, Principle 3: the model can
 * never change rules). An in-process check (a shell-word scan for Bash), so the allow path
 * costs well under a millisecond.
 *
 * Bash: denied when search-hole's CLI is the command being run (directly or through `env`,
 * `sudo`, `xargs`, `npx`, `node`, `pnpm -C <dir> dev`, `sh -c`, `eval`, `$(...)`) with a verb
 * that changes state, or when the command writes a search-hole file (a redirect, `tee`, `cp`,
 * `sed -i`, ...). Words inside quoted arguments of other commands don't count, so commit
 * messages and grep patterns that mention a verb are fine (review 2026-10-31).
 *
 * This is defence in depth, not a boundary. A model with shell access can obfuscate a command
 * (variables, base64, another interpreter) and this check will not see it. The real
 * boundaries are: no model-visible tool changes rules; rule-changing slash commands are
 * user-only skills; `suggest_rule` hands the *user* an approval step; Claude Code's own
 * permission prompts still apply to Bash.
 *
 * `SEARCHHOLE_SKILL=1` as an assignment on the same simple command lets a CLI call through.
 * Only our skills set it, but it is a **soft signal**: anything that can type a command can
 * type it too. It exists so a skill the user invoked can run the CLI through Bash without
 * being denied by its own plugin.
 */
import { basename, join, resolve, sep } from 'node:path'
import { type SimpleCommand, scanShell } from './shellwords.ts'

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
  'uninstall',
  'setup',
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

/** The CLI as a command or script name: `searchhole`, `search-hole@0.1.1`, `.../searchhole.mjs`. */
const CLI_NAME = /^(?:searchhole|search-hole)(?:\.[cm]?[jt]s)?(?:@[^\s/]*)?$/i
/** The CLI entry point run from source (`node packages/search-hole/src/cli/main.ts`). */
const CLI_SOURCE = /(?:^|[\\/])cli[\\/]main\.[cm]?[jt]s$/i
const MENTIONS_US = /search-?hole/i
const SKILL_ASSIGNMENT = 'SEARCHHOLE_SKILL=1'
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Words that only prefix the real command. */
const PREFIXES: ReadonlySet<string> = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
])
/** Wrappers that run their arguments as a command, with the flags that take a value. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['env', new Set(['-u', '--unset', '-C', '--chdir'])],
  ['command', new Set<string>()],
  ['builtin', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['nohup', new Set<string>()],
  ['time', new Set<string>()],
  ['nice', new Set(['-n', '--adjustment'])],
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'])],
  ['doas', new Set(['-u', '-C'])],
  ['caffeinate', new Set(['-t', '-w'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  [
    'xargs',
    new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--replace']),
  ],
])
const NODE_LIKE: ReadonlySet<string> = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node'])
const NODE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
])
const RUNNERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx'])
const RUNNER_VALUE_FLAGS: ReadonlySet<string> = new Set(['-p', '--package', '-c', '--call'])
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const PM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--dir',
  '--prefix',
  '--cwd',
  '--filter',
  '-F',
  '-w',
  '--workspace',
])
/** package.json scripts that run the CLI from source (this repo's `dev`). */
const DEV_SCRIPTS: ReadonlySet<string> = new Set(['dev', 'cli', 'start'])
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])

/** Commands that write the files named in their arguments: which arguments are targets. */
const WRITERS: ReadonlyMap<string, 'all' | 'last' | 'in-place'> = new Map([
  ['tee', 'all'],
  ['rm', 'all'],
  ['rmdir', 'all'],
  ['unlink', 'all'],
  ['truncate', 'all'],
  ['touch', 'all'],
  ['shred', 'all'],
  ['chmod', 'all'],
  ['cp', 'last'],
  ['mv', 'last'],
  ['install', 'last'],
  ['ln', 'last'],
  ['rsync', 'last'],
  ['sed', 'in-place'],
  ['perl', 'in-place'],
  ['yq', 'in-place'],
])

const base = (word: string): string => (word.split(/[\\/]/).pop() ?? word).toLowerCase()

/** `--flag=value` → [`--flag`, `value`]; `-C` → [`-C`, undefined]. */
function splitFlag(word: string): [string, string | undefined] {
  const eq = word.indexOf('=')
  return word.startsWith('--') && eq > 0 ? [word.slice(0, eq), word.slice(eq + 1)] : [word, undefined]
}

/** Index of the first word after the flags starting at `i`; flags in `withValue` consume the next word. */
function skipFlags(
  words: readonly string[],
  i: number,
  withValue: ReadonlySet<string>,
  seen?: string[],
): number {
  let j = i
  while (j < words.length && (words[j] ?? '').startsWith('-') && words[j] !== '--') {
    const [name, attached] = splitFlag(words[j] ?? '')
    if (attached !== undefined) seen?.push(attached)
    else if (withValue.has(name)) {
      j++
      seen?.push(words[j] ?? '')
    }
    j++
  }
  return words[j] === '--' ? j + 1 : j
}

/** Where a search-hole CLI invocation's own arguments start in this simple command. */
interface Invocation {
  args: readonly string[]
  skill: boolean
}

/**
 * Finds the command this simple command really runs (past assignments, `env`, `sudo`,
 * `xargs`, `npx`, `node script`, `pnpm -C dir dev`, ...) and, when it is search-hole's CLI,
 * returns its arguments. `nested` receives command strings run by `sh -c`, `eval` or a heredoc
 * fed to a shell.
 */
function invocation(cmd: SimpleCommand, cwdHint: boolean, nested: string[]): Invocation | null {
  const w = cmd.words
  let skill = false
  let i = 0
  for (;;) {
    while (i < w.length && (PREFIXES.has(w[i] ?? '') || ASSIGNMENT.test(w[i] ?? ''))) {
      if (w[i] === SKILL_ASSIGNMENT) skill = true
      i++
    }
    const word = w[i]
    if (word === undefined) return null
    const name = base(word)
    const valueFlags = WRAPPERS.get(name)
    if (valueFlags !== undefined) {
      i = skipFlags(w, i + 1, valueFlags)
      if (name === 'timeout') i++ // the duration
      continue
    }
    if (CLI_NAME.test(name)) return { args: w.slice(i + 1), skill }
    if (name === 'eval') {
      nested.push(w.slice(i + 1).join(' '))
      return null
    }
    if (SHELLS.has(name)) {
      const c = w.slice(i + 1).findIndex((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x))
      if (c >= 0) nested.push(w[i + 2 + c] ?? '')
      else nested.push(...cmd.heredocs)
      return null
    }
    if (NODE_LIKE.has(name)) {
      let j = i + 1
      if (name === 'deno' && w[j] === 'run') j++
      j = skipFlags(w, j, NODE_VALUE_FLAGS)
      const script = w[j] ?? ''
      const fromSource = CLI_SOURCE.test(script) && (MENTIONS_US.test(script) || cwdHint)
      return CLI_NAME.test(base(script)) || fromSource ? { args: w.slice(j + 1), skill } : null
    }
    if (RUNNERS.has(name)) {
      const packages: string[] = []
      const j = skipFlags(w, i + 1, RUNNER_VALUE_FLAGS, packages)
      if (packages.some((p) => CLI_NAME.test(base(p)))) {
        i = j // `npx -p search-hole searchhole block x`: the binary follows
        continue
      }
      return CLI_NAME.test(base(w[j] ?? '')) ? { args: w.slice(j + 1), skill } : null
    }
    if (PACKAGE_MANAGERS.has(name)) {
      const dirs: string[] = []
      let j = skipFlags(w, i + 1, PM_VALUE_FLAGS, dirs)
      const sub = (w[j] ?? '').toLowerCase()
      if (sub === 'dlx' || sub === 'x' || sub === 'exec') {
        j = skipFlags(w, j + 1, RUNNER_VALUE_FLAGS)
        return CLI_NAME.test(base(w[j] ?? '')) ? { args: w.slice(j + 1), skill } : null
      }
      if (sub === 'run' || sub === 'run-script') j = skipFlags(w, j + 1, PM_VALUE_FLAGS, dirs)
      const script = (w[j] ?? '').toLowerCase()
      const ours = cwdHint || dirs.some((d) => MENTIONS_US.test(d))
      if (CLI_NAME.test(script) || (DEV_SCRIPTS.has(script) && ours)) {
        const rest = w.slice(j + 1)
        return { args: rest[0] === '--' ? rest.slice(1) : rest, skill }
      }
      return null
    }
    return null
  }
}

/** True when CLI arguments start with a verb that changes rules, keys, lists, trust or settings. */
function changesRules(args: readonly string[]): boolean {
  const positional = args.filter((a) => !a.startsWith('-'))
  const verb = positional[0]?.toLowerCase()
  if (verb === undefined) return false
  if (RULE_CHANGING_VERBS.has(verb)) return true
  return verb === 'suggestions' && SUGGESTION_WRITE_VERBS.has(positional[1]?.toLowerCase() ?? '')
}

/** Files a simple command writes: redirect targets plus the target arguments of known writers. */
function writtenFiles(cmd: SimpleCommand): string[] {
  const out = [...cmd.writes]
  let i = 0
  while (i < cmd.words.length && ASSIGNMENT.test(cmd.words[i] ?? '')) i++
  const name = base(cmd.words[i] ?? '')
  const args = cmd.words.slice(i + 1)
  const positional = args.filter((a) => !a.startsWith('-'))
  if (name === 'dd') out.push(...args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)))
  switch (WRITERS.get(name)) {
    case 'all':
      out.push(...positional)
      break
    case 'last':
      if (positional.length >= 2) out.push(positional[positional.length - 1] ?? '')
      break
    case 'in-place':
      if (args.some((a) => /^(?:-[A-Za-z]*i|--in-place)/.test(a))) out.push(...positional)
      break
  }
  return out
}

/** Where the guard resolves paths a command writes (Principle 3: no editing our files via Bash). */
export interface BashFileContext {
  roots: ProtectedRoots
  /** Resolves relative paths. */
  baseDir: string
  /** Expands `~` and `$HOME`. */
  home: string
}

const expandHome = (path: string, home: string): string =>
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell's ${HOME}, not a template
  path === '~' || path === '$HOME' || path === '${HOME}'
    ? home
    : path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[\\/])/, home)

/**
 * True when a Bash command runs a rule-changing search-hole verb (without the skill marker on
 * that same command), or, given `files`, writes a search-hole file. Mentions inside quoted
 * arguments of other commands (`git commit -m "..."`, `grep "searchhole block"`) don't count;
 * `sh -c`, `eval`, `$(...)`, backticks and heredocs fed to a shell are scanned too.
 */
export function bashChangesRules(command: string, files?: BashFileContext): boolean {
  if (command.trim() === '') return false
  const needles =
    files?.roots.dirs.map((d) => base(d.replace(/[\\/]+$/, ''))).filter((n) => n.length > 2) ?? []
  const lower = command.toLowerCase()
  if (!MENTIONS_US.test(command) && !needles.some((n) => lower.includes(n))) return false
  const queue = [command]
  for (let depth = 0; depth < 8 && queue.length > 0; depth++) {
    const batch = queue.splice(0)
    for (const text of batch) {
      const scan = scanShell(text)
      queue.push(...scan.substitutions)
      let cwdHint = false
      for (const cmd of scan.commands) {
        const first = base(cmd.words[0] ?? '')
        if ((first === 'cd' || first === 'pushd') && MENTIONS_US.test(cmd.words[1] ?? '')) cwdHint = true
        const call = invocation(cmd, cwdHint, queue)
        if (call !== null && !call.skill && changesRules(call.args)) return true
        if (files === undefined) continue
        for (const target of writtenFiles(cmd)) {
          if (target !== '' && fileIsProtected(expandHome(target, files.home), files.baseDir, files.roots))
            return true
        }
      }
    }
  }
  return false
}

export interface ProtectedRoots {
  /** Absolute directories whose contents the model must not edit (config and data roots). */
  dirs: readonly string[]
  /** Case-insensitive comparison (macOS and Windows default file systems). */
  caseInsensitive: boolean
  /** The home directory, for `~` in Bash commands. */
  home?: string
}

const fold = (p: string, ci: boolean): string => (ci ? p.toLowerCase() : p)

/** True when an Edit/Write target is a search-hole file: `.searchhole.yaml` or under a root. */
export function fileIsProtected(filePath: string, baseDir: string, roots: ProtectedRoots): boolean {
  if (filePath.trim() === '') return false
  // resolve, not normalize: on Windows it also gives a rooted path (`/Users/u/…`) its drive, like the roots.
  const abs = resolve(baseDir, filePath)
  const name = fold(basename(abs), roots.caseInsensitive)
  if (OWNED_FILE_NAMES.has(name)) return true
  const target = fold(abs, roots.caseInsensitive)
  return roots.dirs.some((dir) => {
    const d = fold(resolve(dir), roots.caseInsensitive).replace(/[\\/]+$/, '')
    return d !== '' && (target === d || target.startsWith(`${d}${sep}`))
  })
}

/** The `~/.searchhole` directory, always protected in addition to the resolved roots. */
export function dotDir(home: string): string {
  return join(home, '.searchhole')
}
