import { describe, expect, it, vi } from 'vitest'
import {
  configureIntakeSourceAgentRouting,
  IntakeSourceAgentRoutingInput,
} from './intake-source-agent-routing-actions'
const input = {
  tenantId: 'tenant',
  venueId: 'venue',
  agentIdentityId: 'content',
  expectedRevision: 0,
}
describe('source routing configuration', () => {
  it('defaults to disabled and rejects authority/unknown fields', () => {
    expect(IntakeSourceAgentRoutingInput.parse(input).enabled).toBe(false)
    expect(IntakeSourceAgentRoutingInput.safeParse({ ...input, actorId: 'forged' }).success).toBe(
      false,
    )
    expect(
      IntakeSourceAgentRoutingInput.safeParse({ ...input, expectedRevision: -1 }).success,
    ).toBe(false)
  })
  it('rejects stale configuration before inspecting identity or writing policy', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      intakeSourceAgentRoutingPolicy: {
        findUnique: vi.fn().mockResolvedValue({ revision: 2 }),
        update: vi.fn(),
      },
      agentIdentity: { findFirst: vi.fn() },
    }
    const client = { $transaction: async (callback: (arg: typeof tx) => unknown) => callback(tx) }
    await expect(
      configureIntakeSourceAgentRouting(input, 'admin', client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.agentIdentity.findFirst).not.toHaveBeenCalled()
    expect(tx.intakeSourceAgentRoutingPolicy.update).not.toHaveBeenCalled()
  })
  it('cannot enable an identity without explicit autonomous draft preparation authority', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
      intakeSourceAgentRoutingPolicy: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      agentIdentity: {
        findFirst: vi
          .fn()
          .mockResolvedValue({
            enabled: true,
            accessCapabilities: ['intake.read', 'content.draft'],
            autonomousActions: [],
            autonomyLevel: 'DRAFT',
            defaultProvider: 'codex-bridge',
            defaultModel: 'subscription-default',
          }),
      },
    }
    const client = { $transaction: async (callback: (arg: typeof tx) => unknown) => callback(tx) }
    await expect(
      configureIntakeSourceAgentRouting({ ...input, enabled: true }, 'admin', client as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tx.intakeSourceAgentRoutingPolicy.create).not.toHaveBeenCalled()
  })
})
