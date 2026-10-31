// SPDX-License-Identifier: Apache-2.0
import { Link } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { usePageTitle } from '../lib/usePageTitle.ts'
import { buttonClass } from './ui/Button.tsx'
import { EmptyState } from './ui/EmptyState.tsx'

export function NotFound() {
  usePageTitle('Not found')
  return (
    <div className="p-6">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState icon={Compass} title="There's no page here">
        <p>The dashboard has four pages: Live log, Rules & lists, Engines and Settings.</p>
        <Link to="/" className={`${buttonClass('secondary', 'sm')} mt-4`}>
          Go to the live log
        </Link>
      </EmptyState>
    </div>
  )
}
