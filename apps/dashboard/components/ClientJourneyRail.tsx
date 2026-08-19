import React from 'react'

import styles from './TorchikoClientPrimitives.module.css'

export type ClientJourneyStageStatus = 'complete' | 'current' | 'upcoming'

export type ClientJourneyStage = {
  id: string
  label: string
  status: ClientJourneyStageStatus
  summary?: string
}

const STATUS_LABEL: Record<ClientJourneyStageStatus, string> = {
  complete: 'Complete',
  current: 'Current',
  upcoming: 'Up next',
}

export function ClientJourneyRail({
  stages,
  label = 'Onboarding progress',
  compact = false,
  className,
}: {
  stages: ClientJourneyStage[]
  label?: string
  compact?: boolean
  className?: string
}) {
  return (
    <section
      className={[styles.journey, compact ? styles.journeyCompact : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
    >
      <ol className={styles.journeyList}>
        {stages.map((stage, index) => (
          <li
            key={stage.id}
            className={styles.journeyItem}
            data-status={stage.status}
            aria-current={stage.status === 'current' ? 'step' : undefined}
          >
            <span className={styles.journeyMarker} aria-hidden="true">
              {stage.status === 'complete' ? '✓' : index + 1}
            </span>
            <span className={styles.journeyCopy}>
              <span className={styles.journeyLabel}>{stage.label}</span>
              <span className={styles.journeyState}>{STATUS_LABEL[stage.status]}</span>
              {stage.summary ? (
                <span className={styles.journeySummary}>{stage.summary}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
