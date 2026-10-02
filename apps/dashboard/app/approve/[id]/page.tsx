import { notFound } from 'next/navigation'

import { formatWhen, untilLabel } from '../../../components/operator/format'
import { OperatorApproveView } from '../../../components/operator/OperatorApproveView'
import type { OperatorReviewItemView } from '../../../components/operator/types'
import { createAdminCaller } from '../../../lib/admin-caller'
import { resolveOperatorSession } from '../../../lib/operator-session'
import { ApprovePanel } from './ApprovePanel'

export const dynamic = 'force-dynamic'

/** One-tap approval page for a proposal or a plan: the full change, then Approve or Reject. */
export default async function OperatorApprovePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
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
  // Opened from a chat approval request: the decision spends that single-use ticket, which is bound
  // to the exact version shown here. A lapsed, used or outdated ticket is explained, and the normal
  // approval below still works for a proposal that is still pending.
  const rawRequest = (await searchParams).request
  const requestId = (Array.isArray(rawRequest) ? rawRequest[0] : rawRequest)?.trim().slice(0, 191)
  let decisionRequestId: string | undefined
  let notice: string | undefined
  if (requestId && item.type === 'proposal') {
    const ticket = await caller.admin.operatorDecisionRequest({
      id: requestId,
      proposalId: item.id,
    })
    if (!ticket) {
      notice = 'This approval request was not found. Approving here works as usual.'
    } else if (ticket.status === 'DECIDED') {
      notice = 'This approval request was already used.'
    } else if (!ticket.open) {
      notice = 'This approval request has expired. Ask for it again in the chat, or approve here.'
    } else if (ticket.argsHash !== item.argsHash) {
      notice = 'The proposal changed after it was requested. Ask for it again in the chat.'
    } else {
      decisionRequestId = ticket.id
      notice = 'Requested from the chat. Your decision here is final for this request.'
    }
  }
  return (
    <OperatorApproveView
      item={item}
      expiry={`${untilLabel(item.expiresAt, now)} (${formatWhen(item.expiresAt)})`}
      notice={notice}
      panel={
        item.status === 'PENDING' ? (
          <ApprovePanel
            id={item.id}
            argsHash={item.argsHash}
            label={item.title}
            decisionRequestId={decisionRequestId}
          />
        ) : null
      }
    />
  )
}
