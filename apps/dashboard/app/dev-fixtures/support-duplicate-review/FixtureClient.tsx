'use client'
import { useState } from 'react'
import { KnowledgeProposalReview } from '../../../components/admin/KnowledgeProposalReview'
import { SemanticUpdatePreview } from '../../../components/admin/SemanticUpdatePreview'
import { TRPCProvider } from '../../../lib/trpc'
export function SupportDuplicateReviewFixture() {
  const [recorded, setRecorded] = useState(false)
  return (
    <TRPCProvider scopeKey="support-duplicate-review-fixture">
      <main className="min-h-screen bg-pf-cream px-4 py-8 text-pf-deep sm:px-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <header>
            <h1 className="text-3xl font-semibold">Review existing guidance</h1>
            <p className="mt-2 text-sm leading-6">
              A reviewed support request matches the current gallery guidance. Record the review
              without changing the guidance.
            </p>
          </header>
          <section aria-labelledby="duplicate-proposal-heading">
            <h2 id="duplicate-proposal-heading" className="mb-4 text-xl font-semibold">
              Gallery hours request
            </h2>
            <SemanticUpdatePreview
              tenantId="fixture-duplicate-tenant"
              venueId="fixture-duplicate-venue"
              proposalId="11111111-1111-4111-8111-111111111111"
              proposalUpdatedAt="2026-09-10T12:00:00.000Z"
              hasTarget
              hasSupportProvenance
              onDuplicateRecorded={() => setRecorded(true)}
              resolutionDraft={{
                relation: 'CORRECTS',
                desired: {
                  title: 'Willow gallery hours',
                  category: 'Hours',
                  content: 'The Willow gallery closes at 5 PM.',
                  isEnabled: true,
                },
              }}
            />
          </section>
          <section aria-labelledby="retained-duplicate-heading">
            <h2 id="retained-duplicate-heading" className="mb-4 text-xl font-semibold">
              Retained review history
            </h2>
            <KnowledgeProposalReview
              tenantId="fixture-duplicate-tenant"
              venueId="fixture-duplicate-venue"
              proposals={[true, false].map((proposalRevisionCurrent, index) => ({
                id: `33333333-3333-4333-8333-33333333333${index}`,
                status: 'APPROVED',
                observedVisitorClaim: null,
                aiInference: null,
                proposedChange: 'The Willow gallery closes at 5 PM.',
                reason: 'Retained duplicate review fixture',
                confidence: 1,
                evidenceMessageIds: [],
                targetKnowledgeEntryId: 'fixture-gallery-hours',
                createdAt: '2026-09-10T11:00:00.000Z',
                updatedAt: '2026-09-10T12:00:00.000Z',
                reviewerId: 'fixture-reviewer',
                reviewNote: 'Compared against current guidance at review time.',
                reviewedAt: '2026-09-10T12:00:00.000Z',
                duplicateResolution: {
                  resolutionId: `44444444-4444-4444-8444-44444444444${index}`,
                  outcome: 'DUPLICATE_NOOP' as const,
                  targetKnowledgeEntryId: 'fixture-gallery-hours',
                  relation: 'CORRECTS',
                  createdAt: '2026-09-10T12:00:00.000Z',
                  proposalRevisionCurrent,
                  currentFulfillmentVerified: false as const,
                },
              }))}
            />
          </section>
          {recorded ? <p role="status">Review recorded in this synthetic fixture.</p> : null}
        </div>
      </main>
    </TRPCProvider>
  )
}
