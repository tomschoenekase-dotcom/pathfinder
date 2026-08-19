'use client'

import React, { useEffect, useRef } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import { TorchikoCore } from './ClientPortalPrimitives'
import styles from './RemoteOnboardingRouteState.module.css'

export function RemoteOnboardingLoading() {
  return (
    <section
      className={styles.statePage}
      aria-busy="true"
      aria-label="Loading venue onboarding"
      role="status"
    >
      <div className={styles.stateCopy}>
        <p>Opening your saved setup</p>
        <h1>Torchiko is gathering the latest pieces.</h1>
        <span>Uploads, questions, and progress are being restored without changing anything.</span>
        <div className={styles.loadingLines} aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
      <TorchikoCore state="processing" size="compact" />
      <span className="sr-only">Loading venue onboarding…</span>
    </section>
  )
}

export function RemoteOnboardingError({ reset }: { reset: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])
  return (
    <section className={styles.statePage} role="alert">
      <div className={styles.stateCopy}>
        <p className={styles.errorLabel}>
          <AlertTriangle aria-hidden="true" /> Setup paused safely
        </p>
        <h1 ref={headingRef} tabIndex={-1}>
          We couldn&apos;t open the latest journey.
        </h1>
        <span>
          No upload, question, or onboarding state was changed. Try loading the saved state again.
        </span>
        <button type="button" onClick={reset}>
          <RefreshCw aria-hidden="true" /> Try loading again
        </button>
      </div>
      <TorchikoCore state="questions" size="compact" />
    </section>
  )
}
