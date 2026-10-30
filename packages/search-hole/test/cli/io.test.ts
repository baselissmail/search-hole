// SPDX-License-Identifier: Apache-2.0
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { applyHiddenInput, parseYesNo, promptHiddenLine, readAllText } from '../../src/cli/io.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'

describe('readAllText', () => {
  it('joins chunks and decodes UTF-8 split across them', async () => {
    const s = new PassThrough()
    const done = readAllText(s)
    const bytes = Buffer.from('clé–日本', 'utf8')
    s.write(bytes.subarray(0, 3))
    s.write(bytes.subarray(3))
    s.end()
    expect(await done).toBe('clé–日本')
  })

  it('an empty, already-closed stream gives an empty string', async () => {
    const s = new PassThrough()
    s.end()
    expect(await readAllText(s)).toBe('')
  })

  it('rejects input over the cap', async () => {
    const s = new PassThrough()
    const done = readAllText(s, { maxBytes: 10 })
    s.write('x'.repeat(11))
    await expect(done).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('gives up on a pipe that stays silent', async () => {
    const s = new PassThrough()
    const err = await readAllText(s, { idleMs: 20 }).catch((e: unknown) => e)
    expect(isSearchHoleError(err)).toBe(true)
    expect(String((err as Error).message)).toContain('Nothing arrived on stdin')
  })

  it('does not time out while data keeps arriving', async () => {
    const s = new PassThrough()
    const done = readAllText(s, { idleMs: 60 })
    for (const part of ['a', 'b', 'c']) {
      s.write(part)
      await new Promise((r) => setTimeout(r, 30))
    }
    s.end()
    expect(await done).toBe('abc')
  })

  it('passes a stream error on', async () => {
    const s = new PassThrough()
    const done = readAllText(s)
    s.destroy(new Error('EIO'))
    await expect(done).rejects.toThrow('EIO')
  })
})

describe('applyHiddenInput (echo-off prompt)', () => {
  it('collects typed characters until Enter', () => {
    let r = applyHiddenInput('', 'abc')
    expect(r).toEqual({ buffer: 'abc', done: false, cancelled: false })
    r = applyHiddenInput(r.buffer, 'd\r')
    expect(r).toEqual({ buffer: 'abcd', done: true, cancelled: false })
  })

  it('handles a paste that ends with a newline', () => {
    expect(applyHiddenInput('', 'tvly-1234\n')).toEqual({ buffer: 'tvly-1234', done: true, cancelled: false })
  })

  it('backspace removes the last character, including multi-unit ones', () => {
    expect(applyHiddenInput('ab', '\u007f').buffer).toBe('a')
    expect(applyHiddenInput('a日', '\b').buffer).toBe('a')
    expect(applyHiddenInput('', '\u007f').buffer).toBe('')
  })

  it('Ctrl-C cancels; Ctrl-D cancels when empty and submits otherwise', () => {
    expect(applyHiddenInput('abc', '\u0003').cancelled).toBe(true)
    expect(applyHiddenInput('', '\u0004').cancelled).toBe(true)
    expect(applyHiddenInput('abc', '\u0004')).toEqual({ buffer: 'abc', done: true, cancelled: false })
  })

  it('ignores arrow keys and other control characters', () => {
    expect(applyHiddenInput('ab', '\u001b[D').buffer).toBe('ab')
    expect(applyHiddenInput('', 'x\u001b[1;5Cy').buffer).toBe('xy')
    expect(applyHiddenInput('', 'a\tb').buffer).toBe('ab')
  })
})

describe('parseYesNo', () => {
  it('empty means the default; only yes means yes', () => {
    expect(parseYesNo('', true)).toBe(true)
    expect(parseYesNo('', false)).toBe(false)
    expect(parseYesNo(' Y ', false)).toBe(true)
    expect(parseYesNo('yes', false)).toBe(true)
    expect(parseYesNo('n', true)).toBe(false)
    expect(parseYesNo('maybe', true)).toBe(false)
  })
})

describe('promptHiddenLine', () => {
  function fakeTty() {
    const listeners = new Set<(chunk: string) => void>()
    const raw: boolean[] = []
    let paused = false
    let written = ''
    return {
      input: {
        setRawMode: (m: boolean) => raw.push(m),
        setEncoding: () => undefined,
        resume: () => {
          paused = false
        },
        pause: () => {
          paused = true
        },
        on: (_: 'data', l: (chunk: string) => void) => listeners.add(l),
        off: (_: 'data', l: (chunk: string) => void) => listeners.delete(l),
      },
      out: {
        write: (t: string) => {
          written += t
        },
      },
      type: (chunk: string) => {
        for (const l of [...listeners]) l(chunk)
      },
      raw,
      isPaused: () => paused,
      written: () => written,
      listening: () => listeners.size,
    }
  }

  it('echoes nothing: only the prompt and a closing newline are written', async () => {
    const tty = fakeTty()
    const done = promptHiddenLine(tty.input, tty.out, 'Paste the key: ')
    tty.type('tvly-')
    tty.type('SECRET\u007f')
    tty.type('1\r')
    expect(await done).toBe('tvly-SECRE1')
    expect(tty.written()).toBe('Paste the key: \n')
    expect(tty.written()).not.toContain('SECRE')
  })

  it('turns raw mode on, then off, and stops listening', async () => {
    const tty = fakeTty()
    const done = promptHiddenLine(tty.input, tty.out, 'p ')
    expect(tty.raw).toEqual([true])
    tty.type('x\n')
    await done
    expect(tty.raw).toEqual([true, false])
    expect(tty.isPaused()).toBe(true)
    expect(tty.listening()).toBe(0)
  })

  it('Ctrl-C restores the terminal and rejects', async () => {
    const tty = fakeTty()
    const done = promptHiddenLine(tty.input, tty.out, 'p ')
    tty.type('abc\u0003')
    await expect(done).rejects.toMatchObject({ code: 'invalid_argument', why: 'Cancelled.' })
    expect(tty.raw).toEqual([true, false])
    expect(tty.listening()).toBe(0)
  })
})
