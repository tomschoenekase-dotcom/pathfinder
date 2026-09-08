'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

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
}: {
  tenantId: string
  venueId: string
  policy: ConversationLearningPolicy
  policyUpdatedAt: Date | string
  candidates: ConversationLearningCandidate[]
}) {
  const client = useTRPCClient()
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

  return (
    <ConversationLearningReview
      policy={policy}
      candidates={candidates}
      pendingId={pendingId}
      errorMessage={error}
      onPolicyChange={changePolicy}
      onReview={review}
    />
  )
}
