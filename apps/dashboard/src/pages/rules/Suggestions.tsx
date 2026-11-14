// SPDX-License-Identifier: Apache-2.0
/**
 * Rules Claude proposed with `suggest_rule`. Nothing applies until the user approves it
 * (Principle 3); approving can be undone like any other rule.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, Inbox, RotateCw, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ActionChip } from '../../components/status.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { EmptyState } from '../../components/ui/EmptyState.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { UrlText } from '../../components/ui/UrlText.tsx'
import { api, messageOf } from '../../lib/api.ts'
import type { SuggestionItem } from '../../lib/contract.ts'
import { formatDateTime } from '../../lib/format.ts'
import { toastError } from '../../lib/notify.ts'
import { keys, useSuggestions } from '../../lib/queries.ts'
import { removeRules } from '../../lib/ruleActions.ts'

const PENDING = new Set(['pending', 'queued'])

function Suggestion({
  item,
  busy,
  onDecide,
}: {
  item: SuggestionItem
  busy: boolean
  onDecide: (approve: boolean) => void
}) {
  const { input } = item
  const pending = PENDING.has(item.status)
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ActionChip action={input.action} {...(input.weight === undefined ? {} : { weight: input.weight })} />
        <span className="min-w-0 truncate font-mono text-[13px] text-fg" title={input.match}>
          {input.match}
        </span>
        {!pending ? <span className="text-xs text-fg-muted">· {item.status}</span> : null}
      </div>
      <p className="text-[13px] break-words text-fg">
        <span className="text-fg-muted">Claude's reason: </span>
        {input.reason}
      </p>
      {input.evidenceUrl ? <UrlText url={input.evidenceUrl} max={80} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fg-muted">
          <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
          {input.scope ? ` · ${input.scope}` : ''}
          {input.profile ? ` · profile ${input.profile}` : ''}
        </span>
        {pending ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onDecide(false)}
              aria-label={`Reject the suggestion for ${input.match}`}
            >
              <X aria-hidden="true" className="size-3.5" />
              Reject
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onDecide(true)}
              aria-label={`Approve the suggestion for ${input.match}`}
            >
              <Check aria-hidden="true" className="size-3.5" />
              Approve
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function Suggestions() {
  const queryClient = useQueryClient()
  const suggestions = useSuggestions()
  const [busyId, setBusyId] = useState<number | null>(null)
  const items = [...(suggestions.data ?? [])].sort(
    (a, b) => Number(PENDING.has(b.status)) - Number(PENDING.has(a.status)) || b.id - a.id,
  )
  const waiting = items.filter((s) => PENDING.has(s.status)).length

  const decide = async (item: SuggestionItem, approve: boolean) => {
    setBusyId(item.id)
    const what = `${item.input.action} ${item.input.match}`
    try {
      if (approve) {
        const rule = await api.approveSuggestion(item.id)
        const label = `Approved: ${what}`
        toast.success(label, {
          description: 'The rule applies from the next search.',
          duration: 8000,
          action: { label: 'Undo', onClick: () => void removeRules(queryClient, [rule], label) },
        })
        void queryClient.invalidateQueries({ queryKey: keys.rules })
        void queryClient.invalidateQueries({ queryKey: keys.review })
      } else {
        await api.rejectSuggestion(item.id)
        toast.success(`Rejected: ${what}`)
      }
    } catch (err) {
      toastError(`Couldn't ${approve ? 'approve' : 'reject'} the suggestion`, err)
    } finally {
      setBusyId(null)
      void queryClient.invalidateQueries({ queryKey: keys.suggestions })
    }
  }

  return (
    <Card
      id="suggestions"
      title="Suggestions"
      description={
        waiting > 0
          ? `${waiting} waiting for you. Claude can only suggest rules; you decide.`
          : 'Claude can only suggest rules; you decide.'
      }
    >
      {suggestions.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true">
          <span className="sr-only">Loading suggestions…</span>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : suggestions.isError ? (
        <div role="alert" className="flex items-center justify-between gap-3 p-4 text-[13px] text-danger">
          <span className="flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4" />
            {messageOf(suggestions.error)}
          </span>
          <Button size="sm" onClick={() => void suggestions.refetch()}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title="No suggestions">
          <p>When Claude proposes a rule with suggest_rule, it waits here until you approve or reject it.</p>
        </EmptyState>
      ) : (
        <ul aria-label="Suggested rules" className="divide-y divide-border">
          {items.map((item) => (
            <Suggestion
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onDecide={(approve) => void decide(item, approve)}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}
