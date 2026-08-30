'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'

import {
  supportRequestTransitionsFrom,
  type SupportRequestStatus,
} from '@pathfinder/contracts/support-workflow'

import { useTRPCClient } from '../../lib/trpc'

const labels: Record<SupportRequestStatus, string> = {
  DRAFT: 'Internal draft',
  OPEN: 'Received',
  WAITING_FOR_CLIENT: 'Waiting for client',
  IN_REVIEW: 'In review',
  PATCH_DRAFTED: 'Package draft recorded',
  VALIDATING: 'Validation / evaluation review',
  AWAITING_APPROVAL: 'Awaiting approval decision',
  APPLYING: 'Apply step recorded',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
}

export function SupportStatusTransitionForm({
  tenantId,
  venueId,
  requestId,
  currentStatus,
  expectedVersion,
}: {
  tenantId: string
  venueId: string
  requestId: string
  currentStatus: SupportRequestStatus
  expectedVersion: number
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const allowed = supportRequestTransitionsFrom(currentStatus).filter(
    (status) => status !== 'WAITING_FOR_CLIENT' && status !== 'COMPLETED',
  )
  const [toStatus, setToStatus] = useState<SupportRequestStatus | ''>(allowed[0] ?? '')
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const active = useRef(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || !toStatus || !confirmed) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      await client.admin.transitionSupportRequestStatus.mutate({
        tenantId,
        venueId,
        requestId,
        expectedVersion,
        toStatus,
      })
      setFeedback(`Support workflow moved to ${labels[toStatus]}. No package action was run.`)
      router.refresh()
    } catch {
      setFeedback(
        'The status outcome could not be confirmed. Your selection is retained; refresh before trying again.',
      )
      router.refresh()
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm">
      <h3 className="text-lg font-semibold text-pf-deep">Advance support workflow</h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/65">
        {currentStatus === 'DRAFT'
          ? 'Opening this internal draft places it in the operator workflow. It does not notify a customer, grant customer access, or apply a venue change.'
          : 'This records support status only. It does not validate, evaluate, approve, apply, or publish a venue package. Evaluation has no separate support status, so validation/evaluation review remains under VALIDATING.'}
      </p>
      {allowed.length === 0 ? (
        <p className="mt-4 text-sm text-pf-deep/65">This request is in a terminal status.</p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="mt-4" aria-busy={pending}>
          <label className="grid gap-2 text-sm font-semibold text-pf-deep">
            Next status
            <select
              value={toStatus}
              onChange={(event) => setToStatus(event.target.value as SupportRequestStatus)}
              disabled={pending}
              className="min-h-11 rounded-xl border border-pf-light bg-white px-3 font-normal"
            >
              {allowed.map((status) => (
                <option key={status} value={status}>
                  {labels[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-4 flex items-start gap-2 text-sm text-pf-deep/75">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={pending}
              className="mt-1"
            />
            I confirm this reflects the current support evidence and does not execute package work.
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending || !toStatus || !confirmed}
              className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? 'Recording…' : 'Record status change'}
            </button>
            <span className="text-xs text-pf-deep/55">Current version {expectedVersion}</span>
          </div>
        </form>
      )}
      {feedback ? (
        <p className="mt-3 text-sm text-pf-deep/70" role="status">
          {feedback}
        </p>
      ) : null}
    </section>
  )
}
