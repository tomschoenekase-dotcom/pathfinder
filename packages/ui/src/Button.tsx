import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { disabledControl, focusRing, mergeClasses, restrainedMotion } from './styles'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-slate-950 text-white hover:bg-slate-800',
  secondary: 'border-slate-300 bg-white text-slate-900 hover:bg-slate-50',
  quiet: 'border-transparent bg-transparent text-slate-700 hover:bg-slate-100 hover:text-slate-950',
  danger: 'border-red-700 bg-red-700 text-white hover:bg-red-800',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'min-h-8 px-3 py-1.5 text-xs',
  md: 'min-h-10 px-4 py-2 text-sm',
  lg: 'min-h-11 px-5 py-2.5 text-sm',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
}

export function Button({
  children,
  className,
  leadingIcon,
  size = 'md',
  trailingIcon,
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={mergeClasses(
        'inline-flex items-center justify-center gap-2 rounded-md border font-semibold shadow-sm',
        focusRing,
        disabledControl,
        restrainedMotion,
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {leadingIcon ? <span aria-hidden="true">{leadingIcon}</span> : null}
      {children}
      {trailingIcon ? <span aria-hidden="true">{trailingIcon}</span> : null}
    </button>
  )
}
