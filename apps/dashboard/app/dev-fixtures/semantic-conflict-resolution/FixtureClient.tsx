'use client'

import { useEffect, useState } from 'react'

import {
  KnowledgeProposalReview,
  type KnowledgeProposal,
} from '../../../components/admin/KnowledgeProposalReview'
import { TRPCProvider, useTRPCClient } from '../../../lib/trpc'
import { runBoundedClientRequest } from '../../../lib/bounded-client-request'

const scope = {
  tenantId: 'fixture-conflict-tenant',
  venueId: 'fixture-conflict-venue',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
}

function ConnectedReview() {
  const client = useTRPCClient()
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([])
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: 15_000,
      request: (signal) =>
        client.admin.listKnowledgeProposals.query(
          {
            tenantId: scope.tenantId,
            venueId: scope.venueId,
            limit: 100,
          },
          { signal },
        ),
    })
      .then((rows) => {
        if (!controller.signal.aborted)
          setProposals(
            rows.map((row) => ({
              ...row,
              confidence: Number(row.confidence),
              evidenceMessageIds: Array.isArray(row.evidenceMessageIds)
                ? row.evidenceMessageIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [],
            })),
          )
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Fixture list failed.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [client, reload])
  return (
    <>
      <button
        type="button"
        disabled={loading}
        onClick={() => setReload((value) => value + 1)}
        className="mb-4 min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold"
      >
        Reload proposals
      </button>
      {loading ? <p role="status">Loading native fixture proposals...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <KnowledgeProposalReview
        tenantId={scope.tenantId}
        venueId={scope.venueId}
        proposals={proposals}
      />
    </>
  )
}

function FixtureBody({ connected }: { connected: boolean }) {
  return (
    <main
      data-fixture="semantic-conflict-resolution"
      className="min-h-screen bg-pf-cream px-4 py-8 text-pf-deep sm:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-pf-light pb-6">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-pf-primary">
            Human conflict review
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Resolve venue guidance</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/70">
            Bind the operator answer to an explicit decision. Replacement wording still returns to
            human review before any visitor-facing draft or publication.
          </p>
        </header>
        <div className="mt-6">
          {connected ? (
            <ConnectedReview />
          ) : (
            <KnowledgeProposalReview
              tenantId={scope.tenantId}
              venueId={scope.venueId}
              proposals={[
                {
                  id: scope.proposalId,
                  status: 'APPROVED',
                  observedVisitorClaim: 'A support source reports later Willow gallery hours.',
                  aiInference: 'The proposed time conflicts with reviewed venue guidance.',
                  proposedChange: desired.content,
                  reason: 'An operator must resolve the lower-authority conflict.',
                  confidence: 0.9,
                  evidenceMessageIds: ['fixture-message-hours'],
                  targetKnowledgeEntryId: 'fixture-current-hours',
                  createdAt: '2026-09-10T11:55:00.000Z',
                  updatedAt: scope.proposalUpdatedAt,
                  reviewerId: 'fixture-reviewer',
                  reviewNote: 'Evidence reviewed; semantic conflict remains.',
                  reviewedAt: '2026-09-10T12:00:00.000Z',
                  createdByType: 'AGENT',
                },
              ]}
            />
          )}
        </div>
      </div>
    </main>
  )
}

const desired = {
  title: 'Willow gallery hours',
  category: 'Hours',
  content: 'The Willow gallery closes at 7 PM.',
  isEnabled: true,
}

export function SemanticConflictResolutionFixtureClient({
  connected = false,
}: {
  connected?: boolean
}) {
  return (
    <TRPCProvider scopeKey="semantic-conflict-resolution-fixture">
      <FixtureBody connected={connected} />
    </TRPCProvider>
  )
}
