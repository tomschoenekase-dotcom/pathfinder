import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  answerAgentQuestionAction,
  askAgentQuestionAction,
  claimAgentRunExecution,
  createClientOnboardingQuestionAction,
  db,
  requestAgentRunCancellationAction,
  respondToSupportInformationAction,
  resumeOnboardingQuestionFromSupportAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_ONBOARDING_RESUME_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_onboarding_resume_[a-f0-9]{12}$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('client question resume disposable persistence', () => {
  afterAll(async () => db.$disconnect())

  it('retains replies, serializes all blockers, releases leases, and does not revive cancelled work', async () => {
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `tenant-resume-${suffix}`
    const venueId = `venue-resume-${suffix}`
    const clientId = `client-resume-${suffix}`
    const identityId = `identity-resume-${suffix}`
    const bridgeSessionId = randomUUID()
    const workerId = `worker-resume-${suffix}`
    const scope = { tenantId, venueId }
    const operator = {
      actorType: 'HUMAN' as const,
      actorId: 'fixture-admin',
      auditRole: 'PLATFORM_ADMIN' as const,
    }
    const clientActor = { actorId: clientId, auditRole: 'MANAGER' as const }

    // Only synthetic fixture setup bypasses the middleware. All actions and readbacks below
    // use the canonical helpers with explicit scope and normal isolation middleware.
    await withTenantIsolationBypass(async () => {
      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic resume tenant', slug: tenantId },
      })
      await db.user.create({
        data: {
          id: clientId,
          email: `${clientId}@example.test`,
          fullName: 'Fixture venue manager',
        },
      })
      await db.tenantMembership.create({
        data: { tenantId, userId: clientId, role: 'MANAGER', joinedAt: new Date() },
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic resume venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          ...scope,
          identityKey: `resume.${suffix}`,
          name: 'Fixture reviewer',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read', 'support.question'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: operator.actorId,
        },
      })
      // Disabled synthetic credential metadata is only a foreign-key fixture. No credential
      // is issued or authenticated and no provider/worker process is started.
      const credential = await db.$transaction(async (tx) => {
        const row = await tx.externalAccessCredential.create({
          data: {
            ...scope,
            clientId: tenantId,
            scopeKey: venueId,
            kind: 'MCP',
            label: 'Disabled resume fixture',
            capabilities: ['resources:read'],
            secretPrefix: `fixture-${suffix}`,
            secretHash: '$argon2id$not-a-real-credential',
            enabled: false,
            createdBy: operator.actorId,
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
            actorId: operator.actorId,
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
          label: 'Synthetic bridge presence',
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
          ownerAdminId: operator.actorId,
          runtimeType: 'CODEX',
          label: 'Synthetic worker presence',
          protocolVersion: 'fixture',
          softwareVersion: 'fixture',
          leaseExpiresAt: new Date(Date.now() + 3_600_000),
        },
      })
    })

    async function newRun() {
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          ...scope,
          agentIdentityId: identityId,
          runType: 'ONBOARDING',
          requestedOperation: 'fixture-review',
          requestPrompt: 'Review the saved client evidence.',
          scopeSnapshot: { authority: 'data-only' },
          status: 'QUEUED',
          initiatedByType: 'HUMAN',
          initiatedById: operator.actorId,
        },
      })
      await claimAgentRunExecution({
        tenantId,
        runId: run.id,
        bridgeSessionId,
        executionWorkerId: workerId,
      })
      return run.id
    }
    async function ask(runId: string, label: string) {
      return (
        await askAgentQuestionAction({
          operationId: randomUUID(),
          ...scope,
          agentIdentityId: identityId,
          agentRunId: runId,
          question: `Confirm ${label}?`,
          blocking: true,
        })
      ).question
    }
    async function clientReply(question: Awaited<ReturnType<typeof ask>>, body: string) {
      const routed = await createClientOnboardingQuestionAction({
        operationId: randomUUID(),
        ...scope,
        agentQuestionId: question.id,
        expectedQuestionUpdatedAt: question.updatedAt,
        recipientUserId: clientId,
        category: 'ACCESSIBILITY',
        subject: 'Confirm a venue detail',
        why: 'Resolve a source conflict.',
        whatWasFound: 'Synthetic sources differ.',
        effect: 'Continue the exact review once all blockers are answered.',
        actor: { actorId: operator.actorId, auditRole: 'PLATFORM_ADMIN' },
      })
      const response = await respondToSupportInformationAction({
        operationId: randomUUID(),
        ...scope,
        requestId: routed.link.supportRequestId,
        expectedClientVersion: 1,
        body,
        attachments: [],
        actor: { ...clientActor, actorType: 'HUMAN', participantKind: 'CLIENT' },
      })
      return {
        input: {
          ...scope,
          supportRequestId: routed.link.supportRequestId,
          supportMessageId: response.message.id,
          actor: clientActor,
        },
        linkId: routed.link.id,
        body,
      }
    }
    const readRun = (runId: string) =>
      db.agentRun.findFirstOrThrow({
        where: { ...scope, id: runId },
        select: {
          status: true,
          executionBridgeSessionId: true,
          executionWorkerId: true,
          executionLeaseToken: true,
          executionLeaseExpiresAt: true,
          lastHeartbeatAt: true,
        },
      })

    const runId = await newRun()
    const first = await ask(runId, 'the entrance')
    const second = await ask(runId, 'the opening hours')
    const reply1 = await clientReply(first, 'The Oak Street entrance is step-free.')
    const reply2 = await clientReply(
      second,
      'The accessible entrance is open for all public hours.',
    )
    const before = await readRun(runId)
    expect(before.status).toBe('AWAITING_INPUT')
    expect(before.executionLeaseToken).not.toBeNull()
    expect(before.executionBridgeSessionId).toBe(bridgeSessionId)
    expect(before.executionWorkerId).toBe(workerId)

    await expect(
      resumeOnboardingQuestionFromSupportAction({
        ...reply1.input,
        actor: { actorId: 'unrelated-client', auditRole: 'MANAGER' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      resumeOnboardingQuestionFromSupportAction({ ...reply1.input, venueId: `wrong-${venueId}` }),
    ).resolves.toMatchObject({ linked: false, runEligibleToResume: false })

    await expect(resumeOnboardingQuestionFromSupportAction(reply1.input)).resolves.toMatchObject({
      linked: true,
      replayed: false,
      runEligibleToResume: false,
      agentRunId: runId,
    })
    expect(await readRun(runId)).toEqual(before)
    await expect(claimAgentRunExecution({ tenantId, runId })).rejects.toMatchObject({
      code: 'NOT_CLAIMABLE',
    })
    await expect(resumeOnboardingQuestionFromSupportAction(reply1.input)).resolves.toMatchObject({
      replayed: true,
      runEligibleToResume: false,
    })
    await expect(
      resumeOnboardingQuestionFromSupportAction({
        ...reply1.input,
        actor: { actorId: 'unrelated-client', auditRole: 'MANAGER' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(
      await db.agentQuestion.findFirstOrThrow({ where: { ...scope, id: first.id } }),
    ).toMatchObject({ status: 'ANSWERED', answeredById: clientId })
    expect(
      await db.onboardingQuestionLink.findFirstOrThrow({ where: { ...scope, id: reply1.linkId } }),
    ).toMatchObject({
      answeredSupportMessageId: reply1.input.supportMessageId,
      resumedAt: expect.any(Date),
    })

    await expect(resumeOnboardingQuestionFromSupportAction(reply2.input)).resolves.toMatchObject({
      runEligibleToResume: true,
    })
    expect(await readRun(runId)).toEqual({
      status: 'QUEUED',
      executionBridgeSessionId: null,
      executionWorkerId: null,
      executionLeaseToken: null,
      executionLeaseExpiresAt: null,
      lastHeartbeatAt: null,
    })
    await expect(resumeOnboardingQuestionFromSupportAction(reply1.input)).resolves.toMatchObject({
      replayed: true,
      runEligibleToResume: true,
    })
    const unrelatedAnswer = `UNLINKED ANSWER MUST NOT ENTER CONTEXT ${suffix}`
    await db.agentMessage.create({
      data: {
        ...scope,
        agentRunId: runId,
        agentIdentityId: identityId,
        role: 'OPERATOR',
        messageType: 'ANSWER',
        content: unrelatedAnswer,
        actorId: operator.actorId,
      },
    })
    const claimed = await claimAgentRunExecution({ tenantId, runId })
    const context = JSON.parse(claimed.executionContext) as {
      authorityNotice: string
      currentResolvedQuestions: Array<{
        questionId: string
        answer: string
        clientResponse?: {
          supportRequestId: string
          supportMessageId: string
          authorId: string
          body: string
          createdAt: string
        }
      }>
    }
    expect(context.authorityNotice).toMatch(/data.*do not grant permission/iu)
    for (const [question, reply] of [
      [first, reply1],
      [second, reply2],
    ] as const) {
      expect(
        context.currentResolvedQuestions.find((entry) => entry.questionId === question.id),
      ).toMatchObject({
        answer: `Client response recorded in support message ${reply.input.supportMessageId}.`,
        clientResponse: {
          supportRequestId: reply.input.supportRequestId,
          supportMessageId: reply.input.supportMessageId,
          authorId: clientId,
          body: reply.body,
          createdAt: expect.any(String),
        },
      })
    }
    expect(claimed.executionContext).not.toContain(unrelatedAnswer)
    await expect(resumeOnboardingQuestionFromSupportAction(reply1.input)).resolves.toMatchObject({
      replayed: true,
      runEligibleToResume: false,
    })
    expect((await readRun(runId)).status).toBe('RUNNING')
    expect(
      await db.agentMessage.count({
        where: { ...scope, agentRunId: runId, messageType: 'ANSWER' },
      }),
    ).toBe(3)
    expect(
      await db.auditLog.count({
        where: {
          tenantId,
          action: 'onboarding-question.client-answer-claimed',
          targetId: { in: [reply1.linkId, reply2.linkId] },
        },
      }),
    ).toBe(2)

    // Different ingress paths must serialize on the same run, not merely on a support request.
    const concurrentRunId = await newRun()
    const clientQuestion = await ask(concurrentRunId, 'the ramp')
    const founderQuestion = await ask(concurrentRunId, 'the review scope')
    const concurrentReply = await clientReply(clientQuestion, 'The north ramp is available.')
    const outcomes = await Promise.all([
      resumeOnboardingQuestionFromSupportAction(concurrentReply.input),
      answerAgentQuestionAction({
        ...scope,
        questionId: founderQuestion.id,
        expectedUpdatedAt: founderQuestion.updatedAt,
        outcome: 'ANSWERED',
        answer: 'Review public entrances only.',
        actor: operator,
      }),
    ])
    expect(outcomes.filter((outcome) => outcome.runEligibleToResume)).toHaveLength(1)
    expect((await readRun(concurrentRunId)).status).toBe('QUEUED')
    expect(
      await db.agentQuestion.count({
        where: { ...scope, agentRunId: concurrentRunId, blocking: true, status: 'PENDING' },
      }),
    ).toBe(0)

    const cancelledRunId = await newRun()
    const cancelledQuestion = await ask(cancelledRunId, 'a superseded review')
    const cancelledReply = await clientReply(
      cancelledQuestion,
      'This reply still belongs in the durable history.',
    )
    await requestAgentRunCancellationAction({
      ...scope,
      agentRunId: cancelledRunId,
      reason: 'Synthetic replacement review requested.',
      actor: { type: 'HUMAN', id: operator.actorId, role: 'PLATFORM_ADMIN' },
    })
    await expect(
      resumeOnboardingQuestionFromSupportAction(cancelledReply.input),
    ).resolves.toMatchObject({
      linked: true,
      replayed: false,
      runEligibleToResume: false,
    })
    await expect(
      resumeOnboardingQuestionFromSupportAction(cancelledReply.input),
    ).resolves.toMatchObject({ replayed: true, runEligibleToResume: false })
    expect((await readRun(cancelledRunId)).status).toBe('CANCELLED')
    expect(
      await db.supportMessage.findFirstOrThrow({
        where: { ...scope, id: cancelledReply.input.supportMessageId },
      }),
    ).toMatchObject({ body: cancelledReply.body })
    expect(
      await db.agentQuestion.findFirstOrThrow({ where: { ...scope, id: cancelledQuestion.id } }),
    ).toMatchObject({ status: 'ANSWERED' })
    expect(await db.approvalRequest.count({ where: scope })).toBe(0)
    expect(await db.agentAction.count({ where: scope })).toBe(0)
  }, 60_000)
})
