import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import {
  askAgentQuestionAction,
  createClientOnboardingQuestionAction,
  db,
  grantSupportRequestParticipantAction,
  respondToSupportInformationAction,
  resumeOnboardingQuestionFromSupportAction,
  withTenantIsolationBypass,
} from '../index'

const enabled =
  process.env.RUN_ONBOARDING_QUESTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_[a-z0-9_]+$/u.test(process.env.DATABASE_URL ?? '')

describe.skipIf(!enabled)('onboarding question disposable lifecycle', () => {
  afterAll(async () => db.$disconnect())

  it('routes, isolates, answers, resumes, and replays one exact blocked run without approval', async () => {
    await withTenantIsolationBypass(async () => {
      const suffix = randomUUID().slice(0, 8)
      const tenantId = `tenant-onboarding-${suffix}`
      const venueId = `venue-onboarding-${suffix}`
      const identityId = `identity-onboarding-${suffix}`
      const clientId = `client-onboarding-${suffix}`
      const outsiderId = `outsider-onboarding-${suffix}`

      await db.tenant.create({
        data: { id: tenantId, name: 'Synthetic onboarding tenant', slug: tenantId },
      })
      await db.user.createMany({
        data: [
          { id: clientId, email: `${clientId}@example.test`, fullName: 'Venue Contact' },
          { id: outsiderId, email: `${outsiderId}@example.test`, fullName: 'Other Contact' },
        ],
      })
      await db.tenantMembership.createMany({
        data: [
          { tenantId, userId: clientId, role: 'MANAGER', joinedAt: new Date() },
          { tenantId, userId: outsiderId, role: 'STAFF', joinedAt: new Date() },
        ],
      })
      await db.venue.create({
        data: { id: venueId, tenantId, name: 'Synthetic Onboarding Venue', slug: venueId },
      })
      await db.agentIdentity.create({
        data: {
          id: identityId,
          tenantId,
          venueId,
          identityKey: `onboarding.accessibility.${suffix}`,
          name: 'Accessibility reviewer',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read', 'support.question'],
          autonomyLevel: 'DRAFT',
          enabled: true,
          createdBy: 'integration-operator',
        },
      })
      const run = await db.agentRun.create({
        data: {
          operationId: randomUUID(),
          tenantId,
          venueId,
          agentIdentityId: identityId,
          runType: 'ONBOARDING',
          requestedOperation: 'review_accessible_arrival',
          requestPrompt: 'Verify the accessible entrance from client evidence.',
          scopeSnapshot: { accessCapabilities: ['intake.read', 'support.question'] },
          status: 'QUEUED',
          initiatedByType: 'HUMAN',
          initiatedById: 'integration-operator',
        },
      })
      const asked = await askAgentQuestionAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        agentIdentityId: identityId,
        agentRunId: run.id,
        question: 'Which public entrance provides the step-free route?',
        context: 'Two synthetic sources name different entrances.',
        choices: ['Oak Street', "I don't know"],
        blocking: true,
      })
      expect(
        await db.agentRun.findUnique({ where: { id: run.id }, select: { status: true } }),
      ).toEqual({ status: 'AWAITING_INPUT' })

      const routingOperationId = randomUUID()
      const routed = await createClientOnboardingQuestionAction({
        operationId: routingOperationId,
        tenantId,
        venueId,
        agentQuestionId: asked.question.id,
        expectedQuestionUpdatedAt: asked.question.updatedAt,
        recipientUserId: clientId,
        category: 'ACCESSIBILITY',
        subject: 'Confirm the step-free entrance',
        why: 'The synthetic sources disagree.',
        whatWasFound: 'Both Oak Street and Pine Street are named.',
        effect: 'The exact accessibility review can continue.',
        actor: { actorId: 'integration-operator', auditRole: 'PLATFORM_ADMIN' },
      })
      expect(routed.approvalGranted).toBe(false)
      const replayedRoute = await createClientOnboardingQuestionAction({
        operationId: routingOperationId,
        tenantId,
        venueId,
        agentQuestionId: asked.question.id,
        expectedQuestionUpdatedAt: asked.question.updatedAt,
        recipientUserId: clientId,
        category: 'ACCESSIBILITY',
        subject: 'Confirm the step-free entrance',
        why: 'The synthetic sources disagree.',
        whatWasFound: 'Both Oak Street and Pine Street are named.',
        effect: 'The exact accessibility review can continue.',
        actor: { actorId: 'integration-operator', auditRole: 'PLATFORM_ADMIN' },
      })
      expect(replayedRoute.replayed).toBe(true)

      await expect(
        respondToSupportInformationAction({
          operationId: randomUUID(),
          tenantId,
          venueId,
          requestId: routed.link.supportRequestId,
          expectedClientVersion: 1,
          body: 'Oak Street is the step-free entrance.',
          attachments: [],
          actor: {
            actorType: 'HUMAN',
            participantKind: 'CLIENT',
            actorId: outsiderId,
            auditRole: 'STAFF',
          },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      const reassigned = await grantSupportRequestParticipantAction({
        operationId: randomUUID(),
        tenantId,
        venueId,
        requestId: routed.link.supportRequestId,
        userId: outsiderId,
        expectedClientVersion: 1,
        actor: {
          actorType: 'HUMAN',
          participantKind: 'CLIENT',
          actorId: clientId,
          auditRole: 'MANAGER',
        },
      })
      expect(reassigned).toMatchObject({ active: true, clientVersion: 2 })

      const answerOperationId = randomUUID()
      const response = await respondToSupportInformationAction({
        operationId: answerOperationId,
        tenantId,
        venueId,
        requestId: routed.link.supportRequestId,
        expectedClientVersion: 2,
        body: 'Oak Street is the step-free entrance during every public hour.',
        attachments: [],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'CLIENT',
          actorId: outsiderId,
          auditRole: 'STAFF',
        },
      })
      const resumed = await resumeOnboardingQuestionFromSupportAction({
        tenantId,
        venueId,
        supportRequestId: routed.link.supportRequestId,
        supportMessageId: response.message.id,
        actor: { actorId: outsiderId, auditRole: 'STAFF' },
      })
      expect(resumed).toMatchObject({
        linked: true,
        replayed: false,
        runEligibleToResume: true,
        agentRunId: run.id,
        questionId: asked.question.id,
      })

      const responseReplay = await respondToSupportInformationAction({
        operationId: answerOperationId,
        tenantId,
        venueId,
        requestId: routed.link.supportRequestId,
        expectedClientVersion: 2,
        body: 'Oak Street is the step-free entrance during every public hour.',
        attachments: [],
        actor: {
          actorType: 'HUMAN',
          participantKind: 'CLIENT',
          actorId: outsiderId,
          auditRole: 'STAFF',
        },
      })
      const resumeReplay = await resumeOnboardingQuestionFromSupportAction({
        tenantId,
        venueId,
        supportRequestId: routed.link.supportRequestId,
        supportMessageId: responseReplay.message.id,
        actor: { actorId: outsiderId, auditRole: 'STAFF' },
      })
      expect(resumeReplay).toMatchObject({ replayed: true, agentRunId: run.id })

      const [question, finalRun, link, approvalCount, answerMessages, auditCount, milestones] =
        await Promise.all([
          db.agentQuestion.findUniqueOrThrow({
            where: { id: asked.question.id },
            select: { status: true, answeredById: true },
          }),
          db.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { status: true } }),
          db.onboardingQuestionLink.findUniqueOrThrow({
            where: { id: routed.link.id },
            select: { answeredSupportMessageId: true, resumedAt: true },
          }),
          db.approvalRequest.count({ where: { tenantId, venueId } }),
          db.agentMessage.count({
            where: { tenantId, venueId, agentRunId: run.id, messageType: 'ANSWER' },
          }),
          db.auditLog.count({
            where: {
              tenantId,
              action: {
                in: [
                  'onboarding-question.routed-to-client',
                  'onboarding-question.client-answer-claimed',
                ],
              },
            },
          }),
          db.onboardingMilestoneEvent.findMany({
            where: { tenantId, venueId },
            orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
            select: { eventType: true, sourceId: true },
          }),
        ])
      expect(question).toEqual({ status: 'ANSWERED', answeredById: outsiderId })
      expect(finalRun).toEqual({ status: 'QUEUED' })
      expect(link.answeredSupportMessageId).toBe(response.message.id)
      expect(link.resumedAt).toBeInstanceOf(Date)
      expect(approvalCount).toBe(0)
      expect(answerMessages).toBe(1)
      expect(auditCount).toBe(2)
      expect(milestones).toEqual([
        { eventType: 'QUESTION_ROUTED', sourceId: routed.link.id },
        { eventType: 'QUESTION_ANSWERED', sourceId: routed.link.id },
      ])
    })
  }, 30_000)
})
