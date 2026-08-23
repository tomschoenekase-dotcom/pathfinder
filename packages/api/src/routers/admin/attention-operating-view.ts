import type { deriveAgentTrustEvidence } from './attention-agent-evidence'
import type { deriveFounderBriefing } from './attention-briefing'

type FounderBriefing = ReturnType<typeof deriveFounderBriefing>
type AgentTrustEvidence = ReturnType<typeof deriveAgentTrustEvidence>

export function deriveFounderOperatingView(
  input: {
    generatedAt: Date
    briefing: FounderBriefing
    agentTrustEvidence: AgentTrustEvidence
  },
  transport:
    | 'PLATFORM_ADMIN_SESSION_ONLY'
    | 'PLATFORM_WORKER_CREDENTIAL' = 'PLATFORM_ADMIN_SESSION_ONLY',
) {
  return {
    schemaVersion: 1 as const,
    generatedAt: input.generatedAt,
    scope: 'PLATFORM' as const,
    effect: 'READ_ONLY' as const,
    focus: input.briefing.focus,
    metrics: input.briefing.metrics,
    changesSinceLastReview: input.briefing.reviewState.changesSinceLastReview,
    changeDigest: input.briefing.reviewState.changeDigest,
    boundedSnapshot: input.briefing.boundedSnapshot,
    autonomyEvidence: input.agentTrustEvidence,
    authority: {
      transport,
      customerCredentialCompatible: false as const,
      canExecute: false as const,
      canApprove: false as const,
      canAcknowledge: false as const,
      canMutatePolicy: false as const,
    },
  }
}
