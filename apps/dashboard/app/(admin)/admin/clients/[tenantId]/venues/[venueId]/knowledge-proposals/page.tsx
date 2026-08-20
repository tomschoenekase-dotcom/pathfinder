export const dynamic = 'force-dynamic'

import { KnowledgeProposalReview } from '../../../../../../../../components/admin/KnowledgeProposalReview'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

export default async function KnowledgeProposalsPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  try {
    const proposals = await caller.admin.listKnowledgeProposals({ tenantId, venueId, limit: 100 })
    return (
      <KnowledgeProposalReview
        tenantId={tenantId}
        venueId={venueId}
        proposals={proposals.map((proposal) => ({
          ...proposal,
          confidence: Number(proposal.confidence),
          evidenceMessageIds: Array.isArray(proposal.evidenceMessageIds)
            ? proposal.evidenceMessageIds.filter(
                (value): value is string => typeof value === 'string',
              )
            : [],
        }))}
      />
    )
  } catch {
    return (
      <section className="rounded-3xl border border-rose-200 bg-white p-8" role="alert">
        <h1 className="text-2xl font-semibold text-slate-950">
          Knowledge proposals could not be loaded
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Refresh the page or return later. No proposal was changed.
        </p>
      </section>
    )
  }
}
