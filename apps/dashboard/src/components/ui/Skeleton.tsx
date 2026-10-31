// SPDX-License-Identifier: Apache-2.0
import { cx } from '../../lib/cx.ts'

/** A placeholder bar; the surrounding region carries `aria-busy` and a text label. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('block animate-pulse rounded bg-surface-3', className)} />
}
