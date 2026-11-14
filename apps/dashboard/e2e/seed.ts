// SPDX-License-Identifier: Apache-2.0
// Seeds a temporary search-hole home for the end-to-end run through the real App (no fixtures):
// built-in searches with hostile titles, a rule, a pending suggestion, lists (offline: an
// imported file, a subscription refused before any connection, searches lists acted on), and
// sites seen in three searches with one opened page (the review list and the Opened marks).
// Usage: SEARCHHOLE_HOME=<dir> node --experimental-strip-types e2e/seed.ts [initial|add <query>]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../../packages/search-hole/src/app/index.ts'

const [mode = 'initial', extra = 'live query'] = process.argv.slice(2)
const env = { ...process.env, SEARCHHOLE_LOG: 'silent' }
const app = await createApp({ host: 'claude-code', version: '0.0.0-e2e', env, cwd: process.cwd() })
const session = { session: { key: 'e2e-session', source: 'hook' as const } }

if (mode === 'initial') {
  await app.rules.add({ match: 'pinterest.com', action: 'block' })
  // Lists (ADR-0022), all offline, set up before the first search (a search schedules a background
  // list refresh 2 s later; the seed closes the app before then). An imported file with one line
  // the importer skips:
  const dir = mkdtempSync(join(tmpdir(), 'searchhole-e2e-list-'))
  try {
    const file = join(dir, 'team-blocklist.txt')
    writeFileSync(file, 'spam.example\nads.example\nnot a domain at all\n')
    await app.lists?.import(file, { name: 'team-blocklist', kind: 'block', format: 'domains' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // A subscription to a loopback address: the fetch guard refuses it before connecting, so the
  // row shows a "Blocked address" error.
  await app.lists?.add({
    source: 'https://127.0.0.1/blocked-list.txt',
    name: 'private-address',
    mode: 'audit',
  })
  // The review list (ADR-0025): two sites kept in three searches and never opened, and a third
  // whose page the assistant opened (not listed, and its result reads "Opened" in the log).
  // These are the oldest searches, so the rows the other tests use stay on top.
  for (const query of ['css grid layout', 'css flexbox gap', 'css subgrid support']) {
    await app.filterBuiltinResults(
      query,
      [
        { title: 'CSS guide', url: 'https://docs.reviewed.example/css/guide' },
        { title: `Top 10 tips: ${query}`, url: `https://farm.example/${query.replaceAll(' ', '-')}` },
        { title: 'CSS tutorial', url: 'https://tutorials.example/css' },
      ],
      session,
    )
  }
  await app.recordBuiltinFetch('https://docs.reviewed.example/css/guide', session)
  await app.filterBuiltinResults(
    'react compiler',
    [
      { title: 'React Compiler v1.0', url: 'https://react.dev/blog/2025/10/07/react-compiler-1' },
      { title: 'Pinterest board', url: 'https://www.pinterest.com/pin/1' },
      { title: 'Some blog', url: 'https://blog.example.net/react-compiler' },
    ],
    session,
  )
  await app.filterBuiltinResults(
    'hostile query',
    [
      { title: '<img src=x onerror=alert(1)>', url: 'https://evil.example/<script>alert(2)</script>' },
      { title: 'javascript link', url: 'javascript:alert(3)' },
      { title: 'كيف أستخدم React', url: 'https://ar.example/react' },
    ],
    session,
  )
  await app.suggestRule(
    { match: 'w3schools.com', action: 'lower', weight: 3, reason: 'Often outdated', scope: 'global' },
    session,
  )
  // Results that starter lists hide (kzen.dev: a Stack Overflow copy), would hide (an audit-mode
  // AI list) and that the import hides, for the "this week" contribution.
  await app.filterBuiltinResults(
    'copied answers',
    [
      { title: 'Copied answer', url: 'https://kzen.dev/en/question/1' },
      { title: 'AI page', url: 'https://www.cgdream.ai/page' },
      { title: 'Team spam', url: 'https://spam.example/x' },
      { title: 'Original', url: 'https://stackoverflow.com/questions/1' },
    ],
    session,
  )
} else {
  await app.filterBuiltinResults(extra, [{ title: 'Live', url: 'https://live.example/' }], session)
}
await app.close()
