import React from 'react'
import { OperationalFactApplicability } from '@pathfinder/contracts/universal-content-actions'

export function factApplicabilitySummary(payload: Record<string, unknown>): string {
  if (payload.applicability === undefined) return 'Unknown — no declaration recorded.'
  const parsed = OperationalFactApplicability.safeParse(payload.applicability)
  if (!parsed.success) return 'Invalid declaration — validate and correct the draft.'
  if (parsed.data.scope === 'VENUE') return 'VENUE — venue-wide whole-body assertion.'
  return `SUBJECTS — module IDs: ${parsed.data.subjectModuleIds.join(', ') || 'none'}; place IDs: ${parsed.data.placeIds.join(', ') || 'none'}.`
}

/** A human-readable review of the exact stored revision or unsaved draft, never certification. */
export function FactApplicabilityReview({
  payload,
  revisionLabel,
}: {
  payload: Record<string, unknown>
  revisionLabel: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-pf-light bg-pf-surface p-3 text-sm leading-6 text-pf-deep">
      <p className="break-words font-semibold">{revisionLabel}</p>
      <p className="mt-1 break-words">{factApplicabilitySummary(payload)}</p>
      <p className="mt-1 text-xs leading-5 text-pf-deep/75">
        This is a human assertion about every sentence in this fact, not proof of correctness.
        Validate target IDs against the server and have a reviewer check the whole body before
        publication. This screen does not enforce independent review.
      </p>
    </div>
  )
}
