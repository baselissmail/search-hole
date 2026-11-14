// SPDX-License-Identifier: Apache-2.0
/**
 * Rule changes from the dashboard: every one is a user action with an Undo toast instead of a
 * confirm dialog (MASTER_PLAN §8.4 point 2).
 */
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from './api.ts'
import type { AddRuleInput, EngineStatus, RuleListing } from './contract.ts'
import { toastError } from './notify.ts'
import { keys } from './queries.ts'

/** The single-key verbs on a selected result. */
export type QuickVerb = 'block' | 'allow' | 'pin' | 'raise' | 'lower'

export const VERB_BY_KEY: Readonly<Record<string, QuickVerb>> = {
  b: 'block',
  a: 'allow',
  p: 'pin',
  r: 'raise',
  l: 'lower',
}

export const VERBS: readonly QuickVerb[] = ['block', 'allow', 'pin', 'raise', 'lower']

const DONE: Record<QuickVerb, string> = {
  block: 'Blocked',
  allow: 'Allowed',
  pin: 'Pinned',
  raise: 'Raised',
  lower: 'Lowered',
}

export const VERB_HINT: Record<QuickVerb, string> = {
  block: 'Hide this site from results',
  allow: 'Always show this site, even if a list blocks it',
  pin: "Put this site's results first",
  raise: 'Move this site up',
  lower: 'Move this site down',
}

const UNDO_TOAST_MS = 8000

function scopeWord(rule: RuleListing): string {
  return rule.scope === 'global' ? 'Global rule' : rule.scope === 'project' ? 'Project rule' : 'Session rule'
}

function refreshRules(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: keys.rules })
  // A rule for a site takes it off the review list, and removing the rule puts it back.
  void qc.invalidateQueries({ queryKey: keys.review })
}

/** Remove rules the dashboard just created (the Undo of an add or an approval). */
export async function removeRules(
  qc: QueryClient,
  rules: readonly RuleListing[],
  what: string,
): Promise<void> {
  try {
    for (const rule of rules) await api.removeRule({ rule: rule.id, scope: rule.scope })
    toast.success(`Undone: ${what}`)
  } catch (err) {
    toastError("Couldn't undo", err)
  } finally {
    refreshRules(qc)
  }
}

/** The input that recreates a removed rule (the Undo of a remove). */
export function listingToInput(rule: RuleListing): AddRuleInput {
  const input: AddRuleInput = { match: rule.match, action: rule.action, scope: rule.scope }
  if (rule.action === 'raise' || rule.action === 'lower') input.weight = rule.weight
  if (rule.important) input.important = true
  if (rule.until) input.until = rule.until
  if (rule.note) input.note = rule.note
  const profile = rule.profiles?.[0]
  if (profile !== undefined && rule.profiles?.length === 1) input.profile = profile
  return input
}

export async function addRuleWithUndo(
  qc: QueryClient,
  input: AddRuleInput,
  title?: string,
): Promise<RuleListing> {
  const rule = await api.addRule(input)
  refreshRules(qc)
  const label = title ?? `${DONE[input.action as QuickVerb] ?? 'Added a rule for'} ${rule.match}`
  toast.success(label, {
    description: scopeWord(rule),
    duration: UNDO_TOAST_MS,
    action: { label: 'Undo', onClick: () => void removeRules(qc, [rule], label) },
  })
  return rule
}

/** A quick verb on a result's domain: `b` blocks it, `p` pins it… True when the rule was added. */
export async function applyVerb(qc: QueryClient, verb: QuickVerb, domain: string): Promise<boolean> {
  try {
    await addRuleWithUndo(qc, { match: domain, action: verb })
    return true
  } catch (err) {
    toastError(`Couldn't ${verb} ${domain}`, err)
    return false
  }
}

export async function removeRuleWithUndo(qc: QueryClient, rule: RuleListing): Promise<void> {
  let removed: RuleListing[]
  try {
    removed = await api.removeRule({ rule: rule.id, scope: rule.scope })
  } catch (err) {
    toastError(`Couldn't remove ${rule.match}`, err)
    return
  } finally {
    refreshRules(qc)
  }
  const label = `Removed ${rule.match}`
  toast.success(label, {
    description: removed.length > 1 ? `${removed.length} rules removed` : scopeWord(rule),
    duration: UNDO_TOAST_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        void (async () => {
          try {
            for (const r of removed) await api.addRule(listingToInput(r))
            toast.success(`Restored ${rule.match}`)
          } catch (err) {
            toastError(`Couldn't restore ${rule.match}`, err)
          } finally {
            refreshRules(qc)
          }
        })()
      },
    },
  })
}

/** "Check now": a bounded health probe of every engine (≤ 3 s on the server). */
export async function probeEngines(qc: QueryClient): Promise<EngineStatus[] | null> {
  try {
    const engines = await api.probeEngines()
    qc.setQueryData(keys.engines, engines)
    void qc.invalidateQueries({ queryKey: keys.doctor })
    void qc.invalidateQueries({ queryKey: keys.overview })
    const healthy = engines.filter((e) => e.health === 'healthy').length
    const configured = engines.filter((e) => e.configured).length
    toast.success('Engines checked', {
      description: `${healthy} of ${configured} configured engines healthy`,
    })
    return engines
  } catch (err) {
    toastError("Couldn't check the engines", err)
    return null
  }
}
