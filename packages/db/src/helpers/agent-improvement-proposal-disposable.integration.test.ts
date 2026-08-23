import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { prepareAgentImprovementProposalAction } from './agent-improvement-proposal-actions'
import { recordAgentOutcomeAction } from './agent-outcome-actions'
import { recordApprovalDecisionAction } from './approval-decisions'

const enabled =
  process.env.RUN_AGENT_IMPROVEMENT_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent improvement proposal disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('preserves exact evidence and keeps approval provider-dark and execution-free', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-improvement-${suffix}`
      const venueId = `venue-improvement-${suffix}`
      const identityId = `identity-improvement-${suffix}`

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic improvement tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic improvement venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `improvement-target.${suffix}`,
          name: 'Improvement target',
          agentType: 'RESEARCH',
          accessScope: 'VENUE',
          autonomyLevel: 'READ_ONLY',
          enabled: true,
          createdBy: 'integration-operator',
        },
      })

      const runs = await Promise.all(
        ['first', 'second'].map((label) =>
          db.agentRun.create({
            data: {
              operationId: randomUUID(),
              tenantId,
              venueId,
              agentIdentityId: identityId,
              runType: 'RESEARCH',
              requestedOperation: `research.${label}`,
              scopeSnapshot: {},
              status: 'COMPLETED',
              modelProvider: 'deterministic',
              modelName: 'fixture',
              initiatedByType: 'HUMAN',
              initiatedById: 'integration-operator',
              startedAt: new Date(),
              completedAt: new Date(),
            },
          }),
        ),
      )
      const actor = {
        type: 'HUMAN' as const,
        id: 'integration-operator',
        role: 'PLATFORM_ADMIN' as const,
      }
      const outcomes = await Promise.all([
        recordAgentOutcomeAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentRunId: runs[0]!.id,
          verdict: 'NEGATIVE',
          summary: 'The recommendation lacked current source evidence.',
          evidenceRef: 'fixture:negative-review',
          actor,
        }),
        recordAgentOutcomeAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentRunId: runs[1]!.id,
          verdict: 'MIXED',
          summary: 'The recommendation became useful after source correction.',
          evidenceRef: 'fixture:mixed-review',
          actor,
        }),
      ])

      const operationId = randomUUID()
      const request = {
        operationId,
        tenantId,
        venueId,
        agentIdentityId: identityId,
        outcomeObservationIds: outcomes.map((outcome) => outcome.id).reverse(),
        proposalKey: 'research-source-grounding',
        revision: 1,
        targetKind: 'RETRIEVAL' as const,
        title: 'Ground research answers in current sources',
        hypothesis: 'Retrieval misses are causing unsupported recommendations.',
        proposedChange: 'Require source retrieval before producing a recommendation.',
        validationPlan: 'Replay affected cases and compare outcomes before any rollout.',
        actor,
      }
      const prepared = await prepareAgentImprovementProposalAction(request)
      expect(prepared).toMatchObject({
        replayed: false,
        tenantId,
        venueId,
        agentIdentityId: identityId,
        taskClass: 'RESEARCH',
        baselineSnapshot: {
          observationCount: 2,
          verdictCounts: { POSITIVE: 0, MIXED: 1, NEGATIVE: 1, INCONCLUSIVE: 0 },
          interpretation: 'descriptive-evidence-only',
        },
        approvalRequest: { riskCategory: 'MEDIUM', decision: null },
      })
      await expect(prepareAgentImprovementProposalAction(request)).resolves.toMatchObject({
        id: prepared.id,
        replayed: true,
      })

      const identityBefore = await db.agentIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: {
          autonomyLevel: true,
          accessCapabilities: true,
          autonomousActions: true,
          defaultProvider: true,
          defaultModel: true,
          updatedAt: true,
        },
      })
      await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: prepared.approvalRequestId,
        decision: 'APPROVED',
        reason: 'Approve the hypothesis for separately validated implementation.',
        actor: {
          actorType: 'HUMAN',
          actorId: 'integration-operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      const identityAfter = await db.agentIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: {
          autonomyLevel: true,
          accessCapabilities: true,
          autonomousActions: true,
          defaultProvider: true,
          defaultModel: true,
          updatedAt: true,
        },
      })
      expect(identityAfter).toEqual(identityBefore)
      expect(await db.agentAction.count({ where: { tenantId, venueId } })).toBe(0)
      expect(
        await db.agentRun.count({ where: { tenantId, venueId, status: 'AWAITING_APPROVAL' } }),
      ).toBe(0)
      expect(
        await db.agentImprovementProposalEvidence.count({
          where: { tenantId, proposalId: prepared.id },
        }),
      ).toBe(2)

      const proposerIdentityId = `identity-reviewer-${suffix}`
      await db.agentIdentity.create({
        data: {
          id: proposerIdentityId,
          tenantId,
          venueId,
          identityKey: `improvement-reviewer.${suffix}`,
          name: 'Improvement reviewer',
          agentType: 'QUALITY_REVIEW',
          accessScope: 'VENUE',
          accessCapabilities: ['agent-improvements:propose'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: 'integration-operator',
        },
      })
      const proposerRun = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: proposerIdentityId,
          runType: 'QUALITY_REVIEW',
          requestedOperation: 'agent-improvement.propose',
          scopeSnapshot: { accessCapabilities: ['agent-improvements:propose'] },
          status: 'RUNNING',
          initiatedByType: 'HUMAN',
          initiatedById: 'integration-operator',
          startedAt: new Date(),
        },
      })
      const agentProposalOperationId = randomUUID()
      const agentPrepared = await prepareAgentImprovementProposalAction({
        ...request,
        operationId: agentProposalOperationId,
        proposalKey: 'research-source-grounding-agent-review',
        actor: {
          type: 'AGENT',
          actorId: proposerIdentityId,
          role: 'AGENT',
          agentIdentityId: proposerIdentityId,
          agentRunId: proposerRun.id,
          workerId: `worker-${suffix}`,
          credentialId: `credential-${suffix}`,
          capability: 'agent-improvements:propose',
          modelProvider: 'deterministic',
          modelName: 'fixture',
          idempotencyKey: agentProposalOperationId,
        },
      })
      expect(agentPrepared).toMatchObject({
        replayed: false,
        agentIdentityId: identityId,
        createdByType: 'AGENT',
        createdById: proposerIdentityId,
      })
      expect(
        await db.agentRun.findUniqueOrThrow({
          where: { id: proposerRun.id },
          select: { status: true },
        }),
      ).toEqual({ status: 'AWAITING_APPROVAL' })
      expect(
        await db.agentAction.count({
          where: {
            tenantId,
            venueId,
            agentRunId: proposerRun.id,
            actionName: 'torchiko.agent_improvements.propose',
            status: 'SUCCEEDED',
          },
        }),
      ).toBe(1)
      await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: agentPrepared.approvalRequestId,
        decision: 'APPROVED',
        reason: 'Accept the agent-authored hypothesis for separately validated implementation.',
        actor: {
          actorType: 'HUMAN',
          actorId: 'integration-operator',
          auditRole: 'PLATFORM_ADMIN',
        },
      })
      expect(
        await db.agentIdentity.findUniqueOrThrow({
          where: { id: identityId },
          select: {
            autonomyLevel: true,
            accessCapabilities: true,
            autonomousActions: true,
            defaultProvider: true,
            defaultModel: true,
            updatedAt: true,
          },
        }),
      ).toEqual(identityBefore)

      await expect(
        db.agentImprovementProposal.update({
          where: { id: prepared.id },
          data: { title: 'Tampered title' },
        }),
      ).rejects.toThrow(/append-only/u)
      await expect(
        db.agentImprovementProposalEvidence.delete({
          where: {
            proposalId_outcomeObservationId: {
              proposalId: prepared.id,
              outcomeObservationId: outcomes[0]!.id,
            },
          },
        }),
      ).rejects.toThrow(/append-only/u)
    })
  })
})
