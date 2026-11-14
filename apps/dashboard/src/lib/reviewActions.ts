// SPDX-License-Identifier: Apache-2.0
/**
 * Actions on the review list (ADR-0025). Blocking or lowering a site is an ordinary rule
 * (lib/ruleActions.ts). Keeping it ("this site is fine") is a dismissal the server stores; it
 * gets the same 8-second Undo toast, and the kept list can restore it later.
 */
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from './api.ts'
import type { ReviewList } from './contract.ts'
import { toastError } from './notify.ts'
import { keys } from './queries.ts'
import { applyVerb } from './ruleActions.ts'

const UNDO_TOAST_MS = 8000

export type ReviewAction = 'block' | 'lower' | 'keep'

function refreshReview(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: keys.review })
}

/** The list without one site, so its row goes at once; the refetch that follows confirms it. */
export function withoutSite(list: ReviewList, domain: string): ReviewList {
  const sites = list.sites.filter((s) => s.domain !== domain)
  if (sites.length === list.sites.length) return list
  return { ...list, sites, total: Math.max(sites.length, list.total - 1) }
}

/** List a kept site again: the Undo of Keep, and "Review again" in the kept list. */
export async function restoreSite(qc: QueryClient, domain: string): Promise<boolean> {
  try {
    await api.restoreReview(domain)
    toast.success(`${domain} can be listed for review again`)
    return true
  } catch (err) {
    toastError(`Couldn't restore ${domain}`, err)
    return false
  } finally {
    refreshReview(qc)
  }
}

/** "This site is fine": stop listing it, with Undo. */
export async function keepSiteWithUndo(qc: QueryClient, domain: string): Promise<boolean> {
  try {
    await api.dismissReview(domain)
  } catch (err) {
    toastError(`Couldn't keep ${domain}`, err)
    refreshReview(qc)
    return false
  }
  toast.success(`Kept ${domain}`, {
    description: "It won't be listed for review again.",
    duration: UNDO_TOAST_MS,
    action: { label: 'Undo', onClick: () => void restoreSite(qc, domain) },
  })
  return true
}

/**
 * One action on a listed site. On success its row is removed from the cached list right away
 * and the list is refetched. True when the action went through.
 */
export async function actOnSite(qc: QueryClient, action: ReviewAction, domain: string): Promise<boolean> {
  const ok = action === 'keep' ? await keepSiteWithUndo(qc, domain) : await applyVerb(qc, action, domain)
  if (ok) {
    qc.setQueryData<ReviewList>(keys.review, (list) => (list ? withoutSite(list, domain) : list))
    refreshReview(qc)
  }
  return ok
}
