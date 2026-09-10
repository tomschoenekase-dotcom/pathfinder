import React from 'react'

import {
  SupportCompletionOutcome,
  type SupportCompletionOutcomeValue,
} from '../SupportCompletionOutcome'

export function SupportCompletionApprovalContext({
  proposal,
}: {
  proposal?:
    | {
        completionOutcome: SupportCompletionOutcomeValue | null
        body: string
      }
    | null
    | undefined
}) {
  if (!proposal) return null

  return (
    <div className="mt-3 border-l-2 border-pf-light pl-3">
      {proposal.completionOutcome ? (
        <SupportCompletionOutcome outcome={proposal.completionOutcome} />
      ) : null}
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-pf-deep/75">
        {proposal.body}
      </p>
    </div>
  )
}
