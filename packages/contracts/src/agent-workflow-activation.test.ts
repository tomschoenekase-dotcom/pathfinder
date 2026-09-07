import { describe, expect, it } from 'vitest'
import { AgentWorkflowCanaryPolicySchema } from './agent-workflow-activation'

const policy = {
  numerator: 1,
  denominator: 10,
  salt: 'reviewed-canary-salt',
  startsAt: '2026-09-07T00:00:00Z',
  endsAt: '2026-09-08T00:00:00Z',
  maxSelectedRuns: 5,
  eligibleRunTypes: ['QUALITY_REVIEW'],
  eligibleOperations: ['operator_task'],
  skippedBaseline: { kind: 'NO_WORKFLOW' },
  supportedActionClasses: ['RUN_TERMINAL_WRITE'],
}

describe('agent workflow activation policy', () => {
  it('retains an explicit skipped baseline and bounded capacity', () => {
    expect(AgentWorkflowCanaryPolicySchema.parse(policy)).toMatchObject({
      maxSelectedRuns: 5,
      skippedBaseline: { kind: 'NO_WORKFLOW' },
    })
  })
  it('rejects invented or inconsistent canary bounds', () => {
    expect(() => AgentWorkflowCanaryPolicySchema.parse({ ...policy, numerator: 11 })).toThrow()
    expect(() =>
      AgentWorkflowCanaryPolicySchema.parse({ ...policy, eligibleOperations: [] }),
    ).toThrow()
  })
})
