import { createHash, randomUUID } from 'node:crypto'

import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { expireAgentQuestionIfDue } from './agent-question-expiration-actions'
import { recordOrReplayOnboardingMilestoneEvent } from './onboarding-milestone-events'

type Client = Pick<typeof db, '$transaction'>

const id = z.string().trim().min(1).max(191)
const createInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: id,
    venueId: id,
    agentQuestionId: id,
    expectedQuestionUpdatedAt: z.date(),
    recipientUserId: id,
    category: z.enum([
      'CONTENT_CORRECTION',
      'OPERATIONAL_UPDATE',
      'BRANDING',
      'EXPERIENCE_BEHAVIOR',
      'ACCESSIBILITY',
      'GENERAL',
    ]),
    subject: z.string().trim().min(1).max(200),
    why: z.string().trim().min(1).max(2000),
    whatWasFound: z.string().trim().min(1).max(2000).optional(),
    effect: z.string().trim().min(1).max(1000),
    actor: z
      .object({
        actorId: id,
        auditRole: z.literal('PLATFORM_ADMIN'),
      })
      .strict(),
  })
  .strict()

const resumeInput = z
  .object({
    tenantId: id,
    venueId: id,
    supportRequestId: id,
    supportMessageId: id,
    actor: z
      .object({
        actorId: id,
        auditRole: z.enum(['STAFF', 'MANAGER', 'OWNER']),
      })
      .strict(),
  })
  .strict()

export type CreateClientOnboardingQuestionInput = z.input<typeof createInput>
export type ResumeOnboardingQuestionInput = z.input<typeof resumeInput>

export class OnboardingQuestionActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INVALID_INPUT' | 'EXPIRED',
    message: string,
  ) {
    super(message)
    this.name = 'OnboardingQuestionActionError'
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function openingBody(input: z.output<typeof createInput>, question: string) {
  return [
    question,
    '',
    `Why Torchiko is asking: ${input.why}`,
    ...(input.whatWasFound ? ['', `What Torchiko already found: ${input.whatWasFound}`] : []),
    '',
    `What your answer changes: ${input.effect}`,
    '',
    'If you are not sure, say so. You can also ask an authorized teammate to help in this conversation.',
  ].join('\n')
}

/**
 * Routes one exact pending AgentQuestion to one active tenant member through
 * the existing Support workflow. This creates discussion evidence only; it
 * never grants an approval or executes the blocked work.
 */
export async function createClientOnboardingQuestionAction(
  rawInput: CreateClientOnboardingQuestionInput,
  client: Client = db,
) {
  const input = createInput.parse(rawInput)
  const operationHash = sha256({
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentQuestionId: input.agentQuestionId,
    expectedQuestionUpdatedAt: input.expectedQuestionUpdatedAt.toISOString(),
    recipientUserId: input.recipientUserId,
    category: input.category,
    subject: input.subject,
    why: input.why,
    whatWasFound: input.whatWasFound ?? null,
    effect: input.effect,
    actorId: input.actor.actorId,
  })

  const transactionResult = client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:onboarding-question:${input.tenantId}:${input.operationId}`}, 0))`
    const replay = await tx.onboardingQuestionLink.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: {
        id: true,
        operationHash: true,
        venueId: true,
        agentQuestionId: true,
        supportRequestId: true,
        recipientUserId: true,
        resumedAt: true,
      },
    })
    if (replay) {
      if (replay.operationHash !== operationHash)
        throw new OnboardingQuestionActionError(
          'CONFLICT',
          'Onboarding question operation was already used',
        )
      return { link: replay, replayed: true as const, approvalGranted: false as const }
    }

    const [question, membership] = await Promise.all([
      tx.agentQuestion.findFirst({
        where: {
          id: input.agentQuestionId,
          tenantId: input.tenantId,
          venueId: input.venueId,
        },
        select: {
          id: true,
          agentIdentityId: true,
          agentRunId: true,
          question: true,
          blocking: true,
          status: true,
          expiresAt: true,
          updatedAt: true,
          agentRun: { select: { status: true } },
        },
      }),
      tx.tenantMembership.findFirst({
        where: {
          tenantId: input.tenantId,
          userId: input.recipientUserId,
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    ])
    if (!question || !membership)
      throw new OnboardingQuestionActionError('NOT_FOUND', 'Question recipient is not available')
    if (question.status === 'EXPIRED' || question.expiresAt) {
      const expiry = await expireAgentQuestionIfDue(tx, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: question.id,
      })
      if (expiry === 'EXPIRED') return { expired: true as const }
    }
    if (
      question.status !== 'PENDING' ||
      question.updatedAt.getTime() !== input.expectedQuestionUpdatedAt.getTime()
    )
      throw new OnboardingQuestionActionError('CONFLICT', 'Agent question changed; refresh it')
    if (
      !question.blocking ||
      !question.agentRunId ||
      question.agentRun?.status !== 'AWAITING_INPUT'
    )
      throw new OnboardingQuestionActionError(
        'CONFLICT',
        'Only exact blocked work can be routed to a client',
      )
    const alreadyLinked = await tx.onboardingQuestionLink.findFirst({
      where: {
        agentQuestionId: question.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
      },
      select: { id: true },
    })
    if (alreadyLinked)
      throw new OnboardingQuestionActionError('CONFLICT', 'Agent question is already routed')

    const now = new Date()
    const request = await tx.supportRequest.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        category: input.category,
        status: 'WAITING_FOR_CLIENT',
        subject: input.subject,
        missingInformation: [question.question],
        artifacts: {
          onboardingQuestion: true,
          onboardingQuestionContext: {
            version: 1,
            why: input.why,
            ...(input.whatWasFound ? { whatWasFound: input.whatWasFound } : {}),
            effect: input.effect,
          },
        },
        version: 1,
        clientVersion: 1,
        clientActivityAt: now,
        statusChangedAt: now,
        createdByKind: 'OPERATOR',
        createdById: input.actor.actorId,
        requesterUserId: null,
        updatedByKind: 'OPERATOR',
        updatedById: input.actor.actorId,
      },
      select: { id: true },
    })
    const message = await tx.supportMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        authorKind: 'OPERATOR',
        authorId: input.actor.actorId,
        visibility: 'CLIENT_VISIBLE',
        body: openingBody(input, question.question),
        submissionRequestId: input.operationId,
        submissionInputHash: operationHash,
        clientVersion: 1,
        requestVersion: 1,
        createdAt: now,
      },
      select: { id: true },
    })
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: 1,
        eventType: 'ONBOARDING_QUESTION_ROUTED',
        actorKind: 'OPERATOR',
        actorId: input.actor.actorId,
        fromStatus: null,
        toStatus: null,
        createdAt: now,
      },
      select: { id: true },
    })
    await tx.supportRequestParticipant.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        userId: input.recipientUserId,
        grantOperationId: input.operationId,
        grantOperationHash: operationHash,
        grantRequestVersion: 1,
        grantClientVersion: 1,
        grantActionAt: now,
        grantedByKind: 'OPERATOR',
        grantedById: input.actor.actorId,
        grantedAt: now,
      },
      select: { id: true },
    })
    const link = await tx.onboardingQuestionLink.create({
      data: {
        operationId: input.operationId,
        operationHash,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentQuestionId: question.id,
        expectedQuestionUpdatedAt: question.updatedAt,
        supportRequestId: request.id,
        recipientUserId: input.recipientUserId,
        createdBy: input.actor.actorId,
        createdAt: now,
      },
      select: {
        id: true,
        operationHash: true,
        venueId: true,
        agentQuestionId: true,
        supportRequestId: true,
        recipientUserId: true,
        resumedAt: true,
      },
    })
    await recordOrReplayOnboardingMilestoneEvent({
      db: tx,
      input: {
        id: randomUUID(),
        tenantId: input.tenantId,
        venueId: input.venueId,
        eventType: 'QUESTION_ROUTED',
        idempotencyKey: `onboarding-question:${link.id}:routed`,
        occurredAt: now,
        actorType: 'OPERATOR',
        actorId: input.actor.actorId,
        sourceType: 'ONBOARDING_QUESTION',
        sourceId: link.id,
        sourceRevision: operationHash,
        category: input.category,
        durationMs: null,
      },
    })
    await tx.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: question.agentRunId,
        actorType: 'HUMAN',
        actorId: input.actor.actorId,
        eventType: 'QUESTION_ROUTED_TO_CLIENT',
        message: 'A blocking question was routed to an authorized venue participant.',
        data: { questionId: question.id, supportRequestId: request.id },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'onboarding-question.routed-to-client',
        targetType: 'OnboardingQuestionLink',
        targetId: link.id,
        afterState: {
          venueId: input.venueId,
          agentQuestionId: question.id,
          supportRequestId: request.id,
          recipientUserId: input.recipientUserId,
          supportMessageId: message.id,
          approvalGranted: false,
        },
      },
      tx,
    )
    return { link, replayed: false as const, approvalGranted: false as const }
  })
  const result = await transactionResult.catch(async (error: unknown) => {
    if (
      !(error instanceof Error) ||
      !error.message.includes('agent question answer deadline has expired')
    )
      throw error
    const expiry = await client.$transaction((tx) =>
      expireAgentQuestionIfDue(tx, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: input.agentQuestionId,
      }),
    )
    if (expiry !== 'EXPIRED') throw error
    return { expired: true as const }
  })
  if ('expired' in result)
    throw new OnboardingQuestionActionError(
      'EXPIRED',
      'This question has expired and cannot be newly routed to a client.',
    )
  return result
}

/**
 * Claims one exact client support response, records it as the answer to the
 * linked AgentQuestion, and returns the exact run eligible for redispatch.
 * The caller owns durable queue dispatch and can replay it with the same key.
 */
export async function resumeOnboardingQuestionFromSupportAction(
  rawInput: ResumeOnboardingQuestionInput,
  client: Client = db,
) {
  const input = resumeInput.parse(rawInput)
  const transactionResult = client.$transaction(async (tx) => {
    async function replayResumeEligibility(agentRunId: string | null) {
      if (!agentRunId) return false
      const lockedRuns = await tx.$queryRaw<
        Array<{ id: string; status: string; cancelRequestedAt: Date | null }>
      >`
        SELECT id, status, cancel_requested_at AS "cancelRequestedAt"
        FROM agent_runs
        WHERE id = ${agentRunId}
          AND tenant_id = ${input.tenantId}
          AND venue_id = ${input.venueId}
        FOR UPDATE
      `
      const run = lockedRuns[0]
      if (!run) return false
      const remainingBlockingQuestions = await tx.agentQuestion.count({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentRunId,
          blocking: true,
          status: { in: ['PENDING', 'EXPIRED'] },
        },
      })
      return (
        run.status === 'QUEUED' &&
        run.cancelRequestedAt === null &&
        remainingBlockingQuestions === 0
      )
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:onboarding-question-resume:${input.tenantId}:${input.supportRequestId}`}, 0))`
    const link = await tx.onboardingQuestionLink.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: input.supportRequestId,
      },
      select: {
        id: true,
        agentQuestionId: true,
        expectedQuestionUpdatedAt: true,
        answeredSupportMessageId: true,
        resumedAt: true,
        createdAt: true,
      },
    })
    if (!link)
      return {
        linked: false as const,
        replayed: false as const,
        runEligibleToResume: false as const,
        agentRunId: null,
        questionId: null,
      }
    if (link.resumedAt) {
      if (link.answeredSupportMessageId !== input.supportMessageId)
        throw new OnboardingQuestionActionError(
          'CONFLICT',
          'Onboarding question already resumed from another answer',
        )
      const [answered, replayMessage] = await Promise.all([
        tx.agentQuestion.findFirst({
          where: {
            id: link.agentQuestionId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'ANSWERED',
          },
          select: { agentRunId: true },
        }),
        tx.supportMessage.findFirst({
          where: {
            id: input.supportMessageId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            supportRequestId: input.supportRequestId,
            authorKind: 'CLIENT',
            authorId: input.actor.actorId,
            visibility: 'CLIENT_VISIBLE',
          },
          select: { id: true },
        }),
      ])
      if (!answered)
        throw new OnboardingQuestionActionError('CONFLICT', 'Resumption evidence is incomplete')
      if (!replayMessage)
        throw new OnboardingQuestionActionError('NOT_FOUND', 'Linked onboarding answer not found')
      const runEligibleToResume = await replayResumeEligibility(answered.agentRunId)
      return {
        linked: true as const,
        replayed: true as const,
        runEligibleToResume,
        agentRunId: answered.agentRunId,
        questionId: link.agentQuestionId,
      }
    }

    const [message, question] = await Promise.all([
      tx.supportMessage.findFirst({
        where: {
          id: input.supportMessageId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          supportRequestId: input.supportRequestId,
          authorKind: 'CLIENT',
          authorId: input.actor.actorId,
          visibility: 'CLIENT_VISIBLE',
        },
        select: { id: true, body: true },
      }),
      tx.agentQuestion.findFirst({
        where: {
          id: link.agentQuestionId,
          tenantId: input.tenantId,
          venueId: input.venueId,
        },
        select: {
          id: true,
          agentIdentityId: true,
          agentRunId: true,
          blocking: true,
          status: true,
          expiresAt: true,
          updatedAt: true,
        },
      }),
    ])
    if (!message || !question)
      throw new OnboardingQuestionActionError('NOT_FOUND', 'Linked onboarding answer not found')
    if (question.status === 'EXPIRED' || question.expiresAt) {
      const expiry = await expireAgentQuestionIfDue(tx, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: question.id,
      })
      if (expiry === 'EXPIRED')
        return {
          linked: true as const,
          replayed: false as const,
          questionExpired: true as const,
          runEligibleToResume: false as const,
          agentRunId: question.agentRunId,
          questionId: question.id,
        }
    }
    if (
      question.status !== 'PENDING' ||
      question.updatedAt.getTime() !== link.expectedQuestionUpdatedAt.getTime()
    )
      throw new OnboardingQuestionActionError('CONFLICT', 'Agent question changed; review manually')
    if (!question.blocking || !question.agentRunId)
      throw new OnboardingQuestionActionError('CONFLICT', 'Linked blocked work is incomplete')

    const lockedRuns = await tx.$queryRaw<
      Array<{ id: string; status: string; cancelRequestedAt: Date | null }>
    >`
      SELECT id, status, cancel_requested_at AS "cancelRequestedAt"
      FROM agent_runs
      WHERE id = ${question.agentRunId}
        AND tenant_id = ${input.tenantId}
        AND venue_id = ${input.venueId}
      FOR UPDATE
    `
    const lockedRun = lockedRuns[0]
    if (!lockedRun)
      throw new OnboardingQuestionActionError('NOT_FOUND', 'Linked blocked work is unavailable')

    const now = new Date()
    const questionChanged = await tx.agentQuestion.updateMany({
      where: {
        id: question.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'PENDING',
        updatedAt: link.expectedQuestionUpdatedAt,
      },
      data: {
        status: 'ANSWERED',
        answer: `Client response recorded in support message ${message.id}.`,
        answeredById: input.actor.actorId,
        answeredAt: now,
      },
    })
    if (questionChanged.count !== 1)
      throw new OnboardingQuestionActionError('CONFLICT', 'Agent question changed; review manually')
    const remainingBlockingQuestions = await tx.agentQuestion.count({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: question.agentRunId,
        blocking: true,
        status: { in: ['PENDING', 'EXPIRED'] },
      },
    })
    let runEligibleToResume =
      lockedRun.status === 'QUEUED' &&
      lockedRun.cancelRequestedAt === null &&
      remainingBlockingQuestions === 0
    if (
      lockedRun.status === 'AWAITING_INPUT' &&
      lockedRun.cancelRequestedAt === null &&
      remainingBlockingQuestions === 0
    ) {
      const runChanged = await tx.agentRun.updateMany({
        where: {
          id: question.agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          status: 'AWAITING_INPUT',
          cancelRequestedAt: null,
        },
        data: {
          status: 'QUEUED',
          executionBridgeSessionId: null,
          executionWorkerId: null,
          executionLeaseToken: null,
          executionLeaseExpiresAt: null,
          lastHeartbeatAt: null,
        },
      })
      runEligibleToResume = runChanged.count === 1
    }
    const linkChanged = await tx.onboardingQuestionLink.updateMany({
      where: {
        id: link.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        resumedAt: null,
        answeredSupportMessageId: null,
      },
      data: { answeredSupportMessageId: message.id, resumedAt: now },
    })
    if (linkChanged.count !== 1)
      throw new OnboardingQuestionActionError('CONFLICT', 'Answer was already claimed')
    await recordOrReplayOnboardingMilestoneEvent({
      db: tx,
      input: {
        id: randomUUID(),
        tenantId: input.tenantId,
        venueId: input.venueId,
        eventType: 'QUESTION_ANSWERED',
        idempotencyKey: `onboarding-question:${link.id}:answered:${message.id}`,
        occurredAt: now,
        actorType: 'CLIENT',
        actorId: input.actor.actorId,
        sourceType: 'ONBOARDING_QUESTION',
        sourceId: link.id,
        sourceRevision: message.id,
        category: null,
        durationMs: Math.max(0, now.getTime() - link.createdAt.getTime()),
      },
    })
    await tx.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: question.agentRunId,
        actorType: 'HUMAN',
        actorId: input.actor.actorId,
        eventType: 'CLIENT_QUESTION_ANSWERED',
        message: 'An authorized venue participant answered the linked onboarding question.',
        data: {
          questionId: question.id,
          supportRequestId: input.supportRequestId,
          supportMessageId: message.id,
          approvalGranted: false,
        },
      },
    })
    await tx.agentMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: question.agentRunId,
        agentIdentityId: question.agentIdentityId,
        role: 'OPERATOR',
        messageType: 'ANSWER',
        content: message.body,
        actorId: input.actor.actorId,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'onboarding-question.client-answer-claimed',
        targetType: 'OnboardingQuestionLink',
        targetId: link.id,
        beforeState: { resumedAt: null },
        afterState: {
          resumedAt: now.toISOString(),
          questionId: question.id,
          agentRunId: question.agentRunId,
          supportMessageId: message.id,
          runEligibleToResume,
          approvalGranted: false,
        },
      },
      tx,
    )
    return {
      linked: true as const,
      replayed: false as const,
      runEligibleToResume,
      agentRunId: question.agentRunId,
      questionId: question.id,
    }
  })
  return transactionResult.catch(async (error: unknown) => {
    if (
      !(error instanceof Error) ||
      !error.message.includes('agent question answer deadline has expired')
    )
      throw error
    // The support response committed before this action. Keep it durable even if the
    // cutoff raced its attempted question answer, without claiming that answer/resumption.
    return client.$transaction(async (tx) => {
      const link = await tx.onboardingQuestionLink.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          supportRequestId: input.supportRequestId,
        },
        select: { agentQuestionId: true, agentQuestion: { select: { agentRunId: true } } },
      })
      const message = await tx.supportMessage.findFirst({
        where: {
          id: input.supportMessageId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          supportRequestId: input.supportRequestId,
          authorKind: 'CLIENT',
          authorId: input.actor.actorId,
          visibility: 'CLIENT_VISIBLE',
        },
        select: { id: true },
      })
      if (!link || !message) throw error
      const expiry = await expireAgentQuestionIfDue(tx, {
        tenantId: input.tenantId,
        venueId: input.venueId,
        questionId: link.agentQuestionId,
      })
      if (expiry !== 'EXPIRED') throw error
      return {
        linked: true as const,
        replayed: false as const,
        questionExpired: true as const,
        runEligibleToResume: false as const,
        agentRunId: link.agentQuestion.agentRunId,
        questionId: link.agentQuestionId,
      }
    })
  })
}
