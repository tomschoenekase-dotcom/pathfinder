import type { HTMLAttributes, ReactNode } from 'react'

import { mergeClasses } from './styles'

export type SurfaceProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

const paddingClasses = {
  none: '',
  sm: 'p-3',
  md: 'p-5',
  lg: 'p-6 sm:p-8',
} as const

export function Surface({ children, className, padding = 'md', ...props }: SurfaceProps) {
  return (
    <section
      className={mergeClasses(
        'border border-slate-200 bg-white shadow-sm',
        paddingClasses[padding],
        className,
      )}
      {...props}
    >
      {children}
    </section>
  )
}

export type PanelProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  padding?: SurfaceProps['padding']
}

export function Panel({ children, className, padding = 'md', ...props }: PanelProps) {
  return (
    <div
      className={mergeClasses(
        'border border-slate-200 bg-slate-50/70',
        paddingClasses[padding],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
