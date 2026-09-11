import { adminAgentTaskRequestsRouter } from './routers/admin/agent-task-requests'
import type { TRPCContext } from './context'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  answerAgentQuestionAction,
  askAgentQuestionActionInTransaction,
  assertCurrentAgentWorkerClaim,
  activateAgentBridgeCredentialAction,
  claimIntakeUploadVerificationAction,
  claimIntakeV1FileExtractionDispatch,
  claimAgentRunExecution,
  createAgentTaskAction,
  configureIntakeSourceAgentRouting,
  assertIntakeSourceAgentRoutingInTransaction,
  createSystemSourceAgentTaskInTransaction,
  dispatchIntakeSourceAgentTask,
  listPendingIntakeSourceAgentDispatches,
  recoverMissingIntakeSourceAgentDispatches,
  getIntakeV1ProcessingRead,
  completeIntakeV1FileExtractionDispatch,
  db,
  issueExternalCredentialAction,
  preflightIntakeV1FileExtractionDispatch,
  recordIntakeUploadPrecheckAction,
  reserveIntakeUploadAction,
  reviewIntakeFileExtractionAction,
  registerAgentBridgeSession,
  registerAgentWorkerAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  submitIntakeV1Action,
  verifyAgentBridgeCredential,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import {
  createFileExtractionClarificationQuestion,
  resolveFileExtractionClarificationInTransaction,
} from './lib/intake-file-clarifications'
import { executeIntakeFileExtraction } from './lib/intake-file-extraction-service'
import { createAgentBridgeRegistry } from './agent-bridge/registry'
import { handleAgentBridgeHttpRequest } from './agent-bridge/http'
import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './mcp/registry'
import { readMcpResource } from './mcp/read-actions'
import { createPathfinderMcpAgentActions } from './mcp/agent-actions'
import { writeSourceClarificationAmendment } from './mcp/source-amendment-writer'
import { buildIntakeVenuePackageCandidate } from './lib/intake-venue-package-candidate'

const enabled =
  process.env.RUN_QUESTION_SOURCE_READER_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_question_source_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('question-source registered worker admission', () => {
  afterAll(async () => db.$disconnect())

  it('reads exact question source through registered worker admission', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-source-question-${suffix}`
    const venueId = `venue-source-question-${suffix}`
    const wrongVenueId = `venue-source-question-wrong-${suffix}`
    const actorId = `founder-source-question-${suffix}`
    const identityId = `identity-source-question-${suffix}`
    const wrongIdentityId = `identity-source-question-wrong-${suffix}`
    let runId = ''
    const siblingRunId = `run-source-question-sibling-${suffix}`
    const terminalRunId = `run-source-question-terminal-${suffix}`
    const wrongVenueRunId = `run-source-question-wrong-venue-${suffix}`
    const bridgeSessionId = randomUUID()
    let workerId = ''
    let syntheticBearer = ''
    let credential!: Awaited<ReturnType<typeof verifyAgentBridgeCredential>>
    const sourcePrefix = 'Retained review notes. '.repeat(230)
    const excerpt =
      'The east and south greenhouses look similar; the source does not establish whether they are distinct buildings.'
    const lateCapacity = 'The approved visitor capacity is exactly 137.'
    const extractedText = `${sourcePrefix}\n${excerpt}\n${lateCapacity}\n`
    let intakeRunId = ''
    let processingSubmissionId = ''
    let receiptId = ''
    let extractedTextHash = ''
    const scope = { tenantId, venueId }

    // This is deliberately synthetic schema setup. The disabled credential is foreign-key
    // metadata only: no secret is usable, no provider is contacted, and no worker is started.
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic source question tenant', slug: tenantId },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic source question venue', slug: venueId },
      })
      await db.user.create({
        data: { id: actorId, email: `${actorId}@example.test`, fullName: 'Synthetic founder' },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: actorId, role: 'MANAGER', joinedAt: new Date() },
      })
      await db.venue.create({
        data: {
          id: wrongVenueId,
          tenantId,
          name: 'Synthetic wrong source question venue',
          slug: wrongVenueId,
        },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          ...scope,
          identityKey: `source.question.${suffix}`,
          name: 'Synthetic Content identity',
          defaultProvider: 'codex-bridge',
          defaultModel: 'subscription-default',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read', 'content.draft'],
          autonomyLevel: 'DRAFT',
          autonomousActions: ['content.prepare-draft'],
          enabled: true,
          createdBy: actorId,
        },
      })
      await db.agentIdentity.create({
        data: {
          id: wrongIdentityId,
          tenantId,
          venueId: wrongVenueId,
          identityKey: `source.question.wrong.${suffix}`,
          name: 'Synthetic wrong Content identity',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read', 'content.draft'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: actorId,
        },
      })
      const actor = { type: 'HUMAN' as const, id: actorId, role: 'PLATFORM_ADMIN' as const }
      const issued = await issueExternalCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        actor,
        kind: 'MCP',
        label: 'Disposable question-source reader credential',
        capabilities: [
          'agent-runs:execute',
          'intake-source:read',
          'intake:draft',
          'questions:ask',
          'resources:read',
        ],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      syntheticBearer = issued.plaintextSecret!
      const activated = await activateAgentBridgeCredentialAction({
        operationId: randomUUID(),
        tenantId,
        clientId: tenantId,
        venueId,
        credentialId: issued.credential.id,
        expectedUpdatedAt: issued.credential.updatedAt,
        actor,
      })
      expect(activated.credential.enabled).toBe(true)
      credential = await verifyAgentBridgeCredential({
        tenantId,
        venueId,
        plaintext: issued.plaintextSecret!,
      })
      const worker = await registerAgentWorkerAction(
        {
          workerKey: `worker-source-question-${suffix}`,
          runtimeType: 'CODEX',
          label: 'Disposable Content source reader',
          protocolVersion: 'mcp-2026-07-28',
          softwareVersion: 'integration/1',
          capabilities: [
            'agent-runs:execute',
            'intake-source:read',
            'intake:draft',
            'questions:ask',
            'resources:read',
          ],
          agentRoles: ['CONTENT'],
          safeHealth: {},
        },
        credential,
      )
      workerId = worker.id
      await registerAgentBridgeSession({
        sessionId: bridgeSessionId,
        venueId,
        provider: 'CODEX_SUBSCRIPTION',
        label: 'Disposable question-source runner',
        runnerVersion: 'integration/1',
        supportedModels: ['subscription-default'],
        credential,
      })
      await db.agentRun.createMany({
        data: [
          {
            id: siblingRunId,
            operationId: randomUUID(),
            ...scope,
            agentIdentityId: identityId,
            runType: 'FILE_SOURCE_FIXTURE',
            requestedOperation: 'source-question.sibling',
            scopeSnapshot: { authority: 'data-only' },
            status: 'QUEUED',
            initiatedByType: 'HUMAN',
            initiatedById: actorId,
          },
          {
            id: terminalRunId,
            operationId: randomUUID(),
            ...scope,
            agentIdentityId: identityId,
            runType: 'FILE_SOURCE_FIXTURE',
            requestedOperation: 'source-question.terminal',
            scopeSnapshot: { authority: 'data-only' },
            status: 'COMPLETED',
            initiatedByType: 'HUMAN',
            initiatedById: actorId,
            startedAt: new Date(),
            completedAt: new Date(),
          },
          {
            id: wrongVenueRunId,
            operationId: randomUUID(),
            tenantId,
            venueId: wrongVenueId,
            agentIdentityId: wrongIdentityId,
            runType: 'FILE_SOURCE_FIXTURE',
            requestedOperation: 'source-question.wrong-venue',
            scopeSnapshot: { authority: 'data-only' },
            status: 'QUEUED',
            initiatedByType: 'HUMAN',
            initiatedById: actorId,
          },
        ],
      })
      // Canonical fixture path: reserved upload, verified evidence, V1 submission, leased
      // dispatch, and deterministic local extraction. The transport yields only fixture bytes.
      const bytes = Buffer.from(extractedText, 'utf8')
      const objectGeneration = randomUUID()
      const storageVersionId = `fixture-version-${randomUUID()}`
      const upload = await reserveIntakeUploadAction({
        tenantId,
        venueId,
        actor,
        request: {
          requestId: randomUUID(),
          displayName: 'Synthetic retained source.txt',
          fileName: 'synthetic-retained-source.txt',
          mimeType: 'text/plain',
          category: 'DOCUMENT',
          byteSize: bytes.byteLength,
          sha256: sha256(bytes),
        },
        trustedObjectIdentity: {
          objectKey: `intake-quarantine/${randomUUID()}`,
          objectGeneration,
        },
      })
      const precheckClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: upload.upload.id,
        actor,
        claimId: precheckClaim,
      })
      await recordIntakeUploadPrecheckAction({
        tenantId,
        venueId,
        uploadId: upload.upload.id,
        actor,
        claimId: precheckClaim,
        verified: {
          objectGeneration,
          storageVersionId,
          mimeType: 'text/plain',
          byteSize: bytes.byteLength,
          sha256: sha256(bytes),
        },
        evidence: {
          engine: 'fixture-precheck',
          engineVersion: '1',
          verdictHash: sha256(`precheck:${suffix}`),
          computedByteSize: bytes.byteLength,
          computedSha256: sha256(bytes),
        },
      })
      const malwareClaim = randomUUID()
      await claimIntakeUploadVerificationAction({
        tenantId,
        venueId,
        uploadId: upload.upload.id,
        actor,
        claimId: malwareClaim,
      })
      await settleIntakeUploadAuthoritativeVerificationAction({
        tenantId,
        venueId,
        uploadId: upload.upload.id,
        actor,
        claimId: malwareClaim,
        malware: {
          verdict: 'CLEAN',
          engine: 'fixture-malware',
          engineVersion: '1',
          verdictHash: sha256(`clean:${suffix}`),
          computedByteSize: bytes.byteLength,
          computedSha256: sha256(bytes),
        },
      })
      const submission = await submitIntakeV1Action({
        tenantId,
        venueId,
        ownerUserId: actorId,
        actorRole: 'MANAGER',
        selection: {
          operationId: randomUUID(),
          partialAcknowledged: false,
          drafts: {},
          intakeRunIds: [],
          intakeUploadIds: [upload.upload.id],
        },
      })
      processingSubmissionId = submission.submissionId
      const revision = await db.intakeV1SubmissionRevision.findFirstOrThrow({
        where: { tenantId, venueId, submissionId: submission.submissionId, revision: 1 },
        include: { members: true },
      })
      const member = revision.members.find((value) => value.intakeUploadId === upload.upload.id)!
      const dispatch = await db.intakeV1ProcessingDispatch.findFirstOrThrow({
        where: { tenantId, venueId, memberId: member.id, kind: 'FILE_EXTRACTION' },
      })
      const claimedDispatch = await claimIntakeV1FileExtractionDispatch({
        dispatchId: dispatch.id,
        leaseOwner: `fixture-source-question-${suffix}`,
      })
      expect(claimedDispatch).not.toBeNull()
      const lease = {
        id: claimedDispatch!.id,
        tenantId: claimedDispatch!.tenantId,
        venueId: claimedDispatch!.venueId,
        operationId: claimedDispatch!.operationId,
        leaseToken: claimedDispatch!.leaseToken,
        sourceHash: claimedDispatch!.sourceHash,
      }
      await expect(
        preflightIntakeV1FileExtractionDispatch({
          ...lease,
          policyVersion: claimedDispatch!.policyVersion,
        }),
      ).resolves.toMatchObject({ state: 'EXECUTE' })
      const extracted = await executeIntakeFileExtraction({
        db,
        tenantId,
        venueId,
        runId: claimedDispatch!.intakeRunId,
        operationId: claimedDispatch!.operationId,
        createdBy: actorId,
        storage: {
          send: async () => ({
            Body: (async function* () {
              yield bytes
            })(),
          }),
        },
        fileDispatchLease: lease,
      })
      expect(extracted).toMatchObject({ outcome: 'SUCCEEDED', replayed: false })
      await completeIntakeV1FileExtractionDispatch({ ...lease, receiptId: extracted.receiptId })
      const receipt = await db.intakeFileExtractionReceipt.findFirstOrThrow({
        where: { id: extracted.receiptId, tenantId, venueId, runId: claimedDispatch!.intakeRunId },
        select: { id: true, runId: true, extractedTextHash: true },
      })
      intakeRunId = receipt.runId
      receiptId = receipt.id
      extractedTextHash = receipt.extractedTextHash!
    })

    const sourceAssignment = {
      version: 1 as const,
      kind: 'FILE_EXTRACTION' as const,
      intakeRunId,
      receiptId,
      extractedTextHash,
    }
    const taskInput = {
      operationId: randomUUID(),
      ...scope,
      agentIdentityId: identityId,
      prompt:
        'Review the assigned exact extraction and clarify whether the greenhouse references describe distinct buildings.',
      sourceAssignment,
      actor: { actorType: 'HUMAN' as const, actorId, auditRole: 'PLATFORM_ADMIN' as const },
    }
    // Concurrent retries must recover one canonical task with one immutable source input.
    const tasks = await Promise.all([
      createAgentTaskAction(taskInput),
      createAgentTaskAction(taskInput),
    ])
    expect(tasks[0].run.id).toBe(tasks[1].run.id)
    expect(tasks.map((task) => task.replayed).sort()).toEqual([false, true])
    runId = tasks[0].run.id
    for (const changedSource of [
      undefined,
      { ...sourceAssignment, extractedTextHash: 'b'.repeat(64) },
    ])
      await expect(
        createAgentTaskAction({ ...taskInput, sourceAssignment: changedSource }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      createAgentTaskAction({
        ...taskInput,
        operationId: randomUUID(),
        sourceAssignment: { ...sourceAssignment, receiptId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      createAgentTaskAction({
        ...taskInput,
        operationId: randomUUID(),
        venueId: wrongVenueId,
        agentIdentityId: wrongIdentityId,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // Disposable legacy-state simulation: a completed extraction predating outbox support.
    expect(await db.intakeSourceAgentDispatch.count({ where: { ...scope, intakeRunId } })).toBe(1)
    await db.intakeSourceAgentDispatch.deleteMany({
      where: { ...scope, intakeRunId, status: 'PENDING' },
    })
    const recoveredOutboxes = await withTenantIsolationBypass(() =>
      Promise.all([
        recoverMissingIntakeSourceAgentDispatches({ limit: 25 }),
        recoverMissingIntakeSourceAgentDispatches({ limit: 25 }),
      ]),
    )
    expect(recoveredOutboxes.reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(
      await withTenantIsolationBypass(() =>
        recoverMissingIntakeSourceAgentDispatches({ limit: 25 }),
      ),
    ).toBe(0)
    const sourceOutbox = await db.intakeSourceAgentDispatch.findFirstOrThrow({
      where: { ...scope, intakeRunId },
    })
    const sourceDispatchInput = { id: sourceOutbox.id, ...scope }
    const ownerProcessing = () =>
      getIntakeV1ProcessingRead({
        ...scope,
        ownerUserId: actorId,
        submissionId: processingSubmissionId,
        revision: 1,
        websiteResearchEnabled: false,
        fileExtractionEnabled: true,
      })
    expect((await ownerProcessing()).members[0]).toMatchObject({
      status: 'COMPLETED',
      sourceReview: { status: 'WAITING' },
    })

    await expect(dispatchIntakeSourceAgentTask(sourceDispatchInput)).resolves.toEqual({
      status: 'HELD',
    })
    expect(
      await db.intakeSourceAgentDispatch.findFirst({ where: sourceDispatchInput }),
    ).toMatchObject({ holdReason: 'ROUTING_UNCONFIGURED', agentRunId: null })
    expect((await ownerProcessing()).members[0]?.sourceReview).toEqual({
      status: 'HELD',
      reasonCode: 'REVIEW_SETUP_REQUIRED',
    })
    await expect(
      getIntakeV1ProcessingRead({
        ...scope,
        ownerUserId: `${actorId}-foreign`,
        submissionId: processingSubmissionId,
        revision: 1,
        websiteResearchEnabled: false,
        fileExtractionEnabled: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const clientScopeIdentityId = `source-client-${suffix}`
    await db.agentIdentity.create({
      data: {
        id: clientScopeIdentityId,
        tenantId,
        venueId: null,
        identityKey: `source.client.${suffix}`,
        name: 'Client-wide source reviewer',
        agentType: 'CONTENT',
        accessScope: 'CLIENT',
        accessCapabilities: ['intake.read', 'content.draft'],
        autonomyLevel: 'DRAFT',
        autonomousActions: ['content.prepare-draft'],
        enabled: true,
        defaultProvider: 'codex-bridge',
        defaultModel: 'subscription-default',
        createdBy: actorId,
      },
    })
    const routingCaller = adminAgentTaskRequestsRouter.createCaller({
      db,
      headers: new Headers(),
      session: {
        userId: actorId,
        activeTenantId: tenantId,
        role: 'MANAGER',
        isPlatformAdmin: true,
      },
    } as TRPCContext)
    const routingCandidates = await routingCaller.listIntakeSourceAgentRoutingCandidates({
      ...scope,
      limit: 100,
    })
    expect(routingCandidates.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([identityId, clientScopeIdentityId]),
    )
    expect(routingCandidates.items.map((item) => item.id)).not.toContain(wrongIdentityId)
    const routingInput = { ...scope, agentIdentityId: identityId, expectedRevision: 0 }
    const routingCreates = await Promise.allSettled([
      configureIntakeSourceAgentRouting(routingInput, actorId),
      configureIntakeSourceAgentRouting(routingInput, actorId),
    ])
    expect(routingCreates.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(routingCreates.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const routing = await db.intakeSourceAgentRoutingPolicy.findFirstOrThrow({ where: scope })
    expect(routing).toMatchObject({ enabled: false, revision: 1, agentIdentityId: identityId })
    await expect(dispatchIntakeSourceAgentTask(sourceDispatchInput)).resolves.toEqual({
      status: 'HELD',
    })
    expect(
      await db.intakeSourceAgentDispatch.findFirst({ where: sourceDispatchInput }),
    ).toMatchObject({ holdReason: 'ROUTING_DISABLED', agentRunId: null })
    await expect(
      configureIntakeSourceAgentRouting(
        { ...routingInput, agentIdentityId: wrongIdentityId, expectedRevision: 1, enabled: true },
        actorId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const enabledRouting = await configureIntakeSourceAgentRouting(
      { ...routingInput, expectedRevision: 1, enabled: true },
      actorId,
    )
    expect(enabledRouting).toMatchObject({
      taskDispatched: false,
      policy: { enabled: true, revision: 2 },
    })
    expect(await db.intakeSourceAgentRoutingPolicy.count({ where: scope })).toBe(1)
    expect(
      await db.auditLog.count({
        where: { tenantId, targetId: routing.id, action: 'intake-source-agent.routing-configured' },
      }),
    ).toBe(2)

    const extractionDispatch = await db.intakeV1ProcessingDispatch.findFirstOrThrow({
      where: { ...scope, intakeRunId },
      select: { id: true },
    })
    const systemTaskInput = {
      ...scope,
      operationId: randomUUID(),
      agentIdentityId: identityId,
      sourceAssignment,
      dispatchId: extractionDispatch.id,
      policyRevision: 2,
    }
    await expect(
      db.$transaction(async (tx) => {
        const admitTask = async () => {
          await assertIntakeSourceAgentRoutingInTransaction(tx, systemTaskInput)
        }
        const systemTask = await createSystemSourceAgentTaskInTransaction(tx, systemTaskInput, {
          admitTask,
        })
        const replay = await createSystemSourceAgentTaskInTransaction(tx, systemTaskInput, {
          admitTask,
        })
        expect(replay).toMatchObject({ replayed: true, run: { id: systemTask.run.id } })
        const stored = await tx.agentRun.findFirstOrThrow({
          where: { id: systemTask.run.id, ...scope },
        })
        expect(stored).toMatchObject({
          initiatedByType: 'SYSTEM',
          requestedOperation: 'intake_source_review',
          scopeSnapshot: {
            sourceDispatch: { version: 1, dispatchId: extractionDispatch.id, policyRevision: 2 },
          },
        })
        expect(
          await tx.agentMessage.findFirstOrThrow({ where: { ...scope, agentRunId: stored.id } }),
        ).toMatchObject({ role: 'SYSTEM', messageType: 'PROMPT' })
        expect(
          await tx.auditLog.findFirstOrThrow({
            where: { tenantId, targetId: stored.id, action: 'agent-task.queued' },
          }),
        ).toMatchObject({ actorType: 'SYSTEM' })
        await expect(
          createSystemSourceAgentTaskInTransaction(tx, systemTaskInput, {
            admitTask: async () => {
              await assertIntakeSourceAgentRoutingInTransaction(tx, {
                ...systemTaskInput,
                policyRevision: 1,
              })
            },
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' })
        throw new Error('rollback system task construction proof')
      }),
    ).rejects.toThrow('rollback system task construction proof')
    expect(
      await db.agentRun.count({ where: { tenantId, operationId: systemTaskInput.operationId } }),
    ).toBe(0)

    const questionCount = () => db.agentQuestion.count({ where: { tenantId } })
    const runStatus = (id: string) =>
      db.agentRun.findFirstOrThrow({ where: { id, tenantId }, select: { status: true } })
    const input = (overrides: Record<string, unknown> = {}) => ({
      db,
      ...scope,
      runId: intakeRunId,
      receiptId,
      expectedExtractedTextHash: extractedTextHash,
      fieldPath: 'entities.greenhouse',
      reason: 'CONTRADICTION' as const,
      blockerScope: 'FOUNDATIONAL' as const,
      question: 'Are the east and south greenhouse references two distinct buildings?',
      evidenceExcerpt: excerpt,
      agentIdentityId: identityId,
      agentRunId: runId,
      ...overrides,
    })

    const initialClaim = await claimAgentRunExecution({
      tenantId,
      runId,
      bridgeSessionId,
      executionWorkerId: workerId,
    })
    const initialContext = JSON.parse(initialClaim.executionContext) as {
      sourceAssignment: typeof sourceAssignment
      currentResolvedQuestions: unknown[]
    }
    expect(initialContext.sourceAssignment).toEqual(sourceAssignment)
    expect(initialContext.currentResolvedQuestions).toEqual([])
    expect(await db.agentQuestion.count({ where: { ...scope, agentRunId: runId } })).toBe(0)
    expect(initialClaim.executionContext.length).toBeLessThanOrEqual(8000)
    expect(initialClaim).toMatchObject({
      status: 'RUNNING',
      attemptNumber: 1,
    })
    expect(await db.agentRun.findFirstOrThrow({ where: { id: runId, ...scope } })).toMatchObject({
      executionBridgeSessionId: bridgeSessionId,
      executionWorkerId: workerId,
      executionLeaseToken: initialClaim.leaseToken,
    })

    const beforeRejected = await questionCount()
    await expect(
      createFileExtractionClarificationQuestion(input({ venueId: wrongVenueId })),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      createFileExtractionClarificationQuestion(input({ agentIdentityId: wrongIdentityId })),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    await expect(
      createFileExtractionClarificationQuestion(input({ agentRunId: terminalRunId })),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    await expect(
      createFileExtractionClarificationQuestion(input({ agentRunId: wrongVenueRunId })),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(await questionCount()).toBe(beforeRejected)
    await expect(runStatus(runId)).resolves.toEqual({ status: 'RUNNING' })
    await expect(runStatus(siblingRunId)).resolves.toEqual({ status: 'QUEUED' })
    await expect(runStatus(terminalRunId)).resolves.toEqual({ status: 'COMPLETED' })
    await expect(runStatus(wrongVenueRunId)).resolves.toEqual({ status: 'QUEUED' })

    const operationalRegistry = createPathfinderMcpRegistry(
      createPathfinderMcpAgentActions(db, {
        read: (input, context) => readMcpResource(db as never, input, context),
      } as Omit<PathfinderMcpDomainActions, 'askOperator' | 'delegateSpecialist'>),
    )
    const bridge = createAgentBridgeRegistry({ operationalRegistry })
    const assignedSourceArgs = {
      venueId,
      toolName: 'pathfinder.read',
      executionClaim: {
        agentRunId: runId,
        bridgeSessionId,
        workerId,
        executionLeaseToken: initialClaim.leaseToken,
      },
      arguments: { resource: 'assigned-source', agentRunId: runId, pageSize: 4000 },
    }
    const initialSourcePage = await bridge.callOperationalTool(assignedSourceArgs, { credential })
    const initialSourceData = initialSourcePage.structuredContent!.data as {
      page: { text: string }
      nextSourceCursor: string
    }
    expect(initialSourceData.page.text).not.toContain(lateCapacity)
    expect(initialSourceData.nextSourceCursor).toBeTruthy()
    const initialSourceContinuation = await bridge.callOperationalTool(
      {
        ...assignedSourceArgs,
        arguments: {
          ...assignedSourceArgs.arguments,
          sourceCursor: initialSourceData.nextSourceCursor,
        },
      },
      { credential },
    )
    const initialSourceText = (
      initialSourceContinuation.structuredContent!.data as { page: { text: string } }
    ).page.text
    expect(initialSourceText).toContain(excerpt)
    expect(initialSourceText).toContain(lateCapacity)
    expect(await questionCount()).toBe(beforeRejected)
    for (const attempt of [
      {
        ...assignedSourceArgs,
        arguments: { ...assignedSourceArgs.arguments, receiptId: randomUUID() },
      },
      {
        ...assignedSourceArgs,
        arguments: { ...assignedSourceArgs.arguments, sourceCursor: 'forged-cursor' },
      },
      {
        ...assignedSourceArgs,
        arguments: { ...assignedSourceArgs.arguments, agentRunId: siblingRunId },
        executionClaim: { ...assignedSourceArgs.executionClaim, agentRunId: siblingRunId },
      },
      {
        ...assignedSourceArgs,
        executionClaim: { ...assignedSourceArgs.executionClaim, executionLeaseToken: randomUUID() },
      },
    ])
      await expect(
        Promise.resolve().then(() => bridge.callOperationalTool(attempt, { credential })),
      ).rejects.toThrow()
    const sourceQuestionArgs = {
      venueId,
      toolName: 'pathfinder.ask_operator',
      executionClaim: {
        agentRunId: runId,
        bridgeSessionId,
        workerId,
        executionLeaseToken: initialClaim.leaseToken,
      },
      arguments: {
        agentIdentityId: identityId,
        agentRunId: runId,
        question: input().question,
        sourceClarification: {
          runId: initialContext.sourceAssignment.intakeRunId,
          receiptId: initialContext.sourceAssignment.receiptId,
          expectedExtractedTextHash: initialContext.sourceAssignment.extractedTextHash,
          fieldPath: input().fieldPath,
          reason: 'CONTRADICTION',
          blockerScope: 'FOUNDATIONAL',
          evidenceExcerpt: initialSourceText.slice(
            initialSourceText.indexOf(excerpt),
            initialSourceText.indexOf(excerpt) + excerpt.length,
          ),
        },
      },
    }
    const beforeCreated = await questionCount()
    await expect(
      bridge.callOperationalTool(
        {
          ...sourceQuestionArgs,
          executionClaim: {
            ...sourceQuestionArgs.executionClaim,
            executionLeaseToken: randomUUID(),
          },
        },
        { credential },
      ),
    ).rejects.toThrow()
    await expect(
      bridge.callOperationalTool(sourceQuestionArgs, {
        credential: {
          ...credential,
          capabilities: credential.capabilities.filter((grant) => grant !== 'intake-source:read'),
        },
      }),
    ).rejects.toThrow()
    expect(await questionCount()).toBe(beforeCreated)
    const sourceQuestionResult = await bridge.callOperationalTool(sourceQuestionArgs, {
      credential,
    })
    const created = sourceQuestionResult.structuredContent!.data as {
      questionId: string
      questionStatus: string
      blockerScope: string
      blocksTerminalReview: boolean
    }
    // FOUNDATIONAL creation relinquishes the first claim; it must not authorize a replay.
    await expect(bridge.callOperationalTool(sourceQuestionArgs, { credential })).rejects.toThrow()
    await expect(bridge.callOperationalTool(assignedSourceArgs, { credential })).rejects.toThrow()
    expect(created).toMatchObject({
      questionStatus: 'PENDING',
      blockerScope: 'FOUNDATIONAL',
      blocksTerminalReview: true,
    })
    const replay = await createFileExtractionClarificationQuestion(input())
    expect(replay).toMatchObject({ questionId: created.questionId, replayed: true })
    expect(await questionCount()).toBe(beforeCreated + 1)
    const question = await db.agentQuestion.findFirstOrThrow({
      where: { id: created.questionId, ...scope },
      select: {
        id: true,
        agentRunId: true,
        agentIdentityId: true,
        blocking: true,
        updatedAt: true,
        callbackMetadata: true,
      },
    })
    expect(question).toMatchObject({
      agentRunId: runId,
      agentIdentityId: identityId,
      blocking: true,
      callbackMetadata: expect.objectContaining({
        receiptId,
        extractedTextHash,
        blockerScope: 'FOUNDATIONAL',
      }),
    })
    await expect(runStatus(runId)).resolves.toEqual({ status: 'AWAITING_INPUT' })
    await expect(runStatus(siblingRunId)).resolves.toEqual({ status: 'QUEUED' })

    const founderAnswer = 'They are two distinct greenhouse buildings; retain both identities.'
    await expect(
      answerAgentQuestionAction({
        ...scope,
        questionId: question.id,
        expectedUpdatedAt: question.updatedAt,
        outcome: 'ANSWERED',
        answer: founderAnswer,
        actor: { actorType: 'HUMAN', actorId, auditRole: 'PLATFORM_ADMIN' },
      }),
    ).resolves.toMatchObject({ agentRunId: runId, runEligibleToResume: true, replayed: false })
    await expect(runStatus(runId)).resolves.toEqual({ status: 'QUEUED' })

    const claimed = await claimAgentRunExecution({
      tenantId,
      runId,
      bridgeSessionId,
      executionWorkerId: workerId,
    })
    expect(claimed).toMatchObject({
      status: 'RUNNING',
      attemptNumber: 2,
    })
    expect(await db.agentRun.findFirstOrThrow({ where: { id: runId, ...scope } })).toMatchObject({
      executionBridgeSessionId: bridgeSessionId,
      executionWorkerId: workerId,
      executionLeaseToken: claimed.leaseToken,
    })
    const executionContext = JSON.parse(claimed.executionContext) as {
      currentResolvedQuestions: Array<{ questionId: string; answer: string }>
    }
    expect(executionContext.currentResolvedQuestions).toEqual([
      expect.objectContaining({
        questionId: question.id,
        answer: founderAnswer,
      }),
    ])

    // Execution context deliberately bounds metadata. The persisted scoped question is the exact
    // continuation record used to re-read retained source after the canonical reclaim.
    const persistedQuestion = await db.agentQuestion.findFirstOrThrow({
      where: { id: question.id, ...scope, agentRunId: runId, agentIdentityId: identityId },
      select: { callbackMetadata: true, evidence: true },
    })
    expect(persistedQuestion.callbackMetadata).toMatchObject({
      receiptId,
      extractedTextHash,
      runId: intakeRunId,
    })
    expect(persistedQuestion.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: excerpt,
          reference: expect.stringContaining(receiptId),
        }),
      ]),
    )
    // The invocation passes only the question ID and claim, never an in-process source locator.
    const executionClaim = {
      agentRunId: runId,
      bridgeSessionId,
      workerId,
      executionLeaseToken: claimed.leaseToken,
    }
    // Transaction-composition prerequisite only: this directly invokes the canonical
    // action, not the still-pending registered source-question writing tool.
    const localQuestionInput = {
      operationId: randomUUID(),
      ...scope,
      agentIdentityId: identityId,
      agentRunId: runId,
      question: 'Transaction admission fixture: retain this source clarification?',
      blocking: false,
      callbackMetadata: {
        workflow: 'intake-file-extraction-clarification',
        runId: intakeRunId,
        receiptId,
        extractedTextHash,
      },
    }
    const admitQuestion = async (tx: Parameters<typeof askAgentQuestionActionInTransaction>[0]) => {
      const admitted = await assertCurrentAgentWorkerClaim(tx, {
        ...scope,
        clientId: tenantId,
        ...executionClaim,
        credentialScope: credential,
        requiredAgentType: 'CONTENT',
        requiredIdentityCapability: 'intake.read',
        requiredTransportCapabilities: ['resources:read', 'intake-source:read'],
      })
      expect(admitted.agentIdentityId).toBe(identityId)
    }
    // Caller-owned amendment transaction proof; this is not a registered machine write route.
    const answered = await db.agentQuestion.findFirstOrThrow({
      where: { id: question.id, ...scope },
      select: { answeredAt: true },
    })
    const resolutionInput = {
      ...scope,
      runId: intakeRunId,
      receiptId,
      requestId: randomUUID(),
      expectedExtractedTextHash: extractedTextHash,
      questionId: question.id,
      expectedAnsweredAt: answered.answeredAt!,
      kind: 'REPLACE_EXCERPT' as const,
      amendedExcerpt: founderAnswer,
      rationale: 'Disposable caller transaction rollback proof.',
      actorId,
    }
    await expect(
      db.$transaction(async (tx) => {
        const resolution = await resolveFileExtractionClarificationInTransaction(
          tx,
          resolutionInput,
          {
            admitResolution: admitQuestion,
          },
        )
        expect(resolution).toMatchObject({ replayed: false, terminalReviewRequired: true })
        const replay = await resolveFileExtractionClarificationInTransaction(tx, resolutionInput, {
          admitResolution: admitQuestion,
        })
        expect(replay).toMatchObject({ replayed: true, resolutionId: resolution.resolutionId })
        await expect(
          resolveFileExtractionClarificationInTransaction(tx, resolutionInput, {
            admitResolution: async () => {
              throw new Error('resolution admission denied')
            },
          }),
        ).rejects.toThrow('resolution admission denied')
        throw new Error('rollback composed resolution')
      }),
    ).rejects.toThrow('rollback composed resolution')
    expect(
      await db.intakeFileClarificationResolution.count({
        where: { ...scope, requestId: resolutionInput.requestId },
      }),
    ).toBe(0)

    const amendmentArgs = {
      venueId,
      toolName: 'pathfinder.resolve_source_clarification',
      executionClaim,
      arguments: {
        clientId: tenantId,
        venueId,
        agentRunId: runId,
        agentIdentityId: identityId,
        runId: intakeRunId,
        receiptId,
        requestId: resolutionInput.requestId,
        expectedExtractedTextHash: extractedTextHash,
        questionId: question.id,
        expectedAnsweredAt: answered.answeredAt!.toISOString(),
        kind: resolutionInput.kind,
        amendedExcerpt: founderAnswer,
        rationale: resolutionInput.rationale,
      },
    }
    await expect(
      bridge.callOperationalTool(amendmentArgs, {
        credential: {
          ...credential,
          capabilities: credential.capabilities.filter((g) => g !== 'intake:draft'),
        },
      }),
    ).rejects.toThrow()
    await expect(
      writeSourceClarificationAmendment(
        db as never,
        amendmentArgs.arguments,
        {
          credential,
          executionClaim,
        },
        {
          writeAuditLogStrict: async () => {
            throw new Error('synthetic audit failure')
          },
        },
      ),
    ).rejects.toThrow('unavailable')
    expect(
      await db.intakeFileClarificationResolution.count({
        where: { ...scope, questionId: question.id },
      }),
    ).toBe(0)
    const amendment = await bridge.callOperationalTool(amendmentArgs, { credential })
    expect(amendment.structuredContent!.data).toMatchObject({
      replayed: false,
      terminalReviewRequired: true,
      canonicalVenueChanged: false,
    })
    const amendmentReplay = await bridge.callOperationalTool(amendmentArgs, { credential })
    expect(amendmentReplay.structuredContent!.data).toMatchObject({ replayed: true })
    const audit = await db.auditLog.findMany({
      where: {
        tenantId,
        targetId: resolutionInput.requestId,
        action: 'intake-file-clarification.agent-amendment-recorded',
      },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actorType: 'AGENT',
      agentRunId: runId,
      agentIdentityId: identityId,
      workerId,
    })
    expect(JSON.stringify(audit)).not.toContain(founderAnswer)
    await expect(
      bridge.callOperationalTool(
        {
          ...amendmentArgs,
          executionClaim: { ...executionClaim, executionLeaseToken: randomUUID() },
        },
        { credential },
      ),
    ).rejects.toThrow()

    const beforeComposedQuestion = await questionCount()
    const composed = await db.$transaction((tx) =>
      askAgentQuestionActionInTransaction(tx, localQuestionInput, { admitQuestion }),
    )
    expect(composed).toMatchObject({ replayed: false })
    expect(await questionCount()).toBe(beforeComposedQuestion + 1)
    const composedReplay = await db.$transaction((tx) =>
      askAgentQuestionActionInTransaction(tx, localQuestionInput, { admitQuestion }),
    )
    expect(composedReplay).toMatchObject({ replayed: true, question: { id: composed.question.id } })
    await expect(
      db.$transaction((tx) =>
        askAgentQuestionActionInTransaction(tx, localQuestionInput, {
          admitQuestion: async () => {
            await assertCurrentAgentWorkerClaim(tx, {
              ...scope,
              clientId: tenantId,
              ...executionClaim,
              executionLeaseToken: randomUUID(),
              credentialScope: credential,
              requiredAgentType: 'CONTENT',
              requiredIdentityCapability: 'intake.read',
              requiredTransportCapabilities: ['resources:read', 'intake-source:read'],
            })
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' })
    // A later failure must roll back the question AND its operation in the caller's tx.
    const rollbackOperationId = randomUUID()
    await expect(
      db.$transaction(async (tx) => {
        await askAgentQuestionActionInTransaction(
          tx,
          {
            ...localQuestionInput,
            operationId: rollbackOperationId,
            question: 'Transaction admission fixture: this question must roll back.',
          },
          { admitQuestion },
        )
        throw new Error('deliberate-question-transaction-rollback')
      }),
    ).rejects.toThrow('deliberate-question-transaction-rollback')
    expect(await questionCount()).toBe(beforeComposedQuestion + 1)
    expect(
      await db.agentQuestionOperation.count({
        where: { tenantId, operationId: rollbackOperationId },
      }),
    ).toBe(0)
    await expect(runStatus(runId)).resolves.toEqual({ status: 'RUNNING' })

    const registeredReplay = await bridge.callOperationalTool(
      { ...sourceQuestionArgs, executionClaim },
      { credential },
    )
    expect(registeredReplay.structuredContent!.data).toMatchObject({
      questionId: question.id,
      replayed: true,
    })
    const sourceArgs = {
      venueId,
      toolName: 'pathfinder.read',
      arguments: {
        resource: 'question-source',
        questionId: question.id,
        agentRunId: runId,
        pageSize: 4_000,
      },
      executionClaim,
    }
    // The late capacity value is intentionally beyond the reader's first 4,000-character page.
    const first = await bridge.callOperationalTool(sourceArgs, { credential })
    const firstSourcePage = first.structuredContent!.data as {
      page: { text: string }
      nextSourceCursor: string | null
    }
    expect(extractedText.length).toBeGreaterThan(4_000)
    expect(firstSourcePage.page.text).not.toContain(lateCapacity)
    expect(firstSourcePage.nextSourceCursor).not.toBeNull()
    expect(JSON.stringify(first)).not.toMatch(/https?:\/\/|intake-quarantine|byteSize/u)
    const second = await bridge.callOperationalTool(
      {
        ...sourceArgs,
        arguments: { ...sourceArgs.arguments, sourceCursor: firstSourcePage.nextSourceCursor! },
      },
      { credential },
    )
    const secondSourcePage = second.structuredContent!.data as { page: { text: string } }
    expect(secondSourcePage.page.text).toContain(excerpt)
    expect(secondSourcePage.page.text).toContain(lateCapacity)

    for (const attempt of [
      { ...sourceArgs, arguments: { ...sourceArgs.arguments, questionId: randomUUID() } },
      { ...sourceArgs, arguments: { ...sourceArgs.arguments, agentRunId: siblingRunId } },
      { ...sourceArgs, executionClaim: { ...executionClaim, workerId: `wrong-worker-${suffix}` } },
      {
        ...sourceArgs,
        executionClaim: { ...executionClaim, executionLeaseToken: randomUUID() },
      },
    ])
      await expect(
        Promise.resolve().then(() => bridge.callOperationalTool(attempt, { credential })),
      ).rejects.toThrow()

    // Exercise the real HTTP handler through separate, database-less client processes.
    const automaticTasks = await Promise.all([
      dispatchIntakeSourceAgentTask(sourceDispatchInput),
      dispatchIntakeSourceAgentTask(sourceDispatchInput),
    ])
    expect(automaticTasks[0].status).toBe('COMPLETED')
    expect(automaticTasks[0].runId).toBeTruthy()
    expect(automaticTasks[1].runId).toBe(automaticTasks[0].runId)
    expect(automaticTasks.filter((result) => result.replayed)).toHaveLength(1)
    const httpTask = { run: { id: automaticTasks[0].runId! } }
    expect((await ownerProcessing()).members[0]?.sourceReview?.status).toBe('QUEUED')
    expect(await db.agentRun.count({ where: { ...scope, operationId: sourceOutbox.id } })).toBe(1)
    // Simulate the persisted retry deadline after a lost queue publication, without network.
    await db.intakeSourceAgentDispatch.update({
      where: sourceDispatchInput,
      data: { nextAttemptAt: new Date(0) },
    })
    expect(
      await withTenantIsolationBypass(() => listPendingIntakeSourceAgentDispatches({ limit: 25 })),
    ).toContainEqual(sourceDispatchInput)
    await expect(dispatchIntakeSourceAgentTask(sourceDispatchInput)).resolves.toEqual({
      status: 'COMPLETED',
      runId: httpTask.run.id,
      replayed: true,
    })
    expect(
      await withTenantIsolationBypass(() => listPendingIntakeSourceAgentDispatches({ limit: 25 })),
    ).not.toContainEqual(sourceDispatchInput)

    expect(
      await db.intakeSourceAgentDispatch.findFirst({ where: sourceDispatchInput }),
    ).toMatchObject({
      status: 'COMPLETED',
      agentRunId: httpTask.run.id,
      agentIdentityId: identityId,
      policyRevision: 2,
    })
    expect(await db.agentRun.findFirst({ where: { id: httpTask.run.id, ...scope } })).toMatchObject(
      { initiatedByType: 'SYSTEM' },
    )
    const retainedAuthority = await db.agentIdentity.findFirstOrThrow({
      where: { id: identityId, tenantId },
    })
    for (const revoked of [
      { autonomousActions: [] },
      { autonomyLevel: 'READ_ONLY' as const },
      { accessCapabilities: ['intake.read'] },
    ]) {
      await db.agentIdentity.update({ where: { id: identityId, tenantId }, data: revoked })
      await expect(
        claimAgentRunExecution({ tenantId, runId: httpTask.run.id, leaseDurationMs: 60000 }),
      ).rejects.toMatchObject({ code: 'NOT_CLAIMABLE' })
      expect(
        await db.agentRun.findFirst({ where: { id: httpTask.run.id, ...scope } }),
      ).toMatchObject({ status: 'QUEUED', attemptNumber: 0 })
      await db.agentIdentity.update({
        where: { id: identityId, tenantId },
        data: {
          autonomousActions: retainedAuthority.autonomousActions,
          autonomyLevel: retainedAuthority.autonomyLevel,
          accessCapabilities: retainedAuthority.accessCapabilities,
        },
      })
    }
    const server = createServer(async (request, response) => {
      try {
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers))
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value)
        const result = await handleAgentBridgeHttpRequest(
          new Request('http://127.0.0.1/bridge', {
            method: request.method!,
            headers,
            body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
            duplex: 'half',
          } as RequestInit),
          scope,
          { registry: bridge },
        )
        response.writeHead(result.status, Object.fromEntries(result.headers.entries()))
        response.end(Buffer.from(await result.arrayBuffer()))
      } catch {
        response.writeHead(500)
        response.end('fixture-http-failure')
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned loopback port')
    const url = `http://127.0.0.1:${address.port}/bridge`
    const runHttpWorker = (mode: 'ask' | 'resume') =>
      new Promise<{
        pid: number
        runId: string
        attemptNumber: number
        questionId: string
        answer?: string
        sourceHash: string
        capacityRead: boolean
        resolutionId?: string
      }>((resolve, reject) => {
        const childEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
        for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP'])
          if (process.env[key]) childEnv[key] = process.env[key]
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../../scripts/fixtures/source-question-http-worker.mjs', import.meta.url),
            ),
          ],
          { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        )
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill(), 30000)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
          if (stdout.length > 16000) child.kill()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-2000)
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) {
            reject(
              new Error(
                `Disposable HTTP worker ${mode} exited ${code}: ${stderr.replaceAll(syntheticBearer, '[redacted]')}`,
              ),
            )
            return
          }
          try {
            resolve(JSON.parse(stdout))
          } catch {
            reject(new Error('Invalid bounded worker proof result'))
          }
        })
        child.stdin.end(
          JSON.stringify({
            url,
            mode,
            token: syntheticBearer,
            sessionId: bridgeSessionId,
            venueId,
            workerKey: `worker-source-question-${suffix}`,
            workerId,
            identityId,
          }),
        )
      })
    try {
      const unauthorized = await fetch(url, { method: 'POST', body: '{}' })
      expect(unauthorized.status).toBe(401)
      const incompatibleKeys = [`wrong-role-${suffix}`, `missing-source-${suffix}`]
      for (const [index, workerKey] of incompatibleKeys.entries())
        await registerAgentWorkerAction(
          {
            workerKey,
            runtimeType: 'CODEX',
            label: 'Disposable incompatible source worker',
            protocolVersion: 'mcp-2026-07-28',
            softwareVersion: 'integration/1',
            capabilities:
              index === 0
                ? ['agent-runs:execute', 'intake-source:read', 'resources:read']
                : ['agent-runs:execute', 'resources:read'],
            agentRoles: index === 0 ? ['OPERATIONS'] : ['CONTENT'],
            safeHealth: {},
          },
          credential,
        )
      for (const workerKey of [undefined, ...incompatibleKeys]) {
        const unsuitable = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${syntheticBearer}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            method: 'claimTask',
            params: { sessionId: bridgeSessionId, venueId, ...(workerKey ? { workerKey } : {}) },
          }),
        })
        expect(unsuitable.status).toBe(200)
        expect(await unsuitable.json()).toMatchObject({ ok: true, result: { task: null } })
        await expect(runStatus(httpTask.run.id)).resolves.toEqual({ status: 'QUEUED' })
      }
      const firstWorker = await runHttpWorker('ask')
      expect(firstWorker).toMatchObject({
        runId: httpTask.run.id,
        attemptNumber: 1,
        sourceHash: extractedTextHash,
        capacityRead: true,
      })
      const httpQuestion = await db.agentQuestion.findFirstOrThrow({
        where: { id: firstWorker.questionId, ...scope, agentRunId: httpTask.run.id },
        select: { updatedAt: true },
      })
      await answerAgentQuestionAction({
        ...scope,
        questionId: firstWorker.questionId,
        expectedUpdatedAt: httpQuestion.updatedAt,
        outcome: 'ANSWERED',
        answer: 'They are two distinct greenhouse buildings; retain both identities.',
        actor: { actorType: 'HUMAN', actorId, auditRole: 'PLATFORM_ADMIN' },
      })
      const resumedWorker = await runHttpWorker('resume')
      expect(resumedWorker.pid).not.toBe(firstWorker.pid)
      expect(resumedWorker.resolutionId).toEqual(expect.any(String))
      const resumedResolution = await db.intakeFileClarificationResolution.findFirstOrThrow({
        where: { id: resumedWorker.resolutionId!, ...scope, questionId: firstWorker.questionId },
      })
      expect(resumedResolution).toMatchObject({
        createdBy: identityId,
        amendedExcerpt: founderAnswer,
      })
      expect(
        await db.auditLog.count({
          where: {
            tenantId,
            targetId: resumedResolution.id,
            actorType: 'AGENT',
            agentRunId: httpTask.run.id,
            action: 'intake-file-clarification.agent-amendment-recorded',
          },
        }),
      ).toBe(1)

      expect(resumedWorker).toMatchObject({
        runId: httpTask.run.id,
        attemptNumber: 2,
        questionId: firstWorker.questionId,
        answer: 'They are two distinct greenhouse buildings; retain both identities.',
        sourceHash: extractedTextHash,
        capacityRead: true,
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    expect(server.listening).toBe(false)

    // Explicit synthetic human review consumes both worker-produced amendments. Roll back
    // this branch so the independent rejection/terminal-read proof below retains its coverage.
    await expect(
      db.$transaction(async (tx) => {
        const review = await reviewIntakeFileExtractionAction(
          {
            operationId: randomUUID(),
            ...scope,
            sourceRunId: intakeRunId,
            receiptId,
            expectedExtractedTextHash: extractedTextHash,
            decision: 'ACCEPTED_FOR_PROPOSAL',
            proposalTitle: 'Reviewed greenhouse identities and auditorium capacity',
            proposalNotes: `${founderAnswer} The auditorium capacity is 137.`,
            rationale: 'Synthetic human review of the exact worker amendment lineage.',
            createdBy: actorId,
          },
          {
            $transaction: async (callback: (inner: typeof tx) => unknown) => callback(tx),
          } as never,
        )
        expect(review).toMatchObject({
          proposalCreated: true,
          packageDraftCreated: false,
          autoApproved: false,
        })
        const storedReview = await tx.intakeFileExtractionReview.findFirstOrThrow({
          where: { ...scope, receiptId },
        })
        expect(storedReview.clarificationResolutionCount).toBe(2)
        expect(storedReview.clarificationResolutionDigest).toMatch(/^[a-f0-9]{64}$/u)
        const candidate = await buildIntakeVenuePackageCandidate({
          db: tx as never,
          ...scope,
          runId: storedReview.proposalRunId!,
        })
        expect(candidate).toMatchObject({
          ready: true,
          autoApprove: false,
          autoApply: false,
          published: false,
        })
        expect(candidate.payload?.knowledgeEntries.create).toEqual([
          expect.objectContaining({
            value: expect.objectContaining({
              content: `${founderAnswer} The auditorium capacity is 137.`,
            }),
          }),
        ])
        throw new Error('rollback synthetic review branch')
      }),
    ).rejects.toThrow('rollback synthetic review branch')
    expect(await db.intakeFileExtractionReview.count({ where: { ...scope, receiptId } })).toBe(0)

    const runless = await createFileExtractionClarificationQuestion(
      input({
        agentRunId: undefined,
        question: 'Which entrance is authoritative for greenhouse access in a runless fallback?',
      }),
    )
    const runlessQuestion = await db.agentQuestion.findFirstOrThrow({
      where: { id: runless.questionId, ...scope },
      select: { agentRunId: true, blocking: true },
    })
    expect(runlessQuestion).toEqual({ agentRunId: null, blocking: true })
    await reviewIntakeFileExtractionAction({
      operationId: randomUUID(),
      ...scope,
      sourceRunId: intakeRunId,
      receiptId,
      expectedExtractedTextHash: extractedTextHash,
      decision: 'REJECTED',
      rationale: 'Disposable proof: terminal source review fences later worker reads.',
      createdBy: actorId,
    })
    await expect(bridge.callOperationalTool(amendmentArgs, { credential })).rejects.toThrow()
    await expect(bridge.callOperationalTool(sourceArgs, { credential })).rejects.toThrow()
    await expect(
      bridge.callOperationalTool({ ...assignedSourceArgs, executionClaim }, { credential }),
    ).rejects.toThrow()
    await expect(
      bridge.callOperationalTool({ ...sourceQuestionArgs, executionClaim }, { credential }),
    ).rejects.toThrow()
  })
})
