import React, { type ReactNode } from 'react'

import styles from './TorchikoClientPrimitives.module.css'

export function ClientSectionHeading({
  eyebrow,
  title,
  summary,
  headingId,
  headingLevel = 2,
  action,
  className,
}: {
  eyebrow?: string
  title: ReactNode
  summary?: ReactNode
  headingId: string
  headingLevel?: 1 | 2 | 3
  action?: ReactNode
  className?: string
}) {
  const Heading: 'h1' | 'h2' | 'h3' = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3'

  return (
    <header className={[styles.sectionHeading, className].filter(Boolean).join(' ')}>
      <div className={styles.sectionHeadingCopy}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <Heading id={headingId} className={styles.sectionTitle}>
          {title}
        </Heading>
        {summary ? <div className={styles.sectionSummary}>{summary}</div> : null}
      </div>
      {action ? <div className={styles.sectionAction}>{action}</div> : null}
    </header>
  )
}
