// SPDX-License-Identifier: Apache-2.0
/**
 * Subscribe to a list by its address: HTTPS URL, optional name, format, kind, mode (Audit by
 * default, so a new list is trialled before it hides anything) and refresh interval. The server
 * downloads it before answering; its own validation messages show next to the field they name.
 */
import { useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Plus } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { Button } from '../../components/ui/Button.tsx'
import { Card } from '../../components/ui/Card.tsx'
import { FieldError, Hint, inputClass, Label, selectClass } from '../../components/ui/Field.tsx'
import { ApiFailure, messageOf } from '../../lib/api.ts'
import type { AddListInput, ListFormat, ListKind, ListMode } from '../../lib/contract.ts'
import { addListWithUndo } from '../../lib/listActions.ts'
import {
  checkListName,
  checkListUrl,
  DEFAULT_UPDATE,
  FORMAT_WORDS,
  KIND_HINTS,
  KIND_WORDS,
  LIST_FORMATS,
  LIST_KINDS,
  MODE_HINTS,
  MODE_WORDS,
  UPDATE_INTERVALS,
} from '../../lib/lists.ts'

type Field = 'url' | 'name' | 'form'
type Problem = { field: Field; message: string; fix?: string | undefined }

/** Which field a server message is about, so it is shown (and announced) next to it. */
function fieldOf(message: string): Field {
  if (/\bname\b|already exists/i.test(message)) return 'name'
  if (/url|https|address|catalog/i.test(message)) return 'url'
  return 'form'
}

const ADD_MODES: readonly ListMode[] = ['audit', 'enforce']

export function AddListForm() {
  const queryClient = useQueryClient()
  const id = useId()
  const urlRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ListFormat>('auto')
  const [kind, setKind] = useState<ListKind>('block')
  const [mode, setMode] = useState<ListMode>('audit')
  const [update, setUpdate] = useState(DEFAULT_UPDATE)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)

  const fail = (p: Problem) => {
    setProblem(p)
    if (p.field === 'name') nameRef.current?.focus()
    else urlRef.current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const urlProblem = checkListUrl(url)
    if (urlProblem) return fail({ field: 'url', ...urlProblem })
    const nameProblem = checkListName(name)
    if (nameProblem) return fail({ field: 'name', ...nameProblem })
    const input: AddListInput = { source: url.trim(), format, kind, mode, update }
    if (name.trim()) input.name = name.trim()
    setBusy(true)
    setProblem(null)
    try {
      await addListWithUndo(queryClient, input)
      setUrl('')
      setName('')
      urlRef.current?.focus()
    } catch (err) {
      const message = messageOf(err)
      const fix = err instanceof ApiFailure ? err.fix : undefined
      const client = err instanceof ApiFailure && err.status >= 400 && err.status < 500
      fail({ field: client ? fieldOf(message) : 'form', message, fix })
    } finally {
      setBusy(false)
    }
  }

  const error = (field: Field) => (problem?.field === field ? `${id}-${field}-error` : undefined)

  return (
    <Card
      id="add-list"
      title="Subscribe by address"
      description="Any list in a format search-hole reads. It is downloaded now and then on the schedule you pick, over HTTPS only; private and local addresses are refused."
    >
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-busy={busy || undefined}
        className="grid gap-x-4 gap-y-3 p-4 md:grid-cols-12"
      >
        <div className="md:col-span-7">
          <Label htmlFor={`${id}-url`}>Address</Label>
          <input
            ref={urlRef}
            id={`${id}-url`}
            name="url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.org/blocklist.txt"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error('url') ? true : undefined}
            aria-describedby={error('url') ?? `${id}-url-hint`}
            className={`${inputClass} font-mono`}
          />
          {error('url') && problem ? (
            <FieldError id={`${id}-url-error`} message={problem.message} fix={problem.fix} />
          ) : (
            <Hint id={`${id}-url-hint`}>The raw list file, starting with https://</Hint>
          )}
        </div>
        <div className="md:col-span-5">
          <Label htmlFor={`${id}-name`}>Name (optional)</Label>
          <input
            ref={nameRef}
            id={`${id}-name`}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="From the file name"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error('name') ? true : undefined}
            aria-describedby={error('name') ?? `${id}-name-hint`}
            className={`${inputClass} font-mono`}
          />
          {error('name') && problem ? (
            <FieldError id={`${id}-name-error`} message={problem.message} fix={problem.fix} />
          ) : (
            <Hint id={`${id}-name-hint`}>Lower-case letters, digits, “.”, “_” and “-”.</Hint>
          )}
        </div>
        <div className="md:col-span-3">
          <Label htmlFor={`${id}-kind`}>Kind</Label>
          <select
            id={`${id}-kind`}
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as ListKind)}
            aria-describedby={`${id}-kind-hint`}
            className={selectClass}
          >
            {LIST_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_WORDS[k]}
              </option>
            ))}
          </select>
          <Hint id={`${id}-kind-hint`}>{KIND_HINTS[kind]}</Hint>
        </div>
        <div className="md:col-span-3">
          <Label htmlFor={`${id}-format`}>Format</Label>
          <select
            id={`${id}-format`}
            name="format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ListFormat)}
            aria-describedby={`${id}-format-hint`}
            className={selectClass}
          >
            {LIST_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_WORDS[f]}
              </option>
            ))}
          </select>
          <Hint id={`${id}-format-hint`}>Unreadable lines are counted and skipped.</Hint>
        </div>
        <fieldset className="md:col-span-3">
          <legend className="mb-1 block text-xs font-medium text-fg">Mode</legend>
          <div className="flex h-8 items-center gap-3">
            {ADD_MODES.map((m) => (
              <label key={m} className="inline-flex items-center gap-1.5 text-[13px] text-fg">
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="size-3.5 accent-fg"
                />
                {MODE_WORDS[m]}
              </label>
            ))}
          </div>
          <Hint>{MODE_HINTS[mode]}</Hint>
        </fieldset>
        <div className="md:col-span-3">
          <Label htmlFor={`${id}-update`}>Check for updates</Label>
          <select
            id={`${id}-update`}
            name="update"
            value={update}
            onChange={(event) => setUpdate(event.target.value)}
            className={selectClass}
          >
            {UPDATE_INTERVALS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3 md:col-span-12">
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Plus aria-hidden="true" className="size-4" />
            )}
            {busy ? 'Downloading…' : 'Subscribe'}
          </Button>
          <p aria-live="polite" className="text-xs text-fg-muted">
            {busy ? 'Downloading the list from its address; this can take up to a minute.' : ''}
          </p>
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
