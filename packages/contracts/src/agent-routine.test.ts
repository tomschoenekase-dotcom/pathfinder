import { describe, expect, it } from 'vitest'

import { CreateAgentRoutineInput } from './agent-routine'

describe('agent routine contract', () => {
  const base = {
    operationId: 'a9ed8fa0-6089-4dd2-a72c-82785d11b5c6',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    routineKey: 'hermes-health-watch',
    agentIdentityId: 'agent-1',
    prompt: 'Read bounded health evidence only.',
    intervalSeconds: 300,
  }

  it('uses conservative run limits when an operator omits optional budget fields', () => {
    expect(CreateAgentRoutineInput.parse(base)).toMatchObject({
      requestedOperation: 'routine_monitor',
      maxAttempts: 1,
      maxRunsPerDay: 24,
      requiredWorkerRoles: [],
      requiredWorkerCapabilities: [],
    })
  })

  it('rejects schedules that could create a tight polling loop', () => {
    expect(() => CreateAgentRoutineInput.parse({ ...base, intervalSeconds: 59 })).toThrow(
      /intervalSeconds/u,
    )
  })

  it('limits the first bridge-only subset to one metered attempt per dispatch', () => {
    expect(() => CreateAgentRoutineInput.parse({ ...base, maxAttempts: 2 })).toThrow(/maxAttempts/u)
  })

  it('does not accept USD budget fields until bridges can enforce them pre-call', () => {
    expect(() => CreateAgentRoutineInput.parse({ ...base, perRunBudgetE8Usd: '100' })).toThrow(
      /unrecognized_key/u,
    )
  })
})
