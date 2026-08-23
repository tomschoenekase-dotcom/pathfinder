import Link from 'next/link'

type CustomerAccessRequest = {
  id: string
  targetEmail: string
  requestedRole: string
  status: string
  supportRequestId: string
  sourceSupportMessageId: string
  providerInvitationId: string | null
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
  if (!request) return null

  const invitationSent = request.status === 'INVITED' && request.providerInvitationId !== null

  return (
    <div
      className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-slate-800"
      aria-label="Customer access request context"
    >
      <p className="font-semibold text-slate-950">Customer team invitation</p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Email</dt>
          <dd className="break-all font-medium">{request.targetEmail}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Role</dt>
          <dd className="font-medium">{request.requestedRole.toLowerCase()}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Request state
          </dt>
          <dd className="font-medium">{request.status.replace(/_/g, ' ').toLowerCase()}</dd>
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
        Source: support request {request.supportRequestId}, message {request.sourceSupportMessageId}
        . The requested membership is tenant-wide; this venue identifies the verified evidence
        scope.
      </p>
      <Link
        className="mt-2 inline-flex min-h-10 items-center font-semibold text-sky-800 underline-offset-4 hover:underline"
        href={`/admin/clients/${encodeURIComponent(tenantId)}/venues/${encodeURIComponent(venueId)}/support-operations`}
      >
        Review support context
      </Link>
    </div>
  )
}
