// SPDX-License-Identifier: Apache-2.0
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx.ts'

export type Tone = 'ok' | 'danger' | 'info' | 'warn' | 'neutral'

const TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok border-ok-line',
  danger: 'bg-danger-soft text-danger border-danger-line',
  info: 'bg-info-soft text-info border-info-line',
  warn: 'bg-warn-soft text-warn border-warn-line',
  neutral: 'bg-surface-2 text-fg-muted border-border',
}

/** State is always colour plus icon plus word (MASTER_PLAN §8.4 point 7). */
export function Chip({
  tone,
  icon: Icon,
  children,
  className,
  title,
}: {
  tone: Tone
  icon: LucideIcon
  children: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full border ps-1.5 pe-2 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.25} />
      <span className="truncate">{children}</span>
    </span>
  )
}
