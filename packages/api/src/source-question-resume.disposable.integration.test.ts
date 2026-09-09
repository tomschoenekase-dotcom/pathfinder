import { createHash, randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  answerAgentQuestionAction,
  claimIntakeUploadVerificationAction,
  claimIntakeV1FileExtractionDispatch,
  claimAgentRunExecution,
  completeIntakeV1FileExtractionDispatch,
  db,
  preflightIntakeV1FileExtractionDispatch,
  recordIntakeUploadPrecheckAction,
  reserveIntakeUploadAction,
  settleIntakeUploadAuthoritativeVerificationAction,
  submitIntakeV1Action,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { createFileExtractionClarificationQuestion } from './lib/intake-file-clarifications'
import { executeIntakeFileExtraction } from './lib/intake-file-extraction-service'
import { readIntakeFileExtractionSource } from './lib/intake-file-extraction-reader'

const enabled =
  process.env.RUN_SOURCE_QUESTION_RESUME_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_source_question_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

describe.skipIf(!enabled)('file-source question resume disposable persistence', () => {
  afterAll(async () => db.$disconnect())

  it('binds retained source questions to the exact resumable worker context', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-source-question-${suffix}`
    const venueId = `venue-source-question-${suffix}`
    const wrongVenueId = `venue-source-question-wrong-${suffix}`
    const actorId = `founder-source-question-${suffix}`
    const identityId = `identity-source-question-${suffix}`
    const wrongIdentityId = `identity-source-question-wrong-${suffix}`
    const runId = `run-source-question-${suffix}`
    const siblingRunId = `run-source-question-sibling-${suffix}`
    const terminalRunId = `run-source-question-terminal-${suffix}`
    const wrongVenueRunId = `run-source-question-wrong-venue-${suffix}`
    const bridgeSessionId = randomUUID()
    const workerId = `worker-source-question-${suffix}`
    const sourcePrefix = 'Retained review notes. '.repeat(230)
    const excerpt = 'Greenhouse access remains ambiguous between the east and south entrances.'
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
          accessCapabilities: ['content.draft'],
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
          accessCapabilities: ['content.draft'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: actorId,
        },
      })
      const credential = await db.$transaction(async (tx) => {
        const row = await tx.externalAccessCredential.create({
          data: {
            ...scope,
            clientId: tenantId,
            scopeKey: venueId,
            kind: 'MCP',
            label: 'Disabled source question fixture',
            capabilities: ['resources:read'],
            secretPrefix: `fixture-${suffix}`,
            secretHash: '$argon2id$not-a-real-credential',
            enabled: false,
            createdBy: actorId,
          },
        })
        await tx.externalCredentialOperationReceipt.create({
          data: {
            operationId: randomUUID(),
            operationHash: 'a'.repeat(64),
            operationKind: 'ISSUE',
            ...scope,
            clientId: tenantId,
            scopeKey: venueId,
            credentialId: row.id,
            actorId,
            createdAt: row.createdAt,
          },
        })
        return row
      })
      await db.agentBridgeSession.create({
        data: {
          id: bridgeSessionId,
          ...scope,
          clientId: tenantId,
          scopeKey: venueId,
          credentialId: credential.id,
          provider: 'CODEX_SUBSCRIPTION',
          label: 'Synthetic source question bridge presence',
          runnerVersion: 'fixture',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      await db.agentWorker.create({
        data: {
          id: workerId,
          workerKey: workerId,
          tenantId,
          clientId: tenantId,
          credentialId: credential.id,
          credentialScopeKey: venueId,
          ownerAdminId: actorId,
          runtimeType: 'CODEX',
          label: 'Synthetic source question worker presence',
          protocolVersion: 'fixture',
          softwareVersion: 'fixture',
          leaseExpiresAt: new Date(Date.now() + 3_600_000),
        },
      })
      await db.agentRun.createMany({
        data: [
          {
            id: runId,
            operationId: randomUUID(),
            ...scope,
            agentIdentityId: identityId,
            runType: 'FILE_SOURCE_FIXTURE',
            requestedOperation: 'source-question.resume',
            requestPrompt: 'Use retained source evidence after founder clarification.',
            scopeSnapshot: { authority: 'data-only', source: 'synthetic-file-receipt' },
            status: 'QUEUED',
            initiatedByType: 'HUMAN',
            initiatedById: actorId,
          },
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
      const actor = { type: 'HUMAN' as const, id: actorId, role: 'MANAGER' as const }
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

    const questionCount = () => db.agentQuestion.count({ where: { tenantId } })
    const runStatus = (id: string) =>
      db.agentRun.findFirstOrThrow({ where: { id, tenantId }, select: { status: true } })
    const input = (overrides: Record<string, unknown> = {}) => ({
      db,
      ...scope,
      runId: intakeRunId,
      receiptId,
      expectedExtractedTextHash: extractedTextHash,
      fieldPath: 'visitor-access.greenhouse',
      reason: 'CONTRADICTION' as const,
      blockerScope: 'FOUNDATIONAL' as const,
      question: 'Which entrance is authoritative for greenhouse access?',
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

    const beforeCreated = await questionCount()
    const created = await createFileExtractionClarificationQuestion(input())
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

    const founderAnswer = 'Use the accessible east greenhouse entrance.'
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
    const metadata = persistedQuestion.callbackMetadata as {
      receiptId: string
      extractedTextHash: string
      runId: string
    }
    // The late capacity value is intentionally beyond the reader's first 4,000-character page.
    const firstSourcePage = await readIntakeFileExtractionSource(
      {
        ...scope,
        runId: metadata.runId,
        receiptId: metadata.receiptId,
        expectedExtractedTextHash: metadata.extractedTextHash,
        pageSize: 4_000,
      },
      db,
    )
    expect(extractedText.length).toBeGreaterThan(4_000)
    expect(firstSourcePage.page.text).not.toContain(lateCapacity)
    expect(firstSourcePage.nextCursor).not.toBeNull()
    const secondSourcePage = await readIntakeFileExtractionSource(
      {
        ...scope,
        runId: metadata.runId,
        receiptId: metadata.receiptId,
        expectedExtractedTextHash: metadata.extractedTextHash,
        pageSize: 4_000,
        cursor: firstSourcePage.nextCursor!,
      },
      db,
    )
    expect(secondSourcePage.page.text).toContain(excerpt)
    expect(secondSourcePage.page.text).toContain(lateCapacity)
    expect(secondSourcePage.extractedTextHash).toBe(extractedTextHash)

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
  })
})
