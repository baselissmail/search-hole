// SPDX-License-Identifier: Apache-2.0
// A minimal MCP Apps host (ext-apps AppBridge, as real hosts embed it): loads the built panel into
// a sandboxed iframe, sends a receipt result, and records the panel's calls for the tests.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'

type Recorded = { calls: unknown[]; contexts: unknown[]; modes: string[] }
const w = window as unknown as Recorded & { ready?: boolean }
w.calls = []
w.contexts = []
w.modes = []

const q = new URLSearchParams(location.search)
const theme = q.get('theme') === 'dark' ? 'dark' : 'light'
const tools = q.get('tools') !== '0'
document.documentElement.style.colorScheme = theme
document.body.style.background = theme === 'dark' ? '#1a1a1a' : '#ffffff'

const RESULT = {
  content: [{ type: 'text' as const, text: 'receipt rcpt_X · 2 searches' }],
  _meta: {
    'search-hole/panel': {
      host: 'claude-desktop',
      receipts: [
        {
          receiptId: 'rcpt_XXXXXXXXXXXXXXXXXXXXXX',
          startedAt: '2026-10-31T10:00:00.000Z',
          summaryLine: 's',
          warnings: [],
          searches: [
            {
              query: 'react compiler 1.0',
              at: 'x',
              mode: 'builtin',
              engines: [],
              kept: 7,
              hidden: 2,
              hiddenByReason: { rule: 2 },
            },
            {
              query: '<script>alert("q")</script>',
              at: 'x',
              mode: 'engines',
              engines: ['searxng'],
              kept: 5,
              hidden: 0,
              hiddenByReason: {},
            },
          ],
          sources: [
            {
              url: 'https://react.dev/learn/react-compiler',
              title: 'React Compiler',
              dates: [
                { value: '2025-10-07T00:00:00.000Z', kind: 'modified', method: 'jsonld', confidence: 'high' },
              ],
              sourceType: 'official',
              freshness: 'fresh',
            },
            {
              url: 'https://www.w3schools.com/react/react_compiler.asp',
              title: '<img src=x onerror=alert(1)>',
              dates: [],
              sourceType: 'blog',
              freshness: 'stale',
            },
            {
              url: 'javascript:alert(2)',
              title: 'not a link',
              dates: [],
              sourceType: 'unknown',
              freshness: 'unknown',
            },
          ],
        },
      ],
      blockable: [
        { site: 'react.dev', token: 'tok-react' },
        { site: 'w3schools.com', token: 'tok-w3' },
      ],
      suggestions: [
        {
          id: 7,
          match: 'geeksforgeeks.org',
          action: 'lower',
          weight: 3,
          reason: 'Often outdated',
          token: 'tok-7',
        },
      ],
    },
  },
}

const iframe = document.getElementById('app') as HTMLIFrameElement
const html = await (await fetch('/receipt.html')).text()

let context = {
  theme,
  // Hosts send their surface colour as a style variable (MCP Apps host context).
  styles: { variables: { '--color-background-primary': theme === 'dark' ? '#1a1a1a' : '#ffffff' } },
  displayMode: 'inline' as 'inline' | 'fullscreen',
  availableDisplayModes: ['inline', 'fullscreen'] as ('inline' | 'fullscreen')[],
}
const bridge = new AppBridge(
  null,
  { name: 'test-host', version: '1.0.0' },
  { ...(tools ? { serverTools: {} } : {}), updateModelContext: {}, openLinks: {} },
  { hostContext: context },
)
bridge.oncalltool = async (params) => {
  w.calls.push(params)
  const value = String((params.arguments as { value?: string } | undefined)?.value)
  return { content: [{ type: 'text', text: `Blocked ${value} (rule r1); it applies from the next search.` }] }
}
bridge.onupdatemodelcontext = async (params) => {
  w.contexts.push(params)
  return {}
}
bridge.onrequestdisplaymode = async ({ mode }) => {
  w.modes.push(mode)
  context = { ...context, displayMode: mode === 'fullscreen' ? 'fullscreen' : 'inline' }
  bridge.setHostContext(context)
  iframe.style.height = mode === 'fullscreen' ? '900px' : '640px'
  return { mode: context.displayMode }
}
bridge.oninitialized = () => {
  void bridge.sendToolResult(RESULT).then(() => {
    w.ready = true
  })
}
// Listen before the app loads, as hosts do: the View sends ui/initialize as soon as it runs.
const target = iframe.contentWindow
if (target === null) throw new Error('no frame window')
await bridge.connect(new PostMessageTransport(target, target))
iframe.srcdoc = html
