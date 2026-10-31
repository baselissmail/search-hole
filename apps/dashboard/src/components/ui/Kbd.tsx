// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-2 px-1 font-mono text-[11px] font-medium text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** A key sequence such as `G` then `L`. */
export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key, i) => (
        <Kbd key={i}>{key}</Kbd>
      ))}
    </span>
  )
}
