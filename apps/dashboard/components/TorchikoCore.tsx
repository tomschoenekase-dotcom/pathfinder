import React from 'react'

import styles from './TorchikoClientPrimitives.module.css'

export type TorchikoCoreState = 'welcome' | 'share' | 'processing' | 'questions' | 'ready' | 'live'

export function TorchikoCore({
  state = 'welcome',
  size = 'hero',
  className,
}: {
  state?: TorchikoCoreState
  size?: 'hero' | 'compact'
  className?: string
}) {
  return (
    <div
      className={[styles.core, size === 'compact' ? styles.coreCompact : '', className]
        .filter(Boolean)
        .join(' ')}
      data-state={state}
    >
      <span className={styles.coreWordmark} aria-hidden="true">
        Torchiko
      </span>
    </div>
  )
}
