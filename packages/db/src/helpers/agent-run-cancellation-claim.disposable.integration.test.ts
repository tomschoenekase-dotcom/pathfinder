import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { claimAgentBridgeTask, registerAgentBridgeSession } from './agent-bridge-actions'
import { requestAgentRunCancellationAction } from './agent-run-cancellation-actions'
import { claimAgentRunExecution } from './agent-run-execution-actions'
import {
  activateAgentBridgeCredentialAction,
  issueExternalCredentialAction,
} from './external-credential-actions'
import { verifyAgentBridgeCredential } from './external-credential-verification'

const enabled =
  process.env.RUN_AGENT_RUN_CANCELLATION_CLAIM_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_agent_run_cancellation_[a-f0-9]{12}$/u.test(
    process.env.DATABASE_URL ?? '',
  )

describe.skipIf(!enabled)('agent run cancellation claim on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())

  it('commits cancellation before returning NOT_CLAIMABLE and consumes no attempt', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
      const tenantId = `cancel-claim-${suffix}`
      const venueId = `venue-${suffix}`
      const identityId = `identity-${suffix}`
      const cancelRequestedAt = new Date()
      await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Cancellation proof' } })
      await db.venue.create({ data: { id: venueId, tenantId, slug: venueId, name: 'Venue' } })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: 'cancellation.proof',
          name: 'Cancellation Proof',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          defaultProvider: 'codex-bridge',
          defaultModel: 'subscription-default',
          enabled: true,
          createdBy: 'fixture-owner',
        },
      })
      const actor = {
        type: 'HUMAN' as const,
        id: 'fixture-owner',
        role: 'PLATFORM_ADMIN' as const,
      }
      const delegatedParent = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'coordinate_immediate_cancellation',
          scopeSnapshot: {},
          status: 'RUNNING',
          startedAt: new Date(),
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: new Date(Date.now() + 60_000),
          attemptNumber: 1,
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
          maxAttempts: 2,
        },
      })
      for (const status of ['QUEUED', 'AWAITING_INPUT', 'AWAITING_APPROVAL'] as const) {
        const startedAt = status === 'QUEUED' ? null : new Date()
        const cancellable = await db.agentRun.create({
          data: {
            operationId: randomUUID(),
            tenantId,
            venueId,
            agentIdentityId: identityId,
            runType: 'OPERATIONS',
            requestedOperation: `immediate_cancel_${status.toLowerCase()}`,
            parentAgentRunId: status === 'QUEUED' ? delegatedParent.id : null,
            scopeSnapshot: {},
            status,
            startedAt,
            modelProvider: 'codex-bridge',
            modelName: 'subscription-default',
            initiatedByType: 'HUMAN',
            initiatedById: actor.id,
            maxAttempts: 2,
          },
        })
        const cancelled = await requestAgentRunCancellationAction({
          tenantId,
          venueId,
          agentRunId: cancellable.id,
          reason: 'Disposable lifecycle proof',
          actor,
        })
        expect(cancelled).toMatchObject({ status: 'CANCELLED', outcome: 'REQUESTED' })
        const replay = await requestAgentRunCancellationAction({
          tenantId,
          venueId,
          agentRunId: cancellable.id,
          reason: 'Replay must not duplicate evidence',
          actor,
        })
        expect(replay).toMatchObject({ status: 'CANCELLED', outcome: 'REPLAYED' })
        const retainedImmediate = await db.agentRun.findFirstOrThrow({
          where: { id: cancellable.id, tenantId, venueId },
          select: { status: true, startedAt: true, completedAt: true, cancelRequestedAt: true },
        })
        expect(retainedImmediate).toMatchObject({ status: 'CANCELLED' })
        expect(retainedImmediate.startedAt).not.toBeNull()
        expect(retainedImmediate.completedAt).toEqual(retainedImmediate.cancelRequestedAt)
        if (startedAt) expect(retainedImmediate.startedAt).toEqual(startedAt)
        expect(
          await db.agentTimelineEvent.count({
            where: { tenantId, venueId, agentRunId: cancellable.id, eventType: 'CANCELLED' },
          }),
        ).toBe(1)
        if (status === 'QUEUED') {
          const parentResult = await db.agentMessage.findFirstOrThrow({
            where: {
              tenantId,
              venueId,
              agentRunId: delegatedParent.id,
              messageType: 'RESULT',
            },
            select: { content: true, agentIdentityId: true },
          })
          expect(parentResult).toEqual({
            content: `agent-run:${cancellable.id} cancelled. Untrusted delegated terminal result: Cancellation was finalized by a platform administrator.`,
            agentIdentityId: identityId,
          })
          expect(
            await db.agentTimelineEvent.count({
              where: {
                tenantId,
                venueId,
                agentRunId: delegatedParent.id,
                eventType: 'DELEGATED_TASK_CANCELLED',
              },
            }),
          ).toBe(1)
          await expect(
            db.agentRun.findFirstOrThrow({
              where: { id: delegatedParent.id, tenantId, venueId },
              select: { status: true, executionLeaseToken: true },
            }),
          ).resolves.toEqual({
            status: 'RUNNING',
            executionLeaseToken: delegatedParent.executionLeaseToken,
          })
        }
      }

      const legacyRequestedAt = new Date(Date.now() - 60_000)
      const legacyPending = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'legacy_pending_cancellation',
          scopeSnapshot: {},
          status: 'AWAITING_INPUT',
          startedAt: new Date(Date.now() - 120_000),
          cancelRequestedAt: legacyRequestedAt,
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
          maxAttempts: 2,
        },
      })
      await expect(
        requestAgentRunCancellationAction({
          tenantId,
          venueId,
          agentRunId: legacyPending.id,
          reason: 'Finalize retained legacy intent',
          actor,
        }),
      ).resolves.toMatchObject({
        status: 'CANCELLED',
        outcome: 'REQUESTED',
        cancelRequestedAt: legacyRequestedAt,
      })
      const retainedLegacy = await db.agentRun.findFirstOrThrow({
        where: { id: legacyPending.id, tenantId, venueId },
        select: { status: true, cancelRequestedAt: true, completedAt: true },
      })
      expect(retainedLegacy).toMatchObject({
        status: 'CANCELLED',
        cancelRequestedAt: legacyRequestedAt,
      })
      expect(retainedLegacy.completedAt!.getTime()).toBeGreaterThan(legacyRequestedAt.getTime())

      const running = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'running_intent_only',
          scopeSnapshot: {},
          status: 'RUNNING',
          startedAt: new Date(),
          executionLeaseToken: randomUUID(),
          executionLeaseExpiresAt: new Date(Date.now() + 60_000),
          attemptNumber: 1,
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
          maxAttempts: 2,
        },
      })
      await expect(
        requestAgentRunCancellationAction({
          tenantId,
          venueId,
          agentRunId: running.id,
          reason: 'Running worker must observe intent',
          actor,
        }),
      ).resolves.toMatchObject({ status: 'RUNNING', outcome: 'REQUESTED' })
      await expect(
        db.agentRun.findFirstOrThrow({ where: { id: running.id }, select: { status: true } }),
      ).resolves.toEqual({ status: 'RUNNING' })

      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'must_not_execute',
          requestPrompt: 'x'.repeat(2_000),
          scopeSnapshot: {},
          status: 'QUEUED',
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: 'fixture-owner',
          cancelRequestedAt,
          maxAttempts: 2,
        },
      })

      await expect(
        claimAgentRunExecution({
          tenantId,
          runId: run.id,
          workflowContextMaxChars: 1,
          executionPromptMaxChars: 1,
        }),
      ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })

      const retained = await db.agentRun.findFirstOrThrow({
        where: { id: run.id, tenantId },
        select: {
          status: true,
          attemptNumber: true,
          cancelRequestedAt: true,
          startedAt: true,
          completedAt: true,
          executionLeaseToken: true,
        },
      })
      expect(retained).toMatchObject({
        status: 'CANCELLED',
        attemptNumber: 0,
        cancelRequestedAt,
        executionLeaseToken: null,
      })
      expect(retained.startedAt).not.toBeNull()
      expect(retained.completedAt).not.toBeNull()

      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        kind: 'MCP',
        label: 'Cancellation starvation proof',
        capabilities: ['agent-runs:execute'],
        expiresAt: new Date(Date.now() + 60 * 60_000),
      })
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor,
      })
      const credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const sessionId = randomUUID()
      await registerAgentBridgeSession({
        sessionId,
        venueId,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Cancellation starvation proof',
        runnerVersion: 'fixture/1',
        supportedModels: ['subscription-default'],
        credential,
      })
      const oldest = new Date('2026-09-01T00:00:00.000Z')
      await db.agentRun.createMany({
        data: Array.from({ length: 26 }, (_, index) => ({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS' as const,
          requestedOperation: `cancelled_candidate_${index}`,
          scopeSnapshot: {},
          status: 'QUEUED' as const,
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN' as const,
          initiatedById: actor.id,
          cancelRequestedAt: new Date(oldest.getTime() + index),
          createdAt: new Date(oldest.getTime() + index),
          maxAttempts: 2,
        })),
      })
      const ready = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'OPERATIONS',
          requestedOperation: 'ready_after_cancelled_window',
          scopeSnapshot: {},
          status: 'QUEUED',
          modelProvider: 'codex-bridge',
          modelName: 'subscription-default',
          initiatedByType: 'HUMAN',
          initiatedById: actor.id,
          createdAt: new Date(oldest.getTime() + 10_000),
          maxAttempts: 2,
        },
      })
      const bridgeClaim = await claimAgentBridgeTask({ sessionId, venueId, credential })
      expect(bridgeClaim.task).toMatchObject({
        id: ready.id,
        requestedOperation: 'ready_after_cancelled_window',
        attemptNumber: 1,
      })
      expect(
        await db.agentRun.count({
          where: { tenantId, venueId, cancelRequestedAt: { not: null }, status: 'QUEUED' },
        }),
      ).toBe(26)
    })
  })
})
