// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'

/** A titled section of a page. The heading level is h2 (pages own the h1). */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cx('rounded-lg border border-border bg-surface', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-semibold text-fg">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div>{children}</div>
    </section>
  )
}

/** A page heading with an optional line of explanation and actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
