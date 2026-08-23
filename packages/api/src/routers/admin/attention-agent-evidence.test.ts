import { describe, expect, it } from 'vitest'

import { deriveAgentTrustEvidence } from './attention-agent-evidence'

const page = <T>(items: T[], hasMore = false) => ({
  items,
  nextCursor: hasMore ? { createdAt: '2026-08-22T00:00:00.000Z', id: 'next' } : null,
})

describe('founder agent trust evidence', () => {
  it('does not treat completed execution as quality or permission evidence', () => {
    const result = deriveAgentTrustEvidence({
      outcomes: page([]),
      completedAgents: page([{ id: 'run_1', _count: { outcomeObservations: 0 } }]),
    })

    expect(result).toMatchObject({
      schemaVersion: 1,
      state: 'NO_OUTCOME_EVIDENCE',
      observations: 0,
      completedRuns: { visible: 1, withObservation: 0, withoutObservation: 1 },
      policy: { approvalReductionRecommended: false },
    })
    expect(result.policy.explanation).toContain('Completion alone is not quality evidence')
  })

  it('surfaces negative evidence without inventing a reliability score or trust threshold', () => {
    const result = deriveAgentTrustEvidence({
      outcomes: page([
        {
          agentRunId: 'run_1',
          verdict: 'POSITIVE',
          signalKind: 'HUMAN_REVIEW',
          taskClass: 'support',
        },
        {
          agentRunId: 'run_2',
          verdict: 'NEGATIVE',
          signalKind: 'QUALITY_EVALUATION',
          taskClass: 'support',
        },
      ]),
      completedAgents: page([
        { id: 'run_1', _count: { outcomeObservations: 1 } },
        { id: 'run_2', _count: { outcomeObservations: 1 } },
      ]),
    })

    expect(result).toMatchObject({
      state: 'NEGATIVE_EVIDENCE_PRESENT',
      verdicts: { positive: 1, mixed: 0, negative: 1, inconclusive: 0 },
      distinctObservedRuns: 2,
      taskClasses: ['support'],
      signalKinds: ['HUMAN_REVIEW', 'QUALITY_EVALUATION'],
      policy: { approvalReductionRecommended: false },
    })
  })

  it('labels positive-only evidence as bounded rather than proven autonomy', () => {
    const result = deriveAgentTrustEvidence({
      outcomes: page(
        [
          {
            agentRunId: 'run_1',
            verdict: 'POSITIVE',
            signalKind: 'BUSINESS_OUTCOME',
            taskClass: 'onboarding',
          },
        ],
        true,
      ),
      completedAgents: page([], true),
    })

    expect(result.state).toBe('POSITIVE_ONLY_EVIDENCE')
    expect(result.boundedSnapshot.hasMore).toBe(true)
    expect(result.policy.explanation).toContain('does not prove reliability')
  })
})
