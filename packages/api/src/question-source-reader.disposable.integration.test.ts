import { createHash, randomUUID } from 'node:crypto'

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

import { createFileExtractionClarificationQuestion } from './lib/intake-file-clarifications'
import { executeIntakeFileExtraction } from './lib/intake-file-extraction-service'
import { createAgentBridgeRegistry } from './agent-bridge/registry'
import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './mcp/registry'
import { readMcpResource } from './mcp/read-actions'
import { createPathfinderMcpAgentActions } from './mcp/agent-actions'

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
    let credential!: Awaited<ReturnType<typeof verifyAgentBridgeCredential>>
    const sourcePrefix = 'Retained review notes. '.repeat(230)
    const excerpt =
      'The east and south greenhouses look similar; the source does not establish whether they are distinct buildings.'
    const lateCapacity = 'The approved visitor capacity is exactly 137.'
    const extractedText = `${sourcePrefix}\n${excerpt}\n${lateCapacity}\n`
    let intakeRunId = ''
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
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read', 'content.draft'],
          autonomyLevel: 'DRAFT',
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
          'questions:ask',
          'resources:read',
        ],
        expiresAt: new Date(Date.now() + 3_600_000),
      })
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
    await expect(bridge.callOperationalTool(sourceArgs, { credential })).rejects.toThrow()
    await expect(
      bridge.callOperationalTool({ ...assignedSourceArgs, executionClaim }, { credential }),
    ).rejects.toThrow()
    await expect(
      bridge.callOperationalTool({ ...sourceQuestionArgs, executionClaim }, { credential }),
    ).rejects.toThrow()
  })
})
