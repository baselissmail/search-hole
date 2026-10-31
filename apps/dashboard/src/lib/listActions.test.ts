// SPDX-License-Identifier: Apache-2.0
/**
 * The list actions end to end against the dev mock's lists routes: the real API client, the real
 * toasts (captured) and their Undo buttons, no network. Adding a catalog list downloads it, which
 * the browser e2e cannot do offline; this is where that flow is checked.
 */
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockServer } from '../dev/mock.ts'
import { api } from './api.ts'
import type { ListStatus } from './contract.ts'
import {
  addListWithUndo,
  commitPendingRemovals,
  removeListWithUndo,
  setListModeWithUndo,
  updateAllLists,
  updateListNow,
} from './listActions.ts'
import { catalogAddMode, catalogUndo } from './lists.ts'
import { startSession } from './session.ts'

interface Shown {
  type: string
  title: string
  /** The toast id (given, or the one returned). */
  id: string | number
  opts: {
    id?: string | number
    description?: string
    action?: { label: string; onClick: (event: unknown) => void }
    onAutoClose?: () => void
    onDismiss?: () => void
  }
}

const shown: Shown[] = []

vi.mock('sonner', () => {
  let next = 0
  const record =
    (type: string) =>
    (title: string, opts: Shown['opts'] = {}) => {
      const id = opts.id ?? ++next
      shown.push({ type, title, opts, id })
      return id
    }
  return {
    toast: Object.assign(record('default'), {
      success: record('success'),
      error: record('error'),
      warning: record('warning'),
      info: record('info'),
      loading: record('loading'),
      dismiss: vi.fn(),
    }),
  }
})

const last = () => shown[shown.length - 1] as Shown
const undo = async (t: Shown) => {
  t.opts.action?.onClick({})
  await vi.waitFor(() => expect(shown[shown.length - 1]).not.toBe(t))
}
const byId = async (id: string): Promise<ListStatus | undefined> =>
  (await api.lists()).find((l) => l.id === id)

let qc: QueryClient

beforeEach(() => {
  shown.length = 0
  const server = new MockServer({ size: 0, brokenStream: false, instant: true })
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new URL(String(input), 'http://127.0.0.1:7341'), null, init),
  )
  startSession('mock-session-token', '0.0.0-test')
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  qc.clear()
})

describe('adding from the catalog', () => {
  it('subscribes a non-starter list in Audit, downloads it, and Undo removes it', async () => {
    const entry = (await api.listCatalog()).find((e) => e.id === 'popcar2-bad-website-blocklist')
    expect(entry).toMatchObject({ starter: false, enabled: false, recommendedMode: 'off' })
    if (!entry) return

    const list = await addListWithUndo(
      qc,
      { source: entry.id, mode: catalogAddMode(entry) },
      catalogUndo(entry),
    )
    expect(list).toMatchObject({
      id: entry.id,
      source: 'subscribed',
      mode: 'audit',
      copy: 'downloaded',
      lastError: null,
    })
    expect(last()).toMatchObject({ type: 'success', title: `Added ${entry.name}` })
    expect(last().opts.description).toMatch(/^Audit · 418 rules\./)
    expect((await api.listCatalog()).find((e) => e.id === entry.id)).toMatchObject({
      enabled: true,
      mode: 'audit',
    })

    await undo(last())
    expect(last().title).toBe(`Undone: ${entry.name} removed`)
    expect(await byId(entry.id)).toBeUndefined()
  })

  it('turns a starter list that was off back on, and Undo turns it off again', async () => {
    const entry = (await api.listCatalog()).find((e) => e.id === 'arosh-github-translation')
    expect(entry).toMatchObject({ starter: true, enabled: false, mode: 'disabled' })
    if (!entry) return
    await addListWithUndo(qc, { source: entry.id, mode: catalogAddMode(entry) }, catalogUndo(entry))
    expect(await byId(entry.id)).toMatchObject({ mode: 'enforce' })
    await undo(last())
    expect(await byId(entry.id)).toMatchObject({ mode: 'disabled' })
  })
})

describe('adding by address', () => {
  it('keeps a failed download on the row and says so, and refuses bad input as an error', async () => {
    const list = await addListWithUndo(qc, {
      source: 'https://lists.unreachable.invalid/team.txt',
      mode: 'audit',
      kind: 'block',
      format: 'auto',
      update: '1d',
    })
    expect(list).toMatchObject({ id: 'team', mode: 'audit', copy: 'none' })
    expect(list.lastError?.code).toBe('network')
    expect(last()).toMatchObject({ type: 'warning', title: 'Added team, but the download failed' })

    await expect(addListWithUndo(qc, { source: 'http://example.net/list.txt' })).rejects.toMatchObject({
      status: 400,
      message: 'Lists are fetched over HTTPS only.',
    })
    await expect(
      addListWithUndo(qc, { source: 'https://lists.unreachable.invalid/team.txt' }),
    ).rejects.toMatchObject({ message: 'A list named "team" already exists.' })
  })
})

describe('mode, refresh and remove', () => {
  it('switches a mode at once and Undo puts it back', async () => {
    const pinterest = (await byId('rjaus-pinterest')) as ListStatus
    await setListModeWithUndo(qc, pinterest, 'audit')
    expect(await byId('rjaus-pinterest')).toMatchObject({ mode: 'audit' })
    expect(last()).toMatchObject({ type: 'success', title: `${pinterest.name}: Audit` })
    await undo(last())
    expect(await byId('rjaus-pinterest')).toMatchObject({ mode: 'enforce' })
  })

  it('holds back a shrunken copy until "Update anyway"', async () => {
    const seo = (await byId('super-seo-spam-suppressor')) as ListStatus
    expect(seo.lastError?.code).toBe('shrink_guard')
    await updateListNow(qc, seo)
    expect(last()).toMatchObject({ type: 'error', title: `Couldn't update ${seo.name}` })
    expect((await byId(seo.id))?.ruleCount).toBe(417_654)
    await updateListNow(qc, seo, true)
    expect(last()).toMatchObject({ type: 'success', title: `Updated ${seo.name}` })
    expect(await byId(seo.id)).toMatchObject({ ruleCount: 1204, lastError: null })
  })

  it('updates every enabled list and sums it up in one toast', async () => {
    const results = await updateAllLists(qc)
    expect(results?.length).toBeGreaterThan(3)
    const loading = shown.find((t) => t.type === 'loading')
    expect(last()).toMatchObject({ type: 'warning', title: 'Lists updated' })
    expect(loading).toBeDefined()
    expect(last().id).toBe(loading?.id)
    expect(last().opts.description).toMatch(
      /updated · .*failed\. Failed: .+\. The copies in force are kept\./,
    )
  })

  it('removes a subscription and Undo subscribes again with the same settings', async () => {
    const seo = (await byId('super-seo-spam-suppressor')) as ListStatus
    await removeListWithUndo(qc, seo)
    expect(await byId(seo.id)).toBeUndefined()
    expect(last()).toMatchObject({ title: `Removed ${seo.name}`, opts: { action: { label: 'Undo' } } })
    await undo(last())
    await vi.waitFor(() => expect(last().title).toBe(`Restored ${seo.name}`))
    expect(await byId(seo.id)).toMatchObject({
      source: 'subscribed',
      url: seo.url,
      mode: 'audit',
      kind: 'block',
      update: '1d',
    })
  })

  it('removes an import only when its Undo window closes', async () => {
    const team = (await byId('team-blocklist')) as ListStatus
    await removeListWithUndo(qc, team)
    const toast = last()
    expect(toast.title).toBe('Removed team-blocklist')
    expect(await byId(team.id)).toBeDefined()
    await undo(toast)
    expect(last().title).toBe('Kept team-blocklist')
    toast.opts.onAutoClose?.()
    expect(await byId(team.id)).toBeDefined()

    await removeListWithUndo(qc, team)
    last().opts.onAutoClose?.()
    await vi.waitFor(async () => expect(await byId(team.id)).toBeUndefined())
  })

  it('sends pending import removals when asked (the page is closing)', async () => {
    const team = (await byId('team-blocklist')) as ListStatus
    await removeListWithUndo(qc, team)
    commitPendingRemovals()
    await vi.waitFor(async () => expect(await byId(team.id)).toBeUndefined())
  })
})
