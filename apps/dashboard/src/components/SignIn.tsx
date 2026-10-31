// SPDX-License-Identifier: Apache-2.0
/**
 * The calm screen shown without a session. There is no password: the only way in is a fresh
 * link from the terminal (ADR-0004 point 4).
 */
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, TerminalSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SignedOutReason } from '../lib/session.ts'
import { usePageTitle } from '../lib/usePageTitle.ts'
import { Logo } from './Logo.tsx'

const REASONS: Record<SignedOutReason, string | null> = {
  'no-session': null,
  expired: 'Your dashboard session has ended.',
  'link-rejected': 'That sign-in link has already been used or is more than a minute old.',
  unreachable: "search-hole didn't answer. It may have stopped.",
}

const COMMAND = 'searchhole ui --open'

function CopyCommand() {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = () => {
    navigator.clipboard?.writeText(COMMAND).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }
  return (
    <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-surface-2 py-1.5 ps-3 pe-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{COMMAND}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy the command'}
        className="inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-4" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Command copied' : ''}
      </span>
    </div>
  )
}

export function SignIn({ reason }: { reason: SignedOutReason }) {
  usePageTitle('Sign in')
  const queryClient = useQueryClient()
  // Nothing from an ended session stays in memory.
  useEffect(() => {
    queryClient.clear()
  }, [queryClient])
  const note = REASONS[reason]
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-2 text-fg">
          <Logo className="size-5" />
          <span className="text-sm font-semibold">search-hole</span>
        </div>
        <h1 className="mt-6 text-lg font-semibold tracking-tight text-fg">Sign in from your terminal</h1>
        {note ? <p className="mt-2 text-sm text-fg-muted">{note}</p> : null}
        <p className="mt-2 text-sm text-fg-muted">
          Open the dashboard from your terminal:{' '}
          <code className="font-mono text-[13px] whitespace-nowrap text-fg">{COMMAND}</code> (or{' '}
          <code className="font-mono text-[13px] whitespace-nowrap text-fg">/search-hole:dashboard</code> in
          Claude Code).
        </p>
        <CopyCommand />
        <p className="mt-5 flex items-start gap-2 text-xs text-fg-muted">
          <TerminalSquare aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>
            Each link signs in once and works for 60 seconds. The session lasts until you close this tab or
            the dashboard stops. There is no password, and nothing is stored in cookies.
          </span>
        </p>
      </div>
    </main>
  )
}
