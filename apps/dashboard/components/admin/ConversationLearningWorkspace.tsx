'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { ConversationLearningProposalDraft } from './ConversationLearningProposalDraft'

import { useTRPCClient } from '../../lib/trpc'
import {
  ConversationLearningReview,
  type ConversationLearningCandidate,
  type ConversationLearningPolicy,
  type ConversationLearningReview as ReviewCommand,
} from './ConversationLearningReview'

export function ConversationLearningWorkspace({
  tenantId,
  venueId,
  policy,
  policyUpdatedAt,
  candidates,
  activeProposalInsightIds = [],
}: {
  tenantId: string
  venueId: string
  policy: ConversationLearningPolicy
  policyUpdatedAt: Date | string
  candidates: ConversationLearningCandidate[]
  activeProposalInsightIds?: string[]
}) {
  const client = useTRPCClient()
  const draftOperation = useRef<{ key: string; operationId: string } | null>(null)
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function changePolicy(nextPolicy: ConversationLearningPolicy) {
    setPendingId('policy')
    setError(null)
    try {
      await client.admin.updateConversationLearningPolicy.mutate({
        tenantId,
        venueId,
        operationId: crypto.randomUUID(),
        policy: nextPolicy,
        expectedUpdatedAt: new Date(policyUpdatedAt),
      })
      router.refresh()
    } catch {
      setError(
        'The learning policy could not be saved. Refresh to check the latest setting before retrying.',
      )
    } finally {
      setPendingId(null)
    }
  }

  async function review(command: ReviewCommand) {
    setPendingId(command.id)
    setError(null)
    try {
      await client.admin.reviewConversationLearningCandidate.mutate({
        tenantId,
        venueId,
        operationId: crypto.randomUUID(),
        insightId: command.id,
        expectedRevision: command.expectedRevision,
        action: command.decision === 'ACCEPT' ? 'ACCEPT_FOR_PROPOSAL' : command.decision,
        summary: command.summary,
        reviewerFeedback: command.feedback,
      })
      router.refresh()
    } catch {
      throw new Error(
        'The candidate changed or could not be saved. Refresh to check the latest review before retrying.',
      )
    } finally {
      setPendingId(null)
    }
  }

  async function createDraft(
    candidate: ConversationLearningCandidate,
    draft: { proposedChange: string; reason: string },
  ) {
    if (candidate.reviewStatus !== 'ACKNOWLEDGED' || !candidate.evidenceMessageIds?.length)
      throw new Error('Review the source candidate before preparing a proposal.')
    const request = {
      tenantId,
      venueId,
      conversationInsightId: candidate.id,
      proposedChange: draft.proposedChange,
      reason: draft.reason,
      confidence: 0,
      evidenceMessageIds: candidate.evidenceMessageIds,
      submitForReview: false,
    }
    const key = JSON.stringify({ request, candidateRevision: candidate.candidateRevision })
    if (draftOperation.current?.key !== key)
      draftOperation.current = { key, operationId: crypto.randomUUID() }
    setPendingId(candidate.id)
    try {
      await client.admin.createKnowledgeProposal.mutate({
        ...request,
        operationId: draftOperation.current.operationId,
      })
      router.refresh()
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <ConversationLearningReview
        policy={policy}
        candidates={candidates}
        pendingId={pendingId}
        errorMessage={error}
        onPolicyChange={changePolicy}
        onReview={review}
      />
      {candidates
        .filter(
          (candidate) =>
            candidate.reviewStatus === 'ACKNOWLEDGED' &&
            candidate.evidenceMessageIds?.length &&
            !activeProposalInsightIds.includes(candidate.id),
        )
        .map((candidate) => (
          <ConversationLearningProposalDraft
            key={`${tenantId}:${venueId}:${candidate.id}:${candidate.candidateRevision}`}
            candidate={candidate}
            disabled={pendingId !== null}
            onCreate={(draft) => createDraft(candidate, draft)}
          />
        ))}
    </div>
  )
}
