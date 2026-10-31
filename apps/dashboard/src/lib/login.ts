// SPDX-License-Identifier: Apache-2.0
/**
 * Sign-in on page load (ADR-0004 point 4). `searchhole ui --open` opens the page with a
 * single-use code in the fragment (`#c=<code>`). `captureLoginCode()` has already removed it from
 * the address bar (see boot.ts); here it is exchanged for a session token.
 */
import { ApiFailure, api } from './api.ts'
import { endSession, resumeSession, startSession } from './session.ts'

export async function signIn(code: string | null): Promise<void> {
  if (code === null) {
    if (!resumeSession()) endSession('no-session')
    return
  }
  try {
    const { token, version } = await api.session(code)
    startSession(token, version)
  } catch (err) {
    // A stale link opened in an old tab shouldn't sign out a session that still works.
    if (resumeSession()) return
    endSession(err instanceof ApiFailure && err.status === 0 ? 'unreachable' : 'link-rejected')
  }
}
