// SPDX-License-Identifier: Apache-2.0
/** ⌘K / Ctrl+K: navigation, theme and the common actions, on cmdk inside a Base UI dialog. */
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Command } from 'cmdk'
import {
  Check,
  CloudDownload,
  EyeOff,
  Keyboard,
  Library,
  ListChecks,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Sun,
} from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { probeEngines } from '../lib/ruleActions.ts'
import { setTheme, THEME_LABELS, type ThemePreference, useTheme } from '../lib/theme.ts'
import { PAGES } from './navigation.ts'
import { AppDialog } from './ui/Dialog.tsx'
import { Keys } from './ui/Kbd.tsx'

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const

const itemClass =
  'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg select-none data-[selected=true]:bg-surface-3 data-[disabled=true]:opacity-50'

function Item({
  onSelect,
  children,
  keywords,
  value,
}: {
  onSelect: () => void
  children: ReactNode
  keywords?: string[]
  value: string
}) {
  return (
    <Command.Item value={value} keywords={keywords ?? []} onSelect={onSelect} className={itemClass}>
      {children}
    </Command.Item>
  )
}

const groupClass =
  'px-1.5 pb-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-muted [&_[cmdk-group-heading]]:uppercase'

export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onShowShortcuts: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const theme = useTheme()
  const inputRef = useRef<HTMLInputElement>(null)

  const run = (action: () => void) => {
    onOpenChange(false)
    action()
  }

  return (
    <AppDialog open={open} onOpenChange={onOpenChange} title="Command menu" hideTitle initialFocus={inputRef}>
      <Command label="Command menu" loop className="flex min-h-0 flex-col">
        <div className="border-b border-border px-3">
          <Command.Input
            ref={inputRef}
            placeholder="Go to a page or run a command…"
            className="h-12 w-full bg-transparent text-sm text-fg outline-none"
          />
        </div>
        <Command.List className="max-h-[min(24rem,60dvh)] overflow-y-auto py-1">
          <Command.Empty className="px-4 py-6 text-center text-sm text-fg-muted">
            No matching command.
          </Command.Empty>
          <Command.Group heading="Go to" className={groupClass}>
            {PAGES.map((page) => (
              <Item
                key={page.to}
                value={`go ${page.label}`}
                onSelect={() => run(() => void navigate({ to: page.to }))}
              >
                <page.icon aria-hidden="true" className="size-4 text-fg-muted" />
                <span className="flex-1">{page.label}</span>
                <Keys keys={['G', page.key]} />
              </Item>
            ))}
            <Item
              value="go lists"
              keywords={['subscriptions', 'blocklists', 'filters', 'audit']}
              onSelect={() => run(() => void navigate({ to: '/rules/lists' }))}
            >
              <ListChecks aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Lists</span>
            </Item>
          </Command.Group>
          <Command.Group heading="Actions" className={groupClass}>
            <Item
              value="add rule"
              keywords={['block', 'allow', 'pin', 'raise', 'lower', 'new']}
              onSelect={() => run(() => void navigate({ to: '/rules', hash: 'add-rule' }))}
            >
              <Plus aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Add rule…</span>
            </Item>
            <Item
              value="check engines"
              keywords={['probe', 'health', 'status']}
              onSelect={() => run(() => void probeEngines(queryClient))}
            >
              <RefreshCw aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Check engines</span>
            </Item>
            <Item
              value="update all lists"
              keywords={['refresh', 'download', 'subscriptions', 'blocklists']}
              onSelect={() =>
                // Loaded on demand: the list actions ship with the Lists view, not the initial bundle.
                run(() => void import('../lib/listActions.ts').then((m) => m.updateAllLists(queryClient)))
              }
            >
              <CloudDownload aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Update all lists</span>
            </Item>
            <Item
              value="browse list catalog"
              keywords={['add list', 'subscribe', 'blocklists', 'catalogue']}
              onSelect={() => run(() => void navigate({ to: '/rules/lists', search: { catalog: true } }))}
            >
              <Library aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Browse list catalog</span>
            </Item>
            <Item
              value="searches that hid results"
              keywords={['filter', 'hidden', 'log']}
              onSelect={() => run(() => void navigate({ to: '/', search: { hidden: true } }))}
            >
              <EyeOff aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Show searches that hid results</span>
            </Item>
            <Item
              value="keyboard shortcuts"
              keywords={['help', 'keys', 'cheat sheet']}
              onSelect={() => run(onShowShortcuts)}
            >
              <Keyboard aria-hidden="true" className="size-4 text-fg-muted" />
              <span className="flex-1">Keyboard shortcuts</span>
              <Keys keys={['?']} />
            </Item>
          </Command.Group>
          <Command.Group heading="Theme" className={groupClass}>
            {(Object.keys(THEME_LABELS) as ThemePreference[]).map((t) => {
              const Icon = THEME_ICONS[t]
              return (
                <Item
                  key={t}
                  value={`theme ${t}`}
                  keywords={['appearance', 'colour', 'color']}
                  onSelect={() => run(() => setTheme(t))}
                >
                  <Icon aria-hidden="true" className="size-4 text-fg-muted" />
                  <span className="flex-1">Theme: {THEME_LABELS[t]}</span>
                  {theme === t ? (
                    <>
                      <Check aria-hidden="true" className="size-4 text-fg-muted" />
                      <span className="sr-only">(current)</span>
                    </>
                  ) : null}
                </Item>
              )
            })}
          </Command.Group>
        </Command.List>
      </Command>
    </AppDialog>
  )
}
