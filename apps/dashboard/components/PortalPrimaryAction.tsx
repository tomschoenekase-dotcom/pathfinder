import React, { type ReactNode } from 'react'
import Link from 'next/link'

import { TorchikoCore, type TorchikoCoreState } from './TorchikoCore'
import styles from './TorchikoClientPrimitives.module.css'

type PortalActionLink = {
  href: string
  label: string
}

export function PortalPrimaryAction({
  eyebrow,
  title,
  summary,
  primaryAction,
  secondaryAction,
  supportingText,
  state = 'welcome',
  tone = 'deep',
  headingLevel = 1,
  headingId,
  showCore = true,
  children,
  className,
}: {
  eyebrow: string
  title: ReactNode
  summary: ReactNode
  primaryAction?: PortalActionLink
  secondaryAction?: PortalActionLink
  supportingText?: ReactNode
  state?: TorchikoCoreState
  tone?: 'deep' | 'light'
  headingLevel?: 1 | 2
  headingId: string
  showCore?: boolean
  children?: ReactNode
  className?: string
}) {
  const Heading: 'h1' | 'h2' = headingLevel === 1 ? 'h1' : 'h2'

  return (
    <section
      className={[styles.primaryAction, className].filter(Boolean).join(' ')}
      data-tone={tone}
      aria-labelledby={headingId}
    >
      <div className={styles.primaryActionCopy}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <Heading id={headingId} className={styles.primaryActionTitle}>
          {title}
        </Heading>
        <div className={styles.primaryActionSummary}>{summary}</div>
        {primaryAction || secondaryAction ? (
          <div className={styles.actionRow}>
            {primaryAction ? (
              <Link className={styles.primaryLink} href={primaryAction.href}>
                {primaryAction.label}
              </Link>
            ) : null}
            {secondaryAction ? (
              <Link className={styles.secondaryLink} href={secondaryAction.href}>
                {secondaryAction.label}
              </Link>
            ) : null}
          </div>
        ) : null}
        {supportingText ? <div className={styles.supportingText}>{supportingText}</div> : null}
        {children}
      </div>
      {showCore ? (
        <div className={styles.primaryActionVisual}>
          <TorchikoCore state={state} />
        </div>
      ) : null}
    </section>
  )
}
