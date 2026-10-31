// SPDX-License-Identifier: Apache-2.0
// Two installed copies of search-hole answering one Claude Code session (ADR-0006 point 11).
import { describe, expect, it } from 'vitest'
import { hookSession, setup } from './helpers.ts'

describe('duplicate copies (ADR-0006 point 11)', () => {
  it('two copies on one session: one logs and prints the Stop line, the other stays quiet; doctor warns', async () => {
    const h = await setup({})
    const second = await h.reopen()
    const results = [{ title: 'React', url: 'https://react.dev/learn' }]
    // Turn hooks only read: the database must exist (any earlier search creates it).
    await h.app.filterBuiltinResults('warm-up', results, hookSession('earlier'))
    const ctx = hookSession('s1')
    await h.app.openTurn(ctx)
    h.clock.advance(20)
    await second.openTurn(ctx)
    const a = await h.app.filterBuiltinResults('react compiler', results, ctx)
    const b = await second.filterBuiltinResults('react compiler', results, ctx)
    expect(b.kept).toEqual(a.kept)
    expect((await h.app.log.recent()).map((e) => e.query)).toEqual(['react compiler', 'warm-up'])
    const lines = [await h.app.closeTurn(ctx), await second.closeTurn(ctx)].map((c) => c.receiptLine)
    expect(lines.filter((l) => l !== undefined)).toHaveLength(1)
    const cli = await h.reopen({ host: 'cli' })
    const report = await cli.doctor()
    expect(report.checks.find((c) => c.id === 'duplicates')).toMatchObject({ status: 'warn' })
  })
})
