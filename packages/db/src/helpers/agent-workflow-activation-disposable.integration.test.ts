import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { createAgentTaskAction } from './agent-task-actions'
import {
  claimAgentRunExecution,
  completeAgentRunExecution,
  failAgentRunExecution,
  heartbeatAgentRunExecution,
} from './agent-run-execution-actions'
import { registerAgentWorkflowVersion } from './agent-workflow-registry-actions'
import { agentWorkflowActivationEventHash } from './agent-workflow-run-lease'

const enabled =
  process.env.RUN_AGENT_WORKFLOW_ACTIVATION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent workflow activation selection disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())
  it('selects one bounded run, preserves takeover binding, and keeps ineligible work unbound', async () =>
    withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8),
        tenantId = `tenant-activation-${suffix}`,
        venueId = `venue-activation-${suffix}`,
        identityId = `identity-activation-${suffix}`
      await db.tenant.create({ data: { id: tenantId, name: 'Activation fixture', slug: tenantId } })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Activation fixture', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `activation.${suffix}`,
          name: 'Activation agent',
          agentType: 'QUALITY_REVIEW',
          accessScope: 'VENUE',
          accessCapabilities: [],
          autonomyLevel: 'READ_ONLY',
          enabled: true,
          createdBy: 'fixture',
        },
      })
      const createReviewedDecision = async (proposedAction: string) => {
        const request = await db.approvalRequest.create({
          data: {
            tenantId,
            venueId,
            agentIdentityId: identityId,
            requestedByType: 'HUMAN',
            requestedById: 'fixture-admin',
            proposedAction,
            scopeSnapshot: { fixture: true },
            reason: 'Fixture-only reviewed authority lineage.',
            riskCategory: 'HIGH',
          },
        })
        return db.approvalDecision.create({
          data: {
            tenantId,
            venueId,
            approvalRequestId: request.id,
            decision: 'APPROVED',
            decidedByType: 'HUMAN',
            decidedById: 'fixture-admin',
            reason: 'Fixture-only reviewed authority lineage.',
          },
        })
      }
      const seedDecision = await createReviewedDecision('agent-workflow.rollback')
      const revokeDecision = await createReviewedDecision('agent-workflow.revoke')
      const registryKey = `reviewed-workflow-${suffix}`
      const manifest = {
        schemaVersion: 1 as const,
        registryKey,
        version: 1,
        kind: 'WORKFLOW' as const,
        description: 'Complete retained fixture workflow.',
        examples: [],
        requiredTools: [],
        testedCases: ['fixture'],
        rollback: null,
        license: null,
      }
      const registered = await registerAgentWorkflowVersion(
        {
          operationId: randomUUID(),
          tenantId,
          venueId,
          manifest,
          portableText: 'Read retained evidence and return a bounded review.',
          provenance: {
            sourceType: 'HUMAN_AUTHORED' as const,
            sourceReferences: ['fixture:activation'],
            capturedAt: new Date().toISOString(),
          },
          actor: { type: 'HUMAN' as const, id: 'fixture-admin', role: 'PLATFORM_ADMIN' as const },
        },
        new Set(),
      )
      const policy = {
        numerator: 1,
        denominator: 1,
        salt: `activation-salt-${suffix}`,
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 3600000).toISOString(),
        maxSelectedRuns: 1,
        eligibleRunTypes: ['QUALITY_REVIEW'],
        eligibleOperations: ['operator_task'],
        skippedBaseline: { kind: 'NO_WORKFLOW' as const },
        supportedActionClasses: ['RUN_TERMINAL_WRITE' as const],
      }
      const eventIdentity = {
        tenantId,
        venueId,
        registryKey,
        kind: 'ROLLBACK' as const,
        priorVersionId: null,
        resultingVersionId: registered.version.id,
        promotionAssessmentId: null,
        approvalDecisionId: seedDecision.id,
        priorRevision: 0,
        resultingRevision: 1,
        evidenceDigest: 'd'.repeat(64),
        canaryPolicy: policy,
        requiredCapabilities: [],
        reason: 'Fixture reviewed activation.',
        createdBy: 'fixture-admin',
      }
      const event = await db.agentWorkflowActivationEvent.create({
        data: {
          operationId: randomUUID(),
          ...eventIdentity,
          eventHash: agentWorkflowActivationEventHash(eventIdentity),
        },
      })
      await db.agentWorkflowActivationHead.create({
        data: {
          tenantId,
          venueId,
          registryKey,
          activeVersionId: registered.version.id,
          activationEventId: event.id,
          revision: 1,
        },
      })
      const request = (operationId: string) => ({
        operationId,
        tenantId,
        venueId,
        agentIdentityId: identityId,
        prompt: 'Review evidence.',
        actor: {
          actorType: 'HUMAN' as const,
          actorId: 'fixture-admin',
          auditRole: 'PLATFORM_ADMIN' as const,
        },
      })
      const [a, b] = await Promise.all([
        createAgentTaskAction(request(randomUUID())),
        createAgentTaskAction(request(randomUUID())),
      ])
      const bindings = await db.agentWorkflowRunBinding.findMany({
        where: { agentRunId: { in: [a.run.id, b.run.id] } },
        orderBy: { selectionReason: 'asc' },
      })
      expect(bindings).toHaveLength(2)
      expect(bindings.filter((x) => x.outcome === 'SELECTED')).toHaveLength(1)
      expect(bindings.filter((x) => x.selectionReason === 'CAPACITY_EXHAUSTED')).toHaveLength(1)
      expect(
        await db.agentWorkflowActivationHead.findUniqueOrThrow({
          where: { tenantId_venueId_registryKey: { tenantId, venueId, registryKey } },
          select: { selectedRunCount: true },
        }),
      ).toEqual({ selectedRunCount: 1 })
      const selected = bindings.find((x) => x.outcome === 'SELECTED')!
      const claimed = await claimAgentRunExecution({ tenantId, runId: selected.agentRunId })
      expect(claimed.workflowBindings[0]?.workflowVersion?.portableText).toBe(
        'Read retained evidence and return a bounded review.',
      )
      expect(
        await db.agentWorkflowRunBinding.count({ where: { agentRunId: selected.agentRunId } }),
      ).toBe(1)
      const skipped = bindings.find((binding) => binding.selectionReason === 'CAPACITY_EXHAUSTED')!
      const skippedClaim = await claimAgentRunExecution({ tenantId, runId: skipped.agentRunId })
      expect(skippedClaim.workflowBindings).toHaveLength(0)
      await db.agentRun.update({
        where: { id: skipped.agentRunId },
        data: { executionLeaseExpiresAt: new Date(Date.now() + 500) },
      })
      let announceRunLock!: () => void
      let releaseRunLock!: () => void
      const runLocked = new Promise<void>((resolve) => (announceRunLock = resolve))
      const mayReleaseRun = new Promise<void>((resolve) => (releaseRunLock = resolve))
      const lockHolder = db.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT id FROM agent_runs
          WHERE id=${skipped.agentRunId} AND tenant_id=${tenantId} FOR UPDATE`
        announceRunLock()
        await mayReleaseRun
      })
      await Promise.race([runLocked, lockHolder])
      let blockedHeartbeat:
        | Promise<
            | { ok: true; value: Awaited<ReturnType<typeof heartbeatAgentRunExecution>> }
            | { ok: false; error: unknown }
          >
        | undefined
      try {
        blockedHeartbeat = heartbeatAgentRunExecution({
          tenantId,
          runId: skipped.agentRunId,
          leaseToken: skippedClaim.leaseToken,
        }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        let observedLockWait = false
        for (let attempt = 0; attempt < 20 && !observedLockWait; attempt += 1) {
          const waiters = await db.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type='Lock'
                AND query LIKE '%execution_lease_expires_at > clock_timestamp()%'
            ) AS waiting`
          observedLockWait = waiters[0]?.waiting === true
          if (!observedLockWait) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(observedLockWait).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 550))
      } finally {
        releaseRunLock()
        await lockHolder
      }
      expect(await blockedHeartbeat).toMatchObject({ ok: false, error: { code: 'LEASE_LOST' } })
      await db.agentRun.update({
        where: { id: skipped.agentRunId },
        data: { executionLeaseExpiresAt: new Date(Date.now() - 1_000) },
      })
      await expect(
        heartbeatAgentRunExecution({
          tenantId,
          runId: skipped.agentRunId,
          leaseToken: skippedClaim.leaseToken,
        }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await db.agentRun.update({
        where: { id: skipped.agentRunId },
        data: {
          executionLeaseExpiresAt: new Date(Date.now() + 60_000),
          cancelRequestedAt: new Date(),
        },
      })
      await expect(
        failAgentRunExecution({
          tenantId,
          runId: skipped.agentRunId,
          leaseToken: skippedClaim.leaseToken,
          errorCode: 'TASK_EXECUTOR_FAILED',
          retryable: false,
        }),
      ).resolves.toMatchObject({ status: 'CANCELLED' })
      await expect(
        db.agentWorkflowRunBinding.update({
          where: { id: selected.id },
          data: { selectionProof: '0'.repeat(64) },
        }),
      ).rejects.toThrow(/append-only/iu)
      const revokeIdentity = {
        tenantId,
        venueId,
        registryKey,
        kind: 'REVOKE' as const,
        priorVersionId: registered.version.id,
        resultingVersionId: null,
        promotionAssessmentId: null,
        approvalDecisionId: revokeDecision.id,
        priorRevision: 1,
        resultingRevision: 2,
        evidenceDigest: 'f'.repeat(64),
        canaryPolicy: {},
        requiredCapabilities: [],
        reason: 'Fixture reviewed revocation.',
        createdBy: 'fixture-admin',
      }
      let announceHeadLock!: () => void
      let releaseHead!: () => void
      const headLocked = new Promise<void>((resolve) => (announceHeadLock = resolve))
      const mayRevoke = new Promise<void>((resolve) => (releaseHead = resolve))
      const revocation = db.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT id FROM agent_workflow_activation_heads
          WHERE tenant_id=${tenantId} AND venue_id=${venueId} AND registry_key=${registryKey}
          FOR UPDATE`
        announceHeadLock()
        await mayRevoke
        const revoke = await transaction.agentWorkflowActivationEvent.create({
          data: {
            operationId: randomUUID(),
            ...revokeIdentity,
            eventHash: agentWorkflowActivationEventHash(revokeIdentity),
          },
        })
        await transaction.agentWorkflowActivationHead.update({
          where: { tenantId_venueId_registryKey: { tenantId, venueId, registryKey } },
          data: { activeVersionId: null, activationEventId: revoke.id, revision: 2 },
        })
      })
      await Promise.race([headLocked, revocation])
      let completionSettled = false
      const completion = completeAgentRunExecution({
        tenantId,
        runId: selected.agentRunId,
        leaseToken: claimed.leaseToken,
        summary: 'Stale completion.',
      })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          completionSettled = true
        })
      try {
        let observedHeadWait = false
        for (let attempt = 0; attempt < 20 && !observedHeadWait; attempt += 1) {
          const waiters = await db.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE wait_event_type='Lock'
                AND query LIKE '%agent_workflow_activation_heads%FOR UPDATE%'
            ) AS waiting`
          observedHeadWait = waiters[0]?.waiting === true
          if (!observedHeadWait) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        expect(observedHeadWait).toBe(true)
        expect(completionSettled).toBe(false)
      } finally {
        releaseHead()
        await revocation
      }
      const completionResult = await completion
      expect(completionResult).toMatchObject({ ok: false, error: { code: 'REVOKED' } })
    }))
})
