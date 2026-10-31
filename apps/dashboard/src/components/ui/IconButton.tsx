// SPDX-License-Identifier: Apache-2.0
import { Tooltip } from '@base-ui/react/tooltip'
import type { LucideIcon } from 'lucide-react'
import type { MouseEvent } from 'react'
import { cx } from '../../lib/cx.ts'
import { Kbd } from './Kbd.tsx'

/** An icon-only button: the label is its accessible name and its tooltip; `shortcut` is shown. */
export function IconButton({
  icon: Icon,
  label,
  shortcut,
  onClick,
  tabIndex,
  disabled,
  className,
}: {
  icon: LucideIcon
  label: string
  shortcut?: string
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  tabIndex?: number
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        type="button"
        aria-label={label}
        aria-keyshortcuts={shortcut?.toLowerCase()}
        onClick={onClick}
        disabled={disabled}
        {...(tabIndex === undefined ? {} : { tabIndex })}
        className={cx(
          'inline-flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-50',
          className,
        )}
      >
        <Icon aria-hidden="true" className="size-3.5" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="flex items-center gap-2 rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-fg shadow-lg transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
            {label}
            {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
