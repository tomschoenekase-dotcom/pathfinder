import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  answerAgentQuestionAction,
  askAgentQuestionAction,
  createClientOnboardingQuestionAction,
  db,
  expireAgentQuestionIfDue,
  expireAgentQuestionsAction,
  respondToSupportInformationAction,
  resumeOnboardingQuestionFromSupportAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_QUESTION_EXPIRY_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_question_expiry_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('agent question expiry disposable persistence', () => {
  afterAll(async () => db.$disconnect())

  it('commits scoped expiry before rejection and makes bounded skip-locked progress', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const tenantId = `tenant-question-expiry-${suffix}`
    const foreignTenantId = `tenant-question-expiry-foreign-${suffix}`
    const venueId = `venue-question-expiry-${suffix}`
    const foreignVenueId = `venue-question-expiry-foreign-${suffix}`
    const identityId = `identity-question-expiry-${suffix}`
    const foreignIdentityId = `identity-question-expiry-foreign-${suffix}`
    const clientId = `client-question-expiry-${suffix}`
    const operatorId = `operator-question-expiry-${suffix}`
    const now = Date.now()
    const scope = { tenantId, venueId }
    const operator = {
      actorType: 'HUMAN' as const,
      actorId: operatorId,
      auditRole: 'PLATFORM_ADMIN' as const,
    }

    const seeded = await withTenantIsolationBypass(async () => {
      await Promise.all([
        db.tenant.create({
          data: { id: tenantId, name: 'Synthetic expiry tenant', slug: tenantId },
        }),
        db.tenant.create({
          data: {
            id: foreignTenantId,
            name: 'Synthetic foreign expiry tenant',
            slug: foreignTenantId,
          },
        }),
        db.user.create({
          data: {
            id: clientId,
            email: `${clientId}@example.test`,
            fullName: 'Synthetic expiry client',
          },
        }),
      ])
      await Promise.all([
        db.venue.create({
          data: { id: venueId, tenantId, name: 'Synthetic expiry venue', slug: venueId },
        }),
        db.venue.create({
          data: {
            id: foreignVenueId,
            tenantId: foreignTenantId,
            name: 'Synthetic foreign expiry venue',
            slug: foreignVenueId,
          },
        }),
        db.tenantMembership.create({
          data: { tenantId, userId: clientId, role: 'MANAGER', joinedAt: new Date() },
        }),
      ])
      await Promise.all([
        db.agentIdentity.create({
          data: {
            id: identityId,
            ...scope,
            identityKey: `question.expiry.${suffix}`,
            name: 'Synthetic expiry agent',
            agentType: 'OPERATIONS',
            accessScope: 'VENUE',
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
            identityKey: `question.expiry.foreign.${suffix}`,
            name: 'Synthetic foreign expiry agent',
            agentType: 'OPERATIONS',
            accessScope: 'VENUE',
            autonomyLevel: 'READ_ONLY',
            enabled: true,
            createdBy: operatorId,
          },
        }),
      ])

      const createRun = (id: string, tenant = tenantId, venue = venueId, identity = identityId) =>
        db.agentRun.create({
          data: {
            id,
            operationId: randomUUID(),
            tenantId: tenant,
            venueId: venue,
            agentIdentityId: identity,
            runType: 'QUESTION_EXPIRY_FIXTURE',
            requestedOperation: 'question-expiry.fixture',
            scopeSnapshot: { authority: 'none' },
            status: 'AWAITING_INPUT',
            initiatedByType: 'HUMAN',
            initiatedById: operatorId,
          },
        })
      const directRun = await createRun(`run-expiry-direct-${suffix}`)
      const routedRun = await createRun(`run-expiry-routed-${suffix}`)
      const blockerRun = await createRun(`run-expiry-blocker-${suffix}`)
      const replayRun = await createRun(`run-expiry-replay-${suffix}`)
      const lockedRun = await createRun(`run-expiry-locked-${suffix}`)
      const foreignRun = await createRun(
        `run-expiry-foreign-${suffix}`,
        foreignTenantId,
        foreignVenueId,
        foreignIdentityId,
      )
      const createQuestion = (input: {
        id: string
        runId?: string
        expiresAt: Date | null
        tenant?: string
        venue?: string
        identity?: string
        blocking?: boolean
      }) =>
        db.agentQuestion.create({
          data: {
            id: input.id,
            operationId: randomUUID(),
            tenantId: input.tenant ?? tenantId,
            venueId: input.venue ?? venueId,
            agentIdentityId: input.identity ?? identityId,
            agentRunId: input.runId ?? null,
            question: `Synthetic expiry question ${input.id}`,
            blocking: input.blocking ?? true,
            status: 'PENDING',
            expiresAt: input.expiresAt,
          },
        })

      const direct = await createQuestion({
        id: `question-expiry-direct-${suffix}`,
        runId: directRun.id,
        expiresAt: new Date(now - 60_000),
      })
      const routed = await createQuestion({
        id: `question-expiry-routed-${suffix}`,
        runId: routedRun.id,
        expiresAt: new Date(now + 5_000),
      })
      const routeExpired = await createQuestion({
        id: `question-expiry-route-denied-${suffix}`,
        runId: routedRun.id,
        expiresAt: new Date(now - 55_000),
      })
      const expiredBlocker = await createQuestion({
        id: `question-expiry-blocker-${suffix}`,
        runId: blockerRun.id,
        expiresAt: new Date(now - 50_000),
      })
      const answerableBlocker = await createQuestion({
        id: `question-expiry-answerable-${suffix}`,
        runId: blockerRun.id,
        expiresAt: null,
      })
      const replay = await createQuestion({
        id: `question-expiry-replay-${suffix}`,
        runId: replayRun.id,
        expiresAt: new Date(now + 15_000),
      })
      const locked = await createQuestion({
        id: `question-expiry-locked-${suffix}`,
        runId: lockedRun.id,
        expiresAt: new Date(now - 40_000),
      })
      const runless = await createQuestion({
        id: `question-expiry-runless-${suffix}`,
        expiresAt: new Date(now - 30_000),
      })
      const foreign = await createQuestion({
        id: `question-expiry-foreign-${suffix}`,
        runId: foreignRun.id,
        expiresAt: new Date(now - 20_000),
        tenant: foreignTenantId,
        venue: foreignVenueId,
        identity: foreignIdentityId,
      })
      const future = await createQuestion({
        id: `question-expiry-future-${suffix}`,
        expiresAt: new Date(now + 3_600_000),
      })
      const sqlCutoff = await createQuestion({
        id: `question-expiry-sql-${suffix}`,
        expiresAt: new Date(now - 10_000),
      })
      return {
        direct,
        routed,
        routeExpired,
        expiredBlocker,
        answerableBlocker,
        replay,
        locked,
        lockedRun,
        runless,
        foreign,
        future,
        sqlCutoff,
      }
    })

    const explicitExpiry = {
      operationId: randomUUID(),
      ...scope,
      agentIdentityId: identityId,
      question: 'A separately timed question.',
      expiresAt: new Date(now + 3_600_000),
      blocking: false,
    }
    const createdTimed = await askAgentQuestionAction(explicitExpiry)
    expect(createdTimed.question.expiresAt).toEqual(explicitExpiry.expiresAt)
    await expect(askAgentQuestionAction(explicitExpiry)).resolves.toMatchObject({ replayed: true })
    await expect(
      askAgentQuestionAction({ ...explicitExpiry, expiresAt: new Date(now + 7_200_000) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const effectCounts = async () => ({
      messages: await db.agentMessage.count({ where: { tenantId } }),
      approvals: await db.approvalRequest.count({ where: { tenantId } }),
      grants: await db.approvalGrant.count({ where: { tenantId } }),
      actions: await db.agentAction.count({ where: { tenantId } }),
      jobs: await db.jobRecord.count({ where: { tenantId } }),
    })
    const effectsBeforeExpiry = await effectCounts()
    const directInput = {
      ...scope,
      questionId: seeded.direct.id,
      expectedUpdatedAt: seeded.direct.updatedAt,
      outcome: 'ANSWERED' as const,
      answer: 'This answer arrived after the cutoff.',
      actor: operator,
    }
    await expect(answerAgentQuestionAction(directInput)).rejects.toMatchObject({ code: 'EXPIRED' })
    const directExpired = await db.agentQuestion.findFirstOrThrow({
      where: { ...scope, id: seeded.direct.id },
      select: { status: true, answer: true, answeredAt: true, expiredAt: true },
    })
    expect(directExpired).toMatchObject({ status: 'EXPIRED', answer: null, answeredAt: null })
    expect(directExpired.expiredAt).toBeInstanceOf(Date)
    expect(await effectCounts()).toEqual(effectsBeforeExpiry)
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'agent-question.expired', targetId: seeded.direct.id },
      }),
    ).toBe(1)
    expect(
      await db.agentTimelineEvent.count({
        where: { tenantId, agentRunId: seeded.direct.agentRunId!, eventType: 'QUESTION_EXPIRED' },
      }),
    ).toBe(1)
    await expect(answerAgentQuestionAction(directInput)).rejects.toMatchObject({ code: 'EXPIRED' })
    expect(
      await db.auditLog.count({
        where: { tenantId, action: 'agent-question.expired', targetId: seeded.direct.id },
      }),
    ).toBe(1)

    await expect(
      db.$transaction((tx) =>
        expireAgentQuestionIfDue(tx, { ...scope, questionId: seeded.future.id }),
      ),
    ).resolves.toBe('NOT_DUE')
    await expect(
      db.$transaction((tx) =>
        expireAgentQuestionIfDue(tx, {
          tenantId,
          venueId: foreignVenueId,
          questionId: seeded.foreign.id,
        }),
      ),
    ).resolves.toBe('NOT_FOUND')

    await expect(
      createClientOnboardingQuestionAction({
        operationId: randomUUID(),
        ...scope,
        agentQuestionId: seeded.routeExpired.id,
        expectedQuestionUpdatedAt: seeded.routeExpired.updatedAt,
        recipientUserId: clientId,
        category: 'GENERAL',
        subject: 'Expired synthetic question',
        why: 'This route must reject after committing expiry.',
        whatWasFound: 'The response cutoff passed.',
        effect: 'The run remains blocked for review.',
        actor: { actorId: operatorId, auditRole: 'PLATFORM_ADMIN' },
      }),
    ).rejects.toMatchObject({ code: 'EXPIRED' })
    await expect(
      db.agentQuestion.findFirstOrThrow({
        where: { ...scope, id: seeded.routeExpired.id },
        select: { status: true, expiredAt: true },
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED', expiredAt: expect.any(Date) })

    const routed = await createClientOnboardingQuestionAction({
      operationId: randomUUID(),
      ...scope,
      agentQuestionId: seeded.routed.id,
      expectedQuestionUpdatedAt: seeded.routed.updatedAt,
      recipientUserId: clientId,
      category: 'GENERAL',
      subject: 'Synthetic expiring question',
      why: 'Confirm expiry preserves a durable reply.',
      whatWasFound: 'A bounded fixture question is awaiting input.',
      effect: 'The expired run remains blocked for review.',
      actor: { actorId: operatorId, auditRole: 'PLATFORM_ADMIN' },
    })
    const supportResponse = await respondToSupportInformationAction({
      operationId: randomUUID(),
      ...scope,
      requestId: routed.link.supportRequestId,
      expectedClientVersion: 1,
      body: `Durable client response ${suffix}`,
      attachments: [],
      actor: {
        actorType: 'HUMAN',
        participantKind: 'CLIENT',
        actorId: clientId,
        auditRole: 'MANAGER',
      },
    })
    const waitForDatabaseCutoff = async (cutoff: Date) => {
      const deadline = Math.max(Date.now() + 10_000, cutoff.getTime() + 10_000)
      for (;;) {
        const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
        if (rows[0]!.now >= cutoff) return
        if (Date.now() >= deadline) throw new Error('Database cutoff was not reached')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    await waitForDatabaseCutoff(seeded.routed.expiresAt!)
    await expect(
      resumeOnboardingQuestionFromSupportAction({
        ...scope,
        supportRequestId: routed.link.supportRequestId,
        supportMessageId: supportResponse.message.id,
        actor: { actorId: clientId, auditRole: 'MANAGER' },
      }),
    ).resolves.toMatchObject({
      linked: true,
      replayed: false,
      questionExpired: true,
      runEligibleToResume: false,
      agentRunId: seeded.routed.agentRunId,
      questionId: seeded.routed.id,
    })
    await expect(
      db.supportMessage.findFirstOrThrow({
        where: { ...scope, id: supportResponse.message.id },
        select: { body: true },
      }),
    ).resolves.toEqual({ body: `Durable client response ${suffix}` })
    await expect(
      db.onboardingQuestionLink.findFirstOrThrow({
        where: { ...scope, id: routed.link.id },
        select: { answeredSupportMessageId: true, resumedAt: true },
      }),
    ).resolves.toEqual({ answeredSupportMessageId: null, resumedAt: null })
    expect(
      await db.agentMessage.count({
        where: { ...scope, agentRunId: seeded.routed.agentRunId!, messageType: 'ANSWER' },
      }),
    ).toBe(0)

    await db.$transaction((tx) =>
      expireAgentQuestionIfDue(tx, { ...scope, questionId: seeded.expiredBlocker.id }),
    )
    await expect(
      answerAgentQuestionAction({
        ...scope,
        questionId: seeded.answerableBlocker.id,
        expectedUpdatedAt: seeded.answerableBlocker.updatedAt,
        outcome: 'ANSWERED',
        answer: 'The other blocker is answered.',
        actor: operator,
      }),
    ).resolves.toMatchObject({ runEligibleToResume: false })
    await expect(
      db.agentRun.findFirstOrThrow({
        where: { tenantId, id: seeded.answerableBlocker.agentRunId! },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'AWAITING_INPUT' })

    const replayInput = {
      ...scope,
      questionId: seeded.replay.id,
      expectedUpdatedAt: seeded.replay.updatedAt,
      outcome: 'ANSWERED' as const,
      answer: 'Exact answer committed before cutoff.',
      actor: operator,
    }
    await expect(answerAgentQuestionAction(replayInput)).resolves.toMatchObject({ replayed: false })
    await waitForDatabaseCutoff(seeded.replay.expiresAt!)
    await expect(answerAgentQuestionAction(replayInput)).resolves.toMatchObject({ replayed: true })

    await expect(
      db.$executeRawUnsafe(
        `UPDATE agent_questions SET status='ANSWERED', answer='late', answered_by_id='${operatorId}',
          answered_at=clock_timestamp() WHERE id='${seeded.sqlCutoff.id}' AND tenant_id='${tenantId}'`,
      ),
    ).rejects.toThrow('agent question answer deadline has expired')
    await expect(
      db.$executeRawUnsafe(
        `UPDATE agent_questions SET status='EXPIRED', expired_at=clock_timestamp()
          WHERE id='${seeded.sqlCutoff.id}' AND tenant_id='${tenantId}'`,
      ),
    ).rejects.toThrow('agent question expiration timestamp is database assigned')
    await expect(
      db.$executeRawUnsafe(
        `UPDATE agent_questions SET status='EXPIRED'
          WHERE id='${seeded.sqlCutoff.id}' AND tenant_id='${tenantId}'`,
      ),
    ).resolves.toBe(1)
    await expect(
      db.agentQuestion.findFirstOrThrow({
        where: { ...scope, id: seeded.sqlCutoff.id },
        select: { status: true, expiredAt: true },
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED', expiredAt: expect.any(Date) })
    await expect(
      db.$executeRawUnsafe(
        `UPDATE agent_questions SET expires_at=clock_timestamp() - interval '1 hour'
          WHERE id='${seeded.future.id}' AND tenant_id='${tenantId}'`,
      ),
    ).rejects.toThrow('agent question request is immutable')

    let releaseRunLock!: () => void
    let confirmRunLock!: () => void
    const runLockHeld = new Promise<void>((resolve) => {
      confirmRunLock = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseRunLock = resolve
    })
    const holding = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM agent_runs
          WHERE id=${seeded.lockedRun.id} AND tenant_id=${tenantId} FOR UPDATE`
        confirmRunLock()
        await release
      },
      { timeout: 15_000 },
    )
    await runLockHeld
    try {
      await expect(
        db.$transaction((tx) =>
          expireAgentQuestionIfDue(
            tx,
            { ...scope, questionId: seeded.locked.id },
            { skipLocked: true },
          ),
        ),
      ).resolves.toBe('SKIPPED')
      const boundedSweep = await expireAgentQuestionsAction({ limit: 1 })
      expect(boundedSweep.expired).toBe(1)
      expect(boundedSweep.scanned).toBeGreaterThanOrEqual(2)
      expect(boundedSweep.scanned).toBeLessThanOrEqual(4)
      expect(boundedSweep.skipped).toBeGreaterThanOrEqual(1)
      await expect(
        db.agentQuestion.findFirstOrThrow({
          where: { ...scope, id: seeded.locked.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'PENDING' })
    } finally {
      releaseRunLock()
      await holding
    }
    const workerProcessorModule =
      '../../../../apps/workers/src/processors/' + 'agent-question-expiration'
    const { processAgentQuestionExpiration } = (await import(workerProcessorModule)) as {
      processAgentQuestionExpiration: () => Promise<{
        scanned: number
        expired: number
        skipped: number
      }>
    }
    await expect(processAgentQuestionExpiration()).resolves.toMatchObject({
      expired: expect.any(Number),
      skipped: 0,
    })
    await expect(
      db.agentQuestion.findFirstOrThrow({
        where: { ...scope, id: seeded.runless.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'EXPIRED' })
    await expect(
      db.agentQuestion.findFirstOrThrow({
        where: { ...scope, id: seeded.locked.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'EXPIRED' })
    await expect(
      db.agentQuestion.findFirstOrThrow({
        where: { tenantId: foreignTenantId, venueId: foreignVenueId, id: seeded.foreign.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'EXPIRED' })
  }, 60_000)
})
