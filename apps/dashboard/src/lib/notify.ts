// SPDX-License-Identifier: Apache-2.0
import { toast } from 'sonner'
import { ApiFailure, isAbort, messageOf } from './api.ts'

/**
 * An error toast for a failed call. Silent for an ended session (the sign-in screen already says
 * so) and for aborted requests.
 */
export function toastError(title: string, err: unknown): void {
  if (isAbort(err) || (err instanceof ApiFailure && err.status === 401)) return
  const fix = err instanceof ApiFailure ? err.fix : undefined
  toast.error(title, { description: fix ? `${messageOf(err)} ${fix}` : messageOf(err) })
}
