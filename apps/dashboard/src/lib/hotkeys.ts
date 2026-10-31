// SPDX-License-Identifier: Apache-2.0
/**
 * Keyboard shortcuts. One document listener lives in the layout and handles the global keys
 * (⌘K, `?`, `g` sequences); pages register their single-key verbs here. Keys are never taken
 * while the user types in a field or works inside a dialog.
 */
import { useEffect, useEffectEvent } from 'react'

/** Returns true when it handled the key. */
export type KeyHandler = (event: KeyboardEvent) => boolean

const pageHandlers = new Set<KeyHandler>()

/** Register a page's key handler while the component is mounted. */
export function usePageKeys(handler: KeyHandler, enabled = true): void {
  const onKey = useEffectEvent(handler)
  useEffect(() => {
    if (!enabled) return
    const fn: KeyHandler = (event) => onKey(event)
    pageHandlers.add(fn)
    return () => {
      pageHandlers.delete(fn)
    }
  }, [enabled])
}

export function dispatchPageKey(event: KeyboardEvent): boolean {
  for (const handler of pageHandlers) if (handler(event)) return true
  return false
}

/** The parts of an element the checks below read; real elements satisfy it. */
export interface KeyTarget {
  tagName?: string
  type?: string
  isContentEditable?: boolean
  getAttribute?(name: string): string | null
  closest?(selector: string): unknown
}

const NON_TEXT_INPUTS = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
])
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])

/** True when keys typed at `target` are text the user is entering. */
export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (!target || typeof target.tagName !== 'string') return false
  if (target.isContentEditable) return true
  const tag = target.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())
  const role = target.getAttribute?.('role')
  return role != null && TEXT_ROLES.has(role)
}

/**
 * True while any dialog is open, wherever focus is: keys typed right after ⌘K can arrive
 * before focus reaches the palette's input, and must not fire row verbs (b, r, l…) underneath.
 */
export function anyDialogOpen(doc: Pick<Document, 'querySelector'> = document): boolean {
  return doc.querySelector('[role="dialog"],[role="alertdialog"]') !== null
}

/** True inside an open dialog: its own keys win. */
export function isInDialog(target: KeyTarget | null | undefined): boolean {
  return Boolean(target?.closest?.('[role="dialog"],[role="alertdialog"]'))
}

/** True on buttons, links and form controls, where Enter and Space already mean something. */
export function isInteractiveTarget(target: KeyTarget | null | undefined): boolean {
  if (!target || typeof target.tagName !== 'string') return false
  const tag = target.tagName.toUpperCase()
  return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

/** A plain key press: no Ctrl, Alt or Meta (Shift is allowed for `?`). */
export function isPlainKey(event: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  return !event.ctrlKey && !event.altKey && !event.metaKey
}

export function isApplePlatform(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  const platform = (nav as (Navigator & { userAgentData?: { platform?: string } }) | undefined)?.userAgentData
    ?.platform
  return /mac|iphone|ipad/i.test(platform ?? nav?.platform ?? '')
}
