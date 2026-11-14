// SPDX-License-Identifier: Apache-2.0
/** Code-based routes (no router codegen). The URL is the state (MASTER_PLAN §8.4 point 4). */
import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router'
import { NotFound } from '../components/NotFound.tsx'
import { Root } from '../components/Root.tsx'
import { parseListsSearch } from '../lib/listsSearch.ts'
import { parseLogSearch } from '../lib/logSearch.ts'
import { EnginesPage } from '../pages/engines/EnginesPage.tsx'
import { LiveLogPage } from '../pages/log/LiveLogPage.tsx'
import { RulesPage } from '../pages/rules/RulesPage.tsx'
import { SettingsPage } from '../pages/settings/SettingsPage.tsx'

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound })

const logRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: parseLogSearch,
  component: LiveLogPage,
})

const rulesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/rules', component: RulesPage })
// Lists load as their own chunk on first visit: the initial bundle stays within budget (§12.3).
const listsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rules/lists',
  validateSearch: parseListsSearch,
  component: lazyRouteComponent(() => import('../pages/lists/ListsPage.tsx'), 'ListsPage'),
})
// So does the review list (ADR-0025): only its count badge is in the initial bundle.
const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rules/review',
  component: lazyRouteComponent(() => import('../pages/rules/ReviewPage.tsx'), 'ReviewPage'),
})
const enginesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/engines',
  component: EnginesPage,
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  logRoute,
  rulesRoute,
  listsRoute,
  reviewRoute,
  enginesRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: false })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
