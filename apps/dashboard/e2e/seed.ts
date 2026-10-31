// SPDX-License-Identifier: Apache-2.0
// Seeds a temporary search-hole home for the end-to-end run through the real App (no fixtures):
// built-in searches with hostile titles, a rule and a pending suggestion.
// Usage: SEARCHHOLE_HOME=<dir> node --experimental-strip-types e2e/seed.ts [initial|add <query>]
import { createApp } from '../../../packages/search-hole/src/app/index.ts'

const [mode = 'initial', extra = 'live query'] = process.argv.slice(2)
const env = { ...process.env, SEARCHHOLE_LOG: 'silent' }
const app = await createApp({ host: 'claude-code', version: '0.0.0-e2e', env, cwd: process.cwd() })
const session = { session: { key: 'e2e-session', source: 'hook' as const } }

if (mode === 'initial') {
  await app.rules.add({ match: 'pinterest.com', action: 'block' })
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
} else {
  await app.filterBuiltinResults(extra, [{ title: 'Live', url: 'https://live.example/' }], session)
}
await app.close()
