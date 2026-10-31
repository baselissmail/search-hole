// SPDX-License-Identifier: Apache-2.0
/** The Rules & lists heading with its two views, each its own URL: /rules and /rules/lists. */
import { Link } from '@tanstack/react-router'
import { ListChecks, ListFilter } from 'lucide-react'
import { PageHeader } from '../../components/ui/Card.tsx'

const tab =
  '-mb-px inline-flex h-9 items-center gap-2 border-b-2 border-transparent px-1 text-[13px] font-medium text-fg-muted transition-colors hover:text-fg data-[status=active]:border-fg data-[status=active]:text-fg'

export function RulesHeader({ description }: { description: string }) {
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
        </ul>
      </nav>
    </div>
  )
}
