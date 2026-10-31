// SPDX-License-Identifier: Apache-2.0
/**
 * Light, dark or system theme. The choice lives in localStorage (per browser, a convenience only)
 * and is applied as `data-theme` on <html>; with no attribute the CSS follows the system. Applied
 * from main.tsx before the first render: the CSP allows no inline script.
 */
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

export const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

const KEY = 'search-hole.theme'
const listeners = new Set<() => void>()

function isTheme(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

let current: ThemePreference = 'system'

export function readStoredTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY)
    return isTheme(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function apply(theme: ThemePreference): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

/** Call once, as early as possible. */
export function applyStoredTheme(): void {
  current = readStoredTheme()
  apply(current)
}

export function setTheme(theme: ThemePreference): void {
  current = theme
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // Not stored; it still applies until the page reloads.
  }
  apply(theme)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTheme(): ThemePreference {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}
