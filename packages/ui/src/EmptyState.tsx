import type { HTMLAttributes, ReactNode } from 'react'

import { mergeClasses } from './styles'

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
}

export function EmptyState({
  action,
  className,
  description,
  icon,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={mergeClasses(
        'flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600"
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-slate-950">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-md text-sm leading-6 text-slate-600">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
