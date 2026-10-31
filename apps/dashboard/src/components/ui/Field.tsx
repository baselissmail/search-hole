// SPDX-License-Identifier: Apache-2.0
import { CircleAlert, Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'

export const inputClass = cx(
  'h-8 w-full min-w-0 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] text-fg transition-colors',
  'hover:border-fg-subtle disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-muted',
  'aria-invalid:border-danger',
)

export const selectClass = cx(inputClass, 'pe-7')

export function Label({ htmlFor, children, id }: { htmlFor?: string; children: ReactNode; id?: string }) {
  return (
    <label htmlFor={htmlFor} id={id} className="mb-1 block text-xs font-medium text-fg">
      {children}
    </label>
  )
}

export function Hint({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={cx('mt-1 text-xs text-fg-muted', className)}>
      {children}
    </p>
  )
}

/** An inline validation message, announced when it appears. */
export function FieldError({ id, message, fix }: { id: string; message: string; fix?: string | undefined }) {
  return (
    <div id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
      <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>
        {message}
        {fix ? <span className="block text-fg-muted">{fix}</span> : null}
      </span>
    </div>
  )
}

/** Shown under a control that an environment variable pins (SettingsView.locked). */
export function LockedNote({ id }: { id: string }) {
  return (
    <p id={id} className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
      <Lock aria-hidden="true" className="size-3.5 shrink-0" />
      Set by an environment variable
    </p>
  )
}
