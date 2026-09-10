'use client'

import { KnowledgeProposalReview } from '../../../components/admin/KnowledgeProposalReview'
import { TRPCProvider } from '../../../lib/trpc'

const scope = {
  tenantId: 'fixture-conflict-tenant',
  venueId: 'fixture-conflict-venue',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
}

function FixtureBody() {
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

export function SemanticConflictResolutionFixtureClient() {
  return (
    <TRPCProvider scopeKey="semantic-conflict-resolution-fixture">
      <FixtureBody />
    </TRPCProvider>
  )
}
