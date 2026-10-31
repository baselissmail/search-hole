// SPDX-License-Identifier: Apache-2.0
/**
 * Rules & lists (§8.3 v1), the rules view: add, list and remove rules, test a URL, decide on
 * suggestions. Lists have their own view at /rules/lists.
 */
import { usePageTitle } from '../../lib/usePageTitle.ts'
import { AddRuleForm } from './AddRuleForm.tsx'
import { ExplainSandbox } from './ExplainSandbox.tsx'
import { RulesTable } from './RulesTable.tsx'
import { RulesHeader } from './RulesTabs.tsx'
import { Suggestions } from './Suggestions.tsx'

export function RulesPage() {
  usePageTitle('Rules & lists')
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 md:px-6">
      <RulesHeader description="Rules decide which sites are hidden, kept, pinned, or moved up and down. Your rules beat lists, and the most local scope wins." />
      <AddRuleForm />
      <RulesTable />
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <ExplainSandbox />
        <Suggestions />
      </div>
    </div>
  )
}
