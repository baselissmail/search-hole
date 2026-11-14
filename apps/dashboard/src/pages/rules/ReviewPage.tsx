// SPDX-License-Identifier: Apache-2.0
/**
 * Rules & lists, the review view (/rules/review): sites seen in many searches and never opened
 * (ADR-0025). It loads as its own chunk on first visit, like the Lists view.
 */
import { usePageTitle } from '../../lib/usePageTitle.ts'
import { Review } from './Review.tsx'
import { RulesHeader } from './RulesTabs.tsx'

export function ReviewPage() {
  usePageTitle('Review sites')
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 md:px-6">
      <RulesHeader description="Sites that keep showing up in results while the assistant never opens them. Block one, rank it lower, or keep it: nothing changes until you decide." />
      <Review />
    </div>
  )
}
