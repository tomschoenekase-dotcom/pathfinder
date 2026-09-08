export const dynamic = 'force-dynamic'

import { KnowledgeProposalReview } from '../../../../../../../../components/admin/KnowledgeProposalReview'
import { ConversationLearningWorkspace } from '../../../../../../../../components/admin/ConversationLearningWorkspace'
import { projectConversationLearningCandidate } from '../../../../../../../../lib/conversation-learning-projection'
import { createAdminCaller } from '../../../../../../../../lib/admin-caller'

export default async function KnowledgeProposalsPage({
  params,
}: {
  params: Promise<{ tenantId: string; venueId: string }>
}) {
  const { tenantId, venueId } = await params
  const caller = await createAdminCaller()
  try {
    const [proposals, learning] = await Promise.all([
      caller.admin.listKnowledgeProposals({ tenantId, venueId, limit: 100 }),
      Promise.all([
        caller.admin.getConversationLearningPolicy({ tenantId, venueId }),
        caller.admin.listConversationLearningCandidates({ tenantId, venueId, limit: 50 }),
      ])
        .then(([policy, candidates]) => ({
          policy,
          candidates: candidates.map((candidate) =>
            projectConversationLearningCandidate(candidate, { tenantId, venueId }),
          ),
        }))
        .catch(() => null),
    ])
    return (
      <div className="space-y-8">
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
        {learning ? (
          <ConversationLearningWorkspace
            tenantId={tenantId}
            venueId={venueId}
            policy={learning.policy.policy}
            policyUpdatedAt={learning.policy.updatedAt}
            candidates={learning.candidates}
          />
        ) : (
          <p role="alert" className="border-t border-slate-200 pt-4 text-sm text-slate-700">
            Conversation candidates could not be loaded. Refresh to try again.
          </p>
        )}
      </div>
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
