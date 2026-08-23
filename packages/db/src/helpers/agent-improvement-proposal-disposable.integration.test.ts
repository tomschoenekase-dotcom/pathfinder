import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { prepareAgentImprovementProposalAction } from './agent-improvement-proposal-actions'
import { recordAgentImprovementValidationAction } from './agent-improvement-validation-actions'
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

      const evalCase = await db.evalCase.create({
        data: {
          tenantId,
          venueId,
          caseKey: `improvement-grounding-${suffix}`,
          revision: 1,
          schemaVersion: 'fixture-v1',
          category: 'grounding',
          caseHash: 'a'.repeat(64),
          caseSnapshot: { prompt: 'Give one grounded recommendation.' },
          createdBy: 'integration-operator',
          sourceType: 'SYNTHETIC',
          sourceRef: `fixture:${suffix}`,
        },
      })
      const evalManifest = [{ caseId: evalCase.id, revision: 1, caseHash: evalCase.caseHash }]
      const createEvalRun = (
        id: string,
        identityHash: string,
        modelName: string,
        modelHash: string,
      ) =>
        db.evalRun.create({
          data: {
            id,
            tenantId,
            venueId,
            idempotencyKey: `improvement-eval-${id}`,
            identityHash,
            corpusHash: 'b'.repeat(64),
            caseManifestSnapshot: evalManifest,
            promptContractVersion: 'fixture-v1',
            promptContractHash: 'c'.repeat(64),
            contentSnapshotKind: 'NATIVE_CORE_V1',
            contentSnapshotRef: `fixture-content-${suffix}`,
            contentSnapshotVersion: 1,
            contentSnapshotHash: 'd'.repeat(64),
            modelProvider: 'deterministic',
            modelName,
            modelSnapshotHash: modelHash,
            modelSnapshot: { provider: 'deterministic', model: modelName },
            runConfigSnapshot: { temperature: 0 },
            identitySnapshot: { purpose: 'synthetic-improvement-validation' },
            declaredBudgetCeilingE8Usd: 1000,
            createdBy: 'integration-operator',
            triggerType: 'SYNTHETIC_VALIDATION',
            status: 'COMPLETED',
            startedAt: new Date(),
            completedAt: new Date(),
          },
        })
      const baselineEvalRun = await createEvalRun(
        randomUUID(),
        'e'.repeat(64),
        'fixture-baseline',
        'f'.repeat(64),
      )
      const candidateEvalRun = await createEvalRun(
        randomUUID(),
        '1'.repeat(64),
        'fixture-candidate',
        '2'.repeat(64),
      )
      await db.evalResult.createMany({
        data: [
          {
            tenantId,
            venueId,
            runId: baselineEvalRun.id,
            runIdentityHash: baselineEvalRun.identityHash,
            caseId: evalCase.id,
            caseRevision: evalCase.revision,
            caseHash: evalCase.caseHash,
            outcome: 'SCORED',
            observationHash: '3'.repeat(64),
            observationSnapshot: { answer: 'Ungrounded answer.' },
            checksSnapshot: [{ check: 'grounding', passed: false }],
            passed: false,
            passedChecks: 0,
            totalChecks: 1,
            latencyMs: 100,
            costE8Usd: 100,
          },
          {
            tenantId,
            venueId,
            runId: candidateEvalRun.id,
            runIdentityHash: candidateEvalRun.identityHash,
            caseId: evalCase.id,
            caseRevision: evalCase.revision,
            caseHash: evalCase.caseHash,
            outcome: 'SCORED',
            observationHash: '4'.repeat(64),
            observationSnapshot: { answer: 'Grounded answer.' },
            checksSnapshot: [{ check: 'grounding', passed: true }],
            passed: true,
            passedChecks: 1,
            totalChecks: 1,
            latencyMs: 110,
            costE8Usd: 120,
          },
        ],
      })

      const validationRequest = {
        operationId: randomUUID(),
        tenantId,
        venueId,
        proposalId: prepared.id,
        baselineEvalRunId: baselineEvalRun.id,
        candidateEvalRunId: candidateEvalRun.id,
        implementationKind: 'MODEL_POLICY_VERSION' as const,
        implementationRef: `fixture:model-policy:${suffix}`,
        implementationVersion: 'fixture-candidate-v1',
        implementationHash: '5'.repeat(64),
        changeDimensions: ['MODEL' as const],
        actor,
      }
      const validation = await recordAgentImprovementValidationAction(validationRequest)
      expect(validation).toMatchObject({
        replayed: false,
        proposalId: prepared.id,
        baselineEvalRunId: baselineEvalRun.id,
        candidateEvalRunId: candidateEvalRun.id,
        changeDimensions: ['MODEL'],
        comparisonSnapshot: {
          status: 'COMPARABLE_WITH_DECLARED_CHANGE',
          interpretation: 'evidence-only-no-promotion-threshold',
          totals: { caseCount: 1, resolvedFailures: 1, newFailures: 0 },
        },
      })
      await expect(
        recordAgentImprovementValidationAction(validationRequest),
      ).resolves.toMatchObject({
        id: validation.id,
        replayed: true,
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
        db.agentImprovementValidationEvidence.update({
          where: { id: validation.id },
          data: { implementationRef: 'fixture:tampered' },
        }),
      ).rejects.toThrow(/append-only/u)

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
