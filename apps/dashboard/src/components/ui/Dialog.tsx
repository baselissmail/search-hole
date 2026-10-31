// SPDX-License-Identifier: Apache-2.0
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useRef } from 'react'
import { cx } from '../../lib/cx.ts'

/**
 * While open, focus that lands outside the dialog by script (not by the user: the trap already
 * handles Tab) is brought back. sonner hands focus back to a toast's trigger when the toast
 * closes, which can happen just after ⌘K opened the command menu.
 */
function useKeepFocusInside(
  open: boolean,
  popup: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null> | undefined,
): void {
  useEffect(() => {
    if (!open) return
    const onFocusIn = (event: FocusEvent) => {
      const el = popup.current
      if (el === null || !(event.target instanceof Node) || el.contains(event.target)) return
      ;(initialFocus?.current ?? el).focus({ preventScroll: true })
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open, popup, initialFocus])
}

/** A modal dialog on Base UI: focus is trapped, Escape closes, focus returns on close. */
export function AppDialog({
  open,
  onOpenChange,
  title,
  description,
  hideTitle = false,
  initialFocus,
  size = 'md',
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** Keep the title for screen readers only (the command menu has its own input). */
  hideTitle?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  /** `lg` for dialogs that hold a list of things (the list catalog). */
  size?: 'md' | 'lg'
  className?: string
  children: ReactNode
}) {
  const popupRef = useRef<HTMLDivElement>(null)
  useKeepFocusInside(open, popupRef, initialFocus)
  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          ref={popupRef}
          {...(initialFocus ? { initialFocus } : {})}
          className={cx(
            'fixed inset-x-0 top-[12dvh] z-50 mx-auto flex max-h-[76dvh] flex-col overflow-hidden rounded-xl border border-border-strong bg-surface text-fg shadow-2xl outline-none',
            size === 'lg' ? 'w-[min(52rem,calc(100vw-2rem))]' : 'w-[min(36rem,calc(100vw-2rem))]',
            'transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0',
            className,
          )}
        >
          <div className={cx('flex items-start justify-between gap-4 px-4 pt-4', hideTitle && 'sr-only')}>
            <div>
              <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-[13px] text-fg-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="-me-1.5 -mt-1 inline-flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
