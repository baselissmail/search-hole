// SPDX-License-Identifier: Apache-2.0
/**
 * A list's mode as three toggle buttons: Enforce, Audit, Off. Arrow keys move between them, Enter
 * or Space applies one at once (with Undo). The mode is state, so it is colour plus icon plus word.
 */
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { CircleOff, Eye, type LucideIcon, ShieldCheck } from 'lucide-react'
import { Chip, type Tone } from '../../components/ui/Chip.tsx'
import type { ListMode } from '../../lib/contract.ts'
import { cx } from '../../lib/cx.ts'
import { LIST_MODES, MODE_HINTS, MODE_WORDS } from '../../lib/lists.ts'

export const MODE_ICONS: Record<ListMode, LucideIcon> = {
  enforce: ShieldCheck,
  audit: Eye,
  disabled: CircleOff,
}

const MODE_TONES: Record<ListMode, Tone> = { enforce: 'ok', audit: 'info', disabled: 'neutral' }

const PRESSED: Record<ListMode, string> = {
  enforce: 'data-pressed:border-ok-line data-pressed:bg-ok-soft data-pressed:text-ok',
  audit: 'data-pressed:border-info-line data-pressed:bg-info-soft data-pressed:text-info',
  disabled: 'data-pressed:border-border-strong data-pressed:bg-surface data-pressed:text-fg',
}

export function ModeChip({ mode }: { mode: ListMode }) {
  return (
    <Chip tone={MODE_TONES[mode] ?? 'neutral'} icon={MODE_ICONS[mode] ?? CircleOff}>
      {MODE_WORDS[mode] ?? mode}
    </Chip>
  )
}

export function ModeControl({
  mode,
  label,
  onChange,
}: {
  mode: ListMode
  /** The group's accessible name, e.g. "Mode of rjaus-pinterest". */
  label: string
  onChange: (mode: ListMode) => void
}) {
  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(value) => {
        const next = value[0]
        if (next !== undefined && next !== mode) onChange(next)
      }}
      aria-label={label}
      className="inline-flex gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
    >
      {LIST_MODES.map((m) => {
        const Icon = MODE_ICONS[m]
        return (
          <Toggle
            key={m}
            value={m}
            title={MODE_HINTS[m]}
            className={cx(
              'inline-flex h-6 items-center gap-1 rounded border border-transparent px-2 text-xs font-medium whitespace-nowrap text-fg-muted transition-colors hover:text-fg',
              PRESSED[m],
            )}
          >
            <Icon aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.25} />
            {MODE_WORDS[m]}
          </Toggle>
        )
      })}
    </ToggleGroup>
  )
}
