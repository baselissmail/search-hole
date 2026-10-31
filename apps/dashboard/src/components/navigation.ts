// SPDX-License-Identifier: Apache-2.0
import { Activity, ListFilter, type LucideIcon, Server, Settings2 } from 'lucide-react'

export type AppPath = '/' | '/rules' | '/engines' | '/settings'

/** The four v1 pages, with the second key of their `g` shortcut. */
export const PAGES: ReadonlyArray<{ to: AppPath; label: string; icon: LucideIcon; key: string }> = [
  { to: '/', label: 'Live log', icon: Activity, key: 'L' },
  { to: '/rules', label: 'Rules & lists', icon: ListFilter, key: 'R' },
  { to: '/engines', label: 'Engines', icon: Server, key: 'E' },
  { to: '/settings', label: 'Settings', icon: Settings2, key: 'S' },
]

export const GO_TO: Readonly<Record<string, AppPath>> = { l: '/', r: '/rules', e: '/engines', s: '/settings' }
