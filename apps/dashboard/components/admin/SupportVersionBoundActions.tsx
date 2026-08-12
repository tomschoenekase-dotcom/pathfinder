'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'

import type { SupportRequestStatus } from '@pathfinder/contracts/support-workflow'

import { SupportManualLoopActions } from './SupportManualLoopActions'

export function SupportVersionBoundActions({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  currentStatus,
  missingInformation,
  children,
}: {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  currentStatus: SupportRequestStatus
  missingInformation: string[]
  children: ReactNode
}) {
  const [stale, setStale] = useState(false)

  if (stale) {
    return (
      <p
        role="status"
        className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
      >
        The request changed. Actions are locked while the latest version loads.
      </p>
    )
  }

  return (
    <fieldset className="contents">
      <legend className="sr-only">Actions for request version {expectedVersion}</legend>
      <SupportManualLoopActions
        tenantId={tenantId}
        venueId={venueId}
        requestId={requestId}
        expectedVersion={expectedVersion}
        currentStatus={currentStatus}
        missingInformation={missingInformation}
        onConfirmed={() => setStale(true)}
      />
      {children}
    </fieldset>
  )
}
