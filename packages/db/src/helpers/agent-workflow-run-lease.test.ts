import { describe, expect, it, vi } from 'vitest'
vi.mock('./agent-workflow-registry-actions', () => ({
  agentWorkflowManifestHash: () => 'a'.repeat(64),
  isAgentWorkflowArtifactIntact: () => true,
}))
import {
  agentWorkflowSelectionProof,
  assertEligibleWorkflowRunLease,
} from './agent-workflow-run-lease'

const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentRunId: 'run-1',
  executionLeaseToken: '00000000-0000-4000-8000-000000000001',
  actionClass: 'RUN_TERMINAL_WRITE' as const,
}
const policy = {
  numerator: 1,
  denominator: 1,
  salt: 'reviewed-canary-salt',
  startsAt: '2026-09-07T00:00:00Z',
  endsAt: '2026-09-08T00:00:00Z',
  maxSelectedRuns: 1,
  eligibleRunTypes: ['QUALITY_REVIEW'],
  eligibleOperations: ['operator_task'],
  skippedBaseline: { kind: 'NO_WORKFLOW' },
  supportedActionClasses: ['RUN_TERMINAL_WRITE'],
}

describe('workflow run lease guard', () => {
  it('preserves existing unbound run behavior after exact lease lock', async () => {
    const tx = {
      $queryRaw: vi.fn(async (parts: readonly string[]) =>
        parts.join('').includes('clock_timestamp() AS now')
          ? [{ now: new Date('2026-09-07T12:00:00Z') }]
          : [
              {
                id: 'run-1',
                executionLeaseExpiresAt: new Date('2026-09-07T13:00:00Z'),
                cancelRequestedAt: null,
              },
            ],
      ),
      agentWorkflowRunBinding: { findMany: vi.fn(async () => []) },
    }
    await expect(assertEligibleWorkflowRunLease(tx as never, input)).resolves.toEqual({
      bindings: [],
    })
  })
  it('fails closed when the post-lock database clock is malformed', async () => {
    const tx = {
      $queryRaw: vi.fn(async (parts: readonly string[]) =>
        parts.join('').includes('clock_timestamp() AS now')
          ? [{ now: new Date(Number.NaN) }]
          : [
              {
                id: 'run-1',
                executionLeaseExpiresAt: new Date('2026-09-07T13:00:00Z'),
                cancelRequestedAt: null,
              },
            ],
      ),
      agentWorkflowRunBinding: { findMany: vi.fn(async () => []) },
    }
    await expect(assertEligibleWorkflowRunLease(tx as never, input)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
  })
  it('rejects replaced activation and unsupported effects', async () => {
    const binding = {
      id: 'binding-1',
      registryKey: 'review',
      outcome: 'SELECTED',
      workflowVersionId: 'version-1',
      bindingHash: 'a'.repeat(64),
      activationEventId: 'event-1',
      activationEvent: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        registryKey: 'review',
        kind: 'ACTIVATE',
        priorVersionId: null,
        resultingVersionId: 'version-1',
        promotionAssessmentId: 'assessment-1',
        approvalDecisionId: 'decision-1',
        priorRevision: 0,
        resultingRevision: 1,
        evidenceDigest: 'b'.repeat(64),
        canaryPolicy: policy,
        requiredCapabilities: [],
        reason: 'reviewed',
        createdBy: 'admin-1',
        eventHash: 'a'.repeat(64),
      },
      workflowVersion: { registryKey: 'review', requiredToolCapabilities: [] },
      tenantId: input.tenantId,
      venueId: input.venueId,
      agentRunId: input.agentRunId,
      headRevision: 1,
      selectionProof: agentWorkflowSelectionProof({
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: input.agentRunId,
        registryKey: 'review',
        activationEventHash: 'a'.repeat(64),
        policyHash: 'a'.repeat(64),
        selectionReason: 'HASH_SELECTED',
        selectionOrdinal: 1,
      }),
      selectionReason: 'HASH_SELECTED',
      selectionOrdinal: 1,
      requiredCapabilities: [],
    }
    const tx = {
      $queryRaw: vi.fn(async (parts: readonly string[]) =>
        parts.join('').includes('clock_timestamp() AS now')
          ? [{ now: new Date('2026-09-07T12:00:00Z') }]
          : [
              {
                id: 'run-1',
                executionLeaseExpiresAt: new Date('2026-09-07T13:00:00Z'),
                cancelRequestedAt: null,
                leaseExpiresAt: new Date('2026-09-07T13:00:00Z'),
                expiresAt: null,
              },
            ],
      ),
      agentWorkflowRunBinding: { findMany: vi.fn(async () => [binding]) },
      agentRun: {
        findFirst: vi.fn(async () => ({
          executionWorkerId: 'worker-1',
          agentIdentity: { enabled: true, accessCapabilities: [] },
        })),
      },
      agentWorker: {
        findFirst: vi.fn(async () => ({
          capabilities: [],
          credentialId: 'credential-1',
          clientId: input.tenantId,
          credentialScopeKey: 'scope-1',
        })),
      },
      externalAccessCredential: {
        findFirst: vi.fn(async () => ({ capabilities: [] })),
      },
      agentWorkflowActivationHead: {
        findFirst: vi.fn(async () => ({ activationEventId: 'event-2', revision: 1 })),
      },
    }
    await expect(assertEligibleWorkflowRunLease(tx as never, input)).rejects.toMatchObject({
      code: 'REVOKED',
    })
    tx.agentWorkflowActivationHead.findFirst.mockResolvedValue({
      activationEventId: 'event-1',
      revision: 1,
    })
    await expect(
      assertEligibleWorkflowRunLease(tx as never, { ...input, actionClass: 'BILLING_PROPOSAL' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' })
    binding.workflowVersion.registryKey = 'foreign-registry'
    await expect(assertEligibleWorkflowRunLease(tx as never, input)).rejects.toMatchObject({
      code: 'CORRUPT_BINDING',
    })
  })
  it('requires the caller supplied live lease', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      agentWorkflowRunBinding: { findMany: vi.fn(async () => []) },
    }
    await expect(assertEligibleWorkflowRunLease(tx as never, input)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    })
  })
})
