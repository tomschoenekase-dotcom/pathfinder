import { describe, expect, it } from 'vitest'

import {
  PlatformWorkerFounderDecisionRequest,
  PlatformWorkerFounderDirectiveTaskRequest,
  PlatformWorkerFounderOperatingViewRequest,
  VerifiedPlatformWorkerPolicyCredential,
} from './platform-worker-policy'

describe('platform worker policy contracts', () => {
  it('accepts only exact unique founder decision keys', () => {
    expect(PlatformWorkerFounderDecisionRequest.parse({ keys: ['codex-autonomy'] })).toEqual({
      keys: ['codex-autonomy'],
    })
    expect(() =>
      PlatformWorkerFounderDecisionRequest.parse({ keys: ['codex-autonomy', 'codex-autonomy'] }),
    ).toThrow(/unique/u)
    expect(() => PlatformWorkerFounderDecisionRequest.parse({ keys: ['Codex autonomy'] })).toThrow()
  })

  it('permits no customer or mutation capability', () => {
    expect(
      VerifiedPlatformWorkerPolicyCredential.parse({
        credentialId: 'credential-1',
        workerId: 'edith-primary',
        capabilities: ['founder-decisions:read'],
      }),
    ).toBeTruthy()
    expect(() =>
      VerifiedPlatformWorkerPolicyCredential.parse({
        credentialId: 'credential-1',
        workerId: 'edith-primary',
        capabilities: ['questions:ask'],
      }),
    ).toThrow()
  })

  it('supports a separate read-only operating-view capability and bounded request', () => {
    expect(
      VerifiedPlatformWorkerPolicyCredential.parse({
        credentialId: 'credential-1',
        workerId: 'edith-primary',
        capabilities: ['founder-decisions:read', 'founder-operating-view:read'],
      }).capabilities,
    ).toEqual(['founder-decisions:read', 'founder-operating-view:read'])
    expect(PlatformWorkerFounderOperatingViewRequest.parse({})).toEqual({ limit: 25 })
    expect(() => PlatformWorkerFounderOperatingViewRequest.parse({ limit: 101 })).toThrow()
  })

  it('separates directive-task read, proposal, and materialization contracts', () => {
    const base = {
      operationId: '11111111-1111-4111-8111-111111111111',
      founderOperatingExchangeId: '22222222-2222-4222-8222-222222222222',
      expectedSnapshotHash: 'a'.repeat(64),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'agent-1',
      proposedPrompt: 'Prepare the exact reviewed venue update.',
      rationale: 'The founder explicitly requested this bounded work.',
      riskCategory: 'MEDIUM' as const,
    }
    expect(PlatformWorkerFounderDirectiveTaskRequest.parse({ action: 'read' })).toEqual({
      action: 'read',
      limit: 20,
    })
    expect(
      PlatformWorkerFounderDirectiveTaskRequest.parse({ action: 'propose', ...base }),
    ).toMatchObject({ action: 'propose', constraints: [] })
    expect(
      PlatformWorkerFounderDirectiveTaskRequest.parse({
        action: 'materialize',
        operationId: '33333333-3333-4333-8333-333333333333',
        requestId: '44444444-4444-4444-8444-444444444444',
        expectedApprovalDecisionId: 'decision-1',
      }),
    ).toMatchObject({ action: 'materialize', expectedApprovalDecisionId: 'decision-1' })
    expect(() =>
      PlatformWorkerFounderDirectiveTaskRequest.parse({
        action: 'propose',
        ...base,
        constraints: ['Preserve customer-contact gate', 'Preserve customer-contact gate'],
      }),
    ).toThrow(/unique/u)
  })
})
