import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { prepareAgentImprovementProposalAction } from './agent-improvement-proposal-actions'
import { recordAgentImprovementValidationAction } from './agent-improvement-validation-actions'
import { recordAgentOutcomeAction, recordAgentTrustSignalAction } from './agent-outcome-actions'
import { recordApprovalDecisionAction } from './approval-decisions'
import {
  createAgentWorkflowPromotionAssessment,
  revalidateAgentWorkflowPromotionAssessment,
} from './agent-workflow-promotion-assessment-actions'
import { appendEvaluationReviewAction } from './evaluation-review-actions'
import { claimAgentBridgeTask, registerAgentBridgeSession } from './agent-bridge-actions'
import { delegateAgentTaskAction } from './agent-delegation-actions'
import { createAgentTaskAction } from './agent-task-actions'
import {
  activateAgentBridgeCredentialAction,
  issueExternalCredentialAction,
} from './external-credential-actions'
import { verifyAgentBridgeCredential } from './external-credential-verification'
import {
  readCompatibleAgentWorkflowVersions,
  registerAgentWorkflowVersion,
} from './agent-workflow-registry-actions'
import {
  activateAgentWorkflowVersion,
  transitionAgentWorkflowActivation,
} from './agent-workflow-activation-actions'
import {
  requestAgentWorkflowActivationApproval,
  requestAgentWorkflowTransitionApproval,
} from './agent-workflow-activation-approval-requests'

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

      const appliedAction = await db.agentAction.create({
        data: {
          tenantId,
          venueId,
          agentRunId: runs[0]!.id,
          agentIdentityId: identityId,
          actorType: 'AGENT',
          actorId: identityId,
          requestedOperation: 'research.first',
          actionName: 'research.apply-recommendation',
          status: 'SUCCEEDED',
        },
      })
      const rollbackSignal = await recordAgentTrustSignalAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentRunId: runs[0]!.id,
        signalKind: 'ROLLBACK',
        relatedAgentActionId: appliedAction.id,
        summary: 'The applied recommendation was rolled back after review.',
        evidenceRef: 'fixture:rollback-review',
        actor,
      })
      const policySignal = await recordAgentTrustSignalAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentRunId: runs[0]!.id,
        signalKind: 'POLICY_VIOLATION',
        relatedAgentActionId: appliedAction.id,
        policyCode: 'unsupported-recommendation',
        severity: 'HIGH',
        summary: 'The recommendation exceeded its trusted evidence.',
        evidenceRef: 'fixture:policy-review',
        actor,
      })
      const confidenceSignal = await recordAgentTrustSignalAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentRunId: runs[1]!.id,
        signalKind: 'CONFIDENCE_CALIBRATION',
        predictionRef: 'recommendation-1',
        predictedConfidenceBps: 7800,
        actualCorrect: true,
        summary: 'The reviewed recommendation was correct.',
        evidenceRef: 'fixture:confidence-review',
        actor,
      })
      expect([rollbackSignal, policySignal, confidenceSignal]).toMatchObject([
        { signalKind: 'ROLLBACK', verdict: 'NEGATIVE', replayed: false },
        { signalKind: 'POLICY_VIOLATION', verdict: 'NEGATIVE', replayed: false },
        {
          signalKind: 'CONFIDENCE_CALIBRATION',
          verdict: 'POSITIVE',
          replayed: false,
        },
      ])
      await expect(
        recordAgentTrustSignalAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentRunId: runs[0]!.id,
          signalKind: 'ROLLBACK',
          relatedAgentActionId: appliedAction.id,
          summary: 'Duplicate rollback evidence must fail closed.',
          actor,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        db.agentOutcomeObservation.update({
          where: { id: rollbackSignal.id },
          data: { summary: 'Append-only evidence must not change.' },
        }),
      ).rejects.toThrow()

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
      expect(
        await db.agentAction.count({
          where: { tenantId, venueId, id: { not: appliedAction.id } },
        }),
      ).toBe(0)
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
        manifest = evalManifest,
      ) =>
        db.evalRun.create({
          data: {
            id,
            tenantId,
            venueId,
            idempotencyKey: `improvement-eval-${id}`,
            identityHash,
            corpusHash: 'b'.repeat(64),
            caseManifestSnapshot: manifest,
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

      const registryRequest = {
        operationId: randomUUID(),
        tenantId,
        venueId,
        manifest: {
          schemaVersion: 1 as const,
          registryKey: `grounded-review-${suffix}`,
          version: 1,
          kind: 'WORKFLOW' as const,
          description: 'Review one recommendation against retained evidence.',
          examples: ['Compare the recommendation with its retained source.'],
          requiredTools: [{ capability: 'resources:read', reason: 'Read retained evidence.' }],
          testedCases: ['Reject a recommendation without a retained source.'],
          rollback: null,
          license: null,
        },
        portableText:
          '# Grounded review\nRead the retained source before returning a recommendation.',
        provenance: {
          sourceType: 'HUMAN_AUTHORED' as const,
          sourceReferences: [`fixture:${suffix}`],
          capturedAt: null,
        },
        actor,
      }
      const registered = await registerAgentWorkflowVersion(
        registryRequest,
        new Set(['resources:read']),
      )
      await expect(
        registerAgentWorkflowVersion(registryRequest, new Set(['resources:read'])),
      ).resolves.toMatchObject({ replayed: true, version: { id: registered.version.id } })
      await expect(registerAgentWorkflowVersion(registryRequest, new Set())).resolves.toMatchObject(
        { replayed: true, version: { id: registered.version.id } },
      )
      await expect(
        registerAgentWorkflowVersion(
          { ...registryRequest, portableText: 'changed' },
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        readCompatibleAgentWorkflowVersions(
          { tenantId, venueId, registryKeys: [registryRequest.manifest.registryKey] },
          new Set(),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          compatibility: 'MISSING_TOOLS',
          missingCapabilities: ['resources:read'],
        }),
      ])
      const registryWorkerId = `registry-worker-${suffix}`
      const registryScopeKey = venueId
      const issuedRegistryCredential = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        kind: 'MCP',
        label: 'Registry machine fixture',
        capabilities: ['agent-improvements:propose', 'agent-runs:execute', 'resources:read'],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      const registryCredential = issuedRegistryCredential.credential
      await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        credentialId: registryCredential.id,
        expectedUpdatedAt: registryCredential.updatedAt,
      })
      await db.agentWorker.create({
        data: {
          id: registryWorkerId,
          workerKey: registryWorkerId,
          tenantId,
          clientId: tenantId,
          credentialId: registryCredential.id,
          credentialScopeKey: registryScopeKey,
          ownerAdminId: 'integration-operator',
          runtimeType: 'CODEX',
          label: 'Registry worker fixture',
          protocolVersion: 'fixture-v1',
          softwareVersion: 'fixture-v1',
          capabilities: ['agent-improvements:propose', 'resources:read'],
          agentRoles: ['QUALITY_REVIEW'],
          safeHealth: { status: 'fixture' },
          status: 'ONLINE',
          leaseExpiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      const registryRun = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: proposerIdentityId,
          runType: 'QUALITY_REVIEW',
          requestedOperation: 'agent-workflow-version.register',
          scopeSnapshot: { accessCapabilities: ['agent-improvements:propose'] },
          status: 'RUNNING',
          initiatedByType: 'HUMAN',
          initiatedById: 'integration-operator',
          startedAt: new Date(),
          executionWorkerId: registryWorkerId,
          executionLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      })
      const machineActor = {
        type: 'AGENT' as const,
        actorId: proposerIdentityId,
        role: 'AGENT' as const,
        agentIdentityId: proposerIdentityId,
        agentRunId: registryRun.id,
        workerId: registryWorkerId,
        credentialId: registryCredential.id,
        capability: 'agent-improvements:propose' as const,
        modelProvider: 'deterministic',
        modelName: 'fixture',
        idempotencyKey: randomUUID(),
      }
      const machineV1Request = {
        ...registryRequest,
        operationId: machineActor.idempotencyKey,
        manifest: {
          ...registryRequest.manifest,
          registryKey: `machine-grounded-review-${suffix}`,
        },
        actor: machineActor,
      }
      const machineV1 = await registerAgentWorkflowVersion(
        machineV1Request,
        new Set(['resources:read']),
      )
      await expect(
        registerAgentWorkflowVersion(machineV1Request, new Set()),
      ).resolves.toMatchObject({ replayed: true, version: { id: machineV1.version.id } })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { capabilities: [] },
      })
      await expect(
        registerAgentWorkflowVersion(machineV1Request, new Set(['resources:read'])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { leaseExpiresAt: new Date(Date.now() + 3_600_000) },
      })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { capabilities: ['agent-improvements:propose'] },
      })
      for (const actorOverride of [
        { workerId: `wrong-${registryWorkerId}` },
        { credentialId: `wrong-${registryCredential.id}` },
        { agentRunId: randomUUID() },
      ]) {
        await expect(
          registerAgentWorkflowVersion(
            { ...machineV1Request, actor: { ...machineActor, ...actorOverride } },
            new Set(['resources:read']),
          ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      }
      await expect(
        registerAgentWorkflowVersion(
          { ...machineV1Request, tenantId: `wrong-${tenantId}` },
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(
        registerAgentWorkflowVersion(
          { ...machineV1Request, venueId: `wrong-${venueId}` },
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const machineV2OperationId = randomUUID()
      const machineV2 = await registerAgentWorkflowVersion(
        {
          ...machineV1Request,
          operationId: machineV2OperationId,
          manifest: {
            ...machineV1Request.manifest,
            version: 2,
            rollback: {
              registryKey: machineV1Request.manifest.registryKey,
              version: 1,
              contentHash: machineV1.version.contentHash,
            },
          },
          portableText: `${machineV1Request.portableText}\n\nVersion two.`,
          supersedesVersionId: machineV1.version.id,
          actor: { ...machineActor, idempotencyKey: machineV2OperationId },
        },
        new Set(['resources:read']),
      )
      expect(machineV2.version).toMatchObject({
        version: 2,
        supersedesVersionId: machineV1.version.id,
      })

      await db.agentIdentity.update({
        where: { id: proposerIdentityId },
        data: { defaultProvider: 'codex-bridge', defaultModel: 'subscription-default' },
      })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: {
          capabilities: ['agent-improvements:propose', 'agent-runs:execute', 'resources:read'],
          leaseExpiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      const verifiedRegistryCredential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issuedRegistryCredential.plaintextSecret!,
      })
      const registryBridgeSessionId = randomUUID()
      await registerAgentBridgeSession({
        sessionId: registryBridgeSessionId,
        venueId,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Canonical registry reachability runner',
        runnerVersion: 'integration/1',
        supportedModels: ['subscription-default'],
        credential: verifiedRegistryCredential,
      })
      const operatorTask = await createAgentTaskAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: proposerIdentityId,
        prompt: 'Register the exact retained workflow artifact.',
        actor: { actorType: 'HUMAN', actorId: 'integration-operator', auditRole: 'PLATFORM_ADMIN' },
      })
      expect(operatorTask.run).toMatchObject({ status: 'QUEUED' })
      const claimedOperatorTask = await claimAgentBridgeTask({
        sessionId: registryBridgeSessionId,
        venueId,
        workerKey: registryWorkerId,
        credential: verifiedRegistryCredential,
      })
      expect(claimedOperatorTask.task).toMatchObject({
        id: operatorTask.run.id,
        requestedOperation: 'operator_task',
      })
      const operatorRegistrationId = randomUUID()
      const operatorRegistration = await registerAgentWorkflowVersion(
        {
          ...registryRequest,
          operationId: operatorRegistrationId,
          manifest: {
            ...registryRequest.manifest,
            registryKey: `operator-task-review-${suffix}`,
          },
          actor: {
            ...machineActor,
            agentRunId: operatorTask.run.id,
            idempotencyKey: operatorRegistrationId,
          },
        },
        new Set(['resources:read']),
      )
      expect(operatorRegistration).toMatchObject({
        replayed: false,
        version: {
          status: 'REGISTERED_UNACTIVATED',
          createdByType: 'AGENT',
          createdById: proposerIdentityId,
        },
      })

      const specialistIdentityId = `identity-registry-specialist-${suffix}`
      await db.agentIdentity.create({
        data: {
          id: specialistIdentityId,
          tenantId,
          venueId,
          identityKey: `registry-specialist.${suffix}`,
          name: 'Registry specialist',
          agentType: 'QUALITY_REVIEW',
          accessScope: 'VENUE',
          accessCapabilities: ['agent-improvements:propose', 'resources:read'],
          autonomyLevel: 'DRAFT',
          defaultProvider: 'codex-bridge',
          defaultModel: 'subscription-default',
          enabled: true,
          createdBy: 'integration-operator',
        },
      })
      const delegation = await delegateAgentTaskAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        parentAgentRunId: operatorTask.run.id,
        requestingAgentIdentityId: proposerIdentityId,
        specialistAgentIdentityId: specialistIdentityId,
        instructions: 'Register the specialist workflow artifact without activating it.',
        reason: 'Use the bounded registry specialist identity.',
      })
      expect(delegation.run).toMatchObject({ status: 'QUEUED' })
      const claimedSpecialistTask = await claimAgentBridgeTask({
        sessionId: registryBridgeSessionId,
        venueId,
        workerKey: registryWorkerId,
        credential: verifiedRegistryCredential,
      })
      expect(claimedSpecialistTask.task).toMatchObject({
        id: delegation.run.id,
        requestedOperation: 'specialist_delegation',
      })
      const specialistRegistrationId = randomUUID()
      const specialistRegistration = await registerAgentWorkflowVersion(
        {
          ...registryRequest,
          operationId: specialistRegistrationId,
          manifest: {
            ...registryRequest.manifest,
            registryKey: `specialist-task-review-${suffix}`,
          },
          actor: {
            ...machineActor,
            actorId: specialistIdentityId,
            agentIdentityId: specialistIdentityId,
            agentRunId: delegation.run.id,
            idempotencyKey: specialistRegistrationId,
          },
        },
        new Set(['resources:read']),
      )
      expect(specialistRegistration).toMatchObject({
        replayed: false,
        version: {
          status: 'REGISTERED_UNACTIVATED',
          createdByType: 'AGENT',
          createdById: specialistIdentityId,
        },
      })
      await expect(
        readCompatibleAgentWorkflowVersions(
          {
            tenantId,
            venueId,
            registryKeys: [
              operatorRegistration.version.registryKey,
              specialistRegistration.version.registryKey,
            ],
          },
          new Set(['resources:read']),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          registryKey: operatorRegistration.version.registryKey,
          compatibility: 'COMPATIBLE',
          version: expect.objectContaining({ status: 'REGISTERED_UNACTIVATED' }),
        }),
        expect.objectContaining({
          registryKey: specialistRegistration.version.registryKey,
          compatibility: 'COMPATIBLE',
          version: expect.objectContaining({ status: 'REGISTERED_UNACTIVATED' }),
        }),
      ])
      await db.agentRun.update({
        where: { id: registryRun.id },
        data: { executionLeaseExpiresAt: new Date(Date.now() - 1_000) },
      })
      await expect(
        registerAgentWorkflowVersion(machineV1Request, new Set(['resources:read'])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await db.agentRun.update({
        where: { id: registryRun.id },
        data: { executionLeaseExpiresAt: new Date(Date.now() + 3_600_000) },
      })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      })
      await expect(
        registerAgentWorkflowVersion(machineV1Request, new Set(['resources:read'])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { leaseExpiresAt: new Date(Date.now() + 3_600_000) },
      })
      const registryValidation = await recordAgentImprovementValidationAction(
        {
          ...validationRequest,
          operationId: randomUUID(),
          implementationKind: 'WORKFLOW_VERSION',
          implementationRef: `AgentWorkflowVersion:${registered.version.id}`,
          implementationVersion: '1',
          implementationHash: registered.version.contentHash,
        },
        db,
        new Set(['resources:read']),
      )
      expect(registryValidation).toMatchObject({
        replayed: false,
        implementationHash: registered.version.contentHash,
      })
      const createValidationPair = async (
        manifest: typeof evalManifest,
        evalCaseId: string,
        prefix: string,
      ) => {
        const before = await createEvalRun(
          randomUUID(),
          `${prefix}1`.padEnd(64, '1').slice(0, 64),
          `${prefix}-before`,
          `${prefix}2`.padEnd(64, '2').slice(0, 64),
          manifest,
        )
        const after = await createEvalRun(
          randomUUID(),
          `${prefix}3`.padEnd(64, '3').slice(0, 64),
          `${prefix}-after`,
          `${prefix}4`.padEnd(64, '4').slice(0, 64),
          manifest,
        )
        await db.evalResult.createMany({
          data: [
            {
              tenantId,
              venueId,
              runId: before.id,
              runIdentityHash: before.identityHash,
              caseId: evalCaseId,
              caseRevision: 1,
              caseHash: manifest[0]!.caseHash,
              outcome: 'SCORED',
              observationHash: `${prefix}5`.padEnd(64, '5').slice(0, 64),
              observationSnapshot: { answer: 'Before.' },
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
              runId: after.id,
              runIdentityHash: after.identityHash,
              caseId: evalCaseId,
              caseRevision: 1,
              caseHash: manifest[0]!.caseHash,
              outcome: 'SCORED',
              observationHash: `${prefix}6`.padEnd(64, '6').slice(0, 64),
              observationSnapshot: { answer: 'After.' },
              checksSnapshot: [{ check: 'grounding', passed: true }],
              passed: true,
              passedChecks: 1,
              totalChecks: 1,
              latencyMs: 105,
              costE8Usd: 102,
            },
          ],
        })
        return recordAgentImprovementValidationAction(
          {
            ...validationRequest,
            operationId: randomUUID(),
            baselineEvalRunId: before.id,
            candidateEvalRunId: after.id,
            implementationKind: 'WORKFLOW_VERSION',
            implementationRef: `AgentWorkflowVersion:${registered.version.id}`,
            implementationVersion: '1',
            implementationHash: registered.version.contentHash,
            changeDimensions: ['MODEL'],
          },
          db,
          new Set(['resources:read']),
        )
      }
      const overlapValidation = await createValidationPair(evalManifest, evalCase.id, '7')
      const overlapAssessment = await createAgentWorkflowPromotionAssessment({
        operationId: randomUUID(),
        tenantId,
        venueId,
        workflowVersionId: registered.version.id,
        proposalId: prepared.id,
        developmentValidationId: registryValidation.id,
        heldoutValidationId: overlapValidation.id,
        actor,
      })
      expect(overlapAssessment.assessment).toMatchObject({
        outcome: 'REJECTED_OVERFIT',
        diagnostics: expect.objectContaining({
          disjointCaseSets: false,
          autonomousPromotionEligible: false,
        }),
      })

      const heldoutCase = await db.evalCase.create({
        data: {
          tenantId,
          venueId,
          caseKey: `improvement-heldout-${suffix}`,
          revision: 1,
          schemaVersion: 'fixture-v1',
          category: 'grounding-heldout',
          caseHash: '8'.repeat(64),
          caseSnapshot: { prompt: 'Heldout grounded recommendation.' },
          createdBy: 'integration-operator',
          sourceType: 'SYNTHETIC',
          sourceRef: `fixture:heldout:${suffix}`,
        },
      })
      const heldoutManifest = [
        { caseId: heldoutCase.id, revision: 1, caseHash: heldoutCase.caseHash },
      ]
      const heldoutValidation = await createValidationPair(heldoutManifest, heldoutCase.id, '9')
      const assessmentRequest = {
        operationId: randomUUID(),
        tenantId,
        venueId,
        workflowVersionId: registered.version.id,
        proposalId: prepared.id,
        developmentValidationId: registryValidation.id,
        heldoutValidationId: heldoutValidation.id,
        actor,
      }
      await expect(
        createAgentWorkflowPromotionAssessment({
          ...assessmentRequest,
          operationId: randomUUID(),
          venueId: `wrong-${venueId}`,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const assessment = await createAgentWorkflowPromotionAssessment(assessmentRequest)
      expect(assessment.assessment).toMatchObject({
        outcome: 'EVIDENCE_READY_REVIEW_REQUIRED',
        diagnostics: expect.objectContaining({
          disjointCaseSets: true,
          targetImprovementObserved: true,
          thresholdResolution: 'UNRESOLVED',
          autonomousPromotionEligible: false,
        }),
      })
      await expect(
        createAgentWorkflowPromotionAssessment(assessmentRequest),
      ).resolves.toMatchObject({ replayed: true, assessment: { id: assessment.assessment.id } })

      const activationPolicy = {
        numerator: 1,
        denominator: 1,
        salt: `reviewed-activation-${suffix}`,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        maxSelectedRuns: 1,
        eligibleRunTypes: ['QUALITY_REVIEW'],
        eligibleOperations: ['operator_task'],
        skippedBaseline: { kind: 'NO_WORKFLOW' as const },
        supportedActionClasses: ['RUN_TERMINAL_WRITE' as const, 'AGENT_DELEGATION' as const],
      }
      const activationOperationId = randomUUID()
      const approvalRequestOperationId = randomUUID()
      const approvalRequestInput = {
        requestOperationId: approvalRequestOperationId,
        tenantId,
        venueId,
        agentIdentityId: identityId,
        registryKey: registered.version.registryKey,
        workflowVersionId: registered.version.id,
        promotionAssessmentId: assessment.assessment.id,
        expectedHeadRevision: 0,
        canaryPolicy: activationPolicy,
        reason: 'Review exact workflow activation evidence.',
        actor: { type: 'HUMAN' as const, id: actor.id, role: 'PLATFORM_ADMIN' as const },
      }
      const [requested, replayedRequest] = await Promise.all([
        requestAgentWorkflowActivationApproval(approvalRequestInput, new Set(['resources:read'])),
        requestAgentWorkflowActivationApproval(approvalRequestInput, new Set(['resources:read'])),
      ])
      expect([requested.replayed, replayedRequest.replayed].sort()).toEqual([false, true])
      await expect(
        requestAgentWorkflowActivationApproval(
          { ...approvalRequestInput, reason: 'Changed terms.' },
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const activationRequest = requested.request
      const activationDecision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: activationRequest.id,
        decision: 'APPROVED',
        reason: 'Approve this exact bounded workflow canary.',
        actor: { actorType: 'HUMAN', actorId: actor.id, auditRole: 'PLATFORM_ADMIN' },
      })
      const activationInput = {
        operationId: activationOperationId,
        tenantId,
        venueId,
        registryKey: registered.version.registryKey,
        workflowVersionId: registered.version.id,
        promotionAssessmentId: assessment.assessment.id,
        approvalDecisionId: activationDecision.id,
        expectedHeadRevision: 0,
        canaryPolicy: activationPolicy,
        reason: 'Activate exact reviewed canary.',
        actor,
      }
      const activated = await activateAgentWorkflowVersion(
        activationInput,
        new Set(['resources:read']),
      )
      expect(activated).toMatchObject({ replayed: false, event: { kind: 'ACTIVATE' } })
      await expect(
        activateAgentWorkflowVersion(activationInput, new Set(['resources:read'])),
      ).resolves.toMatchObject({ replayed: true, event: { id: activated.event.id } })
      await expect(
        activateAgentWorkflowVersion(
          { ...activationInput, venueId: `wrong-${venueId}` },
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      const workflowParent = await createAgentTaskAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: specialistIdentityId,
        prompt: 'Delegate one bounded evidence review to the exact specialist.',
        actor: { actorType: 'HUMAN', actorId: actor.id, auditRole: 'PLATFORM_ADMIN' },
      })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { capabilities: ['agent-improvements:propose', 'agent-runs:execute'] },
      })
      await expect(
        claimAgentBridgeTask({
          sessionId: registryBridgeSessionId,
          venueId,
          workerKey: registryWorkerId,
          credential: verifiedRegistryCredential,
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACTION' })
      expect(
        await db.agentRun.findUniqueOrThrow({
          where: { id: workflowParent.run.id },
          select: {
            status: true,
            attemptNumber: true,
            executionWorkerId: true,
            executionBridgeSessionId: true,
            executionLeaseToken: true,
          },
        }),
      ).toEqual({
        status: 'QUEUED',
        attemptNumber: 0,
        executionWorkerId: null,
        executionBridgeSessionId: null,
        executionLeaseToken: null,
      })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: {
          capabilities: ['agent-improvements:propose', 'agent-runs:execute', 'resources:read'],
        },
      })
      const claimedWorkflowParent = await claimAgentBridgeTask({
        sessionId: registryBridgeSessionId,
        venueId,
        workerKey: registryWorkerId,
        credential: verifiedRegistryCredential,
      })
      expect(claimedWorkflowParent.task).toMatchObject({ id: workflowParent.run.id })
      expect(claimedWorkflowParent.task?.prompt).toContain(registered.version.id)
      expect(claimedWorkflowParent.task?.prompt).toContain(registered.version.contentHash)
      expect(claimedWorkflowParent.task?.prompt).toContain('resources:read')
      const workflowSection = claimedWorkflowParent
        .task!.prompt!.split('Selected workflow instructions and provenance:\n')[1]!
        .split('\n\nBounded persisted execution context:')[0]!
      expect(JSON.parse(workflowSection)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requiredCapabilities: expect.arrayContaining(['resources:read']),
            workflowVersion: {
              id: registered.version.id,
              contentHash: registered.version.contentHash,
              portableText: registryRequest.portableText,
            },
          }),
        ]),
      )
      const workflowDelegationOperationId = randomUUID()
      const workflowDelegationInput = {
        operationId: workflowDelegationOperationId,
        tenantId,
        venueId,
        parentAgentRunId: workflowParent.run.id,
        requestingAgentIdentityId: specialistIdentityId,
        specialistAgentIdentityId: identityId,
        instructions: 'Review the retained evidence using the captured workflow head set.',
        reason: 'The workflow-bound parent delegates one canonical specialist task.',
      }
      await expect(delegateAgentTaskAction(workflowDelegationInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      const [workflowDelegation, concurrentWorkflowDelegation] = await Promise.all([
        delegateAgentTaskAction({
          ...workflowDelegationInput,
          executionLeaseToken: claimedWorkflowParent.task!.leaseToken,
        }),
        delegateAgentTaskAction({
          ...workflowDelegationInput,
          executionLeaseToken: claimedWorkflowParent.task!.leaseToken,
        }),
      ])
      expect([workflowDelegation.replayed, concurrentWorkflowDelegation.replayed].sort()).toEqual([
        false,
        true,
      ])
      expect(concurrentWorkflowDelegation.run.id).toBe(workflowDelegation.run.id)
      expect(workflowDelegation.run).toMatchObject({ status: 'QUEUED' })
      const workflowParentBinding = await db.agentWorkflowRunBinding.findFirstOrThrow({
        where: { tenantId, venueId, agentRunId: workflowParent.run.id },
      })
      expect(workflowParentBinding).toMatchObject({
        outcome: 'SELECTED',
        selectionReason: 'HASH_SELECTED',
      })
      const workflowChildBinding = await db.agentWorkflowRunBinding.findFirstOrThrow({
        where: { tenantId, venueId, agentRunId: workflowDelegation.run.id },
      })
      expect(workflowChildBinding).toMatchObject({
        registryKey: registered.version.registryKey,
        outcome: 'CANARY_SKIPPED_NO_WORKFLOW',
        selectionReason: 'INELIGIBLE_RUN',
      })
      await db.agentRun.update({
        where: { id: workflowParent.run.id },
        data: { executionLeaseExpiresAt: new Date(Date.now() - 1_000) },
      })
      await expect(
        delegateAgentTaskAction({
          ...workflowDelegationInput,
          operationId: randomUUID(),
          executionLeaseToken: claimedWorkflowParent.task!.leaseToken,
        }),
      ).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await db.agentRun.update({
        where: { id: workflowParent.run.id },
        data: { executionLeaseExpiresAt: new Date(Date.now() + 3_600_000) },
      })

      const rollbackRequestInput = {
        requestOperationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        registryKey: registered.version.registryKey,
        kind: 'ROLLBACK' as const,
        workflowVersionId: registered.version.id,
        expectedHeadRevision: 1,
        canaryPolicy: activationPolicy,
        reason: 'Review exact rollback.',
        actor: { type: 'HUMAN' as const, id: actor.id, role: 'PLATFORM_ADMIN' as const },
      }
      const rollbackRequest = await requestAgentWorkflowTransitionApproval(
        rollbackRequestInput,
        new Set(['resources:read']),
      )
      const rollbackDecision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: rollbackRequest.request.id,
        decision: 'APPROVED',
        reason: 'Approve rollback.',
        actor: { actorType: 'HUMAN', actorId: actor.id, auditRole: 'PLATFORM_ADMIN' },
      })
      await expect(
        transitionAgentWorkflowActivation(
          {
            operationId: randomUUID(),
            tenantId,
            venueId,
            registryKey: registered.version.registryKey,
            kind: 'ROLLBACK',
            workflowVersionId: registered.version.id,
            approvalDecisionId: rollbackDecision.id,
            expectedHeadRevision: 1,
            canaryPolicy: activationPolicy,
            reason: 'Review exact rollback.',
            actor,
          },
          new Set(['resources:read']),
        ),
      ).resolves.toMatchObject({ replayed: false, event: { kind: 'ROLLBACK' } })
      await expect(
        requestAgentWorkflowTransitionApproval(rollbackRequestInput, new Set(['resources:read'])),
      ).resolves.toMatchObject({ replayed: true, request: { id: rollbackRequest.request.id } })
      await expect(
        requestAgentWorkflowTransitionApproval(
          { ...rollbackRequestInput, reason: 'Changed rollback terms.' },
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      const queuedWorkflowParent = await createAgentTaskAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: specialistIdentityId,
        prompt: 'Remain queued until the reviewed workflow head is revoked.',
        actor: { actorType: 'HUMAN', actorId: actor.id, auditRole: 'PLATFORM_ADMIN' },
      })
      await expect(
        db.agentWorkflowRunBinding.findFirstOrThrow({
          where: { tenantId, venueId, agentRunId: queuedWorkflowParent.run.id },
        }),
      ).resolves.toMatchObject({ outcome: 'SELECTED', selectionReason: 'HASH_SELECTED' })
      const revokeRequestInput = {
        requestOperationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        registryKey: registered.version.registryKey,
        kind: 'REVOKE' as const,
        expectedHeadRevision: 2,
        reason: 'Review exact revoke.',
        actor: { type: 'HUMAN' as const, id: actor.id, role: 'PLATFORM_ADMIN' as const },
      }
      const revokeRequest = await requestAgentWorkflowTransitionApproval(
        revokeRequestInput,
        new Set(['resources:read']),
      )
      const revokeDecision = await recordApprovalDecisionAction({
        tenantId,
        venueId,
        approvalRequestId: revokeRequest.request.id,
        decision: 'APPROVED',
        reason: 'Approve revoke.',
        actor: { actorType: 'HUMAN', actorId: actor.id, auditRole: 'PLATFORM_ADMIN' },
      })
      await expect(
        transitionAgentWorkflowActivation(
          {
            operationId: randomUUID(),
            tenantId,
            venueId,
            registryKey: registered.version.registryKey,
            kind: 'REVOKE',
            approvalDecisionId: revokeDecision.id,
            expectedHeadRevision: 2,
            reason: 'Review exact revoke.',
            actor,
          },
          new Set(['resources:read']),
        ),
      ).resolves.toMatchObject({ replayed: false, event: { kind: 'REVOKE' } })
      const cancelledWorkflowRuns = await db.agentRun.findMany({
        where: {
          id: { in: [workflowParent.run.id, queuedWorkflowParent.run.id] },
          tenantId,
          venueId,
        },
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          executionLeaseToken: true,
          executionLeaseExpiresAt: true,
        },
        orderBy: { id: 'asc' },
      })
      expect(cancelledWorkflowRuns).toHaveLength(2)
      expect(cancelledWorkflowRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: workflowParent.run.id, status: 'CANCELLED' }),
          expect.objectContaining({ id: queuedWorkflowParent.run.id, status: 'CANCELLED' }),
        ]),
      )
      for (const run of cancelledWorkflowRuns) {
        expect(run.startedAt).toBeInstanceOf(Date)
        expect(run.completedAt).toBeInstanceOf(Date)
        expect(run.executionLeaseToken).toBeNull()
        expect(run.executionLeaseExpiresAt).toBeNull()
      }
      await expect(
        delegateAgentTaskAction({
          ...workflowDelegationInput,
          operationId: randomUUID(),
          executionLeaseToken: claimedWorkflowParent.task!.leaseToken,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(LEASE_LOST|REVOKED)$/u) })
      await expect(
        delegateAgentTaskAction({
          ...workflowDelegationInput,
          executionLeaseToken: claimedWorkflowParent.task!.leaseToken,
        }),
      ).resolves.toMatchObject({ replayed: true, run: { id: workflowDelegation.run.id } })
      await expect(
        requestAgentWorkflowTransitionApproval(revokeRequestInput, new Set(['resources:read'])),
      ).resolves.toMatchObject({ replayed: true, request: { id: revokeRequest.request.id } })

      const heldoutCandidateRun = await db.evalRun.findFirstOrThrow({
        where: { id: heldoutValidation.candidateEvalRunId, tenantId, venueId },
        select: { id: true, identityHash: true },
      })
      const heldoutCandidateResult = await db.evalResult.findFirstOrThrow({
        where: { tenantId, venueId, runId: heldoutCandidateRun.id },
        select: { id: true },
      })
      const revalidationInput = {
        tenantId,
        venueId,
        workflowVersionId: registered.version.id,
        assessmentId: assessment.assessment.id,
      }
      await expect(
        db.$transaction((tx) => revalidateAgentWorkflowPromotionAssessment(tx, revalidationInput)),
      ).resolves.toMatchObject({
        assessment: { id: assessment.assessment.id },
        evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })

      let announceLocked!: () => void
      const locked = new Promise<void>((resolve) => {
        announceLocked = resolve
      })
      let releaseLocks!: () => void
      const release = new Promise<void>((resolve) => {
        releaseLocks = resolve
      })
      const lockHoldingRevalidation = db.$transaction(
        async (tx) => {
          const result = await revalidateAgentWorkflowPromotionAssessment(tx, revalidationInput)
          announceLocked()
          await release
          return result
        },
        { timeout: 15_000 },
      )
      await Promise.race([locked, lockHoldingRevalidation])
      const reviewPromise = appendEvaluationReviewAction({
        tenantId,
        venueId,
        runId: heldoutCandidateRun.id,
        expectedRunIdentityHash: heldoutCandidateRun.identityHash,
        resultId: heldoutCandidateResult.id,
        expectedRevision: 0,
        operationId: randomUUID(),
        decision: 'ACCEPTED',
        conclusion: 'The heldout result remains suitable after human review.',
        rubricVersion: 'promotion-v1',
        actor,
      })
      const reviewOutcome = reviewPromise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      let blockedReviewWrites = 0n
      try {
        for (let attempt = 0; attempt < 50 && blockedReviewWrites === 0n; attempt += 1) {
          const [observation] = await db.$queryRaw<Array<{ blocked: bigint }>>`
            SELECT COUNT(*)::bigint AS blocked
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%eval_reviews%'
          `
          blockedReviewWrites = observation?.blocked ?? 0n
          if (blockedReviewWrites === 0n)
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
        }
        expect(blockedReviewWrites).toBeGreaterThan(0n)
      } finally {
        releaseLocks()
      }
      await expect(lockHoldingRevalidation).resolves.toMatchObject({
        assessment: { id: assessment.assessment.id },
      })
      await expect(reviewOutcome).resolves.toMatchObject({
        ok: true,
        value: { revision: 1, replayed: false },
      })
      await expect(
        db.$transaction((tx) => revalidateAgentWorkflowPromotionAssessment(tx, revalidationInput)),
      ).rejects.toMatchObject({ code: 'CONFLICT' })

      await expect(
        createAgentWorkflowPromotionAssessment({
          ...assessmentRequest,
          proposalId: `wrong-${prepared.id}`,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        db.agentWorkflowPromotionAssessment.update({
          where: { id: assessment.assessment.id },
          data: { outcome: 'REJECTED_REGRESSION' },
        }),
      ).rejects.toThrow(/append-only/iu)
      await expect(
        recordAgentImprovementValidationAction(
          {
            ...validationRequest,
            operationId: randomUUID(),
            implementationKind: 'WORKFLOW_VERSION',
            implementationRef: `AgentWorkflowVersion:${registered.version.id}`,
            implementationVersion: '1',
            implementationHash: '0'.repeat(64),
          },
          db,
          new Set(['resources:read']),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      await expect(
        db.agentWorkflowVersion.update({
          where: { id: registered.version.id },
          data: { portableText: 'tampered' },
        }),
      ).rejects.toThrow(/append-only/iu)

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
