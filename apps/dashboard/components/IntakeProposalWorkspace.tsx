'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import type { StaffInterviewSubmission } from '@pathfinder/contracts/staff-interview'

import { useTRPCClient } from '../lib/trpc'
import { IntakeProposalReview } from './IntakeProposalReview'
import { StaffInterviewCapture } from './StaffInterviewCapture'

type Proposal = {
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
  onSubmit,
}: {
  disabled: boolean
  onSubmit: (input: { displayName: string; websiteUri: string; requestId: string }) => Promise<void>
}) {
  const [displayName, setDisplayName] = useState('')
  const [websiteUri, setWebsiteUri] = useState('')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
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
            setRequestId(crypto.randomUUID())
          })
          .catch(() => undefined)
          .finally(() => {
            submittingRef.current = false
          })
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="font-semibold text-pf-deep">Website source proposal</legend>
        <p className="mt-1 text-sm text-pf-deep/75">
          Record an address for later review. This form does not fetch or crawl it.
        </p>
        <label className="mt-4 block text-sm font-medium text-pf-deep">
          Proposal name
          <input
            required
            maxLength={255}
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value)
              setRequestId(crypto.randomUUID())
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
              setRequestId(crypto.randomUUID())
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
        {disabled ? 'Recording…' : 'Record website proposal'}
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
  proposals: Proposal[]
  adminTenantId?: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
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
      setMessage('Draft proposal recorded for review. Nothing was approved, applied, or published.')
      router.refresh()
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'The proposal was not recorded.'
      setMessage(`${failure} No changes were published.`)
      throw error
    } finally {
      creatingRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="space-y-7">
      <section
        className="rounded-2xl border border-pf-light bg-white p-5"
        aria-labelledby="new-intake-source"
      >
        <h2 id="new-intake-source" className="font-semibold text-pf-deep">
          New draft proposal
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
              Text interview
            </label>
          </div>
        </fieldset>
        <div className="mt-4">
          {source === 'WEBSITE' ? (
            <WebsiteProposalCapture
              disabled={busy}
              onSubmit={(input) => create({ kind: 'WEBSITE', ...input })}
            />
          ) : (
            <StaffInterviewCapture
              disabled={busy}
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
          Proposal history
        </h2>
        {proposals.length ? (
          <ul className="mt-3 space-y-3">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-2xl border border-pf-light bg-white p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{proposal.displayName}</strong>
                  <span>{proposal.status.replaceAll('_', ' ')}</span>
                </div>
                <p className="mt-1 text-sm text-pf-deep/75">
                  {proposal.sourceKind.replaceAll('_', ' ')}
                  {proposal.interviewRole
                    ? ` · ${proposal.interviewRole.replaceAll('_', ' ')}`
                    : ''}{' '}
                  · {proposal._count.evidence} evidence record(s) ·{' '}
                  {proposal.packageHandoff
                    ? `Draft package ${proposal.packageHandoff.packageDraftId}`
                    : 'Awaiting review handoff'}
                </p>
                {proposal.sourceKind === 'INTERVIEW' ? (
                  <IntakeProposalReview
                    venueId={venueId}
                    runId={proposal.id}
                    {...(adminTenantId ? { adminTenantId } : {})}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-6 text-sm text-pf-deep/75">
            No intake proposals yet.
          </p>
        )}
      </section>
    </div>
  )
}
