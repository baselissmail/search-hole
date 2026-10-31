// SPDX-License-Identifier: Apache-2.0
/** The `?` cheat sheet. */
import { isApplePlatform } from '../lib/hotkeys.ts'
import { AppDialog } from './ui/Dialog.tsx'
import { Keys } from './ui/Kbd.tsx'

interface Shortcut {
  keys: string[][]
  label: string
}

function sections(mod: string): Array<{ title: string; items: Shortcut[] }> {
  return [
    {
      title: 'Anywhere',
      items: [
        { keys: [[mod, 'K']], label: 'Open the command menu' },
        { keys: [['?']], label: 'Show these shortcuts' },
        { keys: [['G', 'L']], label: 'Go to the live log' },
        { keys: [['G', 'R']], label: 'Go to rules & lists' },
        { keys: [['G', 'E']], label: 'Go to engines' },
        { keys: [['G', 'S']], label: 'Go to settings' },
      ],
    },
    {
      title: 'Live log',
      items: [
        { keys: [['J'], ['↓']], label: 'Next search or result' },
        { keys: [['K'], ['↑']], label: 'Previous search or result' },
        { keys: [['Enter'], ['→']], label: 'Show or hide the results of a search' },
        { keys: [['←'], ['Esc']], label: 'Back to the search; collapse it' },
        { keys: [['Home'], ['End']], label: 'First or last loaded search' },
      ],
    },
    {
      title: 'On a selected result',
      items: [
        { keys: [['B']], label: 'Block its site' },
        { keys: [['A']], label: 'Allow its site' },
        { keys: [['P']], label: 'Pin its site' },
        { keys: [['R']], label: 'Raise its site' },
        { keys: [['L']], label: 'Lower its site' },
      ],
    },
  ]
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const mod = isApplePlatform() ? '⌘' : 'Ctrl'
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Single keys never fire while you type in a field. Every rule change can be undone from its notification."
    >
      <div className="grid gap-5 overflow-y-auto px-4 pt-3 pb-5 sm:grid-cols-2">
        {sections(mod).map((section) => (
          <section key={section.title} aria-label={section.title} className="min-w-0">
            <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-fg-muted uppercase">
              {section.title}
            </h3>
            <dl className="divide-y divide-border">
              {section.items.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 py-1.5">
                  <dt className="text-[13px] text-fg">{item.label}</dt>
                  <dd className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                    {item.keys.map((combo, i) => (
                      <span key={combo.join('+')} className="inline-flex items-center gap-1.5">
                        {i > 0 ? <span>or</span> : null}
                        <Keys keys={combo} />
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </AppDialog>
  )
}
