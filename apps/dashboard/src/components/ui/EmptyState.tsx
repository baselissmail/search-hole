// SPDX-License-Identifier: Apache-2.0
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'

/** Empty states teach the next step (MASTER_PLAN §8.4 point 8). */
export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('flex flex-col items-center px-6 py-14 text-center', className)}>
      <span className="mb-4 flex size-10 items-center justify-center rounded-full border border-border bg-surface-2">
        <Icon aria-hidden="true" className="size-5 text-fg-muted" />
      </span>
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {children ? <div className="mt-1.5 max-w-md text-sm text-fg-muted">{children}</div> : null}
    </div>
  )
}
