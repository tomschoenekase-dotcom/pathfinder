import React from 'react'

export type SupportCompletionReviewedDecline = {
  proposalSummary: string
  reviewNote: string
}

export function SupportCompletionReviewFacts({
  reviewedDeclines,
}: {
  reviewedDeclines?: SupportCompletionReviewedDecline[] | undefined
}) {
  if (!reviewedDeclines?.length) return null

  return (
    <div className="border-l-2 border-pf-light pl-4">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-pf-deep/65">
        Declined changes
      </p>
      <ul className="mt-2 divide-y divide-pf-light">
        {reviewedDeclines.map((decline, index) => (
          <li key={`${decline.proposalSummary}:${index}`} className="py-2 first:pt-0 last:pb-0">
            <p className="break-words text-sm font-semibold text-pf-deep">
              {decline.proposalSummary}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-pf-deep/70">
              {decline.reviewNote}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}
