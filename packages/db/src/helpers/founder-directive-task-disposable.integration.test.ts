import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { recordApprovalDecisionAction } from './approval-decisions'
import {
  materializeFounderDirectiveTaskAction,
  proposeFounderDirectiveTaskAction,
  readFounderDirectiveTasks,
} from './founder-directive-task-actions'
import { recordFounderOperatingExchange } from './founder-operating-exchanges'
import {
  activatePlatformWorkerPolicyCredentialAction,
  issuePlatformWorkerPolicyCredentialAction,
} from './platform-worker-policy-credentials'

const enabled =
  process.env.RUN_FOUNDER_DIRECTIVE_TASK_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('founder directive task disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('separates directive proposal, human approval, and exact task materialization', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const founderId = `founder-${suffix}`
      const workerId = `worker-${suffix}`
      const tenantId = `tenant-founder-task-${suffix}`
      const venueId = `venue-founder-task-${suffix}`
      const identityId = `identity-founder-task-${suffix}`
      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic founder task tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic founder task venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `founder-task.${suffix}`,
          name: 'Founder task specialist',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          enabled: true,
          createdBy: founderId,
        },
      })

      const issued = await issuePlatformWorkerPolicyCredentialAction({
        operationId: randomUUID(),
        workerId,
        label: 'Disposable founder directive worker',
        capabilities: [
          'founder-directive-tasks:read',
          'founder-directive-tasks:propose',
          'founder-directive-tasks:materialize',
        ],
        expiresAt: null,
        actor: { type: 'HUMAN', id: founderId, role: 'PLATFORM_ADMIN' },
      })
      await activatePlatformWorkerPolicyCredentialAction({
        operationId: randomUUID(),
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor: { type: 'HUMAN', id: founderId, role: 'PLATFORM_ADMIN' },
      })

      const directive = await recordFounderOperatingExchange({
        operationId: randomUUID(),
        operatorUserId: founderId,
        prompt: 'Prepare a review of this venue’s visitor reliability issues.',
        intent: 'DIRECTIVE',
        disposition: 'RECORDED_FOR_TRIAGE',
        responseTitle: 'Direction recorded for triage',
        responseBody:
          'This direction is visible to authorized workers, but nothing was executed or approved.',
        evidence: [],
        snapshot: {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          boundedSnapshot: { limit: 25, hasMore: false },
          metrics: {
            decisions: 0,
            criticalRisks: 0,
            workingAgents: 0,
            blockedAgents: 0,
            customerItems: 0,
          },
          changesSinceLastReview: {
            criticalRisks: 0,
            decisions: 0,
            completedAgents: 0,
            outcomes: 0,
            customerItems: 0,
          },
          operatingCosts: {
            windowDays: 30,
            knownOperatingCostUsd: '0.00000000',
            priorKnownOperatingCostUsd: '0.00000000',
            changeUsd: '0.00000000',
            coverageComplete: false,
            anomalyThreshold: 'UNRESOLVED',
          },
          authority: {
            canExecute: false,
            canApprove: false,
            canContactCustomers: false,
            canChangePricing: false,
            canSpendMoney: false,
            canMutatePolicy: false,
          },
        },
      })
      const actor = {
        type: 'AGENT' as const,
        id: workerId,
        credentialId: issued.credential.id,
        capability: 'founder-directive-tasks:propose' as const,
      }
      const proposalOperationId = randomUUID()
      const proposalInput = {
        action: 'propose' as const,
        operationId: proposalOperationId,
        founderOperatingExchangeId: directive.exchange.id,
        expectedSnapshotHash: directive.exchange.snapshotHash,
        tenantId,
        venueId,
        agentIdentityId: identityId,
        proposedPrompt:
          'Review bounded visitor reliability evidence for this venue and prepare internal recommendations. Do not contact the customer or change venue state.',
        rationale: 'This is the exact scoped interpretation of the retained founder direction.',
        riskCategory: 'LOW' as const,
        constraints: [
          'No customer contact.',
          'No pricing, billing, deployment, policy, or venue-content mutation.',
        ],
        actor,
      }
      const beforeRuns = await db.agentRun.count({ where: { tenantId, venueId } })
      const proposed = await proposeFounderDirectiveTaskAction(proposalInput)
      expect(proposed).toMatchObject({
        replayed: false,
        request: {
          status: 'AWAITING_APPROVAL',
          approvalRequest: {
            proposedAction: 'torchiko.founder-directive.materialize-task',
            decision: null,
          },
        },
      })
      await expect(proposeFounderDirectiveTaskAction(proposalInput)).resolves.toMatchObject({
        replayed: true,
        request: { id: proposed.request.id },
      })
      expect(await db.agentRun.count({ where: { tenantId, venueId } })).toBe(beforeRuns)

      const decision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: proposed.request.approvalRequestId,
        decision: 'APPROVED',
        reason: 'Approve only this exact internal task for the selected read-only specialist.',
        actor: { actorType: 'HUMAN', actorId: founderId, auditRole: 'PLATFORM_ADMIN' },
      })
      expect(
        await db.founderDirectiveTaskRequest.findUniqueOrThrow({
          where: { id: proposed.request.id },
          select: { status: true, agentRunId: true },
        }),
      ).toEqual({ status: 'APPROVED', agentRunId: null })
      expect(await db.agentRun.count({ where: { tenantId, venueId } })).toBe(beforeRuns)

      const materializationOperationId = randomUUID()
      const materializeInput = {
        action: 'materialize' as const,
        operationId: materializationOperationId,
        requestId: proposed.request.id,
        expectedApprovalDecisionId: decision.id,
        actor: { ...actor, capability: 'founder-directive-tasks:materialize' as const },
      }
      const materialized = await materializeFounderDirectiveTaskAction(materializeInput)
      expect(materialized).toMatchObject({
        replayed: false,
        request: { status: 'MATERIALIZED' },
        run: { status: 'QUEUED' },
      })
      await expect(materializeFounderDirectiveTaskAction(materializeInput)).resolves.toMatchObject({
        replayed: true,
        run: { id: materialized.run.id },
      })
      const run = await db.agentRun.findUniqueOrThrow({
        where: { id: materialized.run.id },
        select: {
          requestPrompt: true,
          requestedOperation: true,
          scopeSnapshot: true,
          initiatedByType: true,
          initiatedById: true,
        },
      })
      expect(run).toMatchObject({
        requestPrompt: proposalInput.proposedPrompt,
        requestedOperation: 'founder_directive_task',
        initiatedByType: 'AGENT',
        initiatedById: workerId,
        scopeSnapshot: {
          founderDirective: {
            requestId: proposed.request.id,
            exchangeId: directive.exchange.id,
            approvalDecisionId: decision.id,
          },
          authority: {
            taskMaterializationApproved: true,
            customerContactAuthorized: false,
            pricingAuthorized: false,
            billingAuthorized: false,
            deploymentAuthorized: false,
            policyMutationAuthorized: false,
            valuableDataDestructionAuthorized: false,
          },
        },
      })
      expect(await db.agentRun.count({ where: { tenantId, venueId } })).toBe(beforeRuns + 1)

      await expect(
        materializeFounderDirectiveTaskAction({
          ...materializeInput,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        db.founderDirectiveTaskRequest.update({
          where: { id: proposed.request.id },
          data: { rationale: 'Attempted rewrite of retained proposal.' },
        }),
      ).rejects.toThrow()
      await expect(
        db.founderDirectiveTaskRequest.delete({ where: { id: proposed.request.id } }),
      ).rejects.toThrow()

      const listed = await readFounderDirectiveTasks({ status: 'MATERIALIZED' })
      expect(listed.items.some((item) => item.id === proposed.request.id)).toBe(true)
      expect(listed.boundaries).toMatchObject({
        proposalIsExecution: false,
        approvalIsExecution: false,
        exactApprovalRequiredToMaterialize: true,
        customerContactAuthorized: false,
      })

      const auditActions = await db.auditLog.findMany({
        where: {
          tenantId,
          action: {
            in: ['founder-directive.task-proposed', 'founder-directive.task-materialized'],
          },
        },
        select: { action: true },
      })
      expect(auditActions.map((item) => item.action).sort()).toEqual([
        'founder-directive.task-materialized',
        'founder-directive.task-proposed',
      ])
    })
  })
})
