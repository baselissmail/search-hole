// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { type SseMessage, SseParser } from './sse.ts'
import { toStreamEvent } from './streamEvents.ts'

function collect(chunks: string[]) {
  const messages: SseMessage[] = []
  const comments: string[] = []
  const retries: number[] = []
  const parser = new SseParser({
    onMessage: (m) => messages.push(m),
    onComment: (c) => comments.push(c),
    onRetry: (ms) => retries.push(ms),
  })
  for (const chunk of chunks) parser.push(chunk)
  return { messages, comments, retries, parser }
}

/** Every way of cutting `text` into two chunks. */
function allSplits(text: string): string[][] {
  const out: string[][] = []
  for (let i = 0; i <= text.length; i++) out.push([text.slice(0, i), text.slice(i)])
  return out
}

const STREAM = ': ping\n\nid: 7\nevent: search\ndata: {"a":1}\n\nevent: reset\ndata: {"reason":"pruned"}\n\n'

describe('SseParser', () => {
  it('parses events, ids and comments', () => {
    const { messages, comments } = collect([STREAM])
    expect(comments).toEqual(['ping'])
    expect(messages).toEqual([
      { event: 'search', data: '{"a":1}', id: '7' },
      { event: 'reset', data: '{"reason":"pruned"}', id: '7' },
    ])
  })

  it('gives the same result for every chunk boundary', () => {
    const expected = collect([STREAM]).messages
    for (const chunks of allSplits(STREAM)) expect(collect(chunks).messages).toEqual(expected)
  })

  it('gives the same result one character at a time', () => {
    expect(collect([...STREAM]).messages).toEqual(collect([STREAM]).messages)
  })

  it('accepts CRLF and CR line endings, including a CRLF split across chunks', () => {
    const crlf = 'event: search\r\ndata: x\r\n\r\n'
    const cr = 'event: search\rdata: x\r\r'
    const expected = [{ event: 'search', data: 'x', id: '' }]
    expect(collect([crlf]).messages).toEqual(expected)
    expect(collect([cr]).messages).toEqual(expected)
    expect(collect(['event: search\r', '\ndata: x\r', '\n\r', '\n']).messages).toEqual(expected)
    for (const chunks of allSplits(crlf)) expect(collect(chunks).messages).toEqual(expected)
  })

  it('joins multi-line data with newlines', () => {
    const { messages } = collect(['data: one\ndata: two\ndata:\ndata: three\n\n'])
    expect(messages[0]?.data).toBe('one\ntwo\n\nthree')
  })

  it('strips exactly one space after the colon', () => {
    const { messages } = collect(['data:  two spaces\n\ndata:none\n\n'])
    expect(messages.map((m) => m.data)).toEqual([' two spaces', 'none'])
  })

  it('treats a line without a colon as a field with an empty value', () => {
    const { messages } = collect(['data\n\n'])
    expect(messages).toEqual([{ event: 'message', data: '', id: '' }])
  })

  it('does not dispatch an event without data, and resets its type', () => {
    const { messages } = collect(['event: search\n\ndata: x\n\n'])
    expect(messages).toEqual([{ event: 'message', data: 'x', id: '' }])
  })

  it('keeps the last event id across events and ignores ids containing NUL', () => {
    const { messages, parser } = collect(['id: 1\ndata: a\n\ndata: b\n\nid: 2\u0000\ndata: c\n\n'])
    expect(messages.map((m) => m.id)).toEqual(['1', '1', '1'])
    expect(parser.lastEventId).toBe('1')
  })

  it('lets an empty id clear the last event id', () => {
    const { messages } = collect(['id: 5\ndata: a\n\nid\ndata: b\n\n'])
    expect(messages.map((m) => m.id)).toEqual(['5', ''])
  })

  it('reads retry only when it is all digits, and ignores unknown fields', () => {
    const { retries, messages } = collect(['retry: 3000\nretry: 1.5\nfoo: bar\ndata: x\n\n'])
    expect(retries).toEqual([3000])
    expect(messages).toHaveLength(1)
  })

  it('handles comments with and without a space, and empty comments', () => {
    const { comments, messages } = collect([':ping\n: ping\n:\n\n'])
    expect(comments).toEqual(['ping', 'ping', ''])
    expect(messages).toHaveLength(0)
  })

  it('strips a leading byte-order mark only at the start of the stream', () => {
    // Later, the BOM is part of the field name, so that line is an unknown field.
    const { messages } = collect(['\uFEFFdata: x\n\n', '\uFEFFdata: y\n\n'])
    expect(messages.map((m) => m.data)).toEqual(['x'])
  })

  it('never dispatches a partial event at the end', () => {
    const { messages } = collect(['data: complete\n\ndata: partial\n'])
    expect(messages.map((m) => m.data)).toEqual(['complete'])
  })

  it('keeps data with colons and JSON intact', () => {
    const json = JSON.stringify({ query: 'a: b', url: 'https://x.test/a:b' })
    const { messages } = collect([`data: ${json}\n\n`])
    expect(messages[0]?.data).toBe(json)
  })
})

describe('toStreamEvent', () => {
  const entry = {
    searchId: 42,
    receiptId: 'r1',
    at: '2026-10-31T10:00:00Z',
    query: 'q',
    profile: 'default',
    depth: 'standard',
    mode: 'engines',
    engines: ['brave'],
    kept: 3,
    hidden: 1,
    latencyMs: 120,
  }

  it('decodes a search event and takes the id from the id field', () => {
    const event = toStreamEvent({ event: 'search', id: '43', data: JSON.stringify(entry) })
    expect(event).toEqual({ event: 'search', id: 43, data: entry })
  })

  it('falls back to the search id when the id field is missing', () => {
    expect(toStreamEvent({ event: 'search', id: '', data: JSON.stringify(entry) })).toMatchObject({ id: 42 })
  })

  it('drops malformed search payloads', () => {
    expect(toStreamEvent({ event: 'search', id: '1', data: 'not json' })).toBeNull()
    expect(
      toStreamEvent({ event: 'search', id: '1', data: JSON.stringify({ ...entry, kept: '3' }) }),
    ).toBeNull()
    expect(
      toStreamEvent({ event: 'search', id: '1', data: JSON.stringify({ ...entry, searchId: -1 }) }),
    ).toBeNull()
  })

  it('always honours reset, even with an unreadable payload', () => {
    expect(toStreamEvent({ event: 'reset', id: '', data: '{"reason":"pruned"}' })).toEqual({
      event: 'reset',
      data: { reason: 'pruned' },
    })
    expect(toStreamEvent({ event: 'reset', id: '', data: 'garbage' })).toEqual({
      event: 'reset',
      data: { reason: 'epoch' },
    })
  })

  it('decodes stream-error and ignores unknown events', () => {
    expect(toStreamEvent({ event: 'stream-error', id: '', data: '{"message":"boom"}' })).toEqual({
      event: 'stream-error',
      data: { message: 'boom' },
    })
    expect(toStreamEvent({ event: 'message', id: '', data: '{}' })).toBeNull()
  })
})
