// SPDX-License-Identifier: Apache-2.0
/**
 * Settings (§8.3 v1). Each change posts one `SettingsPatch` and shows the view the server sends
 * back. Paths pinned by an environment variable are read-only. Theme is per browser.
 */
import { Switch } from '@base-ui/react/switch'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, RotateCw } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../../components/ui/Button.tsx'
import { Card, PageHeader } from '../../components/ui/Card.tsx'
import { FieldError, Hint, inputClass, Label, LockedNote } from '../../components/ui/Field.tsx'
import { Skeleton } from '../../components/ui/Skeleton.tsx'
import { api, messageOf } from '../../lib/api.ts'
import type { SearchMode, SettingsPatch, SettingsView } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { searchModeLabel } from '../../lib/labels.ts'
import { toastError } from '../../lib/notify.ts'
import { keys, useSettings } from '../../lib/queries.ts'
import { setTheme, THEME_LABELS, THEMES, type ThemePreference, useTheme } from '../../lib/theme.ts'
import { usePageTitle } from '../../lib/usePageTitle.ts'

type Save = (patch: SettingsPatch, done: string) => Promise<string | null>

function isLocked(view: SettingsView, path: string): boolean {
  return view.locked.some((p) => p === path || path.startsWith(`${p}.`))
}

interface Option<T extends string> {
  value: T
  label: string
  hint: string
}

/** A radio group of cards: one line of explanation per choice. */
function Choice<T extends string>({
  legend,
  name,
  value,
  options,
  locked,
  onChange,
}: {
  legend: string
  name: string
  value: T
  options: readonly Option<T>[]
  locked: boolean
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <fieldset disabled={locked} aria-describedby={locked ? `${id}-locked` : undefined}>
      <legend className="mb-2 text-[13px] font-medium text-fg">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.value}
            className={cx(
              'flex cursor-pointer gap-2.5 rounded-md border border-border bg-surface p-3 transition-colors',
              'hover:border-border-strong has-checked:border-fg has-checked:bg-surface-2 has-disabled:cursor-not-allowed has-disabled:opacity-70',
              'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
            )}
          >
            <input
              type="radio"
              name={`${id}-${name}`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-0.5 size-3.5 shrink-0 accent-fg outline-none"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-fg">{option.label}</span>
              <span className="mt-0.5 block text-xs text-fg-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {locked ? <LockedNote id={`${id}-locked`} /> : null}
    </fieldset>
  )
}

/** A whole-number setting, saved on blur or Enter. */
function NumberSetting({
  label,
  hint,
  path,
  value,
  min,
  max,
  unit,
  locked,
  save,
}: {
  label: string
  hint: string
  path: Extract<SettingsPatch, { value: number }>['path']
  value: number
  min: number
  max: number
  unit?: string
  locked: boolean
  save: Save
}) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = draft ?? String(value)

  const commit = async () => {
    if (draft === null) return
    const n = Number(draft.trim())
    if (draft.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
      setError(`Enter a whole number from ${min} to ${max}.`)
      return
    }
    if (n === value) {
      setDraft(null)
      setError(null)
      return
    }
    const problem = await save({ path, value: n } as SettingsPatch, `${label}: ${n}${unit ? ` ${unit}` : ''}`)
    setError(problem)
    if (problem === null) setDraft(null)
  }

  const describedBy = error ? `${id}-error` : locked ? `${id}-locked` : `${id}-hint`
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={shown}
          readOnly={locked}
          disabled={locked}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit()
            if (event.key === 'Escape') {
              setDraft(null)
              setError(null)
            }
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(inputClass, 'tabular w-28 font-mono')}
        />
        {unit ? <span className="text-xs text-fg-muted">{unit}</span> : null}
      </div>
      {error ? (
        <FieldError id={`${id}-error`} message={error} />
      ) : locked ? (
        <LockedNote id={`${id}-locked`} />
      ) : (
        <Hint id={`${id}-hint`}>{hint}</Hint>
      )}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  locked,
  onChange,
}: {
  label: string
  hint: ReactNode
  checked: boolean
  locked: boolean
  onChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <span id={`${id}-label`} className="text-[13px] font-medium text-fg">
          {label}
        </span>
        <div id={`${id}-hint`} className="mt-0.5 text-xs text-fg-muted">
          {hint}
        </div>
        {locked ? <LockedNote id={`${id}-locked`} /> : null}
      </div>
      <Switch.Root
        checked={checked}
        disabled={locked}
        onCheckedChange={(next) => onChange(next)}
        aria-labelledby={`${id}-label`}
        aria-describedby={locked ? `${id}-hint ${id}-locked` : `${id}-hint`}
        className={cx(
          'mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong bg-surface-3 p-0.5 transition-colors',
          'data-checked:border-fg data-checked:bg-fg data-disabled:cursor-not-allowed data-disabled:opacity-60',
        )}
      >
        <Switch.Thumb className="size-3.5 rounded-full bg-surface shadow transition-transform data-checked:translate-x-4 rtl:data-checked:-translate-x-4" />
      </Switch.Root>
    </div>
  )
}

const MODE_OPTIONS: readonly Option<SearchMode>[] = [
  {
    value: 'auto',
    label: 'Auto',
    hint: "Engines when one is healthy; otherwise Claude's own WebSearch, filtered by your rules.",
  },
  {
    value: 'builtin',
    label: 'Built-in',
    hint: "Always Claude's own WebSearch, with your blocks added and the results filtered again.",
  },
  {
    value: 'engines',
    label: 'Engines',
    hint: "Always search-hole's engines; built-in search runs only if every engine fails.",
  },
]

type HygieneMode = SettingsView['queryHygiene']['mode']

const SECRET_OPTIONS: readonly Option<HygieneMode>[] = [
  { value: 'block', label: 'Block', hint: 'Refuse the search and say why. The secret is never echoed.' },
  { value: 'redact', label: 'Redact', hint: 'Replace the secret with [redacted], then search.' },
  { value: 'off', label: 'Off', hint: 'Send queries as written. Turns off the address check too.' },
]

const ADDRESS_OPTIONS: readonly Option<HygieneMode>[] = [
  { value: 'block', label: 'Block', hint: 'Refuse searches that name internal hosts or private IPs.' },
  { value: 'redact', label: 'Cut out', hint: 'Remove them from the query, then search.' },
  { value: 'off', label: 'Off', hint: 'Send them as written.' },
]

const THEME_HINTS: Record<ThemePreference, string> = {
  system: 'Follow your operating system.',
  light: 'Always light.',
  dark: 'Always dark.',
}

function SettingsForm({ view }: { view: SettingsView }) {
  const queryClient = useQueryClient()
  const theme = useTheme()

  const save: Save = async (patch, done) => {
    try {
      const next = await api.patchSettings(patch)
      queryClient.setQueryData(keys.settings, next)
      void queryClient.invalidateQueries({ queryKey: keys.overview })
      toast.success('Saved', { description: done })
      return null
    } catch (err) {
      toastError("Couldn't save the setting", err)
      return messageOf(err)
    }
  }

  return (
    <div className="space-y-5">
      <Card
        id="mode"
        title="Search mode"
        description={`Which search Claude Code uses. Right now: ${searchModeLabel(view.mode.effective)}.`}
      >
        <div className="p-4">
          <Choice
            legend="Mode"
            name="mode"
            value={view.mode.configured}
            options={MODE_OPTIONS}
            locked={isLocked(view, 'mode')}
            onChange={(value) => void save({ path: 'mode', value }, `Search mode: ${searchModeLabel(value)}`)}
          />
        </div>
      </Card>

      <Card
        id="hygiene"
        title="Query hygiene"
        description="Queries are checked before they reach any engine, and before they are logged."
      >
        <div className="space-y-5 p-4">
          <Choice
            legend="Secrets (API keys, tokens, private keys, connection strings)"
            name="secrets"
            value={view.queryHygiene.mode}
            options={SECRET_OPTIONS}
            locked={isLocked(view, 'queryHygiene.mode')}
            onChange={(value) => void save({ path: 'queryHygiene.mode', value }, `Secrets: ${value}`)}
          />
          <Choice
            legend="Private addresses (internal hostnames, private and link-local IPs)"
            name="addresses"
            value={view.queryHygiene.hosts}
            options={ADDRESS_OPTIONS}
            locked={isLocked(view, 'queryHygiene.hosts')}
            onChange={(value) =>
              void save({ path: 'queryHygiene.hosts', value }, `Private addresses: ${value}`)
            }
          />
        </div>
      </Card>

      <Card
        id="limits"
        title="Loop limits"
        description="Stop a model that searches in circles. 0 turns a limit off."
      >
        <div className="grid gap-5 p-4 sm:grid-cols-3">
          <NumberSetting
            label="Searches per turn"
            hint="Claude Code only; resets with your next prompt. Default 40."
            path="limits.searchesPerTurn"
            value={view.limits.searchesPerTurn}
            min={0}
            max={100_000}
            locked={isLocked(view, 'limits.searchesPerTurn')}
            save={save}
          />
          <NumberSetting
            label="Searches per hour"
            hint="Per session, over a sliding hour. Default 120."
            path="limits.searchesPerHour"
            value={view.limits.searchesPerHour}
            min={0}
            max={100_000}
            locked={isLocked(view, 'limits.searchesPerHour')}
            save={save}
          />
          <NumberSetting
            label="Same search again"
            hint="Refused on this repeat within 10 minutes. Default 3; 1 is not allowed."
            path="limits.repeatQuery"
            value={view.limits.repeatQuery}
            min={0}
            max={1000}
            locked={isLocked(view, 'limits.repeatQuery')}
            save={save}
          />
        </div>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card id="retention" title="History" description="What stays on this machine, and for how long.">
          <div className="space-y-5 p-4">
            <NumberSetting
              label="Keep searches for"
              hint="Searches, results and receipts older than this are deleted. Default 90."
              path="retention.days"
              value={view.retention.days}
              min={1}
              max={3650}
              unit="days"
              locked={isLocked(view, 'retention.days')}
              save={save}
            />
            <Toggle
              label="Receipt line"
              hint={
                <>
                  After a turn that searched, Claude Code shows a line such as{' '}
                  <span className="font-mono">search-hole · 2 searches · 18 results · 3 hidden</span>.
                </>
              }
              checked={view.hooks.receiptLine}
              locked={isLocked(view, 'hooks.receiptLine')}
              onChange={(value) =>
                void save({ path: 'hooks.receiptLine', value }, `Receipt line ${value ? 'on' : 'off'}`)
              }
            />
          </div>
        </Card>

        <Card id="appearance" title="Appearance" description="Stored in this browser only.">
          <div className="p-4">
            <Choice
              legend="Theme"
              name="theme"
              value={theme}
              options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t], hint: THEME_HINTS[t] }))}
              locked={false}
              onChange={setTheme}
            />
          </div>
        </Card>
      </div>

      <Card
        id="lists"
        title="Lists"
        description="Starter lists and your subscriptions, refreshed from their addresses."
      >
        <div className="p-4">
          <Toggle
            label="Update lists in the background"
            hint={
              <>
                After a search, lists that are due are downloaded again, each on its own schedule. Off keeps
                search-hole from downloading lists; <span className="font-medium">Update all</span> on the
                Lists page still works.
              </>
            }
            checked={view.lists?.autoUpdate ?? true}
            locked={isLocked(view, 'lists.autoUpdate')}
            onChange={(value) =>
              void save(
                { path: 'lists.autoUpdate', value },
                `Background list updates ${value ? 'on' : 'off'}`,
              )
            }
          />
        </div>
      </Card>

      <Card id="files" title="Files" description="Everything else is edited in settings.yaml.">
        <dl className="grid gap-x-6 gap-y-2 p-4 text-xs sm:grid-cols-2">
          {(
            [
              ['Config', view.paths.config],
              ['Data', view.paths.data],
            ] as const
          ).map(([name, path]) => (
            <div key={name} className="min-w-0">
              <dt className="text-fg-muted">{name}</dt>
              <dd className="mt-0.5 truncate font-mono text-fg" title={path}>
                {path}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}

export function SettingsPage() {
  usePageTitle('Settings')
  const settings = useSettings()
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-5 md:px-6">
      <PageHeader title="Settings" description="Changes apply to every client from its next search." />
      {settings.isPending ? (
        <div className="space-y-4" aria-busy="true">
          <span className="sr-only">Loading settings…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      ) : settings.isError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-danger-line bg-danger-soft p-4 text-[13px] text-danger"
        >
          <span className="flex items-center gap-2">
            <CircleAlert aria-hidden="true" className="size-4" />
            Couldn't load the settings: {messageOf(settings.error)}
          </span>
          <Button size="sm" onClick={() => void settings.refetch()}>
            <RotateCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : (
        <SettingsForm view={settings.data} />
      )}
    </div>
  )
}
