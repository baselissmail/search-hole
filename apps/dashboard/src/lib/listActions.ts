// SPDX-License-Identifier: Apache-2.0
/**
 * List changes from the dashboard (ADR-0022). Each is a user action with an Undo toast instead of
 * a confirm dialog (MASTER_PLAN §8.4 point 2). Refreshes can take up to a minute, so which lists
 * are updating is kept here, shared by the Lists page and the command menu.
 */
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { type ExternalToast, toast } from 'sonner'
import { api } from './api.ts'
import type { AddListInput, ListMode, ListStatus, ListUpdateResult } from './contract.ts'
import { formatCount } from './format.ts'
import {
  MODE_HINTS,
  MODE_WORDS,
  resubscribeInput,
  tallyText,
  tallyUpdates,
  updateOutcome,
  withStop,
} from './lists.ts'
import { toastError } from './notify.ts'
import { keys } from './queries.ts'

const UNDO_TOAST_MS = 8000

/** The busy key for "Update all". */
export const ALL_LISTS = '*'

// ── Which lists are updating or being removed ───────────────────────────────

export interface ListsActivity {
  /** Lists being refreshed right now (`ALL_LISTS` for "Update all"). */
  updating: ReadonlySet<string>
  /** Imports removed but still inside their Undo window: hidden from the table. */
  removing: ReadonlySet<string>
}

let activity: ListsActivity = { updating: new Set(), removing: new Set() }
const listeners = new Set<() => void>()

function toggle(key: keyof ListsActivity, id: string, on: boolean): void {
  const next = new Set(activity[key])
  if (on) next.add(id)
  else next.delete(id)
  activity = { ...activity, [key]: next }
  for (const listener of listeners) listener()
}

const setBusy = (id: string, on: boolean) => toggle('updating', id, on)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useListsActivity(): ListsActivity {
  return useSyncExternalStore(
    subscribe,
    () => activity,
    () => activity,
  )
}

// ── Cache helpers ───────────────────────────────────────────────────────────

function refresh(qc: QueryClient): void {
  // `keys.lists` is a prefix of the catalog's key, so both refetch.
  void qc.invalidateQueries({ queryKey: keys.lists })
  void qc.invalidateQueries({ queryKey: keys.doctor })
}

function replaceList(qc: QueryClient, next: ListStatus): void {
  qc.setQueryData<ListStatus[]>(keys.lists, (old) => old?.map((l) => (l.id === next.id ? next : l)))
}

function patchMode(qc: QueryClient, id: string, mode: ListMode): void {
  qc.setQueryData<ListStatus[]>(keys.lists, (old) => old?.map((l) => (l.id === id ? { ...l, mode } : l)))
}

function nameOf(qc: QueryClient, id: string): string {
  return qc.getQueryData<ListStatus[]>(keys.lists)?.find((l) => l.id === id)?.name ?? id
}

function show(tone: 'success' | 'info' | 'error' | 'warning', title: string, opts: ExternalToast): void {
  if (tone === 'error') toast.error(title, opts)
  else if (tone === 'warning') toast.warning(title, opts)
  else if (tone === 'info') toast.info(title, opts)
  else toast.success(title, opts)
}

// ── Mode ────────────────────────────────────────────────────────────────────

async function setMode(qc: QueryClient, list: ListStatus, mode: ListMode): Promise<boolean> {
  const before = list.mode
  patchMode(qc, list.id, mode)
  try {
    replaceList(qc, await api.setListMode(list.id, mode))
    return true
  } catch (err) {
    patchMode(qc, list.id, before)
    toastError(`Couldn't change ${list.name}`, err)
    return false
  } finally {
    refresh(qc)
  }
}

/** Switch a list's mode at once (optimistically), with Undo. */
export async function setListModeWithUndo(qc: QueryClient, list: ListStatus, mode: ListMode): Promise<void> {
  if (mode === list.mode) return
  const before = list.mode
  if (!(await setMode(qc, list, mode))) return
  toast.success(`${list.name}: ${MODE_WORDS[mode]}`, {
    description: MODE_HINTS[mode],
    duration: UNDO_TOAST_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        void (async () => {
          if (await setMode(qc, { ...list, mode }, before)) {
            toast.success(`Undone: ${list.name} is back to ${MODE_WORDS[before]}`)
          }
        })()
      },
    },
  })
}

// ── Refresh ─────────────────────────────────────────────────────────────────

/** "Update now" on one list (`force` accepts a copy the shrink guard refused). */
export async function updateListNow(qc: QueryClient, list: ListStatus, force = false): Promise<void> {
  if (activity.updating.has(list.id) || activity.updating.has(ALL_LISTS)) return
  setBusy(list.id, true)
  try {
    const results = await api.updateList(list.id, force)
    const result = results.find((r) => r.id === list.id) ?? results[0]
    if (result === undefined) {
      toast.info(`${list.name} was not updated`)
      return
    }
    const outcome = updateOutcome(result, list.name)
    show(outcome.tone, outcome.title, { description: outcome.description })
  } catch (err) {
    toastError(`Couldn't update ${list.name}`, err)
  } finally {
    setBusy(list.id, false)
    refresh(qc)
  }
}

/** "Update all": every enabled list with an address, then one summary toast. */
export async function updateAllLists(qc: QueryClient): Promise<ListUpdateResult[] | null> {
  if (activity.updating.has(ALL_LISTS)) return null
  setBusy(ALL_LISTS, true)
  const id = toast.loading('Updating lists…', {
    description: 'Downloading each enabled list from its address. This can take a minute.',
  })
  try {
    const results = await api.updateLists()
    const tally = tallyUpdates(results)
    const failed = results.filter((r) => r.result === 'failed').map((r) => nameOf(qc, r.id))
    const description =
      failed.length > 0
        ? `${tallyText(tally)}. Failed: ${failed.join(', ')}. The copies in force are kept.`
        : tallyText(tally)
    show(failed.length > 0 ? 'warning' : 'success', 'Lists updated', { id, description })
    return results
  } catch (err) {
    toastError("Couldn't update the lists", err, id)
    return null
  } finally {
    setBusy(ALL_LISTS, false)
    refresh(qc)
  }
}

// ── Add ─────────────────────────────────────────────────────────────────────

/** How to undo an add: remove the new list, or put back the mode a list already had. */
export type AddUndo = { remove: true } | { mode: ListMode }

async function undoAdd(qc: QueryClient, list: ListStatus, undo: AddUndo): Promise<void> {
  try {
    if ('mode' in undo) await api.setListMode(list.id, undo.mode)
    else await api.removeList(list.id)
    toast.success(
      `Undone: ${list.name} ${'mode' in undo ? `is back to ${MODE_WORDS[undo.mode]}` : 'removed'}`,
    )
  } catch (err) {
    toastError(`Couldn't undo adding ${list.name}`, err)
  } finally {
    refresh(qc)
  }
}

/**
 * Subscribe (or turn a starter list back on). The server downloads the list before answering; a
 * failed download is in `lastError`, shown on the row, not thrown. Errors that are thrown (bad
 * input) are the caller's to show next to the form.
 */
export async function addListWithUndo(
  qc: QueryClient,
  input: AddListInput,
  undo: AddUndo = { remove: true },
): Promise<ListStatus> {
  const list = await api.addList(input)
  refresh(qc)
  const action = {
    label: 'Undo',
    onClick: () => void undoAdd(qc, list, undo),
  }
  if (list.lastError) {
    toast.warning(`Added ${list.name}, but the download failed`, {
      description: `${withStop(list.lastError.message)} The list's row says what to do.`,
      duration: UNDO_TOAST_MS,
      action,
    })
  } else {
    const rules = `${formatCount(list.ruleCount)} ${list.ruleCount === 1 ? 'rule' : 'rules'}`
    toast.success(`Added ${list.name}`, {
      description: `${MODE_WORDS[list.mode]} · ${rules}. ${MODE_HINTS[list.mode]}`,
      duration: UNDO_TOAST_MS,
      action,
    })
  }
  return list
}

// ── Remove ──────────────────────────────────────────────────────────────────

/**
 * Removals waiting for their Undo window to close. An import's file is deleted with it, so its
 * removal is only sent when the toast closes; a page that is closing sends what is pending.
 */
const pendingRemovals = new Map<string, (keepalive?: boolean) => void>()
let flushOnHide = false

function flushPendingRemovals(keepalive = false): void {
  for (const commit of [...pendingRemovals.values()]) commit(keepalive)
}

async function resubscribe(qc: QueryClient, input: AddListInput, name: string): Promise<void> {
  const id = toast.loading(`Subscribing to ${name} again…`, {
    description: 'Downloading it from its address.',
  })
  try {
    const list = await api.addList(input)
    if (list.lastError) {
      toast.warning(`Restored ${name}, but the download failed`, {
        id,
        description: `${withStop(list.lastError.message)} The list's row says what to do.`,
      })
    } else {
      toast.success(`Restored ${name}`, { id, description: `${formatCount(list.ruleCount)} rules.` })
    }
  } catch (err) {
    toastError(`Couldn't restore ${name}`, err, id)
  } finally {
    refresh(qc)
  }
}

/** Remove a subscription or an import, with Undo. Built-in and starter lists are turned off instead. */
export async function removeListWithUndo(qc: QueryClient, list: ListStatus): Promise<void> {
  if (list.source === 'local') {
    removeImportWithUndo(qc, list)
    return
  }
  let removed: ListStatus
  try {
    removed = await api.removeList(list.id)
  } catch (err) {
    toastError(`Couldn't remove ${list.name}`, err)
    return
  } finally {
    refresh(qc)
  }
  const input = resubscribeInput(removed)
  const opts: ExternalToast = { duration: UNDO_TOAST_MS }
  if (input) {
    opts.description = 'Undo subscribes again and downloads it.'
    opts.action = { label: 'Undo', onClick: () => void resubscribe(qc, input, list.name) }
  }
  toast.success(`Removed ${list.name}`, opts)
}

function removeImportWithUndo(qc: QueryClient, list: ListStatus): void {
  if (pendingRemovals.has(list.id)) return
  if (!flushOnHide && typeof window !== 'undefined') {
    flushOnHide = true
    window.addEventListener('pagehide', () => flushPendingRemovals(true))
  }
  let settled = false
  const commit = (keepalive = false) => {
    if (settled) return
    settled = true
    pendingRemovals.delete(list.id)
    void (async () => {
      try {
        await api.removeList(list.id, { keepalive })
      } catch (err) {
        toastError(`Couldn't remove ${list.name}`, err)
      } finally {
        // Unhide only once the refetched lists no longer have it (or have it back after a failure).
        await qc.invalidateQueries({ queryKey: keys.lists })
        toggle('removing', list.id, false)
        void qc.invalidateQueries({ queryKey: keys.doctor })
      }
    })()
  }
  pendingRemovals.set(list.id, commit)
  toggle('removing', list.id, true)
  toast.success(`Removed ${list.name}`, {
    description: 'Its imported file is deleted when this message closes.',
    duration: UNDO_TOAST_MS,
    onAutoClose: () => commit(),
    onDismiss: () => commit(),
    action: {
      label: 'Undo',
      onClick: () => {
        if (settled) return
        settled = true
        pendingRemovals.delete(list.id)
        toggle('removing', list.id, false)
        toast.success(`Kept ${list.name}`)
      },
    },
  })
}

/** Send every removal still waiting for its Undo window (tests; a page leaving). */
export function commitPendingRemovals(): void {
  flushPendingRemovals()
}
