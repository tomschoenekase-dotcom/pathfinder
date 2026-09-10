'use client'

import {
  KnowledgeProposalReview,
  type KnowledgeProposal,
} from '../../../components/admin/KnowledgeProposalReview'
import { SupportCompletionApprovalContext } from '../../../components/admin/SupportCompletionApprovalContext'
import { SupportManualLoopActions } from '../../../components/admin/SupportManualLoopActions'
import { TRPCProvider } from '../../../lib/trpc'

const base: Omit<KnowledgeProposal, 'id' | 'status' | 'proposedChange' | 'updatedAt'> = {
  observedVisitorClaim: null,
  aiInference: null,
  reason: 'A support source was reviewed by an operator.',
  confidence: 0.91,
  evidenceMessageIds: ['message-1'],
  targetKnowledgeEntryId: 'entry-1',
  createdAt: '2026-09-10T10:00:00.000Z',
  reviewerId: null,
  reviewNote: null,
  reviewedAt: null,
  supportRequestId: 'request-1',
  supportRequestVersion: 7,
  hasSupportProvenance: true,
}

const proposals: KnowledgeProposal[] = [
  {
    ...base,
    id: '11111111-1111-4111-8111-111111111111',
    status: 'PENDING_REVIEW',
    proposedChange: 'Replace the accessible entrance directions.',
    updatedAt: '2026-09-10T12:00:00.000Z',
    canRecordReviewedDecline: true,
  },
  {
    ...base,
    id: '22222222-2222-4222-8222-222222222222',
    status: 'REJECTED',
    proposedChange: 'Describe a seasonal route as permanent.',
    updatedAt: '2026-09-10T12:01:00.000Z',
    canRecordReviewedDecline: true,
    reviewerId: 'admin-1',
    reviewNote: 'Initial proposal rejected.',
    reviewedAt: '2026-09-10T12:01:00.000Z',
  },
  {
    ...base,
    id: '33333333-3333-4333-8333-333333333333',
    status: 'REJECTED',
    proposedChange: 'Current reviewed decline receipt.',
    updatedAt: '2026-09-10T12:02:00.000Z',
    canRecordReviewedDecline: false,
    reviewedDecline: {
      resolutionId: 'resolution-current',
      outcome: 'REVIEWED_DECLINE',
      createdAt: '2026-09-10T12:03:00.000Z',
      proposalRevisionCurrent: true,
      currentFulfillmentVerified: false,
    },
  },
  {
    ...base,
    id: '44444444-4444-4444-8444-444444444444',
    status: 'REJECTED',
    proposedChange: 'Stale reviewed decline receipt.',
    updatedAt: '2026-09-10T12:04:00.000Z',
    canRecordReviewedDecline: false,
    reviewedDecline: {
      resolutionId: 'resolution-stale',
      outcome: 'REVIEWED_DECLINE',
      createdAt: '2026-09-10T12:03:00.000Z',
      proposalRevisionCurrent: false,
      currentFulfillmentVerified: false,
    },
  },
]

const reviewedDeclines = [
  {
    proposalSummary: 'Replace the accessible entrance directions.',
    reviewNote: 'The source did not establish a permanent route. Keep the reviewed wording.',
  },
]

export function SupportReviewedDeclineFixtureClient() {
  return (
    <TRPCProvider scopeKey="support-reviewed-decline-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 text-pf-deep sm:px-8">
        <div className="mx-auto max-w-6xl space-y-10">
          <header className="border-b border-pf-light pb-5">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
              Support evidence review
            </p>
            <h1 className="mt-2 text-3xl font-semibold">Review declined support changes</h1>
          </header>
          <KnowledgeProposalReview
            tenantId="fixture-decline-tenant"
            venueId="fixture-decline-venue"
            proposals={proposals}
          />
          <section aria-labelledby="completion-heading">
            <h2 id="completion-heading" className="mb-4 text-xl font-semibold">
              Completion review
            </h2>
            <SupportManualLoopActions
              tenantId="fixture-decline-tenant"
              venueId="fixture-decline-venue"
              requestId="55555555-5555-4555-8555-555555555555"
              expectedVersion={7}
              currentStatus="IN_REVIEW"
              missingInformation={[]}
            />
          </section>
          <section aria-labelledby="founder-heading">
            <h2 id="founder-heading" className="text-xl font-semibold">
              Founder approval context
            </h2>
            <SupportCompletionApprovalContext
              proposal={{
                completionOutcome: 'RESOLVED',
                reviewedDeclines,
                body: 'We reviewed your request. The existing visitor guidance remains unchanged.\nThank you for the supporting detail.',
              }}
            />
          </section>
        </div>
      </main>
    </TRPCProvider>
  )
}
