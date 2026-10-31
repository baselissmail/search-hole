// SPDX-License-Identifier: Apache-2.0
import { toast } from 'sonner'
import { ApiFailure, isAbort, messageOf } from './api.ts'

/**
 * An error toast for a failed call. Silent for an ended session (the sign-in screen already says
 * so) and for aborted requests. With `id`, it replaces that toast (a "working…" one), which is
 * dismissed instead when the failure is silent.
 */
export function toastError(title: string, err: unknown, id?: string | number): void {
  if (isAbort(err) || (err instanceof ApiFailure && err.status === 401)) {
    if (id !== undefined) toast.dismiss(id)
    return
  }
  const fix = err instanceof ApiFailure ? err.fix : undefined
  const description = fix ? `${messageOf(err)} ${fix}` : messageOf(err)
  toast.error(title, id === undefined ? { description } : { id, description })
}
