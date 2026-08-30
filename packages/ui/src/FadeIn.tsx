import type { CSSProperties, ReactNode } from 'react'

export function FadeIn({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  const style: CSSProperties = {
    animationDelay: `${Math.max(0, delay)}ms`,
  }

  return (
    <div className={`reveal ${className}`} style={style}>
      {children}
    </div>
  )
}
