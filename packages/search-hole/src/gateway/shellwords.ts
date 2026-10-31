// SPDX-License-Identifier: Apache-2.0
/**
 * A small POSIX-shell word scanner for the Bash guard (guard.ts). It splits a command line
 * into simple commands (at `;` `&&` `||` `|` `&` newlines and parentheses), removes quoting,
 * and collects what would also run or be written: `$(...)` and backtick substitutions,
 * heredoc bodies, and redirect targets. It never expands variables or globs.
 *
 * It only has to be good enough to tell "runs search-hole" from "mentions search-hole in a
 * quoted argument" (a commit message, a grep pattern). Obfuscated commands are out of scope:
 * the guard is defence in depth (see guard.ts).
 */

export interface SimpleCommand {
  /** Words with quoting removed, assignments and the command name included. */
  readonly words: string[]
  /** Targets of `>`, `>>`, `>|`, `&>` and `&>>` (file-descriptor duplications excluded). */
  readonly writes: string[]
  /** Bodies of heredocs fed to this command. */
  readonly heredocs: string[]
}

export interface ShellScan {
  readonly commands: SimpleCommand[]
  /** Bodies of `$(...)` and backtick command substitutions (they run as commands). */
  readonly substitutions: string[]
}

const newCommand = (): SimpleCommand => ({ words: [], writes: [], heredocs: [] })

/** Index just past the `)` closing a `$(` or `(` whose body starts at `start`. */
function closeParen(src: string, start: number): number {
  let depth = 1
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') i += 2
    else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      i = end < 0 ? src.length : end + 1
    } else if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
      i++
    } else {
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i + 1
      i++
    }
  }
  return src.length
}

/** Splits a command line into simple commands; see the module comment. */
export function scanShell(src: string): ShellScan {
  const commands: SimpleCommand[] = []
  const substitutions: string[] = []
  const heredocs: Array<{ delim: string; strip: boolean; cmd: SimpleCommand }> = []
  let cmd = newCommand()
  let word = ''
  let inWord = false
  /** What the next word is: an ordinary word, a redirect target, an input file, a heredoc delimiter. */
  let next: 'word' | 'write' | 'read' | 'heredoc' | 'heredoc-strip' = 'word'

  const endWord = (): void => {
    if (!inWord) return
    if (next === 'write') {
      // `>&2`, `2>&1`, `>&-`: a file descriptor, not a file.
      if (!/^&?(?:\d+|-)?$/.test(word)) cmd.writes.push(word)
    } else if (next === 'heredoc' || next === 'heredoc-strip') {
      heredocs.push({ delim: word, strip: next === 'heredoc-strip', cmd })
    } else if (next === 'word') {
      cmd.words.push(word)
    }
    next = 'word'
    word = ''
    inWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (cmd.words.length > 0 || cmd.writes.length > 0) commands.push(cmd)
    cmd = newCommand()
    next = 'word'
  }
  const substitution = (body: string): void => {
    substitutions.push(body)
    word += '$()'
    inWord = true
  }

  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (c === '\n') {
      endCommand()
      i++
      for (const h of heredocs.splice(0)) {
        const lines: string[] = []
        while (i < src.length) {
          const nl = src.indexOf('\n', i)
          const end = nl < 0 ? src.length : nl
          const line = src.slice(i, end)
          i = end + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
          lines.push(line)
        }
        h.cmd.heredocs.push(lines.join('\n'))
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
    } else if (c === ';' || c === '|' || c === '(' || c === ')') {
      endCommand()
      i++
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        endWord()
        i += src[i + 2] === '>' ? 3 : 2
        next = 'write'
      } else {
        endCommand()
        i++
      }
    } else if (c === '>') {
      // A bare number right before `>` is a file descriptor (`2>err.log`).
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else endWord()
      i++
      if (src[i] === '>' || src[i] === '|') i++
      next = 'write'
    } else if (c === '<') {
      endWord()
      if (src.startsWith('<<<', i)) {
        i += 3 // here-string: the next word is data, kept as an ordinary word
      } else if (src[i + 1] === '<') {
        i += 2
        next = src[i] === '-' ? 'heredoc-strip' : 'heredoc'
        if (src[i] === '-') i++
      } else {
        i++
        if (src[i] === '&' || src[i] === '>') i++
        next = 'read'
      }
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      const stop = end < 0 ? src.length : end
      word += src.slice(i + 1, stop)
      inWord = true
      i = stop + 1
    } else if (c === '"') {
      inWord = true
      i++
      while (i < src.length && src[i] !== '"') {
        const d = src[i] ?? ''
        if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') word += src[i + 1]
          i += 2
        } else if (d === '$' && src[i + 1] === '(') {
          const end = closeParen(src, i + 2)
          substitution(src.slice(i + 2, end - 1))
          i = end
        } else if (d === '`') {
          const end = src.indexOf('`', i + 1)
          const stop = end < 0 ? src.length : end
          substitution(src.slice(i + 1, stop))
          i = stop + 1
        } else {
          word += d
          i++
        }
      }
      i++
    } else if (c === '\\') {
      if (i + 1 < src.length && src[i + 1] !== '\n') {
        word += src[i + 1]
        inWord = true
      }
      i += 2
    } else if (c === '$' && src[i + 1] === '(') {
      const end = closeParen(src, i + 2)
      substitution(src.slice(i + 2, end - 1))
      i = end
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1)
      const stop = end < 0 ? src.length : end
      substitution(src.slice(i + 1, stop))
      i = stop + 1
    } else if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? src.length : nl
    } else {
      word += c
      inWord = true
      i++
    }
  }
  endCommand()
  return { commands, substitutions }
}
