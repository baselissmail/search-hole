// SPDX-License-Identifier: Apache-2.0
import { ExternalLink } from 'lucide-react'
import { cx } from '../../lib/cx.ts'
import { EXTERNAL_LINK, safeHttpUrl } from '../../lib/safeUrl.ts'
import { displayUrl, middleTruncate } from '../../lib/text.ts'

/**
 * A web-sourced URL in mono, middle-truncated, with the full value in the title. It becomes a
 * link only for http(s); anything else (`javascript:`, `data:`…) renders as plain text.
 */
export function UrlText({ url, max = 72, className }: { url: string; max?: number; className?: string }) {
  const href = safeHttpUrl(url)
  const shown = middleTruncate(displayUrl(url), max)
  const classes = cx('block truncate font-mono text-xs', className)
  if (!href) {
    return (
      <span className={cx(classes, 'text-fg-muted')} title={url}>
        {shown}
      </span>
    )
  }
  return (
    <a
      href={href}
      {...EXTERNAL_LINK}
      title={url}
      className={cx(classes, 'group text-fg-muted underline-offset-2 hover:text-fg hover:underline')}
    >
      {shown}
      <ExternalLink
        aria-hidden="true"
        className="ms-1 inline size-3 align-[-1px] opacity-0 group-hover:opacity-100"
      />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
