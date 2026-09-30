import { notFound } from 'next/navigation'

import { formatWhen, untilLabel } from '../../../components/operator/format'
import { OperatorApproveView } from '../../../components/operator/OperatorApproveView'
import type { OperatorReviewItemView } from '../../../components/operator/types'
import { createAdminCaller } from '../../../lib/admin-caller'
import { resolveOperatorSession } from '../../../lib/operator-session'
import { ApprovePanel } from './ApprovePanel'

export const dynamic = 'force-dynamic'

/** One-tap approval page for a proposal or a plan: the full change, then Approve or Reject. */
export default async function OperatorApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await resolveOperatorSession()
  if (session.status === 'disabled' || session.status === 'misconfigured') notFound()
  if (session.status !== 'ok') {
    return (
      <main className="mx-auto max-w-lg bg-tk-paper px-4 py-12">
        <h1 className="text-xl font-semibold text-tk-ink">Not allowed</h1>
      </main>
    )
  }
  const { id } = await params
  const caller = await createAdminCaller()
  let item: OperatorReviewItemView
  try {
    item = await caller.admin.operatorReview({ id })
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND') notFound()
    throw error
  }
  const now = new Date()
  return (
    <OperatorApproveView
      item={item}
      expiry={`${untilLabel(item.expiresAt, now)} (${formatWhen(item.expiresAt)})`}
      panel={
        item.status === 'PENDING' ? (
          <ApprovePanel id={item.id} argsHash={item.argsHash} label={item.title} />
        ) : null
      }
    />
  )
}
