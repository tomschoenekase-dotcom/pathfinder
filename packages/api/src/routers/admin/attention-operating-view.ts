import type { deriveAgentTrustEvidence } from './attention-agent-evidence'
import type { deriveFounderBriefing } from './attention-briefing'
import type { deriveFounderAbsenceReadiness } from './attention-founder-absence'
import type { readFounderUnitEconomics } from './unit-economics'

type FounderBriefing = ReturnType<typeof deriveFounderBriefing>
type AgentTrustEvidence = ReturnType<typeof deriveAgentTrustEvidence>
type FounderUnitEconomics = Awaited<ReturnType<typeof readFounderUnitEconomics>>
type FounderAbsenceReadinessBase = ReturnType<typeof deriveFounderAbsenceReadiness>
type FounderAbsenceReadiness = Omit<FounderAbsenceReadinessBase, 'target' | 'evidenceWindow'> & {
  target: Omit<
    FounderAbsenceReadinessBase['target'],
    'observationState' | 'observedDays' | 'explanation'
  > & {
    observationState: 'NOT_STARTED' | 'IN_PROGRESS' | 'READY_FOR_REVIEW'
    observedDays: number
    explanation: string
  }
  evidenceWindow: Omit<
    FounderAbsenceReadinessBase['evidenceWindow'],
    'historicalContinuityVerified'
  > & {
    historicalContinuityVerified: boolean
  }
}

export function deriveFounderOperatingView(
  input: {
    generatedAt: Date
    briefing: FounderBriefing
    agentTrustEvidence: AgentTrustEvidence
    unitEconomics: FounderUnitEconomics
    founderAbsenceReadiness: FounderAbsenceReadiness
    founderConversation: Array<{
      id: string
      operationId: string
      prompt: string
      intent: string
      disposition: string
      responseTitle: string
      responseBody: string
      evidence: unknown
      snapshot: unknown
      snapshotHash: string
      createdAt: Date
    }>
  },
  transport:
    | 'PLATFORM_ADMIN_SESSION_ONLY'
    | 'PLATFORM_WORKER_CREDENTIAL' = 'PLATFORM_ADMIN_SESSION_ONLY',
) {
  return {
    schemaVersion: 3 as const,
    generatedAt: input.generatedAt,
    scope: 'PLATFORM' as const,
    effect: 'READ_ONLY' as const,
    focus: input.briefing.focus,
    metrics: input.briefing.metrics,
    changesSinceLastReview: input.briefing.reviewState.changesSinceLastReview,
    changeDigest: input.briefing.reviewState.changeDigest,
    boundedSnapshot: input.briefing.boundedSnapshot,
    autonomyEvidence: input.agentTrustEvidence,
    operatingCosts: input.unitEconomics,
    founderAbsenceReadiness: input.founderAbsenceReadiness,
    recentConversation: input.founderConversation,
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
