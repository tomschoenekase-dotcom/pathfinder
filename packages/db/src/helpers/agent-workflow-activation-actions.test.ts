import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
vi.mock('./agent-workflow-promotion-assessment-actions', () => ({
  revalidateAgentWorkflowPromotionAssessment: vi.fn(
    async (
      tx: {
        agentWorkflowPromotionAssessment: {
          findFirst: (args: { where: { id: string } }) => Promise<unknown>
        }
      },
      input: { assessmentId: string },
    ) => ({
      assessment: await tx.agentWorkflowPromotionAssessment.findFirst({
        where: { id: input.assessmentId },
      }),
      evidenceDigest: 'c'.repeat(64),
    }),
  ),
}))
import {
  activateAgentWorkflowVersion,
  transitionAgentWorkflowActivation,
} from './agent-workflow-activation-actions'
import { agentWorkflowManifestHash, agentWorkflowTextHash } from './agent-workflow-registry-actions'

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
const base = {
  operationId: randomUUID(),
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  registryKey: 'grounded-review',
  workflowVersionId: randomUUID(),
  promotionAssessmentId: 'assessment-1',
  approvalDecisionId: 'decision-1',
  expectedHeadRevision: 0,
  canaryPolicy: policy,
  reason: 'Reviewed canary.',
  actor: { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const },
}

describe('workflow activation actions', () => {
  it.each(['OPERATOR_QUESTION', 'BILLING_PROPOSAL'] as const)(
    'rejects unfenced %s in both activation and rollback before any transition',
    async (action) => {
      const transaction = vi.fn()
      const client = { $transaction: transaction } as never
      const canaryPolicy = { ...policy, supportedActionClasses: [action] }
      await expect(
        activateAgentWorkflowVersion({ ...base, canaryPolicy }, new Set(), client),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(
        transitionAgentWorkflowActivation(
          {
            operationId: base.operationId,
            tenantId: base.tenantId,
            venueId: base.venueId,
            registryKey: base.registryKey,
            workflowVersionId: base.workflowVersionId,
            approvalDecisionId: base.approvalDecisionId,
            reason: base.reason,
            actor: base.actor,
            expectedHeadRevision: 1,
            kind: 'ROLLBACK',
            canaryPolicy,
          },
          new Set(),
          client,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(transaction).not.toHaveBeenCalled()
    },
  )

  it('admits the canonically fenced delegation action class to transaction validation', async () => {
    const transaction = vi.fn()
    await activateAgentWorkflowVersion(
      { ...base, canaryPolicy: { ...policy, supportedActionClasses: ['AGENT_DELEGATION'] } },
      new Set(),
      { $transaction: transaction } as never,
    )
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid canary input before opening a transaction', async () => {
    const transaction = vi.fn()
    await expect(
      activateAgentWorkflowVersion(
        { ...base, canaryPolicy: { ...policy, numerator: 11 } },
        new Set(),
        { $transaction: transaction } as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
  })
  it('requires the dedicated exact human activation approval', async () => {
    const manifest = {
      schemaVersion: 1,
      registryKey: base.registryKey,
      version: 1,
      kind: 'WORKFLOW',
      description: 'Reviewed workflow.',
      examples: [],
      requiredTools: [],
      testedCases: ['heldout'],
      rollback: null,
      license: null,
    }
    const diagnostics = {
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
    }
    const tx = {
      $queryRaw: vi.fn(async () => []),
      agentWorkflowActivationHead: { findFirst: vi.fn(async () => null) },
      agentWorkflowActivationEvent: { findFirst: vi.fn(async () => null) },
      agentWorkflowVersion: {
        findFirst: vi.fn(async () => ({
          id: base.workflowVersionId,
          registryKey: base.registryKey,
          version: 1,
          kind: 'WORKFLOW',
          manifest,
          manifestHash: agentWorkflowManifestHash(manifest),
          portableText: 'review',
          contentHash: agentWorkflowTextHash('review'),
          requiredToolCapabilities: [],
        })),
      },
      agentWorkflowPromotionAssessment: {
        findFirst: vi.fn(async () => ({
          id: base.promotionAssessmentId,
          outcome: 'EVIDENCE_READY_REVIEW_REQUIRED',
          diagnostics,
          developmentValidationId: 'dev',
          heldoutValidationId: 'held',
        })),
      },
      approvalDecision: { findFirst: vi.fn(async () => null) },
    }
    await expect(
      activateAgentWorkflowVersion(base, new Set(), {
        $transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
      } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('requires an exact rollback target and reviewed canary', async () => {
    const transaction = vi.fn()
    await expect(
      transitionAgentWorkflowActivation(
        {
          operationId: randomUUID(),
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          registryKey: 'grounded-review',
          approvalDecisionId: 'decision-1',
          expectedHeadRevision: 1,
          reason: 'rollback',
          actor: base.actor,
          kind: 'ROLLBACK',
        },
        new Set(),
        { $transaction: transaction } as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(transaction).not.toHaveBeenCalled()
  })
})
