import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { claimAgentRunExecution, db, withTenantIsolationBypass } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { appRouter } from '../root'

const enabled =
  process.env.RUN_QUESTION_DISCUSSION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_question_discussion_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent question discussion disposable persistence', () => {
  afterAll(async () => db.$disconnect())

  it('keeps scoped discussion append-only, non-authoritative, and bounded in execution context', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-question-discussion-${suffix}`
    const foreignTenantId = `tenant-question-discussion-foreign-${suffix}`
    const venueId = `venue-question-discussion-${suffix}`
    const wrongVenueId = `venue-question-discussion-wrong-${suffix}`
    const foreignVenueId = `venue-question-discussion-foreign-${suffix}`
    const identityId = `identity-question-discussion-${suffix}`
    const foreignIdentityId = `identity-question-discussion-foreign-${suffix}`
    const runId = `run-question-discussion-${suffix}`
    const operatorId = `operator-question-discussion-${suffix}`
    const replayNote = `Concurrent replay note ${suffix}`
    const runNote = `Latest run-bound data-only note ${suffix}`
    const runlessNote = `Runless unrelated note ${suffix}`

    const [runQuestion, runlessQuestion, paginationQuestion, foreignQuestion] =
      await withTenantIsolationBypass(async () => {
        await Promise.all([
          db.tenant.create({
            data: { id: tenantId, name: 'Synthetic discussion tenant', slug: tenantId },
          }),
          db.tenant.create({
            data: {
              id: foreignTenantId,
              name: 'Synthetic foreign discussion tenant',
              slug: foreignTenantId,
            },
          }),
        ])
        await Promise.all([
          db.venue.create({
            data: { id: venueId, tenantId, name: 'Synthetic discussion venue', slug: venueId },
          }),
          db.venue.create({
            data: {
              id: wrongVenueId,
              tenantId,
              name: 'Synthetic wrong discussion venue',
              slug: wrongVenueId,
            },
          }),
          db.venue.create({
            data: {
              id: foreignVenueId,
              tenantId: foreignTenantId,
              name: 'Synthetic foreign discussion venue',
              slug: foreignVenueId,
            },
          }),
        ])
        await Promise.all([
          db.agentIdentity.create({
            data: {
              id: identityId,
              tenantId,
              venueId,
              identityKey: `question.discussion.${suffix}`,
              name: 'Synthetic discussion agent',
              agentType: 'OPERATIONS',
              accessScope: 'VENUE',
              accessCapabilities: ['operations.read'],
              autonomyLevel: 'READ_ONLY',
              enabled: true,
              createdBy: operatorId,
            },
          }),
          db.agentIdentity.create({
            data: {
              id: foreignIdentityId,
              tenantId: foreignTenantId,
              venueId: foreignVenueId,
              identityKey: `question.discussion.foreign.${suffix}`,
              name: 'Synthetic foreign discussion agent',
              agentType: 'OPERATIONS',
              accessScope: 'VENUE',
              autonomyLevel: 'READ_ONLY',
              enabled: true,
              createdBy: operatorId,
            },
          }),
        ])
        await db.agentRun.create({
          data: {
            id: runId,
            operationId: randomUUID(),
            tenantId,
            venueId,
            agentIdentityId: identityId,
            runType: 'QUESTION_DISCUSSION_FIXTURE',
            requestedOperation: 'question-discussion.fixture',
            requestPrompt: 'Use only bounded persisted discussion after a human answers.',
            scopeSnapshot: { venueId, authority: 'data-only' },
            status: 'AWAITING_INPUT',
            initiatedByType: 'HUMAN',
            initiatedById: operatorId,
          },
        })
        return Promise.all([
          db.agentQuestion.create({
            data: {
              operationId: randomUUID(),
              tenantId,
              venueId,
              agentIdentityId: identityId,
              agentRunId: runId,
              question: 'Which descriptive visitor detail should the resumed run consider?',
              category: 'fixture-context',
              status: 'PENDING',
            },
          }),
          db.agentQuestion.create({
            data: {
              operationId: randomUUID(),
              tenantId,
              venueId,
              agentIdentityId: identityId,
              question: 'Which unrelated runless detail should remain outside run context?',
              category: 'fixture-context',
              status: 'PENDING',
            },
          }),
          db.agentQuestion.create({
            data: {
              operationId: randomUUID(),
              tenantId,
              venueId,
              agentIdentityId: identityId,
              question: 'Can equal-time discussion rows paginate without loss?',
              category: 'fixture-pagination',
              status: 'PENDING',
            },
          }),
          db.agentQuestion.create({
            data: {
              operationId: randomUUID(),
              tenantId: foreignTenantId,
              venueId: foreignVenueId,
              agentIdentityId: foreignIdentityId,
              question: 'Foreign scoped question',
              status: 'PENDING',
            },
          }),
        ])
      })

    const context = (
      isPlatformAdmin: boolean,
      userId: string | null = operatorId,
    ): TRPCContext => ({
      db,
      headers: new Headers(),
      session:
        userId === null
          ? { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false }
          : {
              userId,
              activeTenantId: tenantId,
              role: isPlatformAdmin ? null : 'STAFF',
              isPlatformAdmin,
            },
    })
    const admin = appRouter.createCaller(context(true)).admin
    const staff = appRouter.createCaller(context(false)).admin
    const unauthenticated = appRouter.createCaller(context(false, null)).admin
    const appendInput = {
      operationId: randomUUID(),
      tenantId,
      venueId,
      questionId: runQuestion.id,
      body: replayNote,
    }

    const initialQuestion = await db.agentQuestion.findUniqueOrThrow({
      where: { id: runQuestion.id, tenantId },
      select: { status: true, answer: true, updatedAt: true },
    })
    const sideEffectCounts = async () => ({
      messages: await db.agentMessage.count({ where: { tenantId } }),
      timeline: await db.agentTimelineEvent.count({ where: { tenantId } }),
      approvals: await db.approvalRequest.count({ where: { tenantId } }),
      grants: await db.approvalGrant.count({ where: { tenantId } }),
      actions: await db.agentAction.count({ where: { tenantId } }),
      jobs: await db.jobRecord.count({ where: { tenantId } }),
    })
    const beforeEffects = await sideEffectCounts()

    for (const rejected of [
      { ...appendInput, venueId: wrongVenueId },
      { ...appendInput, tenantId: foreignTenantId },
      { ...appendInput, questionId: foreignQuestion.id },
    ]) {
      await expect(admin.appendAgentQuestionDiscussion(rejected)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    }
    await expect(staff.appendAgentQuestionDiscussion(appendInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(unauthenticated.appendAgentQuestionDiscussion(appendInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(await db.agentQuestionDiscussionMessage.count({ where: { tenantId } })).toBe(0)

    const concurrent = await Promise.all([
      admin.appendAgentQuestionDiscussion(appendInput),
      admin.appendAgentQuestionDiscussion(appendInput),
    ])
    expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true])
    const canonicalMessageId = concurrent[0]!.message.id
    expect(concurrent[1]!.message.id).toBe(canonicalMessageId)
    expect(
      await db.agentQuestionDiscussionMessage.count({
        where: { tenantId, operationId: appendInput.operationId },
      }),
    ).toBe(1)
    expect(
      await db.auditLog.count({
        where: {
          tenantId,
          action: 'agent-question.discussion-message-added',
          targetId: runQuestion.id,
        },
      }),
    ).toBe(1)
    await expect(
      admin.appendAgentQuestionDiscussion({ ...appendInput, body: `${runNote} changed` }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await expect(
      admin.appendAgentQuestionDiscussion({
        operationId: randomUUID(),
        tenantId,
        venueId,
        questionId: runlessQuestion.id,
        body: runlessNote,
      }),
    ).resolves.toMatchObject({ replayed: false })

    for (let index = 1; index <= 6; index += 1) {
      await admin.appendAgentQuestionDiscussion({
        operationId: randomUUID(),
        tenantId,
        venueId,
        questionId: runQuestion.id,
        body: `Bounded earlier discussion ${index} ${suffix}`,
      })
    }
    await admin.appendAgentQuestionDiscussion({
      operationId: randomUUID(),
      tenantId,
      venueId,
      questionId: runQuestion.id,
      body: runNote,
    })

    const unchangedQuestion = await db.agentQuestion.findUniqueOrThrow({
      where: { id: runQuestion.id, tenantId },
      select: { status: true, answer: true, updatedAt: true },
    })
    expect(unchangedQuestion).toEqual(initialQuestion)
    await expect(
      db.agentRun.findUniqueOrThrow({ where: { id: runId, tenantId }, select: { status: true } }),
    ).resolves.toEqual({ status: 'AWAITING_INPUT' })
    expect(await sideEffectCounts()).toEqual(beforeEffects)

    const equalCreatedAt = new Date('2026-09-08T19:00:00.000Z')
    await withTenantIsolationBypass(() =>
      db.agentQuestionDiscussionMessage.createMany({
        data: ['a', 'b', 'c'].map((id) => ({
          id: `discussion-${id}-${suffix}`,
          operationId: randomUUID(),
          tenantId,
          venueId,
          questionId: paginationQuestion.id,
          authorId: operatorId,
          body: `Equal timestamp ${id}`,
          createdAt: equalCreatedAt,
        })),
      }),
    )
    const pageOne = await admin.listAgentQuestionDiscussion({
      tenantId,
      venueId,
      questionId: paginationQuestion.id,
      limit: 2,
    })
    expect(pageOne.items.map((item) => item.id)).toEqual([
      `discussion-c-${suffix}`,
      `discussion-b-${suffix}`,
    ])
    expect(pageOne.nextCursor).toEqual({
      createdAt: equalCreatedAt.toISOString(),
      id: `discussion-b-${suffix}`,
    })
    const pageTwo = await admin.listAgentQuestionDiscussion({
      tenantId,
      venueId,
      questionId: paginationQuestion.id,
      cursor: pageOne.nextCursor!,
      limit: 2,
    })
    expect(pageTwo.items.map((item) => item.id)).toEqual([`discussion-a-${suffix}`])
    expect(pageTwo.nextCursor).toBeNull()
    for (const rejected of [
      { tenantId, venueId: wrongVenueId, questionId: paginationQuestion.id },
      { tenantId: foreignTenantId, venueId, questionId: paginationQuestion.id },
      { tenantId, venueId, questionId: foreignQuestion.id },
    ]) {
      await expect(admin.listAgentQuestionDiscussion(rejected)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    }
    await expect(
      staff.listAgentQuestionDiscussion({ tenantId, venueId, questionId: paginationQuestion.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      unauthenticated.listAgentQuestionDiscussion({
        tenantId,
        venueId,
        questionId: paginationQuestion.id,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    for (const statement of [
      `UPDATE agent_question_discussion_messages SET body = 'changed' WHERE id = '${canonicalMessageId}' AND tenant_id = '${tenantId}'`,
      `DELETE FROM agent_question_discussion_messages WHERE id = '${canonicalMessageId}' AND tenant_id = '${tenantId}'`,
      'TRUNCATE agent_question_discussion_messages',
    ]) {
      await expect(db.$executeRawUnsafe(statement)).rejects.toThrow(
        'agent question discussion messages are append-only',
      )
    }
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO agent_question_discussion_messages
              (id, operation_id, tenant_id, venue_id, question_id, author_id, body)
              VALUES ('discussion-whitespace-${suffix}', '${randomUUID()}', '${tenantId}',
                '${venueId}', '${runQuestion.id}', '${operatorId}', E' \\t\\n')`,
      ),
    ).rejects.toThrow('agent_question_discussion_messages_body_check')
    await expect(
      db.agentQuestionDiscussionMessage.findUniqueOrThrow({
        where: { id: canonicalMessageId, tenantId },
        select: { body: true },
      }),
    ).resolves.toEqual({ body: replayNote })

    const answer = 'Use the east entrance description as data, subject to normal policy checks.'
    await expect(
      admin.answerAgentQuestion({
        tenantId,
        venueId,
        questionId: runQuestion.id,
        expectedUpdatedAt: unchangedQuestion.updatedAt.toISOString(),
        outcome: 'ANSWERED',
        answer,
      }),
    ).resolves.toMatchObject({ status: 'ANSWERED', dispatchStatus: 'DISABLED' })
    const claimed = await claimAgentRunExecution({ tenantId, runId })
    const executionContext = JSON.parse(claimed.executionContext) as {
      authorityNotice: string
      currentResolvedQuestions: Array<{
        questionId: string
        answer: string
        discussion: Array<{ body: string }>
      }>
      omissions: {
        omittedDiscussionMessagesAtLeast: number
        discussionSelectionLimitReached: boolean
      }
    }
    expect(executionContext.authorityNotice).toMatch(/data.*do not grant permission/iu)
    expect(executionContext.currentResolvedQuestions).toEqual([
      expect.objectContaining({
        questionId: runQuestion.id,
        answer,
        discussion: expect.arrayContaining([expect.objectContaining({ body: runNote })]),
      }),
    ])
    expect(executionContext.currentResolvedQuestions[0]?.discussion).toHaveLength(5)
    expect(executionContext.omissions.discussionSelectionLimitReached).toBe(true)
    expect(executionContext.omissions.omittedDiscussionMessagesAtLeast).toBeGreaterThanOrEqual(1)
    expect(claimed.executionContext).not.toContain(runlessNote)
  })
})
