import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  db,
  completeSupportRequestAction,
  prepareSupportKnowledgeProposalAction,
  readSupportPackageFulfillment,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { mergeRouters, router } from '../core'
import type { TRPCContext } from '../context'
import { adminKnowledgeProposalsRouter } from '../routers/admin/knowledge-proposals'
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'
import { hashSemanticConflictTarget } from './semantic-conflict-resolution-contract'

const enabled =
  process.env.RUN_SUPPORT_ADDITION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_support_addition_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')
const app = router({ admin: mergeRouters(adminKnowledgeProposalsRouter) })

async function bounded<T>(promise: Promise<T>, message: string, timeoutMs = 3_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe.skipIf(!enabled)('semantic duplicate on disposable PostgreSQL', () => {
  afterAll(async () => db.$disconnect())
  it('records one immutable reviewed support duplicate without changing canonical content', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-duplicate-${suffix}`,
      venueId = `venue-duplicate-${suffix}`,
      adminId = `admin-duplicate-${suffix}`
    const scope = { tenantId, venueId }
    const desired = {
      title: `Quiet room ${suffix}`,
      category: 'Visitor services',
      content: 'The quiet room is beside the east gallery.',
      isEnabled: true,
    }
    const caller = app.createCaller({
      db,
      headers: new Headers(),
      session: { userId: adminId, activeTenantId: null, role: null, isPlatformAdmin: true },
    } as TRPCContext).admin
    let requestId = '',
      requestVersion = 0,
      messageId = '',
      targetId = ''
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({ data: { id: tenantId, name: 'Duplicate fixture', slug: tenantId } })
      await db.user.create({ data: { id: adminId, email: `${adminId}@example.test` } })
      await db.venue.create({
        data: { tenantId, id: venueId, name: 'Duplicate venue', slug: venueId },
      })
      const request = await db.supportRequest.create({
        data: {
          ...scope,
          category: 'CONTENT_CORRECTION',
          status: 'IN_REVIEW',
          subject: 'Confirm quiet room',
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
          body: desired.content,
          submissionRequestId: randomUUID(),
          submissionInputHash: 'a'.repeat(64),
          requestVersion,
          clientVersion: request.clientVersion,
        },
      })
      messageId = message.id
      const target = await db.venueKnowledgeEntry.create({
        data: {
          ...scope,
          ...desired,
          visibility: 'PUBLIC',
          sourceType: 'SYNTHETIC_FIXTURE',
          authorship: 'HUMAN_AUTHORED',
        },
      })
      targetId = target.id
    })
    const proposalId = randomUUID()
    await prepareSupportKnowledgeProposalAction({
      operationId: proposalId,
      ...scope,
      supportRequestId: requestId,
      expectedVersion: requestVersion,
      evidenceMessageIds: [messageId],
      correctionKind: 'CREATE_KNOWLEDGE',
      aiInference: 'The support request repeats existing guidance.',
      proposedChange: desired.content,
      reason: 'Review existing guidance before making a change.',
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
        modelName: 'duplicate-fixture',
      },
    })
    const pending = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { ...scope, id: proposalId },
    })
    await caller.reviewKnowledgeProposal({
      operationId: randomUUID(),
      ...scope,
      proposalId,
      expectedUpdatedAt: pending.updatedAt.toISOString(),
      decision: 'APPROVED',
      reviewNote: 'Review the exact repeat of existing guidance.',
    })
    const approved = await db.knowledgeChangeProposal.findFirstOrThrow({
      where: { ...scope, id: proposalId },
    })
    const preview = await previewSemanticVenueUpdateFromProposal({
      db,
      ...scope,
      proposalId,
      expectedUpdatedAt: approved.updatedAt,
      relation: 'NEW_FACT',
      desired,
    })
    expect(preview.classification).toBe('DUPLICATE_NOOP')
    expect(preview.targetKnowledgeEntryId).toBeNull()
    expect(preview.duplicateMatch?.knowledgeEntryId).toBe(targetId)
    const targetBefore = await db.venueKnowledgeEntry.findFirstOrThrow({
      where: { ...scope, id: targetId },
    })
    const input = {
      operationId: randomUUID(),
      ...scope,
      proposalId,
      expectedProposalUpdatedAt: approved.updatedAt.toISOString(),
      expectedPreviewHash: preview.previewHash,
      relation: 'NEW_FACT' as const,
      desired,
      resolutionNote: 'The approved request already matches this exact canonical entry.',
    }
    await expect(
      caller.resolveSupportSemanticDuplicate({ ...input, expectedPreviewHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const results = await Promise.all([
      caller.resolveSupportSemanticDuplicate(input),
      caller.resolveSupportSemanticDuplicate(input),
    ])
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true])
    expect(results[0]).toMatchObject({
      resolutionId: input.operationId,
      outcome: 'DUPLICATE_NOOP',
      completionGranted: false,
      currentFulfillmentVerified: false,
      canonicalKnowledgeChanged: false,
    })
    const receipt = await db.semanticDuplicateResolution.findFirstOrThrow({
      where: { ...scope, id: input.operationId },
    })
    expect(receipt.targetKnowledgeEntryId).toBe(targetId)
    expect(receipt.targetSnapshotHash).toBe(
      hashSemanticConflictTarget({
        id: targetBefore.id,
        title: targetBefore.title,
        category: targetBefore.category,
        content: targetBefore.content,
        isEnabled: targetBefore.isEnabled,
        humanConfirmedAt: targetBefore.humanConfirmedAt,
        authorship: targetBefore.authorship,
        sourceType: targetBefore.sourceType,
      }),
    )
    expect(receipt.sourceEvidence).toEqual([
      expect.objectContaining({
        sourceId: `support-message:${messageId}`,
        locator: `support-request:${requestId}`,
        excerptHash: createHash('sha256').update(desired.content).digest('hex'),
      }),
    ])
    expect(await db.semanticDuplicateResolution.count({ where: { ...scope, proposalId } })).toBe(1)
    await expect(
      caller.resolveSupportSemanticDuplicate({ ...input, resolutionNote: 'Changed decision' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.resolveSupportSemanticDuplicate({ ...input, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(
      await db.venueKnowledgeEntry.findFirstOrThrow({ where: { ...scope, id: targetId } }),
    ).toEqual(targetBefore)
    expect(
      await db.knowledgeChangeProposal.findFirstOrThrow({ where: { ...scope, id: proposalId } }),
    ).toEqual(approved)
    expect(await db.knowledgeProposalUniversalContentHandoff.count({ where: scope })).toBe(0)
    expect(await db.knowledgeProposalPackageHandoff.count({ where: scope })).toBe(0)
    expect(await db.knowledgeProposalOperationalUpdateHandoff.count({ where: scope })).toBe(0)
    expect(await db.legacyKnowledgeUniversalContentAdoption.count({ where: scope })).toBe(0)
    await expect(
      db.semanticDuplicateResolution.updateMany({
        where: { ...scope, id: receipt.id },
        data: { resolutionNote: 'Rewrite' },
      }),
    ).rejects.toThrow(/append-only/i)
    await expect(
      db.semanticDuplicateResolution.deleteMany({ where: { ...scope, id: receipt.id } }),
    ).rejects.toThrow(/append-only/i)
    // Raw SQL reaches the database trigger, independently of application middleware.
    await expect(
      db.$executeRaw`UPDATE semantic_duplicate_resolutions SET resolution_note='rewrite' WHERE id=${receipt.id}::uuid AND tenant_id=${tenantId} AND venue_id=${venueId}`,
    ).rejects.toThrow(/append-only/i)
    await expect(
      db.$executeRaw`DELETE FROM semantic_duplicate_resolutions WHERE id=${receipt.id}::uuid AND tenant_id=${tenantId} AND venue_id=${venueId}`,
    ).rejects.toThrow(/append-only/i)
    expect(
      await db.semanticDuplicateResolution.findFirst({
        where: { tenantId: 'other-tenant', venueId, id: receipt.id },
      }),
    ).toBeNull()
    const fulfillment = await db.$transaction((tx) =>
      readSupportPackageFulfillment(tx, { ...scope, supportRequestId: requestId }),
    )
    expect(fulfillment).toMatchObject({
      contractVersion: 6,
      noChangeFulfillment: {
        receipts: [
          expect.objectContaining({
            outcome: 'DUPLICATE_NOOP',
            resolutionId: receipt.id,
            proposalId,
            targetKnowledgeEntryId: targetId,
          }),
        ],
      },
    })
    // A no-change completion requires a reviewed outcome and exact fulfillment identity.
    const requestBefore = await db.supportRequest.findFirstOrThrow({
      where: { ...scope, id: requestId },
    })
    await expect(
      completeSupportRequestAction({
        operationId: randomUUID(),
        ...scope,
        requestId,
        expectedVersion: requestBefore.version,
        body: 'Your update is complete.',
        actor: {
          actorType: 'HUMAN',
          participantKind: 'OPERATOR',
          actorId: adminId,
          auditRole: 'PLATFORM_ADMIN',
        },
      }),
    ).rejects.toThrow(/outcome|structured completion|preview/i)
    expect(
      await db.supportRequest.findFirstOrThrow({ where: { ...scope, id: requestId } }),
    ).toEqual(requestBefore)
    const completionInput = {
      operationId: randomUUID(),
      ...scope,
      requestId,
      expectedVersion: requestBefore.version,
      expectedCompletionOutcome: 'NO_CHANGE' as const,
      expectedFulfillmentDigest: fulfillment.digest,
      body: 'The existing guidance already covers this request; it remains unchanged.',
      actor: {
        actorType: 'HUMAN' as const,
        participantKind: 'OPERATOR' as const,
        actorId: adminId,
        auditRole: 'PLATFORM_ADMIN' as const,
      },
    }
    await expect(
      completeSupportRequestAction({ ...completionInput, expectedCompletionOutcome: 'UPDATED' }),
    ).rejects.toThrow(/outcome|preview/i)
    await expect(
      completeSupportRequestAction({
        ...completionInput,
        expectedFulfillmentDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow(/fulfillment|preview/i)
    const completed = await completeSupportRequestAction(completionInput)
    expect(completed).toMatchObject({
      status: 'COMPLETED',
      message: { completionOutcome: 'NO_CHANGE', body: completionInput.body },
      replayed: false,
    })
    await expect(completeSupportRequestAction(completionInput)).resolves.toMatchObject({
      message: {
        id: completed.message.id,
        completionOutcome: 'NO_CHANGE',
        body: completionInput.body,
      },
      replayed: true,
    })
    const storedCompletion = await db.supportMessage.findFirstOrThrow({
      where: { ...scope, id: completed.message.id },
    })
    expect(storedCompletion).toMatchObject({
      completionOutcome: 'NO_CHANGE',
      body: completionInput.body,
      visibility: 'CLIENT_VISIBLE',
    })
    await expect(
      db.$executeRaw`UPDATE support_messages SET completion_outcome='UPDATED' WHERE id=${completed.message.id}`,
    ).rejects.toThrow(/append-only/i)
    for (const invalid of [
      {
        visibility: 'INTERNAL_ONLY' as const,
        requestVersion: completed.requestVersion,
        completionOutcome: 'NO_CHANGE',
      },
      {
        visibility: 'CLIENT_VISIBLE' as const,
        requestVersion: null,
        completionOutcome: 'NO_CHANGE',
      },
      {
        visibility: 'CLIENT_VISIBLE' as const,
        requestVersion: completed.requestVersion,
        completionOutcome: 'INVENTED',
      },
    ]) {
      await expect(
        db.supportMessage.create({
          data: {
            ...scope,
            supportRequestId: requestId,
            authorKind: 'OPERATOR',
            authorId: adminId,
            body: 'Invalid outcome fixture',
            clientVersion: invalid.visibility === 'CLIENT_VISIBLE' ? 999 : null,
            ...invalid,
          },
        }),
      ).rejects.toThrow(/completion_outcome_shape_check/)
    }
    const requestAfterCompletion = await db.supportRequest.findFirstOrThrow({
      where: { ...scope, id: requestId },
    })
    // Direct database boundary: a recorded duplicate cannot later acquire a package outcome.
    const boundaryPackage = await db.venuePackage.create({
      data: {
        ...scope,
        draftKey: randomUUID(),
        schemaVersion: 3,
        payload: {},
        payloadHash: 'a'.repeat(64),
        baseDigest: 'b'.repeat(64),
        validationReport: {},
        previewPlan: {},
        createdBy: adminId,
      },
    })
    const handoffData = {
      ...scope,
      proposalId,
      venuePackageId: boundaryPackage.id,
      previewHash: receipt.previewHash,
      createdBy: adminId,
    }
    await expect(db.knowledgeProposalPackageHandoff.create({ data: handoffData })).rejects.toThrow(
      /duplicate.*outcome|duplicate.*resolution/i,
    )
    expect(
      await db.knowledgeProposalPackageHandoff.count({ where: { ...scope, proposalId } }),
    ).toBe(0)

    // A competing outcome insert holds the same proposal lock. A duplicate insert must
    // observe its committed result after waiting, not the statement's earlier snapshot.
    for (const isolationLevel of ['ReadCommitted', 'RepeatableRead'] as const) {
      const racePackage = await db.venuePackage.create({
        data: {
          ...scope,
          draftKey: randomUUID(),
          schemaVersion: 3,
          payload: {},
          payloadHash: 'a'.repeat(64),
          baseDigest: 'b'.repeat(64),
          validationReport: {},
          previewPlan: {},
          createdBy: adminId,
        },
      })
      const boundaryProposal = await db.knowledgeChangeProposal.create({
        data: {
          ...scope,
          targetKnowledgeEntryId: targetId,
          proposedChange: desired.content,
          reason: 'Synthetic direct database outcome-exclusion proof',
          confidence: 1,
          status: 'APPROVED',
          createdByType: 'HUMAN',
          createdById: adminId,
          reviewerId: adminId,
          reviewedAt: new Date(),
        },
      })
      let outcomeLocked!: () => void
      let releaseOutcome!: () => void
      const outcomeReady = new Promise<void>((resolve) => {
        outcomeLocked = resolve
      })
      const outcomeRelease = new Promise<void>((resolve) => {
        releaseOutcome = resolve
      })
      const outcomeWriter = db.$transaction(
        async (tx) => {
          await tx.knowledgeProposalPackageHandoff.create({
            data: {
              ...handoffData,
              proposalId: boundaryProposal.id,
              venuePackageId: racePackage.id,
            },
          })
          outcomeLocked()
          await bounded(outcomeRelease, 'Outcome writer release timed out', 8000)
        },
        { timeout: 10000 },
      )
      const outcomeSettled = Promise.allSettled([outcomeWriter])
      let duplicateSettled: Promise<PromiseSettledResult<unknown>[]> | undefined
      let outcomeCoordinationError: unknown
      try {
        await bounded(outcomeReady, 'Outcome writer did not lock the proposal')
        let identifyDuplicate!: (pid: number) => void
        const duplicatePid = new Promise<number>((resolve) => {
          identifyDuplicate = resolve
        })
        const duplicateInsert = db.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS "pid"`
            identifyDuplicate(rows[0]?.pid ?? -1)
            return tx.$executeRaw`
          INSERT INTO semantic_duplicate_resolutions
          (id, tenant_id, venue_id, proposal_id, proposal_updated_at, preview_hash,
           target_knowledge_entry_id, target_snapshot_hash, input_hash, relation,
           desired, source_evidence, resolution_note, created_by)
          SELECT ${randomUUID()}::uuid, tenant_id, venue_id, ${boundaryProposal.id}::uuid,
           ${boundaryProposal.updatedAt}, preview_hash, target_knowledge_entry_id,
           target_snapshot_hash, input_hash, relation, desired, source_evidence,
           'Synthetic competing outcome boundary', created_by
          FROM semantic_duplicate_resolutions WHERE id=${receipt.id}::uuid
        `
          },
          { timeout: 10000, isolationLevel },
        )
        duplicateSettled = Promise.allSettled([duplicateInsert])
        const pid = await bounded(duplicatePid, 'Duplicate insert did not start')
        expect(pid).toBeGreaterThan(0)
        const deadline = Date.now() + 3000
        let waiting = false
        do {
          const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${pid}
            AND wait_event_type='Lock' AND query LIKE '%INSERT INTO semantic_duplicate_resolutions%') AS waiting
        `
          waiting = rows[0]?.waiting ?? false
          if (!waiting && Date.now() >= deadline)
            throw new Error('Duplicate insert did not wait on outcome lock')
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10))
        } while (!waiting)
      } catch (error) {
        outcomeCoordinationError = error
      } finally {
        releaseOutcome()
      }
      const [outcomeResult] = await outcomeSettled
      const [duplicateResult] = duplicateSettled ? await duplicateSettled : []
      if (outcomeCoordinationError) throw outcomeCoordinationError
      expect(outcomeResult?.status).toBe('fulfilled')
      expect(duplicateResult?.status).toBe('rejected')
      expect(String(duplicateResult?.status === 'rejected' ? duplicateResult.reason : '')).toMatch(
        /outcome|handoff|serializ|conflict/i,
      )
      expect(
        await db.semanticDuplicateResolution.count({
          where: { ...scope, proposalId: boundaryProposal.id },
        }),
      ).toBe(0)
      expect(
        await db.knowledgeProposalPackageHandoff.count({
          where: { ...scope, proposalId: boundaryProposal.id },
        }),
      ).toBe(1)
    }
    let writerLocked!: () => void
    let releaseWriter!: () => void
    const locked = new Promise<void>((resolve) => {
      writerLocked = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const changedContent = 'The fixture canonical guidance changed after review.'
    const writer = db.$transaction(
      async (tx) => {
        const changed = await tx.venueKnowledgeEntry.updateMany({
          where: { ...scope, id: targetId },
          data: { content: changedContent },
        })
        expect(changed.count).toBe(1)
        writerLocked()
        await bounded(release, 'Timed out waiting to release the canonical target writer', 8_000)
      },
      { timeout: 10_000 },
    )
    const writerSettled = Promise.allSettled([writer])
    let readerSettled: Promise<PromiseSettledResult<unknown>[]> | undefined
    let coordinationError: unknown
    try {
      await bounded(locked, 'Timed out acquiring the canonical target writer lock')
      let reportReaderPid!: (pid: number) => void
      const readerPid = new Promise<number>((resolve) => {
        reportReaderPid = resolve
      })
      const racedRead = db.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS "pid"
          `
          reportReaderPid(rows[0]?.pid ?? -1)
          return await readSupportPackageFulfillment(tx, {
            ...scope,
            supportRequestId: requestId,
          })
        },
        { timeout: 10_000 },
      )
      readerSettled = Promise.allSettled([racedRead])
      const pid = await bounded(readerPid, 'Timed out starting the fulfillment reader')
      expect(pid).toBeGreaterThan(0)
      const waitDeadline = Date.now() + 3_000
      let waiting = false
      do {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pid = ${pid} AND wait_event_type = 'Lock'
              AND query LIKE '%venue_knowledge_entries%'
          ) AS "waiting"
        `
        waiting = rows[0]?.waiting ?? false
        if (!waiting && Date.now() >= waitDeadline)
          throw new Error('Timed out proving the fulfillment reader waited on the target lock')
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10))
      } while (!waiting)
    } catch (error) {
      coordinationError = error
    } finally {
      releaseWriter()
    }
    const [writerResult] = await writerSettled
    const [readerResult] = readerSettled ? await readerSettled : []
    if (coordinationError) throw coordinationError
    expect(writerResult?.status).toBe('fulfilled')
    expect(readerResult?.status).toBe('rejected')
    expect(readerResult?.status === 'rejected' ? readerResult.reason : null).toMatchObject({
      message: expect.stringContaining('No-change target snapshot changed'),
    })
    expect(
      await db.venueKnowledgeEntry.findFirstOrThrow({ where: { ...scope, id: targetId } }),
    ).toMatchObject({ content: changedContent })
    expect(
      await db.supportRequest.findFirstOrThrow({ where: { ...scope, id: requestId } }),
    ).toEqual(requestAfterCompletion)
    await expect(caller.resolveSupportSemanticDuplicate(input)).resolves.toMatchObject({
      replayed: true,
      currentFulfillmentVerified: false,
    })
  }, 30000)
})
