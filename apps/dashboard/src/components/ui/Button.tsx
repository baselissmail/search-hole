// SPDX-License-Identifier: Apache-2.0
import type { ComponentProps } from 'react'
import { cx } from '../../lib/cx.ts'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-fg text-inverse hover:bg-fg/90 border border-transparent',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-2 border border-transparent',
  danger: 'bg-surface text-danger border border-danger-line hover:bg-danger-soft',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-8 gap-2 px-3 text-sm',
}

export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md') =>
  cx(
    'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap select-none transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55',
    VARIANTS[variant],
    SIZES[size],
  )

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return <button type={type} className={cx(buttonClass(variant, size), className)} {...props} />
}
