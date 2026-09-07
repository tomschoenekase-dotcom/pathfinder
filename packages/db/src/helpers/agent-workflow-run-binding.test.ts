import { describe, expect, it, vi } from 'vitest'
vi.mock('./agent-workflow-registry-actions', async (original) => {
  const actual = await original<typeof import('./agent-workflow-registry-actions')>()
  return { ...actual, isAgentWorkflowArtifactIntact: () => true }
})
vi.mock('./agent-workflow-run-lease', async (original) => {
  const actual = await original<typeof import('./agent-workflow-run-lease')>()
  return {
    ...actual,
    agentWorkflowActivationEventHash: () => 'e'.repeat(64),
    agentWorkflowBindingHash: () => 'b'.repeat(64),
  }
})
import { bindAgentWorkflowVersions } from './agent-workflow-run-binding'

const input = {
  tenantId: 'tenant',
  venueId: 'venue',
  agentRunId: 'run',
  runType: 'QUALITY_REVIEW',
  operation: 'operator_task',
  registryKeys: ['review'],
}

describe('workflow run binding selection', () => {
  it('persists an explicit no-workflow outcome once', async () => {
    const create = vi.fn(async ({ data }) => ({ id: 'binding', ...data }))
    const tx = {
      $queryRaw: vi.fn(async (parts: readonly string[]) =>
        parts.join('').includes('FROM agent_runs')
          ? [{ status: 'QUEUED', attemptNumber: 0, leaseToken: null }]
          : [],
      ),
      agentWorkflowRunBinding: { findMany: vi.fn(async () => []), create },
      agentWorkflowActivationHead: { findFirst: vi.fn(async () => null) },
      agentWorkflowVersion: { findFirst: vi.fn() },
    }
    const result = await bindAgentWorkflowVersions(tx as never, input)
    expect(result.replayed).toBe(false)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'CANARY_SKIPPED_NO_WORKFLOW',
          selectionReason: 'NO_ACTIVE_WORKFLOW',
          selectionOrdinal: null,
        }),
      }),
    )
  })
  it('reserves selected capacity under the locked head and records its ordinal', async () => {
    const policy = {
      numerator: 1,
      denominator: 1,
      salt: 'reviewed-selection-salt',
      startsAt: '2026-09-07T00:00:00Z',
      endsAt: '2026-09-09T00:00:00Z',
      maxSelectedRuns: 2,
      eligibleRunTypes: ['QUALITY_REVIEW'],
      eligibleOperations: ['operator_task'],
      skippedBaseline: {
        kind: 'PRIOR_VERSION',
        workflowVersionId: '00000000-0000-4000-8000-000000000009',
        contentHash: '9'.repeat(64),
      },
      supportedActionClasses: ['RUN_TERMINAL_WRITE'],
    }
    const event = {
      tenantId: 'tenant',
      venueId: 'venue',
      registryKey: 'review',
      kind: 'ACTIVATE',
      priorVersionId: null,
      resultingVersionId: 'version',
      promotionAssessmentId: 'assessment',
      approvalDecisionId: 'decision',
      priorRevision: 0,
      resultingRevision: 1,
      evidenceDigest: 'd'.repeat(64),
      canaryPolicy: policy,
      requiredCapabilities: [],
      reason: 'reviewed',
      createdBy: 'admin',
      eventHash: 'e'.repeat(64),
    }
    const version = { id: 'version', requiredToolCapabilities: [] }
    const create = vi.fn(async ({ data }) => ({ id: 'binding', ...data }))
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const tx = {
      $queryRaw: vi.fn(async (parts: readonly string[]) => {
        const sql = parts.join('')
        if (sql.includes('FROM agent_runs'))
          return [{ status: 'QUEUED', attemptNumber: 0, leaseToken: null }]
        return sql.includes('clock_timestamp') ? [{ now: new Date('2026-09-08T00:00:00Z') }] : []
      }),
      agentWorkflowRunBinding: { findMany: vi.fn(async () => []), create },
      agentWorkflowActivationHead: {
        findFirst: vi.fn(async () => ({
          id: 'head',
          revision: 1,
          selectedRunCount: 0,
          activationEventId: 'event',
          activationEvent: event,
          activeVersion: version,
        })),
        updateMany,
      },
      agentWorkflowVersion: { findFirst: vi.fn() },
    }
    await bindAgentWorkflowVersions(tx as never, input)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ selectedRunCount: 0 }),
        data: { selectedRunCount: { increment: 1 } },
      }),
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'SELECTED',
          selectionReason: 'HASH_SELECTED',
          selectionOrdinal: 1,
        }),
      }),
    )
    await bindAgentWorkflowVersions(tx as never, {
      ...input,
      agentRunId: 'run-ineligible',
      runType: 'UNRELATED',
    })
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: 'CANARY_SKIPPED_NO_WORKFLOW',
          selectionReason: 'INELIGIBLE_RUN',
          workflowVersionId: null,
        }),
      }),
    )
    expect(tx.agentWorkflowVersion.findFirst).not.toHaveBeenCalled()
  })
})
