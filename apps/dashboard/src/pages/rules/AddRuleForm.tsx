// SPDX-License-Identifier: Apache-2.0
/**
 * Add a rule: match, action, weight (raise/lower), optional end date and note. Rules added
 * here are global: one dashboard serves every project, so it has no current project.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { FieldError, Hint, inputClass, Label, selectClass } from '../../components/ui/Field.tsx'
import { ApiFailure, messageOf } from '../../lib/api.ts'
import type { AddRuleInput, RuleAction } from '../../lib/contract.ts'
import { RULE_ACTION_LABELS } from '../../lib/labels.ts'
import { addRuleWithUndo } from '../../lib/ruleActions.ts'

const ACTION_HINTS: Record<RuleAction, string> = {
  block: 'Hide this site from results.',
  allow: 'Always show it, even when a list blocks it.',
  pin: 'Put its results first.',
  raise: 'Move it up. Weight 1–10.',
  lower: 'Move it down. Weight 1–10.',
  normal: 'Cancel raises and lowers that lists apply to it.',
}

const ACTIONS: readonly RuleAction[] = ['block', 'allow', 'pin', 'raise', 'lower', 'normal']

type Problem = { field: 'match' | 'weight' | 'form'; message: string; fix?: string | undefined }

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function AddRuleForm() {
  const queryClient = useQueryClient()
  const id = useId()
  const matchRef = useRef<HTMLInputElement>(null)
  const [match, setMatch] = useState('')
  const [action, setAction] = useState<RuleAction>('block')
  const [weight, setWeight] = useState('3')
  const [until, setUntil] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const weighted = action === 'raise' || action === 'lower'

  // The command menu's "Add rule…" lands here with #add-rule.
  const hash = useLocation({ select: (location) => location.hash })
  useEffect(() => {
    if (hash === 'add-rule') matchRef.current?.focus()
  }, [hash])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = match.trim()
    if (!text) {
      setProblem({
        field: 'match',
        message: 'Enter what the rule matches.',
        fix: 'A domain (example.com), a host and path (example.com/blog), a URL pattern with *, or a /regex/.',
      })
      matchRef.current?.focus()
      return
    }
    const w = Number(weight)
    if (weighted && !(Number.isInteger(w) && w >= 1 && w <= 10)) {
      setProblem({ field: 'weight', message: 'The weight is a whole number from 1 to 10.' })
      return
    }
    const input: AddRuleInput = { match: text, action, scope: 'global' }
    if (weighted) input.weight = w
    if (until) input.until = until
    if (note.trim()) input.note = note.trim()
    setBusy(true)
    setProblem(null)
    try {
      await addRuleWithUndo(queryClient, input, `Added: ${RULE_ACTION_LABELS[action].toLowerCase()} ${text}`)
      setMatch('')
      setUntil('')
      setNote('')
      matchRef.current?.focus()
    } catch (err) {
      setProblem({
        field: err instanceof ApiFailure && err.status >= 400 && err.status < 500 ? 'match' : 'form',
        message: messageOf(err),
        fix: err instanceof ApiFailure ? err.fix : undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  const matchError = problem?.field === 'match' ? `${id}-match-error` : undefined
  const weightError = problem?.field === 'weight' ? `${id}-weight-error` : undefined

  return (
    <Card
      id="add-rule"
      title="Add a rule"
      description="Rules you add here apply to every project, from the next search. Your rules always beat lists."
    >
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        className="grid gap-x-4 gap-y-3 p-4 md:grid-cols-12"
      >
        <div className="md:col-span-7">
          <Label htmlFor={`${id}-match`}>Match</Label>
          <input
            ref={matchRef}
            id={`${id}-match`}
            name="match"
            value={match}
            onChange={(event) => setMatch(event.target.value)}
            placeholder="example.com"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={matchError ? true : undefined}
            aria-describedby={matchError ?? `${id}-match-hint`}
            className={`${inputClass} font-mono`}
          />
          {matchError && problem ? (
            <FieldError id={matchError} message={problem.message} fix={problem.fix} />
          ) : (
            <Hint id={`${id}-match-hint`}>A domain, host/path, URL pattern with *, or /regex/.</Hint>
          )}
        </div>
        <div className="md:col-span-3">
          <Label htmlFor={`${id}-action`}>Action</Label>
          <select
            id={`${id}-action`}
            name="action"
            value={action}
            onChange={(event) => setAction(event.target.value as RuleAction)}
            aria-describedby={`${id}-action-hint`}
            className={selectClass}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {RULE_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
          <Hint id={`${id}-action-hint`}>{ACTION_HINTS[action]}</Hint>
        </div>
        <div className="md:col-span-2">
          <Label htmlFor={`${id}-weight`}>Weight</Label>
          <input
            id={`${id}-weight`}
            name="weight"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            step={1}
            value={weight}
            disabled={!weighted}
            onChange={(event) => setWeight(event.target.value)}
            aria-invalid={weightError ? true : undefined}
            aria-describedby={weightError ?? `${id}-weight-hint`}
            className={`${inputClass} tabular font-mono`}
          />
          {weightError && problem ? (
            <FieldError id={weightError} message={problem.message} />
          ) : (
            <Hint id={`${id}-weight-hint`}>
              {weighted ? '1 is a nudge, 10 a shove.' : 'Raise and lower only.'}
            </Hint>
          )}
        </div>
        <div className="md:col-span-3">
          <Label htmlFor={`${id}-until`}>Until (optional)</Label>
          <input
            id={`${id}-until`}
            name="until"
            type="date"
            min={today()}
            value={until}
            onChange={(event) => setUntil(event.target.value)}
            aria-describedby={`${id}-until-hint`}
            className={`${inputClass} tabular`}
          />
          <Hint id={`${id}-until-hint`}>The rule stops applying after this day.</Hint>
        </div>
        <div className="md:col-span-7">
          <Label htmlFor={`${id}-note`}>Note (optional)</Label>
          <input
            id={`${id}-note`}
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why this rule exists"
            maxLength={500}
            className={inputClass}
          />
        </div>
        <div className="flex items-start md:col-span-2 md:pt-5">
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy} className="w-full">
            <Plus aria-hidden="true" className="size-4" />
            {busy ? 'Adding…' : 'Add rule'}
          </Button>
        </div>
        {problem?.field === 'form' ? (
          <div className="md:col-span-12">
            <FieldError id={`${id}-form-error`} message={problem.message} fix={problem.fix} />
          </div>
        ) : null}
      </form>
    </Card>
  )
}
