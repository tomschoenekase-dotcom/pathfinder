import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { prepareAgentImprovementProposalAction } from './agent-improvement-proposal-actions'
import { recordAgentImprovementValidationAction } from './agent-improvement-validation-actions'
import { recordAgentOutcomeAction, recordAgentTrustSignalAction } from './agent-outcome-actions'
import { recordApprovalDecisionAction } from './approval-decisions'
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
        capabilities: ['agent-improvements:propose', 'agent-runs:execute'],
        expiresAt: new Date(Date.now() + 60_000),
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
          capabilities: ['agent-improvements:propose'],
          agentRoles: ['QUALITY_REVIEW'],
          safeHealth: { status: 'fixture' },
          status: 'ONLINE',
          leaseExpiresAt: new Date(Date.now() + 60_000),
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
          capabilities: ['agent-improvements:propose', 'agent-runs:execute'],
          leaseExpiresAt: new Date(Date.now() + 60_000),
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
          accessCapabilities: ['agent-improvements:propose'],
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
        data: { executionLeaseExpiresAt: new Date(Date.now() + 60_000) },
      })
      await db.agentWorker.update({
        where: { id: registryWorkerId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      })
      await expect(
        registerAgentWorkflowVersion(machineV1Request, new Set(['resources:read'])),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
