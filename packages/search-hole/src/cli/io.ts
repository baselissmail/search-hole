// SPDX-License-Identifier: Apache-2.0
/**
 * The CLI's window on the process: output streams, environment, stdin and prompts, behind
 * one interface so every command can be tested with a fake. Prompts and progress go to
 * stderr; stdout carries only a command's result (and is never used by `mcp`).
 */
import { createInterface } from 'node:readline'
import { SearchHoleError } from '../shared/errors.ts'

export interface OutStream {
  write(text: string): void
  readonly isTTY: boolean
  readonly columns?: number
}

export interface CliIo {
  readonly stdout: OutStream
  readonly stderr: OutStream
  /** True when stdin is a terminal (a person is typing). */
  readonly stdinIsTTY: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** Aborts on Ctrl-C so a running search can stop. */
  readonly signal?: AbortSignal
  /** The running script (argv[1]); `setup` writes it into client configs. */
  readonly entry?: string
  /** Everything piped on stdin. Never call on a TTY. */
  readStdin(): Promise<string>
  /** Prompts on stderr and reads one line with echo off. TTY only. */
  promptHidden(prompt: string): Promise<string>
  /** Asks a yes/no question on the terminal: an empty answer gives `defaultYes`, anything but yes gives no. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>
}

/** Cap on piped stdin: a key or a short note, never a file. */
export const MAX_STDIN_BYTES = 64 * 1024
/** How long a pipe may stay silent before `readStdin` gives up. */
export const STDIN_IDLE_MS = 30_000

/**
 * Reads a stream to the end as UTF-8 text. Rejects with `invalid_argument` when more than
 * `maxBytes` arrive or the stream is silent for `idleMs` (a pipe that never closes).
 */
export function readAllText(
  stream: NodeJS.ReadableStream,
  opts: { maxBytes?: number; idleMs?: number } = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? MAX_STDIN_BYTES
  const idleMs = opts.idleMs ?? STDIN_IDLE_MS
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('close', onEnd)
      stream.removeListener('error', onError)
      stream.pause()
    }
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new SearchHoleError(
                'invalid_argument',
                `Nothing arrived on stdin for ${Math.round(idleMs / 1000)} seconds.`,
                {
                  fix: 'Pipe the value in (for example `pbpaste | searchhole keys set tavily`) or run it in a terminal.',
                },
              ),
            ),
          ),
        idleMs,
      )
    }
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.length
      if (size > maxBytes) {
        finish(() =>
          reject(
            new SearchHoleError('invalid_argument', 'The input on stdin is too large.', {
              fix: 'Pass only the value itself, not a file.',
            }),
          ),
        )
        return
      }
      chunks.push(buf)
      arm()
    }
    const onEnd = (): void => finish(() => resolve(Buffer.concat(chunks).toString('utf8')))
    const onError = (err: Error): void => finish(() => reject(err))

    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('close', onEnd)
    stream.on('error', onError)
    arm()
    stream.resume()
  })
}

/** Turns a typed answer into a decision: empty means the default, anything but yes means no. */
export function parseYesNo(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim().toLowerCase()
  if (a === '') return defaultYes
  return a === 'y' || a === 'yes'
}

/**
 * Applies raw terminal input to a hidden-line buffer. Returns the new buffer and whether
 * the line is complete (Enter) or cancelled (Ctrl-C, or Ctrl-D on an empty line). Escape
 * sequences (arrow keys) are skipped. Exported for tests.
 */
export function applyHiddenInput(
  buffer: string,
  chunk: string,
): { buffer: string; done: boolean; cancelled: boolean } {
  let buf = buffer
  const chars = [...chunk]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? ''
    if (ch === '\r' || ch === '\n') return { buffer: buf, done: true, cancelled: false }
    if (ch === '\u0003') return { buffer: buf, done: false, cancelled: true }
    if (ch === '\u0004') {
      return buf === ''
        ? { buffer: buf, done: false, cancelled: true }
        : { buffer: buf, done: true, cancelled: false }
    }
    if (ch === '\u007f' || ch === '\b') {
      buf = [...buf].slice(0, -1).join('')
      continue
    }
    if (ch === '\u001b') {
      // CSI sequence: ESC [ ... final byte in 0x40-0x7e. Anything else: drop the ESC only.
      if (chars[i + 1] === '[') {
        i += 2
        while (i < chars.length && !/[@-~]/.test(chars[i] ?? '')) i++
      }
      continue
    }
    if (ch >= ' ') buf += ch
  }
  return { buffer: buf, done: false, cancelled: false }
}

/** The parts of a TTY input stream the hidden prompt uses (so tests can fake it). */
export interface HiddenPromptInput {
  setRawMode(mode: boolean): unknown
  setEncoding(encoding: BufferEncoding): unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', listener: (chunk: string) => void): unknown
  off(event: 'data', listener: (chunk: string) => void): unknown
}

/**
 * Reads one line with echo off: raw mode, nothing typed is written back, the terminal is
 * restored on Enter, Ctrl-C and Ctrl-D. Only `prompt` and a final newline reach `out`.
 */
export function promptHiddenLine(
  input: HiddenPromptInput,
  out: { write(text: string): unknown },
  prompt: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = ''
    out.write(prompt)
    input.setRawMode(true)
    input.setEncoding('utf8')
    input.resume()
    const restore = (): void => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      out.write('\n')
    }
    const onData = (chunk: string): void => {
      const r = applyHiddenInput(buffer, chunk)
      buffer = r.buffer
      if (r.cancelled) {
        restore()
        reject(new SearchHoleError('invalid_argument', 'Cancelled.'))
      } else if (r.done) {
        restore()
        resolve(buffer)
      }
    }
    input.on('data', onData)
  })
}

function confirmOnTty(question: string, defaultYes: boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, (answer) => {
      rl.close()
      resolve(parseYesNo(answer, defaultYes))
    })
    rl.once('SIGINT', () => {
      rl.close()
      resolve(false)
    })
  })
}

/** How long a command may take to stop after the first Ctrl-C before the process exits anyway. */
const INTERRUPT_GRACE_MS = 1000

/**
 * The real process I/O. For a normal command, the first Ctrl-C aborts `signal` (a running
 * search stops) and the process exits after a short grace period if the command did not
 * finish; a second one exits at once. A closed pipe on stdout or stderr
 * (`searchhole log | head`) ends quietly instead of crashing. With `gateway` (the `mcp`
 * command) none of this is installed: the gateway owns signals and the stdio streams.
 */
export function createNodeIo(opts: { gateway?: boolean; entry?: string } = {}): CliIo {
  const controller = new AbortController()
  if (opts.gateway !== true) {
    process.on('SIGINT', () => {
      if (controller.signal.aborted) process.exit(130)
      controller.abort()
      setTimeout(() => process.exit(130), INTERRUPT_GRACE_MS).unref()
    })
    for (const stream of [process.stdout, process.stderr]) {
      stream.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EPIPE') process.exit(0)
        throw e
      })
    }
  }
  const out = (stream: NodeJS.WriteStream): OutStream => ({
    write: (text) => {
      stream.write(text)
    },
    isTTY: stream.isTTY === true,
    ...(stream.columns === undefined ? {} : { columns: stream.columns }),
  })
  return {
    stdout: out(process.stdout),
    stderr: out(process.stderr),
    stdinIsTTY: process.stdin.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
    ...(opts.entry === undefined ? {} : { entry: opts.entry }),
    signal: controller.signal,
    readStdin: () => readAllText(process.stdin),
    promptHidden: (prompt) =>
      process.stdin.isTTY ? promptHiddenLine(process.stdin, process.stderr, prompt) : Promise.resolve(''),
    confirm: confirmOnTty,
  }
}
