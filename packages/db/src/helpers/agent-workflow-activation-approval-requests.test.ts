import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./agent-workflow-registry-actions', () => ({
  isAgentWorkflowArtifactIntact: vi.fn(() => true),
}))
vi.mock('./agent-workflow-promotion-assessment-actions', () => ({
  revalidateAgentWorkflowPromotionAssessment: vi.fn(async () => ({
    assessment: {
      outcome: 'EVIDENCE_READY_REVIEW_REQUIRED',
      diagnostics: {
        contractVersion: 1,
        interpretation: 'evidence-only-no-activation',
        development: {
          validationId: 'dev',
          caseCount: 1,
          resolvedFailures: 1,
          newFailures: 0,
          missingResults: 0,
          caseIdentityHash: 'a'.repeat(64),
          latencyDeltaMs: null,
          costDeltaE8Usd: null,
        },
        heldout: {
          validationId: 'held',
          caseCount: 1,
          resolvedFailures: 1,
          newFailures: 0,
          missingResults: 0,
          caseIdentityHash: 'b'.repeat(64),
          latencyDeltaMs: null,
          costDeltaE8Usd: null,
        },
        disjointCaseSets: true,
        targetImprovementObserved: true,
        thresholdResolution: 'UNRESOLVED',
        autonomousPromotionEligible: false,
        limitations: ['Explicit human review required.'],
      },
    },
    evidenceDigest: 'c'.repeat(64),
  })),
}))

import {
  requestAgentWorkflowActivationApproval,
  requestAgentWorkflowTransitionApproval,
} from './agent-workflow-activation-approval-requests'

const policy = {
  numerator: 1,
  denominator: 10,
  salt: 'reviewed-canary-salt',
  startsAt: '2026-09-07T00:00:00Z',
  endsAt: '2026-09-08T00:00:00Z',
  maxSelectedRuns: 5,
  eligibleRunTypes: ['QUALITY_REVIEW'],
  eligibleOperations: ['operator_task'],
  skippedBaseline: { kind: 'NO_WORKFLOW' as const },
  supportedActionClasses: ['RUN_TERMINAL_WRITE' as const],
}
const input = {
  requestOperationId: randomUUID(),
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentIdentityId: 'identity-1',
  registryKey: 'grounded-review',
  workflowVersionId: randomUUID(),
  promotionAssessmentId: 'assessment-1',
  expectedHeadRevision: 0,
  canaryPolicy: policy,
  reason: 'Review exact activation.',
  actor: { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const },
}

function clientFixture(overrides?: { identity?: boolean; capabilities?: string[] }) {
  let saved: Record<string, unknown> | null = null
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    approvalRequest: {
      findFirst: vi.fn(async () => saved),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        saved = { ...data, createdAt: new Date(), updatedAt: new Date() }
        return saved
      }),
    },
    agentIdentity: {
      findFirst: vi.fn(async () => (overrides?.identity === false ? null : { id: 'identity-1' })),
    },
    agentWorkflowActivationHead: { findFirst: vi.fn(async () => null) },
    agentWorkflowVersion: {
      findFirst: vi.fn(async () => ({
        id: input.workflowVersionId,
        registryKey: input.registryKey,
        requiredToolCapabilities: overrides?.capabilities ?? [],
      })),
    },
    agentWorkflowActivationEvent: { findFirst: vi.fn(async () => null) },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  }
  return { client: client as never, transaction: client.$transaction, tx, getSaved: () => saved }
}

describe('workflow activation approval requests', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replays the immutable request before mutable head and evidence checks', async () => {
    const fixture = clientFixture()
    await expect(
      requestAgentWorkflowActivationApproval(input, new Set(), fixture.client),
    ).resolves.toMatchObject({ replayed: false })
    expect(fixture.getSaved()).not.toBeNull()
    fixture.tx.agentWorkflowActivationHead.findFirst.mockRejectedValueOnce(
      new Error('mutable head must not be read on replay'),
    )
    fixture.tx.agentWorkflowVersion.findFirst.mockRejectedValueOnce(
      new Error('mutable version must not be read on replay'),
    )
    await expect(
      requestAgentWorkflowActivationApproval(input, new Set(), fixture.client),
    ).resolves.toMatchObject({ replayed: true })
    expect(fixture.tx.agentWorkflowActivationHead.findFirst).toHaveBeenCalledTimes(1)
    expect(fixture.tx.agentWorkflowVersion.findFirst).toHaveBeenCalledTimes(1)
  })

  it('rejects an identity outside the exact tenant and venue', async () => {
    const fixture = clientFixture({ identity: false })
    await expect(
      requestAgentWorkflowActivationApproval(input, new Set(), fixture.client),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fixture.tx.agentIdentity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: input.tenantId, venueId: input.venueId }),
      }),
    )
  })

  it('rejects a workflow whose required capability is unavailable', async () => {
    const fixture = clientFixture({ capabilities: ['resources:read'] })
    await expect(
      requestAgentWorkflowActivationApproval(input, new Set(), fixture.client),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(fixture.tx.approvalRequest.create).not.toHaveBeenCalled()
  })

  it('rejects an unsupported transition action class before persistence', async () => {
    const fixture = clientFixture()
    await expect(
      requestAgentWorkflowTransitionApproval(
        {
          requestOperationId: randomUUID(),
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: input.agentIdentityId,
          registryKey: input.registryKey,
          expectedHeadRevision: 1,
          kind: 'ROLLBACK',
          workflowVersionId: input.workflowVersionId,
          canaryPolicy: { ...policy, supportedActionClasses: ['OPERATOR_QUESTION'] },
          reason: 'Review unsupported rollback.',
          actor: input.actor,
        },
        new Set(['resources:read']),
        fixture.client,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(fixture.transaction).not.toHaveBeenCalled()
  })
})
