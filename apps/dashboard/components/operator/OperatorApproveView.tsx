import type { ReactNode } from 'react'

import { OperatorReviewSteps } from './OperatorReviewSteps'
import type { OperatorReviewItemView } from './types'

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Waiting for you',
  APPLIED: 'Approved and applied',
  APPROVED: 'Approved, applying',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  STALE: 'Went stale, nothing applied',
  FAILED: 'Approved, but did not apply',
}

/**
 * The phone layout of the one-tap page: who is asking, what changes (client and venue by name,
 * before and after where recorded, every plan step), then the pinned Approve and Reject panel.
 * Presentational so it can be rendered without a session.
 */
export function OperatorApproveView({
  item,
  expiry,
  panel,
  notice,
}: {
  item: OperatorReviewItemView
  expiry: string
  panel: ReactNode
  /** Says where a chat approval request stands, when this page was opened from one. */
  notice?: string | undefined
}) {
  const pending = item.status === 'PENDING'
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col bg-tk-paper">
      <div className="flex-1 px-4 pb-4 pt-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-tk-soft">
          Request from {item.clientName}
        </p>
        <h1 className="mt-1 font-portal text-2xl font-semibold leading-tight text-tk-ink">
          {item.title}
        </h1>
        <p className="mt-1 text-sm text-tk-soft">
          <strong className="font-semibold text-tk-ink">
            {STATUS_TEXT[item.status] ?? item.status}
          </strong>
          {pending ? `, ${expiry}` : ''}
          {item.type === 'plan'
            ? `. ${item.steps.length} steps run in order and stop at the first failure.`
            : ''}
        </p>
        {notice ? (
          <p
            role="status"
            className="mt-3 rounded-lg border border-tk-rule bg-white px-3 py-2 text-sm text-tk-ink"
          >
            {notice}
          </p>
        ) : null}
        <div className="mt-4">
          <OperatorReviewSteps steps={item.steps} pending={pending} />
        </div>
      </div>
      {panel}
    </main>
  )
}
