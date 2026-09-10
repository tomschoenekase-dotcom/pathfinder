import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  completeSupportRequestAction,
  db,
  prepareSupportKnowledgeProposalAction,
  readSupportPackageFulfillment,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { createSemanticReviewedDeclineService } from './semantic-reviewed-decline-service'

const enabled =
  process.env.RUN_SUPPORT_ADDITION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_addition_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe.skipIf(!enabled)('semantic reviewed decline on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())
  it('records, reads, completes, and replays one immutable source-bound decline', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-decline-${suffix}`,
      venueId = `venue-decline-${suffix}`,
      adminId = `admin-decline-${suffix}`
    const scope = { tenantId, venueId }
    let requestId = '',
      requestVersion = 0,
      messageId = ''
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Decline fixture', slug: tenantId } })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { tenantId, id: venueId, name: 'Decline venue', slug: venueId },
      })
      const request = await db.supportRequest.create({
        data: {
          ...scope,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Review guidance',
          createdByKind: 'OPERATOR',
          createdById: adminId,
          updatedByKind: 'OPERATOR',
          updatedById: adminId,
        },
      })
      requestId = request.id
      requestVersion = request.version
      await db.supportRequestAuditEvent.create({
        data: {
          ...scope,
          supportRequestId: requestId,
          requestVersion,
          eventType: 'STATUS_CHANGED',
          actorKind: 'OPERATOR',
          actorId: adminId,
          fromStatus: 'OPEN',
          toStatus: 'IN_REVIEW',
        },
      })
      const message = await db.supportMessage.create({
        data: {
          ...scope,
          supportRequestId: requestId,
          authorKind: 'CLIENT',
          authorId: adminId,
          visibility: 'CLIENT_VISIBLE',
          body: 'Please remove this unsupported request.',
          submissionRequestId: randomUUID(),
          submissionInputHash: 'a'.repeat(64),
          requestVersion,
          clientVersion: request.clientVersion,
        },
      })
      messageId = message.id
    })
    const proposalId = randomUUID()
    await prepareSupportKnowledgeProposalAction({
      operationId: proposalId,
      ...scope,
      supportRequestId: requestId,
      expectedVersion: requestVersion,
      evidenceMessageIds: [messageId],
      correctionKind: 'CREATE_KNOWLEDGE',
      aiInference: 'The request should be declined.',
      proposedChange: 'Unsupported change.',
      reason: 'Requires explicit human review.',
      confidence: 0.9,
      actor: {
        type: 'AGENT',
        actorId: `agent-${suffix}`,
        role: 'AGENT',
        agentIdentityId: `agent-${suffix}`,
        agentRunId: `run-${suffix}`,
        workerId: `worker-${suffix}`,
        credentialId: `credential-${suffix}`,
        capability: 'knowledge:draft',
        idempotencyKey: proposalId,
        modelProvider: 'deterministic-fixture',
        modelName: 'decline-fixture',
      },
    })
    const pending = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { ...scope, id: proposalId },
    })
    expect(pending.status).toBe('PENDING_REVIEW')
    const input = {
      operationId: randomUUID(),
      ...scope,
      proposalId,
      expectedProposalUpdatedAt: pending.updatedAt.toISOString(),
      resolutionNote: 'Reviewed and explicitly declined.',
    }
    const first = await createSemanticReviewedDeclineService({ db, actorId: adminId, input })
    expect(first).toMatchObject({
      outcome: 'REVIEWED_DECLINE',
      replayed: false,
      completionGranted: false,
    })
    await expect(
      createSemanticReviewedDeclineService({ db, actorId: adminId, input }),
    ).resolves.toMatchObject({ resolutionId: input.operationId, replayed: true })
    const receipt = await db.semanticReviewedDecline.findFirstOrThrow({
      where: { ...scope, id: input.operationId },
    })
    expect(receipt).toMatchObject({
      proposalId,
      sourceProposalId: proposalId,
      supportRequestId: requestId,
      supportRequestVersion: requestVersion,
      createdBy: adminId,
      reviewNoteHash: createHash('sha256').update(input.resolutionNote).digest('hex'),
    })
    expect(receipt.sourceEvidence).toEqual([
      expect.objectContaining({
        sourceId: `support-message:${messageId}`,
        locator: `support-request:${requestId}`,
      }),
    ])
    const competingUpdateId = `decline-competing-${suffix}`
    await db.operationalUpdate.create({
      data: {
        ...scope,
        id: competingUpdateId,
        severity: 'WARNING',
        title: 'Competing outcome',
        body: 'Must be rejected.',
        expiresAt: new Date(Date.now() + 86_400_000),
        createdBy: adminId,
      },
    })
    await expect(
      db.knowledgeProposalOperationalUpdateHandoff.create({
        data: {
          ...scope,
          proposalId,
          operationalUpdateId: competingUpdateId,
          previewHash: 'b'.repeat(64),
          createdBy: adminId,
        },
      }),
    ).rejects.toThrow(/incompatible outcome claim/i)
    expect(
      await db.knowledgeProposalOperationalUpdateHandoff.count({ where: { ...scope, proposalId } }),
    ).toBe(0)
    await expect(
      db.semanticReviewedDecline.updateMany({
        where: { ...scope, id: receipt.id },
        data: { createdBy: 'changed' },
      }),
    ).rejects.toThrow(/append-only/i)
    await expect(
      db.$executeRaw`DELETE FROM semantic_reviewed_declines WHERE id=${receipt.id}::uuid`,
    ).rejects.toThrow(/append-only/i)
    expect(
      await db.semanticReviewedDecline.findFirst({
        where: { tenantId: 'other', venueId, id: receipt.id },
      }),
    ).toBeNull()
    const fulfillment = await db.$transaction((tx) =>
      readSupportPackageFulfillment(tx, { ...scope, supportRequestId: requestId }),
    )
    expect(fulfillment).toMatchObject({
      contractVersion: 7,
      proposalResolutionFulfillment: {
        declines: [expect.objectContaining({ resolutionId: receipt.id, proposalId })],
      },
    })
    const request = await db.supportRequest.findFirstOrThrow({ where: { ...scope, id: requestId } })
    const completion = {
      operationId: randomUUID(),
      ...scope,
      requestId,
      expectedVersion: request.version,
      expectedCompletionOutcome: 'RESOLVED' as const,
      expectedFulfillmentDigest: fulfillment.digest,
      body: 'This request was reviewed and declined.',
      actor: {
        actorType: 'HUMAN' as const,
        participantKind: 'OPERATOR' as const,
        actorId: adminId,
        auditRole: 'PLATFORM_ADMIN' as const,
      },
    }
    const completed = await completeSupportRequestAction(completion)
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      replayed: false,
      message: { completionOutcome: 'RESOLVED', body: completion.body },
    })
    await expect(completeSupportRequestAction(completion)).resolves.toMatchObject({
      replayed: true,
      message: { id: completed.message.id, completionOutcome: 'RESOLVED', body: completion.body },
    })
    expect(
      await db.supportMessage.findFirstOrThrow({ where: { ...scope, id: completed.message.id } }),
    ).toMatchObject({ completionOutcome: 'RESOLVED', body: completion.body })

    // A historical bare REJECTED status is not fulfillment; an exact fresh re-attestation is.
    const bareRequest = await db.supportRequest.create({
      data: {
        ...scope,
        category: 'CONTENT_CORRECTION',
        status: 'IN_REVIEW',
        subject: 'Bare rejection',
        createdByKind: 'OPERATOR',
        createdById: adminId,
        updatedByKind: 'OPERATOR',
        updatedById: adminId,
      },
    })
    await db.supportRequestAuditEvent.create({
      data: {
        ...scope,
        supportRequestId: bareRequest.id,
        requestVersion: bareRequest.version,
        eventType: 'STATUS_CHANGED',
        actorKind: 'OPERATOR',
        actorId: adminId,
        fromStatus: 'OPEN',
        toStatus: 'IN_REVIEW',
      },
    })
    const bareMessage = await db.supportMessage.create({
      data: {
        ...scope,
        supportRequestId: bareRequest.id,
        authorKind: 'CLIENT',
        authorId: adminId,
        visibility: 'CLIENT_VISIBLE',
        body: 'Decline this separately.',
        submissionRequestId: randomUUID(),
        submissionInputHash: 'c'.repeat(64),
        requestVersion: bareRequest.version,
        clientVersion: bareRequest.clientVersion,
      },
    })
    const bareProposalId = randomUUID()
    await prepareSupportKnowledgeProposalAction({
      operationId: bareProposalId,
      ...scope,
      supportRequestId: bareRequest.id,
      expectedVersion: bareRequest.version,
      evidenceMessageIds: [bareMessage.id],
      correctionKind: 'CREATE_KNOWLEDGE',
      aiInference: 'Bare historical rejection.',
      proposedChange: 'Do not apply.',
      reason: 'Needs re-attestation.',
      confidence: 0.9,
      actor: {
        type: 'AGENT',
        actorId: `agent-bare-${suffix}`,
        role: 'AGENT',
        agentIdentityId: `agent-bare-${suffix}`,
        agentRunId: `run-bare-${suffix}`,
        workerId: `worker-bare-${suffix}`,
        credentialId: `credential-bare-${suffix}`,
        capability: 'knowledge:draft',
        idempotencyKey: bareProposalId,
        modelProvider: 'deterministic-fixture',
        modelName: 'decline-fixture',
      },
    })
    const bareReviewedAt = new Date()
    expect(
      (
        await db.knowledgeChangeProposal.updateMany({
          where: { ...scope, id: bareProposalId },
          data: {
            status: 'REJECTED',
            reviewerId: adminId,
            reviewNote: 'Historical rejection only.',
            reviewedAt: bareReviewedAt,
          },
        })
      ).count,
    ).toBe(1)
    await expect(
      db.$transaction((tx) =>
        readSupportPackageFulfillment(tx, { ...scope, supportRequestId: bareRequest.id }),
      ),
    ).rejects.toThrow(/fulfillment|resolution|outcome/i)
    const bareRejected = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { ...scope, id: bareProposalId },
    })
    const reattestInput = {
      operationId: randomUUID(),
      ...scope,
      proposalId: bareProposalId,
      expectedProposalUpdatedAt: bareRejected.updatedAt.toISOString(),
      resolutionNote: 'Fresh explicit re-attestation.',
    }
    await expect(
      createSemanticReviewedDeclineService({ db, actorId: adminId, input: reattestInput }),
    ).resolves.toMatchObject({ replayed: false, outcome: 'REVIEWED_DECLINE' })
    const reattested = await db.$transaction((tx) =>
      readSupportPackageFulfillment(tx, { ...scope, supportRequestId: bareRequest.id }),
    )
    expect(reattested).toMatchObject({
      contractVersion: 7,
      proposalResolutionFulfillment: {
        declines: [
          expect.objectContaining({
            proposalId: bareProposalId,
            reviewNote: reattestInput.resolutionNote,
          }),
        ],
      },
    })
    await expect(
      completeSupportRequestAction({
        operationId: randomUUID(),
        ...scope,
        requestId: bareRequest.id,
        expectedVersion: bareRequest.version,
        expectedCompletionOutcome: 'RESOLVED',
        expectedFulfillmentDigest: reattested.digest,
        body: 'The historical rejection was freshly reviewed.',
        actor: {
          actorType: 'HUMAN',
          participantKind: 'OPERATOR',
          actorId: adminId,
          auditRole: 'PLATFORM_ADMIN',
        },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED', message: { completionOutcome: 'RESOLVED' } })

    for (const isolationLevel of ['ReadCommitted', 'RepeatableRead'] as const) {
      const raceProposalId = randomUUID(),
        raceNote = `Race ${isolationLevel}`
      const raceRequest = await db.supportRequest.create({
        data: {
          ...scope,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: `Race ${isolationLevel}`,
          createdByKind: 'OPERATOR',
          createdById: adminId,
          updatedByKind: 'OPERATOR',
          updatedById: adminId,
        },
      })
      await db.supportRequestAuditEvent.create({
        data: {
          ...scope,
          supportRequestId: raceRequest.id,
          requestVersion: raceRequest.version,
          eventType: 'STATUS_CHANGED',
          actorKind: 'OPERATOR',
          actorId: adminId,
          fromStatus: 'OPEN',
          toStatus: 'IN_REVIEW',
        },
      })
      const raceMessage = await db.supportMessage.create({
        data: {
          ...scope,
          supportRequestId: raceRequest.id,
          authorKind: 'CLIENT',
          authorId: adminId,
          visibility: 'CLIENT_VISIBLE',
          body: `Race evidence ${isolationLevel}`,
          submissionRequestId: randomUUID(),
          submissionInputHash: 'f'.repeat(64),
          requestVersion: raceRequest.version,
          clientVersion: raceRequest.clientVersion,
        },
      })
      const racePending = await db.knowledgeChangeProposal.create({
        data: {
          ...scope,
          id: raceProposalId,
          supportRequestId: raceRequest.id,
          supportRequestVersion: raceRequest.version,
          evidenceMessageIds: [raceMessage.id],
          proposedChange: 'Race outcome.',
          reason: 'Prove exclusive terminal outcomes.',
          confidence: 0.9,
          status: 'PENDING_REVIEW',
          createdByType: 'HUMAN',
          createdById: adminId,
        },
      })
      const raceReviewedAt = new Date()
      await db.knowledgeChangeProposal.updateMany({
        where: { ...scope, id: raceProposalId },
        data: {
          status: 'REJECTED',
          reviewerId: adminId,
          reviewNote: raceNote,
          reviewedAt: raceReviewedAt,
        },
      })
      const raceProposal = await db.knowledgeChangeProposal.findFirstOrThrow({
        where: { ...scope, id: raceProposalId },
      })
      const raceUpdateId = `race-${isolationLevel.toLowerCase()}-${suffix}`
      await db.operationalUpdate.create({
        data: {
          ...scope,
          id: raceUpdateId,
          severity: 'WARNING',
          title: 'Race outcome',
          expiresAt: new Date(Date.now() + 86_400_000),
          createdBy: adminId,
        },
      })
      const declineData = {
        ...scope,
        id: randomUUID(),
        proposalId: raceProposalId,
        sourceProposalId: raceProposalId,
        supportRequestId: raceRequest.id,
        supportRequestVersion: raceRequest.version,
        proposalUpdatedAt: racePending.updatedAt,
        reviewedProposalUpdatedAt: raceProposal.updatedAt,
        reviewedAt: raceReviewedAt,
        reviewNoteHash: createHash('sha256').update(raceNote).digest('hex'),
        inputHash: 'd'.repeat(64),
        sourceEvidence: [
          {
            sourceId: `support-message:${raceMessage.id}`,
            locator: `support-request:${raceRequest.id}`,
            capturedAt: raceMessage.createdAt.toISOString(),
            excerptHash: createHash('sha256').update(raceMessage.body).digest('hex'),
          },
        ],
        createdBy: adminId,
      }
      const contentData = {
        ...scope,
        proposalId: raceProposalId,
        operationalUpdateId: raceUpdateId,
        previewHash: 'e'.repeat(64),
        createdBy: adminId,
      }
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.semanticReviewedDecline.create({ data: declineData })
            throw new Error('validated-decline-rollback')
          },
          { isolationLevel },
        ),
      ).rejects.toThrow('validated-decline-rollback')
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.knowledgeProposalOperationalUpdateHandoff.create({ data: contentData })
            throw new Error('validated-content-rollback')
          },
          { isolationLevel },
        ),
      ).rejects.toThrow('validated-content-rollback')
      const locked = deferred(),
        release = deferred()
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM knowledge_change_proposals WHERE id=${raceProposalId}::uuid FOR UPDATE`
          locked.resolve(undefined)
          await release.promise
        },
        { timeout: 10_000 },
      )
      const holderSettled = Promise.allSettled([holder])
      await locked.promise
      const declinePid = deferred<number>(),
        contentPid = deferred<number>()
      const raced = Promise.allSettled([
        db.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`
            declinePid.resolve(row!.pid)
            return tx.semanticReviewedDecline.create({ data: { ...declineData, id: randomUUID() } })
          },
          { isolationLevel, timeout: 10_000 },
        ),
        db.$transaction(
          async (tx) => {
            const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() pid`
            contentPid.resolve(row!.pid)
            return tx.knowledgeProposalOperationalUpdateHandoff.create({ data: contentData })
          },
          { isolationLevel, timeout: 10_000 },
        ),
      ])
      const [declineBackendPid, contentBackendPid] = await Promise.all([
        declinePid.promise,
        contentPid.promise,
      ])
      let observedBlocked = false
      try {
        for (let attempt = 0; attempt < 100 && !observedBlocked; attempt++) {
          const waits = await db.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pid FROM pg_stat_activity WHERE pid IN (${declineBackendPid}, ${contentBackendPid}) AND wait_event_type='Lock'`
          observedBlocked = waits.length === 2
          if (!observedBlocked) await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        release.resolve(undefined)
      }
      const [outcomes] = await Promise.all([raced, holderSettled])
      expect(observedBlocked).toBe(true)
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = outcomes.find((result) => result.status === 'rejected')
      const rejectedReason =
        rejected && rejected.status === 'rejected'
          ? (rejected.reason as { message?: string; meta?: unknown })
          : null
      expect(
        `${rejectedReason?.message ?? ''} ${JSON.stringify(rejectedReason?.meta ?? null)}`,
      ).toMatch(/incompatible outcome claim|serialize access|write conflict/i)
      const claims = await db.$queryRaw<
        Array<{ outcome_kind: string }>
      >`SELECT outcome_kind FROM semantic_proposal_outcome_claims WHERE proposal_id=${raceProposalId}::uuid AND tenant_id=${tenantId} AND venue_id=${venueId}`
      expect(claims).toEqual([{ outcome_kind: expect.stringMatching(/^(DECLINED|CONTENT)$/u) }])
    }
  })
})
