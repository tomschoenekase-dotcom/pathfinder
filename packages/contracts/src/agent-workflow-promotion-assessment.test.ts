import { describe, expect, it } from 'vitest'
import { AgentWorkflowPromotionAssessmentDiagnosticsSchema } from './agent-workflow-promotion-assessment'

const evidence = {
  validationId: 'validation-1',
  caseCount: 1,
  resolvedFailures: 1,
  newFailures: 0,
  missingResults: 0,
  caseIdentityHash: 'a'.repeat(64),
  latencyDeltaMs: 5,
  costDeltaE8Usd: '2',
}

describe('workflow promotion assessment evidence', () => {
  it('requires unresolved thresholds and forbids autonomous promotion', () => {
    expect(
      AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse({
        contractVersion: 1,
        interpretation: 'evidence-only-no-activation',
        development: evidence,
        heldout: { ...evidence, validationId: 'validation-2', resolvedFailures: 0 },
        disjointCaseSets: true,
        targetImprovementObserved: true,
        thresholdResolution: 'UNRESOLVED',
        autonomousPromotionEligible: false,
        limitations: ['No reviewed latency or cost threshold exists.'],
      }),
    ).toMatchObject({ autonomousPromotionEligible: false })
  })
  it('rejects a receipt that claims autonomous eligibility', () => {
    expect(() =>
      AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse({
        contractVersion: 1,
        interpretation: 'evidence-only-no-activation',
        development: evidence,
        heldout: evidence,
        disjointCaseSets: false,
        targetImprovementObserved: false,
        thresholdResolution: 'UNRESOLVED',
        autonomousPromotionEligible: true,
        limitations: ['Missing policy.'],
      }),
    ).toThrow()
  })

  it('retains an oversized manifest count without inventing comparison costs', () => {
    expect(
      AgentWorkflowPromotionAssessmentDiagnosticsSchema.parse({
        contractVersion: 1,
        interpretation: 'evidence-only-no-activation',
        development: {
          ...evidence,
          caseCount: 10_000,
          missingResults: 10_000,
          costDeltaE8Usd: null,
        },
        heldout: { ...evidence, validationId: 'validation-2' },
        disjointCaseSets: true,
        targetImprovementObserved: false,
        thresholdResolution: 'UNRESOLVED',
        autonomousPromotionEligible: false,
        limitations: ['The manifest exceeds the comparison boundary.'],
      }).development,
    ).toMatchObject({ caseCount: 10_000, costDeltaE8Usd: null })
  })
})
