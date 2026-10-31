// SPDX-License-Identifier: Apache-2.0
/** Code-based routes (no router codegen). The URL is the state (MASTER_PLAN §8.4 point 4). */
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { NotFound } from '../components/NotFound.tsx'
import { Root } from '../components/Root.tsx'
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

const routeTree = rootRoute.addChildren([logRoute, rulesRoute, enginesRoute, settingsRoute])

export const router = createRouter({ routeTree, defaultPreload: false, scrollRestoration: false })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
