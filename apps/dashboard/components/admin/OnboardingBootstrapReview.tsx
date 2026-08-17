'use client'

import { useEffect, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
import { normalizeTorchikoBrandText } from '@pathfinder/ui'

import { useTRPCClient } from '../../lib/trpc'
import { ReviewedVenuePackageDraftForm } from './ReviewedVenuePackageDraftForm'

type Candidate = inferRouterOutputs<AppRouter>['admin']['getIntakeVenuePackageCandidate']

export function OnboardingBootstrapReview({
  tenantId,
  venueId,
  run,
}: {
  tenantId: string
  venueId: string
  run: {
    id: string
    displayName: string
    status: string
    structuredBootstrap: unknown
  }
}) {
  const client = useTRPCClient()
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)

  useEffect(() => {
    requestSequence.current += 1
    setCandidate(null)
    setBusy(false)
    setError(null)
  }, [run.id, tenantId, venueId])

  async function loadCandidate() {
    const sequence = ++requestSequence.current
    setBusy(true)
    setError(null)
    try {
      const next = await client.admin.getIntakeVenuePackageCandidate.query({
        tenantId,
        venueId,
        runId: run.id,
      })
      if (sequence === requestSequence.current) setCandidate(next)
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : 'The package candidate is unavailable.')
      }
    } finally {
      if (sequence === requestSequence.current) setBusy(false)
    }
  }

  return (
    <article className="rounded-xl border border-pf-light p-4">
      <p className="font-medium text-pf-deep">{normalizeTorchikoBrandText(run.displayName)}</p>
      <p className="mt-1 text-xs uppercase tracking-wide text-pf-deep/60">
        {run.status.replaceAll('_', ' ')}
      </p>
      <p className="mt-2 text-sm text-pf-deep/70">
        Build a deterministic VenuePackage candidate from the stored reviewed proposal. The server
        rebuilds and hash-checks it again before creating and linking a DRAFT.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void loadCandidate()}
        className="mt-3 min-h-11 rounded-full border border-pf-light px-4 text-sm font-medium text-pf-deep disabled:opacity-50"
      >
        {busy
          ? 'Loading candidate…'
          : candidate
            ? 'Reload package candidate'
            : 'Review package candidate'}
      </button>
      {error ? (
        <p className="mt-3 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {candidate && !candidate.ready ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="text-sm font-semibold text-amber-950">Candidate is not ready</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {candidate.issues.map((issue) => (
              <li key={`${issue.code}:${issue.path}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {candidate?.ready && candidate.payload && candidate.candidateHash ? (
        <div className="mt-5">
          <ReviewedVenuePackageDraftForm
            tenantId={tenantId}
            venueId={venueId}
            intakeRunId={run.id}
            prefillCandidate={{
              identity: `${candidate.sourceKind}:${candidate.runId}:${candidate.candidateHash}`,
              expectedCandidateHash: candidate.candidateHash,
              payload: candidate.payload,
              source: {
                kind: candidate.sourceKind,
                label: 'structured onboarding proposal',
                evidenceCount: candidate.summary.candidateCount,
                discrepancyCount: candidate.summary.issueCount,
                confidence: null,
              },
              warnings: candidate.issues.map((issue) => `${issue.path}: ${issue.message}`),
            }}
          />
        </div>
      ) : null}
      <details className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-800">
        <summary className="cursor-pointer font-semibold text-pf-deep">
          View original private proposal
        </summary>
        <pre className="mt-3 overflow-auto whitespace-pre-wrap">
          {JSON.stringify(run.structuredBootstrap, null, 2)}
        </pre>
      </details>
    </article>
  )
}
