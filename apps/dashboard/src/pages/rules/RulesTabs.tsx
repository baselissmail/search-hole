// SPDX-License-Identifier: Apache-2.0
/**
 * The Rules & lists heading with its views, each its own URL: /rules, /rules/lists and
 * /rules/review. The Review tab carries the number of sites waiting for a decision.
 */
import { Link } from '@tanstack/react-router'
import { Eye, ListChecks, ListFilter } from 'lucide-react'
import { PageHeader } from '../../components/ui/Card.tsx'
import { formatCount } from '../../lib/format.ts'
import { useReview } from '../../lib/queries.ts'

const tab =
  '-mb-px inline-flex h-9 items-center gap-2 border-b-2 border-transparent px-1 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg data-[status=active]:border-fg data-[status=active]:text-fg'

export function RulesHeader({ description }: { description: string }) {
  const waiting = useReview().data?.total ?? 0
  return (
    <div className="space-y-3">
      <PageHeader title="Rules & lists" description={description} />
      <nav aria-label="Rules and lists">
        <ul className="flex gap-5 border-b border-border">
          <li>
            <Link to="/rules" activeOptions={{ exact: true, includeSearch: false }} className={tab}>
              <ListFilter aria-hidden="true" className="size-4" />
              Rules
            </Link>
          </li>
          <li>
            <Link
              to="/rules/lists"
              activeOptions={{ exact: true, includeSearch: false }}
              preload="intent"
              className={tab}
            >
              <ListChecks aria-hidden="true" className="size-4" />
              Lists
            </Link>
          </li>
          <li>
            <Link
              to="/rules/review"
              activeOptions={{ exact: true, includeSearch: false }}
              preload="intent"
              className={tab}
            >
              <Eye aria-hidden="true" className="size-4" />
              Review{' '}
              {/* The link reads "Review 2 sites to review": the visible text, then what the number counts. */}
              {waiting > 0 ? (
                <span className="tabular rounded-full border border-border bg-surface-2 px-1.5 font-mono text-[11px] leading-4 text-fg">
                  {formatCount(waiting)}
                  <span className="sr-only"> {waiting === 1 ? 'site' : 'sites'} to review</span>
                </span>
              ) : null}
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  )
}
