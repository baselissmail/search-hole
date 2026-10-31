// SPDX-License-Identifier: Apache-2.0
/**
 * The root layout: sign-in gate, left navigation, the Overview header, the page, the footer, and
 * the one document key listener (⌘K, `?`, `g` sequences, then the page's own keys).
 */
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { Command, Keyboard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cx } from '../lib/cx.ts'
import {
  anyDialogOpen,
  dispatchPageKey,
  isApplePlatform,
  isInDialog,
  isPlainKey,
  isTypingTarget,
  type KeyTarget,
} from '../lib/hotkeys.ts'
import { useOverview } from '../lib/queries.ts'
import { readVersion, useAuth } from '../lib/session.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { Logo } from './Logo.tsx'
import { GO_TO, PAGES } from './navigation.ts'
import { OverviewHeader } from './OverviewHeader.tsx'
import { ShortcutsDialog } from './ShortcutsDialog.tsx'
import { SignIn } from './SignIn.tsx'
import { Kbd, Keys } from './ui/Kbd.tsx'
import { Skeleton } from './ui/Skeleton.tsx'

const SEQUENCE_MS = 1500

export function Root() {
  const auth = useAuth()
  if (auth.status === 'checking') {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <span className="sr-only">Signing in…</span>
        <Skeleton className="h-3 w-40" />
      </div>
    )
  }
  if (auth.status === 'signed-out') return <SignIn reason={auth.reason} />
  return <Shell />
}

function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    let sequenceAt = 0
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as KeyTarget | null
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (event.defaultPrevented || event.isComposing || !isPlainKey(event)) return
      if (isTypingTarget(target) || isInDialog(target) || anyDialogOpen()) return
      if (sequenceAt > 0 && Date.now() - sequenceAt < SEQUENCE_MS) {
        sequenceAt = 0
        const to = GO_TO[event.key.toLowerCase()]
        if (to) {
          event.preventDefault()
          void navigate({ to })
        }
        return
      }
      sequenceAt = 0
      if (event.key === 'g') {
        sequenceAt = Date.now()
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (dispatchPageKey(event)) event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg md:flex-row">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
      >
        Skip to content
      </a>
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} onOpenShortcuts={() => setShortcutsOpen(true)} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <OverviewHeader />
        <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none">
          <Outlet />
        </main>
        <Footer />
      </div>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}

const navItem =
  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg data-[status=active]:bg-surface-3 data-[status=active]:text-fg'

function Sidebar({
  onOpenPalette,
  onOpenShortcuts,
}: {
  onOpenPalette: () => void
  onOpenShortcuts: () => void
}) {
  const mod = isApplePlatform() ? '⌘' : 'Ctrl'
  return (
    <header className="flex shrink-0 flex-col border-b border-border bg-surface md:w-56 md:border-e md:border-b-0">
      <div className="flex h-12 items-center gap-2 px-4">
        <Logo className="size-[18px] text-fg" />
        <span className="text-sm font-semibold tracking-tight">search-hole</span>
      </div>
      <nav aria-label="Main" className="px-2 pb-2 md:pb-0">
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {PAGES.map((page) => (
            <li key={page.to}>
              <Link
                to={page.to}
                activeOptions={{ exact: page.to === '/', includeSearch: false }}
                className={navItem}
              >
                <page.icon aria-hidden="true" className="hidden size-4 shrink-0 sm:block" />
                <span className="flex-1">{page.label}</span>
                <span className="hidden md:inline-flex" aria-hidden="true">
                  <Keys keys={['G', page.key]} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-auto hidden flex-col gap-1 p-2 md:flex">
        <button type="button" onClick={onOpenPalette} className={cx(navItem, 'w-full')}>
          <Command aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1 text-start">Command menu</span>
          <Kbd>{`${mod} K`}</Kbd>
        </button>
        <button type="button" onClick={onOpenShortcuts} className={cx(navItem, 'w-full')}>
          <Keyboard aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1 text-start">Keyboard shortcuts</span>
          <Kbd>?</Kbd>
        </button>
      </div>
    </header>
  )
}

function Footer() {
  const overview = useOverview()
  const version = readVersion() ?? overview.data?.version
  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-4 border-t border-border bg-surface px-4 text-xs text-fg-muted">
      <span>
        search-hole {version ? <span className="tabular font-mono">v{version.replace(/^v/, '')}</span> : null}
      </span>
      <span className="truncate">Local dashboard · {window.location.host}</span>
    </footer>
  )
}
