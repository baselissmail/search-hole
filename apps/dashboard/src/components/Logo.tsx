// SPDX-License-Identifier: Apache-2.0
import { cx } from '../lib/cx.ts'

/** The mark: a ring with a hole. Decorative; the product name always sits next to it. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cx('shrink-0', className)}>
      <circle cx="16" cy="16" r="12.5" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="16" cy="16" r="5" fill="currentColor" />
    </svg>
  )
}
