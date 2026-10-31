// SPDX-License-Identifier: Apache-2.0
/**
 * The receipt panel (ADR-0021): an inline card with 4–5 data points and two actions, and a
 * fullscreen receipt with per-site Block and per-suggestion Approve buttons. Buttons call the
 * app-only `apply_rule` with the one-time token the gateway put in this result's `_meta`; hosts
 * without `serverTools` get the command to type instead. Every web string is set as text.
 */
import type { CallToolResult } from '@modelcontextprotocol/client'
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps'
import {
  type CardModel,
  cardModel,
  fallbackCommand,
  type PanelData,
  readPanelData,
  reasonLabel,
  safeHttpUrl,
  siteOf,
} from './model.ts'
import './styles.css'

type Child = Node | string | null | undefined | false

/** Builds an element; strings become text nodes, never HTML. */
function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

const root = document.getElementById('root') as HTMLElement
const app = new App({ name: 'search-hole receipt', version: '1.0.0' }, {}, { autoResize: true })

let data: PanelData | null = null
let full = false
/** Results of actions taken in this panel, by site or suggestion id. */
const done = new Map<string, string>()

function applyContext(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme)
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables)
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts)
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets
    root.style.padding = `${top}px ${right}px ${bottom}px ${left}px`
  }
  if (ctx.displayMode !== undefined) full = ctx.displayMode === 'fullscreen'
}

const canCall = (): boolean => Boolean(app.getHostCapabilities()?.serverTools)
const canFullscreen = (): boolean =>
  app.getHostContext()?.availableDisplayModes?.includes('fullscreen') === true

async function openFull(focus?: 'sources'): Promise<void> {
  if (canFullscreen()) {
    try {
      const { mode } = await app.requestDisplayMode({ mode: 'fullscreen' })
      full = mode === 'fullscreen'
    } catch {
      full = true
    }
  } else {
    full = true // expand in place
  }
  render()
  if (focus === 'sources') document.getElementById('sources')?.focus()
}

async function closeFull(): Promise<void> {
  if (canFullscreen()) {
    try {
      await app.requestDisplayMode({ mode: 'inline' })
    } catch {
      // The host keeps its mode; render the card anyway.
    }
  }
  full = false
  render()
}

function stat(label: string, value: string, detail?: string, tone?: 'warn'): HTMLElement {
  return el(
    'div',
    { class: `stat${tone === 'warn' ? ' warn' : ''}` },
    el('dt', {}, label),
    el(
      'dd',
      {},
      el('span', { class: 'num' }, value),
      detail ? el('span', { class: 'detail' }, ` ${detail}`) : null,
    ),
  )
}

function card(m: CardModel): HTMLElement {
  const hiddenDetail = m.topHiddenReason ? `mostly ${reasonLabel(m.topHiddenReason)}` : undefined
  return el(
    'section',
    { class: 'card', 'aria-label': 'search-hole receipt' },
    el('h1', {}, 'search-hole receipt'),
    el(
      'dl',
      { class: 'stats' },
      stat('Searches', String(m.searches), m.builtin > 0 ? `${m.builtin} built-in` : undefined),
      stat('Kept', String(m.kept)),
      stat('Hidden', String(m.hidden), hiddenDetail),
      stat('Opened', String(m.opened), m.official > 0 ? `${m.official} official` : undefined),
      m.stale > 0 ? stat('Stale', String(m.stale), 'older than the limit', 'warn') : null,
    ),
    el(
      'div',
      { class: 'actions' },
      button('Full receipt', () => void openFull(), 'primary'),
      m.opened > 0 ? button('Block a site…', () => void openFull('sources')) : null,
    ),
  )
}

function button(label: string, onClick: () => void, variant?: 'primary', aria?: string): HTMLButtonElement {
  const b = el(
    'button',
    { type: 'button', class: `btn${variant ? ` ${variant}` : ''}`, ...(aria ? { 'aria-label': aria } : {}) },
    label,
  ) as HTMLButtonElement
  b.addEventListener('click', onClick)
  return b
}

async function apply(
  kind: 'block' | 'approve',
  value: string,
  token: string,
  b: HTMLButtonElement,
): Promise<void> {
  b.disabled = true
  b.textContent = kind === 'block' ? 'Blocking…' : 'Approving…'
  try {
    const res = (await app.callServerTool({
      name: 'apply_rule',
      arguments: { kind, value, token },
    })) as CallToolResult
    const message = res.content?.find((c) => c.type === 'text')?.text ?? ''
    if (res.isError) {
      done.set(`${kind}:${value}`, `Not done: ${message}`)
    } else {
      done.set(`${kind}:${value}`, kind === 'block' ? `Blocked ${value}` : 'Approved')
      if (app.getHostCapabilities()?.updateModelContext) {
        const front = kind === 'block' ? `blocked: ${value}` : `approved-suggestion: ${value}`
        await app
          .updateModelContext({
            content: [
              {
                type: 'text',
                text: `---\n${front}\n---\nThe user did this in the search-hole receipt panel.`,
              },
            ],
          })
          .catch(() => undefined)
      }
    }
  } catch {
    done.set(`${kind}:${value}`, 'Not done: the host did not answer.')
  }
  render()
}

function actionCell(
  kind: 'block' | 'approve',
  value: string,
  label: string,
  token: string | undefined,
  host: PanelData['host'],
): Child {
  const result = done.get(`${kind}:${value}`)
  if (result !== undefined)
    return el(
      'span',
      { class: result.startsWith('Not') ? 'result error' : 'result ok', role: 'status' },
      result,
    )
  if (token !== undefined && canCall()) {
    const b = button(label, () => void apply(kind, value, token, b), undefined, `${label} ${value}`)
    return b
  }
  return el('code', { class: 'cmd' }, fallbackCommand(host, kind, value))
}

function fullView(d: PanelData, m: CardModel): HTMLElement {
  const searches = d.receipts.flatMap((r) => r.searches)
  return el(
    'section',
    { class: 'full', 'aria-label': 'Full search-hole receipt' },
    el(
      'header',
      { class: 'full-head' },
      el('h1', {}, 'search-hole receipt'),
      button(canFullscreen() ? 'Back to chat' : 'Show less', () => void closeFull()),
    ),
    el(
      'p',
      { class: 'summary' },
      `${m.searches} searches · ${m.kept} kept · ${m.hidden} hidden · ${m.opened} opened${m.stale > 0 ? ` · ${m.stale} stale` : ''}`,
    ),
    el('h2', {}, 'Searches'),
    el(
      'ul',
      { class: 'list' },
      ...searches.map((s) =>
        el(
          'li',
          {},
          el('span', { class: 'query' }, s.query),
          el(
            'span',
            { class: 'meta' },
            `${s.mode === 'builtin' ? 'built-in' : s.engines.join(', ') || 'engines'} · ${s.kept} kept${s.hidden > 0 ? ` · ${s.hidden} hidden` : ''}`,
          ),
        ),
      ),
    ),
    el('h2', { id: 'sources', tabindex: '-1' }, 'Sources opened'),
    m.sources.length === 0
      ? el('p', { class: 'meta' }, 'No pages were opened.')
      : el(
          'ul',
          { class: 'list' },
          ...m.sources.map((s) => {
            const site = siteOf(s.url, d.blockable)
            const href = safeHttpUrl(s.url)
            const token = site === undefined ? undefined : d.blockable.find((b) => b.site === site)?.token
            const title = s.title && s.title.trim() !== '' ? s.title : s.url
            return el(
              'li',
              {},
              el(
                'div',
                { class: 'src' },
                href === null
                  ? el('span', { class: 'title' }, title)
                  : el(
                      'a',
                      { class: 'title', href, target: '_blank', rel: 'noopener noreferrer nofollow' },
                      title,
                    ),
                el('span', { class: 'meta url' }, s.url),
                el(
                  'span',
                  { class: `meta${s.freshness === 'stale' ? ' warn-text' : ''}` },
                  `${s.sourceType} · ${s.freshness}${s.dates[0] ? ` · ${s.dates[0].value.slice(0, 10)}` : ''}`,
                ),
              ),
              site === undefined ? null : actionCell('block', site, 'Block', token, d.host),
            )
          }),
        ),
    d.suggestions.length === 0
      ? null
      : el(
          'div',
          {},
          el('h2', {}, 'Suggested rules'),
          el(
            'ul',
            { class: 'list' },
            ...d.suggestions.map((s) =>
              el(
                'li',
                {},
                el(
                  'div',
                  { class: 'src' },
                  el('span', { class: 'query' }, `${s.action}${s.weight ? ` ${s.weight}` : ''} ${s.match}`),
                  el('span', { class: 'meta' }, `Claude's reason: ${s.reason}`),
                ),
                actionCell('approve', String(s.id), 'Approve', s.token, d.host),
              ),
            ),
          ),
        ),
    d.dashboardUrl ? el('p', { class: 'meta' }, `Full log: ${d.dashboardUrl}`) : null,
  )
}

function render(): void {
  root.replaceChildren()
  if (data === null) {
    root.append(el('p', { class: 'meta' }, 'Waiting for the receipt…'))
    return
  }
  const m = cardModel(data)
  root.append(full ? fullView(data, m) : card(m))
}

app.addEventListener('toolresult', (result) => {
  data = readPanelData(result)
  render()
})
app.addEventListener('hostcontextchanged', (ctx) => {
  applyContext(ctx)
  render()
})
app.onteardown = async () => ({})

render()
void app.connect().then(() => {
  const ctx = app.getHostContext()
  if (ctx) applyContext(ctx)
  render()
})
