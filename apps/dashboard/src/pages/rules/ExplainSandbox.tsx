// SPDX-License-Identifier: Apache-2.0
/** "Test a URL": what the rules would do with it, and every rule that matched. */
import { useMutation } from '@tanstack/react-query'
import { CircleCheck, CircleHelp, EyeOff, FlaskConical, type LucideIcon, Pin } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { Chip, type Tone } from '../../components/ui/Chip.tsx'
import { FieldError, Hint, inputClass, Label } from '../../components/ui/Field.tsx'
import { ApiFailure, api, messageOf } from '../../lib/api.ts'

/** The decision is free text from the server; known words get a state chip. */
function decisionTone(decision: string): { tone: Tone; icon: LucideIcon } {
  const d = decision.toLowerCase()
  if (/\b(hidden|hide|blocked|block)\b/.test(d)) return { tone: 'danger', icon: EyeOff }
  if (/\bpinned?\b/.test(d)) return { tone: 'info', icon: Pin }
  if (/\b(kept|keep|shown|allowed|allow)\b/.test(d)) return { tone: 'ok', icon: CircleCheck }
  return { tone: 'neutral', icon: CircleHelp }
}

export function ExplainSandbox() {
  const id = useId()
  const [url, setUrl] = useState('')
  const [empty, setEmpty] = useState(false)
  const explain = useMutation({ mutationFn: (value: string) => api.explain({ url: value }) })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = url.trim()
    setEmpty(value === '')
    if (value) explain.mutate(value)
  }

  const errorId = `${id}-error`
  const hasError = empty || explain.isError
  const result = explain.data
  const tone = result ? decisionTone(result.decision) : null

  return (
    <Card
      id="explain"
      title="Test a URL"
      description="See what your rules and lists would do with a URL, and why."
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${id}-url`}>URL</Label>
          <input
            id={`${id}-url`}
            name="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.example.com/some/page"
            aria-invalid={hasError ? true : undefined}
            aria-describedby={hasError ? errorId : `${id}-hint`}
            className={`${inputClass} font-mono`}
          />
          {empty ? (
            <FieldError id={errorId} message="Enter a URL to test." />
          ) : explain.isError ? (
            <FieldError
              id={errorId}
              message={messageOf(explain.error)}
              fix={explain.error instanceof ApiFailure ? explain.error.fix : undefined}
            />
          ) : (
            <Hint id={`${id}-hint`}>Nothing is fetched; only the rules are checked.</Hint>
          )}
        </div>
        <Button type="submit" className="sm:mt-5" disabled={explain.isPending} aria-busy={explain.isPending}>
          <FlaskConical aria-hidden="true" className="size-4" />
          {explain.isPending ? 'Checking…' : 'Explain'}
        </Button>
      </form>
      <div aria-live="polite" className="px-4 pb-4 empty:hidden">
        {result && tone ? (
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={tone.tone} icon={tone.icon}>
                {result.decision}
              </Chip>
              <span className="min-w-0 truncate font-mono text-xs text-fg-muted" title={explain.variables}>
                {explain.variables}
              </span>
            </div>
            {result.lines.length > 0 ? (
              <ol className="mt-2.5 space-y-1 border-t border-border pt-2.5">
                {result.lines.map((line, i) => (
                  <li key={i} className="font-mono text-xs break-words whitespace-pre-wrap text-fg">
                    {line}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
