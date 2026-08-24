'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = {
  tenantId: string
  venueId: string
  approvalRequestId: string
  proposedAction: string
}

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

export function ApprovalDecisionForm({
  tenantId,
  venueId,
  approvalRequestId,
  proposedAction,
}: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const active = useRef(false)
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | 'CANCELLED'>('REJECTED')
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [requiresRefresh, setRequiresRefresh] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const isSupportInformationRequest =
    proposedAction === 'pathfinder.apply_support_information_request'
  const isSupportCompletion = proposedAction === 'pathfinder.apply_support_completion'
  const isSupportPackageDraft = proposedAction === 'pathfinder.apply_support_package_draft'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || requiresRefresh) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = isSupportPackageDraft
        ? await client.admin.decideSupportPackageDraftProposal.mutate({
            operationId: crypto.randomUUID(),
            tenantId,
            venueId,
            approvalRequestId,
            decision,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          })
        : isSupportCompletion
          ? await client.admin.decideSupportCompletionProposal.mutate({
              operationId: crypto.randomUUID(),
              tenantId,
              venueId,
              approvalRequestId,
              decision,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            })
          : isSupportInformationRequest
            ? await client.admin.decideSupportInformationRequestProposal.mutate({
                operationId: crypto.randomUUID(),
                tenantId,
                venueId,
                approvalRequestId,
                decision,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              })
            : proposedAction === 'pathfinder.apply_support_triage'
              ? await client.admin.decideSupportTriageProposal.mutate({
                  operationId: crypto.randomUUID(),
                  tenantId,
                  venueId,
                  approvalRequestId,
                  decision,
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                })
              : await client.admin.recordApprovalDecision.mutate({
                  tenantId,
                  venueId,
                  approvalRequestId,
                  decision,
                  ...(reason.trim() ? { reason: reason.trim() } : {}),
                })
      if (result.executionTriggered !== false) throw new Error('Unexpected execution state')
      setFeedback({
        kind: 'success',
        text:
          isSupportPackageDraft && decision === 'APPROVED'
            ? 'APPROVED decision recorded. Exact one-shot package-DRAFT authority was issued; no package was created, approved, applied, or published.'
            : isSupportCompletion && decision === 'APPROVED'
              ? 'APPROVED decision recorded. Exact one-shot support-completion authority was issued; no message was sent and no lifecycle state changed.'
              : isSupportInformationRequest && decision === 'APPROVED'
                ? 'APPROVED decision recorded. Exact one-shot client information-request authority was issued; no message was sent and no lifecycle state changed.'
                : proposedAction === 'pathfinder.apply_support_triage' && decision === 'APPROVED'
                  ? 'APPROVED decision recorded. Exact one-shot triage authority was issued; no action was executed.'
                  : `${decision.replace(/_/g, ' ')} decision recorded. No action was executed.`,
      })
      setRequiresRefresh(true)
      router.refresh()
    } catch (error) {
      setRequiresRefresh(true)
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'This request is expired or already has a decision. No action was executed. Refresh its state.'
            : 'The decision outcome could not be confirmed. No execution was requested. Refresh its state before retrying.',
      })
    } finally {
      active.current = false
      setPending(false)
    }
  }

  async function refreshState() {
    if (active.current) return
    active.current = true
    setPending(true)
    try {
      const request = await client.admin.getApprovalRequest.query({
        tenantId,
        venueId,
        approvalRequestId,
      })
      if (request.state === 'PENDING') {
        setRequiresRefresh(false)
        setFeedback({
          kind: 'success',
          text: 'Request is still pending. No action has been executed.',
        })
      } else {
        setFeedback({
          kind: 'success',
          text: `Request state is ${request.state.replace(/_/g, ' ')}. No action was executed by this decision form.`,
        })
      }
      router.refresh()
    } catch {
      setFeedback({
        kind: 'error',
        text: 'Approval state could not be refreshed. No new decision or execution was attempted.',
      })
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"
      aria-busy={pending}
    >
      <p className="font-semibold text-amber-950">Record a terminal decision</p>
      <p className="mt-1 text-xs leading-5 text-amber-900">
        {isSupportPackageDraft
          ? 'Approval issues exact one-shot authority to create and link only the reviewed V3 package DRAFT. The decision itself creates no package, changes no support state, and cannot approve, apply, publish, or roll back content.'
          : isSupportCompletion
            ? 'Approval issues exact one-shot authority to create the reviewed in-app client-visible completion message and move this unchanged request to COMPLETED. The decision itself does not contact the client or change lifecycle state.'
            : isSupportInformationRequest
              ? 'Approval issues exact one-shot authority to create the reviewed in-app client-visible prompt and move this unchanged request to WAITING FOR CLIENT. The decision itself does not contact the client or change lifecycle state.'
              : proposedAction === 'pathfinder.apply_support_triage'
                ? 'Approval issues exact one-shot authority for the reviewed request version. The decision itself does not apply triage, send a message, or change lifecycle state.'
                : `Approval records evidence only. It does not run, apply, publish, retry, or enqueue “${proposedAction}”.`}
      </p>
      <fieldset disabled={pending || requiresRefresh} className="mt-3">
        <legend className="sr-only">Decision</legend>
        <div className="flex flex-wrap gap-3">
          {(['APPROVED', 'REJECTED', 'CANCELLED'] as const).map((value) => (
            <label
              key={value}
              className="flex min-h-10 items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 text-sm font-semibold text-pf-deep"
            >
              <input
                type="radio"
                name={`decision-${approvalRequestId}`}
                value={value}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {value}
            </label>
          ))}
        </div>
        <label className="mt-3 grid gap-1 text-sm font-semibold text-pf-deep">
          Decision reason (optional)
          <textarea
            rows={2}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="rounded-xl border border-amber-300 bg-white px-3 py-2 font-normal"
          />
        </label>
        <button
          type="submit"
          disabled={pending || requiresRefresh}
          className="mt-3 min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? 'Working…' : `Record ${decision.toLowerCase()} decision`}
        </button>
      </fieldset>
      {requiresRefresh && !pending ? (
        <button
          type="button"
          onClick={() => void refreshState()}
          className="mt-3 min-h-10 rounded-xl border border-amber-300 bg-white px-4 text-sm font-semibold text-pf-primary"
        >
          Refresh approval state
        </button>
      ) : null}
      {feedback ? (
        <p
          className={`mt-3 text-sm ${feedback.kind === 'error' ? 'text-rose-800' : 'text-emerald-800'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </form>
  )
}
