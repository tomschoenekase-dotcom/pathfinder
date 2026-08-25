'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import React, { useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type CustomerAccessRequest = {
  id: string
  targetEmail: string
  requestedRole: string
  status: string
  supportRequestId: string
  sourceSupportMessageId: string
  providerInvitationId: string | null
  updatedAt: Date | string
}

export function CustomerAccessApprovalContext({
  tenantId,
  venueId,
  request,
}: {
  tenantId: string
  venueId: string
  request: CustomerAccessRequest | null | undefined
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)

  if (!request) return null
  const currentRequest = request

  const invitationSent =
    currentRequest.status === 'INVITED' && currentRequest.providerInvitationId !== null
  const executionReady =
    currentRequest.status === 'APPROVED' || currentRequest.status === 'RECONCILIATION_REQUIRED'

  async function executeInvitation() {
    if (active.current || !executionReady) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.executeApprovedCustomerInvitation.mutate({
        tenantId,
        venueId,
        requestId: currentRequest.id,
        expectedUpdatedAt: new Date(currentRequest.updatedAt),
      })
      setFeedback({
        kind: 'success',
        text: result.replayed
          ? 'The matching provider invitation was confirmed. No duplicate invitation was created.'
          : 'The approved provider invitation was sent and its exact provider evidence was recorded.',
      })
      router.refresh()
    } catch {
      setFeedback({
        kind: 'error',
        text: 'The provider outcome could not be confirmed. The request was retained for reconciliation; refresh before retrying.',
      })
      router.refresh()
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <div
      className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-slate-800"
      aria-label="Customer access request context"
    >
      <p className="font-semibold text-slate-950">Customer team invitation</p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</dt>
          <dd className="break-all font-medium">{currentRequest.targetEmail}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Role</dt>
          <dd className="font-medium">{currentRequest.requestedRole.toLowerCase()}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Request state
          </dt>
          <dd className="font-medium">{currentRequest.status.replace(/_/g, ' ').toLowerCase()}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            External effect
          </dt>
          <dd
            className={
              invitationSent ? 'font-medium text-emerald-800' : 'font-medium text-amber-800'
            }
          >
            {invitationSent ? 'Provider invitation confirmed' : 'No invitation sent'}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-slate-600">
        Source: support request {currentRequest.supportRequestId}, message{' '}
        {currentRequest.sourceSupportMessageId}. The requested membership is tenant-wide; this venue
        identifies the verified evidence scope.
      </p>
      {executionReady ? (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs leading-5 text-amber-950">
            Human approval is recorded. Continuing may send an external provider invitation email;
            accepted membership is still synchronized from the provider.
          </p>
          <button
            type="button"
            className="mt-3 min-h-11 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={pending}
            onClick={() => void executeInvitation()}
          >
            {pending
              ? 'Confirming provider outcome…'
              : currentRequest.status === 'RECONCILIATION_REQUIRED'
                ? 'Reconcile approved invitation'
                : 'Send approved invitation'}
          </button>
        </div>
      ) : null}
      {feedback ? (
        <p
          className={`mt-3 text-sm ${feedback.kind === 'error' ? 'text-rose-800' : 'text-emerald-800'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
      <Link
        className="mt-2 inline-flex min-h-10 items-center font-semibold text-sky-800 underline-offset-4 hover:underline"
        href={`/admin/clients/${encodeURIComponent(tenantId)}/venues/${encodeURIComponent(venueId)}/support-operations`}
      >
        Review support context
      </Link>
    </div>
  )
}
