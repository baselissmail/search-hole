// SPDX-License-Identifier: Apache-2.0
/**
 * The dashboard session (ADR-0004 point 4): a bearer token in `sessionStorage`, which is scoped
 * to this origin (and so to this port). No cookies. The token is also kept in memory so the page
 * keeps working when storage is unavailable.
 */
import { useSyncExternalStore } from 'react'

const TOKEN_KEY = 'search-hole.token'
const VERSION_KEY = 'search-hole.version'

export type SignedOutReason =
  /** No token and no login code: the page was opened directly. */
  | 'no-session'
  /** The server answered 401: the token expired or the server restarted. */
  | 'expired'
  /** The login code in the link was rejected (used already, or older than 60 s). */
  | 'link-rejected'
  /** The server didn't answer the code exchange. */
  | 'unreachable'

export type AuthState =
  | { status: 'checking' }
  | { status: 'signed-in' }
  | { status: 'signed-out'; reason: SignedOutReason }

let state: AuthState = { status: 'checking' }
let memoryToken: string | null = null
const listeners = new Set<() => void>()

function publish(next: AuthState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): AuthState {
  return state
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function readToken(): string | null {
  if (memoryToken !== null) return memoryToken
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** The search-hole version from the session response, for the footer. */
export function readVersion(): string | null {
  try {
    return sessionStorage.getItem(VERSION_KEY)
  } catch {
    return null
  }
}

export function startSession(token: string, version: string): void {
  memoryToken = token
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
    sessionStorage.setItem(VERSION_KEY, version)
  } catch {
    // Storage can be disabled; the in-memory token still works until the tab closes.
  }
  publish({ status: 'signed-in' })
}

/** Use a token stored by an earlier page load, if there is one. */
export function resumeSession(): boolean {
  if (readToken() === null) return false
  publish({ status: 'signed-in' })
  return true
}

export function endSession(reason: SignedOutReason): void {
  memoryToken = null
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Nothing stored.
  }
  if (state.status === 'signed-out' && state.reason === reason) return
  publish({ status: 'signed-out', reason })
}

let capturedCode: string | null = null

/**
 * Take the login code out of the URL. Runs before the router is created, so the code never
 * reaches the router's state, the history entry or any later navigation.
 */
export function captureLoginCode(): void {
  const code = parseLoginFragment(window.location.hash)
  if (code === null) return
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  capturedCode = code
}

/** The code captured at startup, once. */
export function takeLoginCode(): string | null {
  const code = capturedCode
  capturedCode = null
  return code
}

/**
 * The single-use login code from a `#c=<code>` fragment, or null. Other fragment parameters are
 * ignored; an over-long value is refused rather than sent.
 */
export function parseLoginFragment(hash: string): string | null {
  if (!hash || hash === '#') return null
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const code = params.get('c')?.trim()
  if (!code || code.length > 512) return null
  return code
}
