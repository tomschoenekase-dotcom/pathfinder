import { describe, expect, it } from 'vitest'
import { deriveFounderAbsenceReadiness } from './attention-founder-absence'

const page = <T>(items: T[], hasMore = false) => ({
  items,
  nextCursor: hasMore ? { createdAt: '2026-08-28T00:00:00.000Z', id: 'next' } : null,
})

function input() {
  return {
    generatedAt: new Date('2026-08-28T04:00:00.000Z'),
    jobs: page([{ id: 'job_1' }]),
    evaluations: page([
      { id: 'eval_1', status: 'RUNNING', expiredLease: true },
      { id: 'eval_2', status: 'STAGED', expiredLease: false },
    ]),
    approvals: page([{ id: 'approval_1' }]),
    support: page([
      { id: 'support_1', status: 'OPEN' },
      { id: 'support_2', status: 'WAITING_FOR_CLIENT' },
    ]),
    questions: page([
      { id: 'question_1', agentRunId: 'run_linked', blocking: true },
      { id: 'question_2', agentRunId: null, blocking: false },
    ]),
    blockedAgents: page([
      { id: 'run_linked', status: 'AWAITING_INPUT' },
      { id: 'run_hidden', status: 'AWAITING_INPUT' },
      { id: 'run_approval', status: 'AWAITING_APPROVAL' },
      { id: 'run_failed', status: 'FAILED' },
    ]),
    events: page([{ id: 'event_1', occurrenceCount: 3 }]),
    platformEvents: page([{ id: 'platform_1', occurrenceCount: 1 }]),
    agentTrustEvidence: {
      actions: { denied: 2 },
      customerSignals: { negative: 1 },
      rollbackEvidence: { distinctActions: 1 },
      policyViolationEvidence: { observations: 1 },
      boundedSnapshot: { hasMore: false },
    },
  }
}

describe('deriveFounderAbsenceReadiness', () => {
  it('maps current canonical signals without claiming the seven-day test ran', () => {
    const result = deriveFounderAbsenceReadiness(input())

    expect(result.target).toMatchObject({
      ordinaryOperationDays: 7,
      launchGate: false,
      certification: 'NOT_CERTIFIED',
      observationState: 'NOT_STARTED',
      observedDays: 0,
    })
    expect(
      Object.fromEntries(result.dimensions.map((item) => [item.key, item.visibleSignals])),
    ).toEqual({
      FOUNDER_WAITS: 5,
      PERMISSION_FRICTION: 3,
      REPEATED_ESCALATIONS: 1,
      CUSTOMER_RESPONSE_WORK: 1,
      FAILED_AUTOMATION: 3,
      HIDDEN_MANUAL_STEPS: 1,
      UNCONTROLLED_EFFECTS: 3,
    })
    expect(result.authority).toEqual({
      effect: 'READ_ONLY',
      canChangePermissions: false,
      canResolveWork: false,
      canCertifyMaturity: false,
    })
  })

  it('marks bounded evidence without converting missing rows into zero-risk proof', () => {
    const value = input()
    value.support = page(value.support.items, true)

    const result = deriveFounderAbsenceReadiness(value)

    expect(result.evidenceWindow).toMatchObject({ complete: false, hasMore: true })
    expect(result.dimensions.find((item) => item.key === 'CUSTOMER_RESPONSE_WORK')).toMatchObject({
      hasMore: true,
      state: 'REVIEW_CANDIDATES',
    })
  })
})
