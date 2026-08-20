'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import type { StaffInterviewSubmission } from '@pathfinder/contracts/staff-interview'
import { normalizeTorchikoBrandText } from '@pathfinder/ui'

import { useTRPCClient } from '../lib/trpc'
import { browserUuid } from '../lib/browser-uuid'
import { IntakeProposalReview } from './IntakeProposalReview'
import { StaffInterviewCapture } from './StaffInterviewCapture'

export type IntakeProposalSummary = {
  id: string
  sourceKind: string
  status: string
  displayName: string
  websiteUri: string | null
  interviewRole: string | null
  createdAt: Date
  _count: { evidence: number; events: number }
  packageHandoff: { packageDraftId: string; createdAt: Date } | null
}

function WebsiteProposalCapture({
  disabled,
  clientFacing,
  onSubmit,
}: {
  disabled: boolean
  clientFacing: boolean
  onSubmit: (input: { displayName: string; websiteUri: string; requestId: string }) => Promise<void>
}) {
  const [displayName, setDisplayName] = useState('')
  const [websiteUri, setWebsiteUri] = useState('')
  const [requestId, setRequestId] = useState(browserUuid)
  const submittingRef = useRef(false)
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (submittingRef.current) return
        submittingRef.current = true
        void onSubmit({ displayName: displayName.trim(), websiteUri, requestId })
          .then(() => {
            setDisplayName('')
            setWebsiteUri('')
            setRequestId(browserUuid())
          })
          .catch(() => undefined)
          .finally(() => {
            submittingRef.current = false
          })
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="font-semibold text-pf-deep">
          {clientFacing ? 'Share a website' : 'Website source proposal'}
        </legend>
        <p className="mt-1 text-sm text-pf-deep/75">
          {clientFacing
            ? 'Add a website address for the Torchiko team to review. Nothing is published from this step.'
            : 'Record an address for later review. This form does not fetch or crawl it.'}
        </p>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          {clientFacing ? 'Website name' : 'Proposal name'}
          <input
            required
            maxLength={255}
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value)
              setRequestId(browserUuid())
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          Website URL
          <input
            required
            type="url"
            maxLength={2000}
            value={websiteUri}
            onChange={(event) => {
              setWebsiteUri(event.target.value)
              setRequestId(browserUuid())
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
      </fieldset>
      <button
        type="submit"
        disabled={disabled || !displayName.trim() || !websiteUri.trim()}
        className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {disabled
          ? clientFacing
            ? 'Sharing…'
            : 'Recording…'
          : clientFacing
            ? 'Share website'
            : 'Record website proposal'}
      </button>
    </form>
  )
}

export function IntakeProposalWorkspace({
  venueId,
  proposals,
  adminTenantId,
}: {
  venueId: string
  proposals: IntakeProposalSummary[]
  adminTenantId?: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const clientFacing = !adminTenantId
  const [source, setSource] = useState<'WEBSITE' | 'INTERVIEW'>('WEBSITE')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const creatingRef = useRef(false)

  async function create(
    proposal:
      | {
          kind: 'WEBSITE'
          displayName: string
          websiteUri: string
          requestId: string
        }
      | {
          kind: 'INTERVIEW'
          displayName: string
          requestId: string
          submission: StaffInterviewSubmission
        },
  ) {
    if (creatingRef.current) return
    creatingRef.current = true
    setBusy(true)
    setMessage(null)
    try {
      if (adminTenantId) {
        await client.admin.createIntakeProposal.mutate({
          tenantId: adminTenantId,
          venueId,
          ...proposal,
        })
      } else {
        await client.intake.createProposal.mutate({ venueId, ...proposal })
      }
      setMessage(
        clientFacing
          ? 'Information received. The Torchiko team will review it before use.'
          : 'Draft proposal recorded for review. Nothing was approved, applied, or published.',
      )
      router.refresh()
    } catch (error) {
      const failure = clientFacing
        ? 'Torchiko could not receive this information.'
        : error instanceof Error
          ? error.message
          : 'The proposal was not recorded.'
      setMessage(
        clientFacing
          ? `${failure} Your information was not shared.`
          : `${failure} No changes were published.`,
      )
      throw error
    } finally {
      creatingRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-7">
      <section
        id="website-source"
        className="rounded-2xl border border-pf-light bg-white p-5"
        aria-labelledby="new-intake-source"
      >
        <h2 id="new-intake-source" className="font-semibold text-pf-deep">
          {clientFacing ? 'Share more information' : 'New draft proposal'}
        </h2>
        <fieldset className="mt-3" disabled={busy}>
          <legend className="sr-only">Choose source type</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                checked={source === 'WEBSITE'}
                onChange={() => setSource('WEBSITE')}
              />{' '}
              Website
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                checked={source === 'INTERVIEW'}
                onChange={() => setSource('INTERVIEW')}
              />{' '}
              {clientFacing ? 'Staff questionnaire' : 'Text interview'}
            </label>
          </div>
        </fieldset>
        <div className="mt-4">
          {source === 'WEBSITE' ? (
            <WebsiteProposalCapture
              disabled={busy}
              clientFacing={clientFacing}
              onSubmit={(input) => create({ kind: 'WEBSITE', ...input })}
            />
          ) : (
            <StaffInterviewCapture
              disabled={busy}
              clientFacing={clientFacing}
              onSubmit={(input) => create({ kind: 'INTERVIEW', ...input })}
            />
          )}
        </div>
        <p aria-live="polite" aria-atomic="true" className="mt-3 text-sm text-pf-deep/75">
          {message}
        </p>
      </section>
      <section aria-labelledby="proposal-history">
        <h2 id="proposal-history" className="text-xl font-semibold text-pf-deep">
          {clientFacing ? 'Information shared' : 'Proposal history'}
        </h2>
        {proposals.length ? (
          <ul className="mt-3 space-y-3">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{normalizeTorchikoBrandText(proposal.displayName)}</strong>
                  <span>
                    {clientFacing
                      ? proposal.status === 'AWAITING_REVIEW'
                        ? 'Received'
                        : 'Reviewed'
                      : proposal.status.replaceAll('_', ' ')}
                  </span>
                </div>
                <p className="mt-1 text-sm text-pf-deep/75">
                  {clientFacing ? (
                    <>
                      {proposal.sourceKind === 'INTERVIEW' ? 'Staff answers' : 'Website'} ·{' '}
                      {proposal.packageHandoff ? 'Prepared for Torchiko review' : 'Review pending'}
                    </>
                  ) : (
                    <>
                      {proposal.sourceKind.replaceAll('_', ' ')}
                      {proposal.interviewRole
                        ? ` · ${proposal.interviewRole.replaceAll('_', ' ')}`
                        : ''}{' '}
                      · {proposal._count.evidence} evidence record(s) ·{' '}
                      {proposal.packageHandoff
                        ? `Draft package ${proposal.packageHandoff.packageDraftId}`
                        : 'Awaiting review handoff'}
                    </>
                  )}
                </p>
                {proposal.sourceKind === 'INTERVIEW' ? (
                  <IntakeProposalReview
                    venueId={venueId}
                    runId={proposal.id}
                    clientFacing={clientFacing}
                    {...(adminTenantId ? { adminTenantId } : {})}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/75">
            {clientFacing
              ? 'No websites or staff answers have been shared yet.'
              : 'No intake proposals yet.'}
          </p>
        )}
      </section>
    </div>
  )
}
