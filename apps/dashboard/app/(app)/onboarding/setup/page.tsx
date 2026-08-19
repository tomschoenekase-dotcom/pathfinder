'use client'

import React, { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../../../lib/trpc'
import { PortalPrimaryAction } from '../../../../components/ClientPortalPrimitives'
import styles from './VenueSetup.module.css'

function publicMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message)
    if (/slug already exists/iu.test(message)) return 'A venue with this name already exists.'
    if (/insufficient role|tenant context required|forbidden|unauthorized/iu.test(message)) {
      return 'Your client workspace selection expired. Return to Admin, open the client again, and retry.'
    }
  }
  return 'Torchiko could not create the venue. Please try again.'
}

export default function OnboardingSetupPage() {
  const client = useTRPCClient()
  const router = useRouter()
  const inFlight = useRef(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const venueName = name.trim()
    if (!venueName || inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    try {
      const venue = await client.venue.create.mutate({
        name: venueName,
        guideMode: 'non_location',
      })
      router.push(`/venues/${encodeURIComponent(venue.id)}/onboarding`)
      router.refresh()
    } catch (cause) {
      inFlight.current = false
      setSubmitting(false)
      setError(publicMessage(cause))
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.frame}>
        <PortalPrimaryAction
          headingId="venue-setup-title"
          eyebrow="A remarkably short setup"
          title="Start with your venue"
          summary="Name the place your visitors know. On the next screen, give Torchiko whatever useful material your team already has."
          state="welcome"
          showCore
        >
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <label htmlFor="venue-name">Venue name</label>
            <div className={styles.fieldRow}>
              <input
                id="venue-name"
                required
                maxLength={200}
                autoComplete="organization"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Riverside Museum"
              />
              <button type="submit" disabled={submitting || name.trim().length === 0}>
                {submitting ? 'Creating venue…' : 'Create venue and add materials'}
              </button>
            </div>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <p className={styles.reassurance}>
              That is the only required field. Nothing is published during setup.
            </p>
          </form>
        </PortalPrimaryAction>
      </div>
    </div>
  )
}
