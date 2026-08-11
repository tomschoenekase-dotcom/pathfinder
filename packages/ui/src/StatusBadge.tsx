import type { HTMLAttributes, ReactNode } from 'react'

import { mergeClasses } from './styles'

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-slate-300 bg-slate-50 text-slate-700',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  danger: 'border-red-200 bg-red-50 text-red-800',
}

const dotClasses: Record<StatusTone, string> = {
  neutral: 'bg-slate-500',
  info: 'bg-blue-600',
  success: 'bg-emerald-600',
  warning: 'bg-amber-600',
  danger: 'bg-red-600',
}

export type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode
  tone?: StatusTone
  showDot?: boolean
}

export function StatusBadge({
  children,
  className,
  showDot = true,
  tone = 'neutral',
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={mergeClasses(
        'inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold leading-5',
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {showDot ? (
        <span
          aria-hidden="true"
          className={mergeClasses('h-1.5 w-1.5 rounded-full', dotClasses[tone])}
        />
      ) : null}
      {children}
    </span>
  )
}
