import {
  ConversationLearningActionError,
  recordConversationLearningCandidate,
} from '@pathfinder/db'

import { classifyConversationLearningCandidate } from './conversation-learning-candidate'

/** Uses only the already-persisted, authorized turn; no extra transcript copy. */
export async function captureConversationLearning(input: {
  tenantId: string
  venueId: string
  sessionId: string
  guestChatTurnId: string
  userMessageId: string
  message: string
  sourceScope: 'PUBLIC' | 'SECOND_LAYER'
  actor?: { id: string; role: 'OWNER' | 'MANAGER' | 'STAFF' }
}): Promise<void> {
  const candidate = classifyConversationLearningCandidate(input.message)
  if (!candidate) return
  try {
    await recordConversationLearningCandidate({
      tenantId: input.tenantId,
      venueId: input.venueId,
      sessionId: input.sessionId,
      guestChatTurnId: input.guestChatTurnId,
      userMessageId: input.userMessageId,
      source: input.sourceScope,
      ...(input.actor ? { authenticatedActorRef: input.actor.id } : {}),
      summary: candidate.summary,
      classifier: { kind: candidate.kind, version: 'conversation-learning-en-v1' },
      hedged: candidate.hedged,
    })
  } catch (error) {
    // Disabled capture or a revoked employee membership is an expected skip.
    if (error instanceof ConversationLearningActionError && error.code === 'FORBIDDEN') return
    throw error
  }
}
